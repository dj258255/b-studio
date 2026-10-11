import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { EDGE_IMAGE } from '../edge-config';
import { SandboxError } from '../errors';
import { computeGitMask, findMissingMasks, type InspectedMount, type MaskVolume } from './git-mask';

const execFileAsync = promisify(execFile);

/**
 * 세션 터미널(이슈 #673): 에이전트 CLI를 호스트가 아니라 컨테이너 안에서 돌리고, 화면의 터미널을 그 CLI에 붙인다.
 *
 * 호스트에서 도는 CLI는 경로 검사로 다 가둘 수 없었다(ADR-168: 검사와 사용 사이에 경로를 링크로 바꿔치기할 수 있다).
 * 컨테이너 안에서는 작업 복사본만 보이고, 링크가 밖을 가리켜도 컨테이너의 파일로 풀린다. `.git`은 서비스 컨테이너와 같은
 * 방식으로 막는다(ADR-158: 읽기 전용, 상태 폴더는 빈 폴더). CLI의 홈 폴더는 이름 있는 볼륨에 두어 로그인과 설치가 남는다.
 *
 * 가상 터미널은 컨테이너 안에서 `script`로 만든다. 호스트와는 `docker exec -i`의 파이프로 잇는다 — 호스트에 네이티브
 * 모듈(node-pty)을 두지 않고, 다른 도커 호출과 같은 방식(CLI)을 쓴다. 크기는 다른 exec에서 `stty`로 바꾼다.
 */

/** 플랫폼 이미지(edge·부하 러너와 같다). node와 npm, bash, script(bsdutils)가 들어 있다 */
export const AGENT_IMAGE = EDGE_IMAGE;
export const AGENT_SERVICE = 'b-studio-agent';
/** 컨테이너 안에서 작업 복사본이 보이는 자리. 폴더 열기로 만든 서비스 컨테이너와 같다(ADR-088) */
export const AGENT_WORKSPACE = '/workspace';
/**
 * CLI의 홈 폴더를 두는 볼륨. 세션이 바뀌어도 로그인과 설치한 CLI가 남게 하되, **프로젝트마다 따로** 둔다.
 * 홈 폴더에는 로그인 정보와 CLI의 설정(훅), 셸 설정, 설치한 실행 파일이 있다. 모든 세션이 하나를 같이 쓰면 한 프로젝트의
 * 터미널에서 바꿔 둔 것이 다른 프로젝트의 세션에 그대로 따라간다. 대가는 프로젝트마다 로그인을 한 번씩 하는 것이다.
 */
export const AGENT_HOME_VOLUME_PREFIX = 'b-studio-agent-home';
export function agentHomeVolume(projectId: string): string {
  // 볼륨 이름에 쓸 수 있는 글자만 남긴다. 서로 다른 id가 같은 이름이 되지 않게 걸러 낸 글자가 있으면 길이를 덧붙인다
  const safe = projectId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80);
  if (!safe) throw new SandboxError('프로젝트 id가 비어 있어 에이전트 홈 볼륨을 정할 수 없습니다');
  return `${AGENT_HOME_VOLUME_PREFIX}-${safe}${safe === projectId ? '' : `-${projectId.length}`}`;
}
/** 컨테이너에 설치할 CLI의 판. 고정해 둔다 — 터미널을 열 때마다 "지금 최신"을 받으면 무엇이 깔리는지 알 수 없다. 올릴 때는 가두기를 다시 확인한다(ADR-168) */
export const AGENT_CLI_PACKAGE = '@anthropic-ai/claude-code@2.1.296';
const AGENT_HOME = '/home/node';
const NPM_PREFIX = `${AGENT_HOME}/.npm-global`;
const AGENT_PATH = `${NPM_PREFIX}/bin:${AGENT_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

/** 터미널 크기의 허용 범위. 숫자가 아닌 값이 셸 명령에 들어가지 않게 정수로 좁힌다 */
const MIN_COLS = 20;
const MAX_COLS = 400;
const MIN_ROWS = 5;
const MAX_ROWS = 200;

/**
 * 터미널을 열면 도는 명령. CLI가 없으면 홈 볼륨에 설치하고(처음 한 번), CLI를 띄우고, CLI에서 나오면 셸로 남는다.
 * 환경 변수로 넘겨 `sh -c "$변수"`로 실행한다. 명령 글을 따옴표 안에 끼워 넣지 않는다.
 */
export const AGENT_TERMINAL_COMMAND = [
  'if ! command -v claude >/dev/null 2>&1; then',
  '  printf "%s\\n" "[b-studio] 이 컨테이너에 claude CLI를 설치합니다(처음 한 번)."',
  `  npm install --global --no-fund --no-audit ${AGENT_CLI_PACKAGE} || printf "%s\\n" "[b-studio] 설치하지 못했습니다. 네트워크를 확인하고 npm install -g ${AGENT_CLI_PACKAGE} 를 다시 실행하세요."`,
  'fi',
  'if command -v claude >/dev/null 2>&1; then claude; fi',
  'printf "%s\\n" "[b-studio] claude에서 나왔습니다. 다시 띄우려면 claude 를 입력하세요."',
  'exec bash -l',
].join('\n');

export interface AgentContainerPlan {
  /** 컨테이너 이름 */
  name: string;
  /** 이 컨테이너가 속한 샌드박스. 샌드박스를 정리할 때 라벨로 함께 찾는다 */
  sandboxId: string;
  /** 작업 복사본(호스트 절대 경로) */
  projectRoot: string;
  /** `.git`을 막는 마운트(읽기 전용, 상태 폴더는 빈 폴더). computeGitMask가 계산한다 */
  masks: readonly MaskVolume[];
  /** CLI의 홈 폴더를 둘 볼륨(agentHomeVolume) */
  homeVolume: string;
  image?: string;
}

/** 세션 하나에 컨테이너 하나. 이름에 쓸 수 없는 글자는 뺀다 */
export function agentContainerName(sandboxId: string): string {
  return `${sandboxId.replace(/[^A-Za-z0-9_.-]/g, '-')}-agent`;
}

/**
 * CLI용 컨테이너를 띄우는 `docker run` 인자. 컨테이너는 아무것도 하지 않고 떠 있고(sleep), 터미널은 exec로 붙는다.
 *  - 보이는 호스트 폴더는 작업 복사본 하나다. `.git`은 읽기 전용으로 덮는다
 *  - 루트 파일 시스템은 읽기 전용. 쓸 수 있는 곳은 작업 복사본, 홈 볼륨, /tmp
 *  - 권한을 모두 내려놓고 root가 아닌 사용자로 돈다
 * 나가는 통신은 막지 않는다(CLI가 모델과 로그인 서버에 닿아야 한다). edge 프록시 뒤로 옮기는 것은 다음 단계다(#673)
 */
export function agentRunArgs(plan: AgentContainerPlan): string[] {
  const mount = (volume: MaskVolume): string => `type=bind,source=${volume.source},target=${volume.target},readonly`;
  for (const value of [plan.projectRoot, plan.homeVolume, ...plan.masks.flatMap((volume) => [volume.source, volume.target])]) {
    // --mount의 값은 쉼표로 나뉜다. 쉼표가 든 경로를 그대로 넣으면 다른 옵션으로 읽힌다
    if (value.includes(',')) throw new SandboxError('경로에 쉼표가 있어 에이전트 컨테이너에 연결할 수 없습니다', value);
  }
  return [
    'run',
    '--detach',
    '--init',
    '--name', plan.name,
    '--label', `b-studio.sandbox=${plan.sandboxId}`,
    '--label', `b-studio.service=${AGENT_SERVICE}`,
    '--hostname', AGENT_SERVICE,
    '--user', 'node',
    '--workdir', AGENT_WORKSPACE,
    '--read-only',
    '--tmpfs', '/tmp:rw,exec,nosuid,size=512m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '512',
    '--memory', '2g',
    '--mount', `type=bind,source=${plan.projectRoot},target=${AGENT_WORKSPACE}`,
    ...plan.masks.flatMap((volume) => ['--mount', mount(volume)]),
    '--mount', `type=volume,source=${plan.homeVolume},target=${AGENT_HOME}`,
    '--env', `HOME=${AGENT_HOME}`,
    '--env', `NPM_CONFIG_PREFIX=${NPM_PREFIX}`,
    '--env', `PATH=${AGENT_PATH}`,
    '--env', 'LANG=C.UTF-8',
    plan.image ?? AGENT_IMAGE,
    'sleep', 'infinity',
  ];
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** 크기를 허용 범위의 정수로 맞춘다. 숫자가 아니면 기본값을 쓴다 */
export function clampTerminalSize(size: { cols?: unknown; rows?: unknown }): TerminalSize {
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.min(max, Math.max(min, number));
  };
  return { cols: clamp(size.cols, MIN_COLS, MAX_COLS, 100), rows: clamp(size.rows, MIN_ROWS, MAX_ROWS, 30) };
}

/** 터미널 id는 컨테이너 안의 파일 이름에 들어간다. 정해진 글자만 받는다 */
function assertTerminalId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new SandboxError('터미널 id가 올바르지 않습니다', id);
}

const ttyFile = (id: string): string => `/tmp/b-studio-tty-${id}`;

/**
 * 컨테이너 안에 가상 터미널을 만들고 그 안에서 명령을 돌리는 `docker exec` 인자.
 * `script`가 가상 터미널을 만들고 표준 입출력(파이프)과 잇는다. 터미널의 장치 이름을 파일에 적어 두어 크기를 바꿀 때 쓴다.
 * 명령과 크기는 환경 변수로 넘긴다(인자의 글에 끼워 넣지 않는다)
 */
export function agentTerminalArgs(name: string, { id, size, command = AGENT_TERMINAL_COMMAND }: { id: string; size: TerminalSize; command?: string }): string[] {
  assertTerminalId(id);
  const { cols, rows } = clampTerminalSize(size);
  return [
    'exec',
    '--interactive',
    '--workdir', AGENT_WORKSPACE,
    '--env', 'TERM=xterm-256color',
    '--env', 'COLORTERM=truecolor',
    '--env', `B_STUDIO_TTY_FILE=${ttyFile(id)}`,
    '--env', `B_STUDIO_TTY_SIZE=rows ${rows} cols ${cols}`,
    '--env', `B_STUDIO_TERMINAL_COMMAND=${command}`,
    name,
    'script', '--quiet', '--flush', '--command', 'stty $B_STUDIO_TTY_SIZE; tty > "$B_STUDIO_TTY_FILE"; exec sh -c "$B_STUDIO_TERMINAL_COMMAND"', '/dev/null',
  ];
}

/** 열려 있는 터미널의 크기를 바꾸는 `docker exec` 인자. 크기가 바뀌면 터미널이 그 안의 프로그램에 알린다(SIGWINCH) */
export function agentResizeArgs(name: string, id: string, size: TerminalSize): string[] {
  assertTerminalId(id);
  const { cols, rows } = clampTerminalSize(size);
  return ['exec', '--env', `B_STUDIO_TTY_FILE=${ttyFile(id)}`, name, 'sh', '-c', `stty -F "$(cat "$B_STUDIO_TTY_FILE")" rows ${rows} cols ${cols}`];
}

export interface AgentContainerOptions {
  /** 홈 볼륨을 나누는 단위(프로젝트 id) */
  projectId: string;
  dockerBin?: string;
  image?: string;
}

/**
 * 세션의 CLI용 컨테이너가 떠 있게 한다. 이미 떠 있으면 그대로 쓰고, 멈춰 있으면 지우고 새로 띄운다.
 * 띄운 뒤에는 설정이 아니라 결과를 본다: 실제 마운트에서 `.git`이 읽기 전용으로 덮였는지 확인하고, 아니면 지우고 던진다.
 * 확인하기 전에는 누구도 이 컨테이너에서 명령을 돌리지 않는다(이름을 돌려주지 않는다)
 */
export async function ensureAgentContainer(sandboxId: string, projectRoot: string, { projectId, dockerBin = 'docker', image }: AgentContainerOptions): Promise<string> {
  const name = agentContainerName(sandboxId);
  const docker = (args: string[]) => execFileAsync(dockerBin, args, { cwd: tmpdir(), maxBuffer: 16 * 1024 * 1024 });
  const root = await realpath(projectRoot);

  const existing = await inspect(dockerBin, name);
  if (existing?.running && (await masksInPlace(root, existing.mounts))) return name;
  if (existing) await docker(['rm', '--force', name]).catch(() => {});

  const masks = (await computeGitMask(root, { services: { [AGENT_SERVICE]: { volumes: [{ type: 'bind', source: root, target: AGENT_WORKSPACE }] } } }))[AGENT_SERVICE] ?? [];
  try {
    await docker(agentRunArgs({ name, sandboxId, projectRoot: root, masks, homeVolume: agentHomeVolume(projectId), image }));
  } catch (error) {
    throw new SandboxError('에이전트 컨테이너를 띄우지 못했습니다', describe(error), { platform: true });
  }
  const started = await inspect(dockerBin, name);
  if (!started?.running || !(await masksInPlace(root, started.mounts))) {
    await docker(['rm', '--force', name]).catch(() => {});
    throw new SandboxError('에이전트 컨테이너의 .git 보호를 확인하지 못해 컨테이너를 지웠습니다', started ? `마운트 ${started.mounts.length}개` : '컨테이너가 뜨지 않았습니다', { platform: true });
  }
  return name;
}

/** 세션을 정리할 때 부른다. 없으면 아무 일도 하지 않는다 */
export async function removeAgentContainer(sandboxId: string, { dockerBin = 'docker' }: { dockerBin?: string } = {}): Promise<void> {
  await execFileAsync(dockerBin, ['rm', '--force', agentContainerName(sandboxId)], { cwd: tmpdir() }).catch(() => {});
}

async function masksInPlace(projectRoot: string, mounts: readonly InspectedMount[]): Promise<boolean> {
  return (await findMissingMasks(projectRoot, mounts, {})).length === 0;
}

async function inspect(dockerBin: string, name: string): Promise<{ running: boolean; mounts: InspectedMount[] } | undefined> {
  try {
    const { stdout } = await execFileAsync(dockerBin, ['inspect', '--type', 'container', name], { cwd: tmpdir(), maxBuffer: 16 * 1024 * 1024 });
    const [container] = JSON.parse(stdout) as Array<{ State?: { Running?: boolean }; Mounts?: InspectedMount[] }>;
    return container ? { running: container.State?.Running === true, mounts: container.Mounts ?? [] } : undefined;
  } catch {
    return undefined;
  }
}

/** 열린 터미널 하나. 출력은 바이트 그대로 준다(화면 제어 문자가 섞여 있어 글자로 바꾸지 않는다) */
export interface AgentTerminal {
  readonly id: string;
  write(data: string): void;
  resize(size: TerminalSize): Promise<void>;
  onData(listener: (chunk: Buffer) => void): void;
  onExit(listener: (code: number | null) => void): void;
  close(): void;
}

/** 프로세스를 띄우는 자리(테스트가 가짜를 끼운다) */
export type SpawnTerminal = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

/** 컨테이너 안에 가상 터미널을 열고 기본 명령(CLI)을 띄운다. 컨테이너는 ensureAgentContainer가 확인한 것이어야 한다 */
export function openAgentTerminal(
  name: string,
  { id, size, command, dockerBin = 'docker', spawnProcess = (bin, args) => spawn(bin, args, { cwd: tmpdir() }) }: { id: string; size: TerminalSize; command?: string; dockerBin?: string; spawnProcess?: SpawnTerminal },
): AgentTerminal {
  const child = spawnProcess(dockerBin, agentTerminalArgs(name, { id, size, command }));
  // 닫힌 뒤에 들어온 입력으로 프로세스 전체가 죽지 않게 한다
  child.stdin.on('error', () => {});
  return {
    id,
    write(data) {
      if (child.stdin.writable) child.stdin.write(data);
    },
    async resize(next) {
      await execFileAsync(dockerBin, agentResizeArgs(name, id, next), { cwd: tmpdir() }).catch(() => {});
    },
    onData(listener) {
      child.stdout.on('data', listener);
      child.stderr.on('data', listener);
    },
    onExit(listener) {
      child.once('close', (code) => listener(code));
    },
    close() {
      child.stdin.end();
      child.kill('SIGTERM');
    },
  };
}

function describe(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim().split('\n').slice(-3).join(' / ');
  return error instanceof Error ? error.message : String(error);
}
