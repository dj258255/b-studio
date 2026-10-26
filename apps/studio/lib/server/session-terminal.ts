import { watch as watchFs } from 'node:fs';
import path from 'node:path';
import {
  checkHostGatewayConfig,
  clampTerminalSize,
  defaultAgentGatewayRoot,
  ensureAgentContainer,
  expectedHostGatewayFiles,
  ACCOUNT_DIR_ENV,
  findHostCli,
  findUnhookedCli,
  userStatusLineCommand,
  listProcesses,
  openAgentTerminal,
  openHostTerminal,
  pauseAgentContainer,
  probeAgentGateway,
  probeHostGateway,
  removeAgentContainer,
  removeAgentGatewayConfig,
  removeHostGatewayConfig,
  unpauseAgentContainer,
  writeAgentGatewayConfig,
  writeHostGatewayConfig,
  type AgentGatewayAddress,
  type AgentTerminal,
  type HostCli,
  type HostCliKind,
  type ProcessEntry,
  type TerminalSize,
} from '@b-studio/sandbox';
import { notifyAgentsChanged } from './agents-pulse';
import { StudioError } from './errors';

/**
 * 세션 터미널(이슈 #673): 세션마다 에이전트 CLI용 컨테이너 하나와 그 안의 가상 터미널 하나를 든다.
 *
 * 화면과는 SSE(출력)와 POST(입력·크기)로 잇는다. 출력은 세션 기록에 남기지 않고(화면 제어 문자가 섞인 바이트다)
 * 최근 것만 메모리에 두어, 화면을 다시 열면 이어서 보이게 한다. 터미널은 화면이 닫혀도 살아 있고, 세션이 멈출 때 닫는다.
 */

/** 다시 연결한 화면에 되돌려 줄 최근 출력의 상한 */
const REPLAY_BYTES = 512 * 1024;
/** 한 번에 받는 입력의 상한. 붙여넣기까지는 받고, 그 이상은 잘못된 요청으로 본다 */
export const MAX_TERMINAL_INPUT = 256 * 1024;
const TERMINAL_ID = 'main';
/** 이 컴퓨터 방식의 관문 설정 파일 이름. host-terminal.ts의 SETTINGS_FILE과 같아야 한다 */
const HOST_SETTINGS_FILE = 'settings.json';
/** 이 컴퓨터 방식에서 관문 폴더에 바뀐 것이 없는지 보는 주기 */
const HOST_WATCH_INTERVAL_MS = 3_000;
/** fs.watch가 준 신호를 검사 한 번으로 모으는 시간 */
const HOST_WATCH_DEBOUNCE_MS = 250;

export type TerminalMode = 'container' | 'host';

/**
 * 터미널을 여는 방식(B_STUDIO_TERMINAL): 컨테이너 안의 CLI를 붙이거나, 이 컴퓨터의 CLI를 세션의 작업 복사본에서 띄운다.
 * 비었으면 host(이 컴퓨터 방식, ADR-173 덧붙임), container면 컨테이너, host면 이 컴퓨터, 그 밖은 던진다 — sessionMode와 같은 태도다:
 * 오타가 조용히 다른 방식으로 떨어지지 않는다
 */
export function sessionTerminalMode(env: Record<string, string | undefined> = process.env): TerminalMode {
  const value = env.B_STUDIO_TERMINAL?.trim();
  if (!value || value === 'host') return 'host';
  if (value === 'container') return 'container';
  throw new StudioError(500, `B_STUDIO_TERMINAL은 container, host 중 하나여야 합니다 (지금 값: ${value})`);
}

export type TerminalMessage =
  | { kind: 'data'; data: string }
  | { kind: 'status'; state: 'closed' | 'opening' | 'open'; message?: string }
  | { kind: 'exit'; code: number | null }
  /**
   * 터미널 안에 에이전트 CLI가 떠 있는가(CLI의 세션 시작·끝 훅으로 안다). 화면은 떠 있을 때만 다른 패널의 글을 붙여 넣는다 —
   * 셸 프롬프트에 붙여 넣으면 사람이 요청인 줄 알고 누른 Enter가 그 글을 명령으로 실행한다(이슈 #689)
   */
  | { kind: 'cli'; alive: boolean }
  /**
   * 감시가 찾은 위반(관문 파일 변조, 훅 없이 뜬 CLI). 터미널 패널의 경고 줄에 바로 보인다.
   * 다시 연결한 화면에는 마지막 경고를 되풀이하지 않는다(활동 기록에는 세션 이벤트로 남는다)
   */
  | { kind: 'warning'; message: string };

type Listener = (message: TerminalMessage) => void;

interface TerminalState {
  sandboxId: string;
  terminal?: AgentTerminal;
  opening?: Promise<void>;
  chunks: Buffer[];
  bytes: number;
  listeners: Set<Listener>;
  size: TerminalSize;
  /** 에이전트 CLI가 떠 있다고 알려 왔는가. 터미널이 닫히거나 끝나면 거짓으로 돌린다 */
  cli: boolean;
  /** 열려 있는 터미널의 감시를 멈추는 함수(백엔드가 watch를 줄 때만). 터미널이 끝나거나 닫히면 부른다 */
  watchStop?: () => void;
  /**
   * 이 스튜디오 프로세스에서 지금 샌드박스의 터미널을 연 적이 있는가(#872). 처음 열 때만 지난 CLI 대화를 이어 붙인다.
   * 같은 프로세스에서 다시 여는 것은 CLI·셸이 끝났거나 사람이 닫은 뒤라, 일부러 끝낸 대화를 되살리지 않는다
   */
  opened?: boolean;
}

export interface TerminalTarget {
  /** 컨테이너에 붙일 라벨과 이름의 바탕 */
  sandboxId: string;
  /** 작업 복사본(호스트 절대 경로) */
  root: string;
  /** CLI의 홈 볼륨을 나누는 단위 */
  projectId: string;
  /**
   * 세션 프로젝트가 선언한 평가 자산(studio.yaml workflow.evaluationAssets). 컨테이너 방식이면 작업 복사본 위에 읽기 전용으로 덮는다.
   * 이 컴퓨터 방식은 마운트가 없어 게이트의 지문 견줌에만 기댄다
   */
  evaluationAssets?: readonly string[];
  /**
   * 세션이 아직 살아 있는가. 세션을 멈추는 일과 터미널을 여는 일이 겹칠 수 있다: 멈추는 쪽이 컨테이너를 지운 뒤에
   * 여는 쪽이 컨테이너를 띄우면, 멈춘 세션의 작업 복사본을 붙인 컨테이너가 남는다. 띄운 뒤에 한 번 더 물어 지운다
   */
  alive?: () => boolean;
  /**
   * 관문(#673 2단계)을 띄우고 그 주소를 돌려준다. 주면 컨테이너에 CLI의 관리 설정(훅, b-studio 도구)과 그 주소를 붙이고,
   * 컨테이너에서 관문에 닿는 것을 확인한 뒤에야 터미널을 연다. 주지 않으면 관문 없는 터미널이다(테스트와 옛 호출자)
   */
  gateway?: () => Promise<AgentGatewayAddress>;
  /** 이 컴퓨터 방식에서 띄울 CLI(#825). 없으면 claude다. 컨테이너 방식은 claude만 쓴다 */
  cli?: HostCliKind;
  /** 이어 붙일 지난 CLI 대화 id(#872). 훅으로 받아 세션 기록에 남긴 것이다. 터미널을 열 때 한 번 묻는다 */
  resumeConversation?: () => string | undefined;
  /**
   * 세션의 AI 계정의 설정 폴더(#885). 기본 계정이면 undefined다. 계정이 목록에서 빠졌으면 던진다 — 다른 계정으로 띄우지 않는다.
   * 이 컴퓨터 방식은 감싸개가 CLAUDE_CONFIG_DIR·CODEX_HOME으로 넘긴다. 컨테이너 방식은 기본 계정만 쓴다
   */
  accountDir?: () => Promise<string | undefined>;
  /**
   * 감시가 위반(관문 파일 변조, 훅 없이 뜬 CLI)을 찾았을 때 부른다. 세션은 이 실행을 실패로 닫고 되돌린다(이슈 #695)
   */
  onViolation?: (reason: string) => void;
}

/** 터미널을 여는 자리(테스트가 가짜를 끼운다) */
export interface TerminalBackend {
  /** 터미널이 붙을 자리를 준비하고 그 자리를 가리키는 값을 돌려준다(컨테이너 이름, 또는 관문 설정 폴더) */
  prepare(target: TerminalTarget, gateway?: AgentGatewayAddress): Promise<string>;
  open(place: string, options: { id: string; size: TerminalSize; target: TerminalTarget; initialPrompt?: string; resumeConversation?: string }): AgentTerminal | Promise<AgentTerminal>;
  /**
   * 터미널을 열 때 첫 요청을 CLI 실행 인자로 넘길 수 있는가(#836). 이 컴퓨터 방식만 받는다. 받지 않는 백엔드에는 넘기지 않는다
   */
  readonly acceptsInitialPrompt?: boolean;
  /**
   * 터미널을 열 때 지난 CLI 대화를 이어 붙일 수 있는가(#872). 이 컴퓨터 방식만 받는다.
   * 컨테이너 방식은 CLI의 대화 기록이 컨테이너의 홈 볼륨에 있어 따로 확인하지 않았다
   */
  readonly acceptsResume?: boolean;
  /** 준비한 것(컨테이너, 관문 설정)을 지운다 */
  remove(sandboxId: string): Promise<void>;
  /** 그 자리에서 관문에 닿는가 */
  reachable(place: string): Promise<boolean>;
  /** 닿지 못할 때 사용자에게 보일 글 */
  readonly unreachable: string;
  /**
   * 열린 터미널을 감시한다. 위반을 찾으면 report를 부른다. 돌려준 함수로 멈춘다.
   * 관문을 쓰지 않는 백엔드(컨테이너)는 이 메서드를 두지 않는다 — 관리 설정이 읽기 전용 마운트라 필요 없다
   */
  watch?(place: string, terminal: AgentTerminal, target: TerminalTarget, report: (reason: string) => void): () => void;
  /**
   * 검사 구간(Stop 훅의 게이트) 동안 그 세션의 에이전트 컨테이너를 멈추고 푼다(이슈 #765).
   * 멈출 컨테이너가 없는 이 컴퓨터 방식은 두지 않는다 — 그 한계는 sessions.ts의 Stop 훅 게이트에 적었다
   */
  pause?(sandboxId: string): Promise<void>;
  unpause?(sandboxId: string): Promise<void>;
}

/** 검사 동안 에이전트 컨테이너를 멈추고 푸는 자리. 지금 방식의 백엔드가 두 메서드를 두었을 때만 있다 */
export interface TerminalPause {
  pause(sandboxId: string): Promise<void>;
  unpause(sandboxId: string): Promise<void>;
}

/** 컨테이너를 지우고, 그것이 실패해도 토큰이 든 관문 설정은 지운다 */
export async function removeContainerAndConfig(
  sandboxId: string,
  removeContainer: (id: string) => Promise<void> = removeAgentContainer,
  removeConfig: (id: string) => Promise<void> = removeAgentGatewayConfig,
): Promise<void> {
  try {
    await removeContainer(sandboxId);
  } finally {
    // 토큰이 든 설정을 남겨 두지 않는다. 컨테이너 지우기가 실패해도 지운다
    await removeConfig(sandboxId).catch(() => {});
  }
}

const DOCKER_BACKEND: TerminalBackend = {
  prepare: async (target, gateway) => {
    // 컨테이너의 CLI 로그인은 컨테이너 홈 볼륨에 있다. 이 컴퓨터의 계정 폴더를 붙이지 않는다
    if (await target.accountDir?.()) throw new Error('컨테이너 방식 터미널은 기본 계정만 씁니다. 다른 계정은 이 컴퓨터 방식(B_STUDIO_TERMINAL=host)에서 씁니다');
    return ensureAgentContainer(target.sandboxId, target.root, {
      projectId: target.projectId,
      ...(target.evaluationAssets ? { evaluationAssets: target.evaluationAssets } : {}),
      ...(gateway ? { gatewayDir: await writeAgentGatewayConfig(target.sandboxId, gateway) } : {}),
    });
  },
  open: (place, options) => openAgentTerminal(place, options),
  remove: (sandboxId) => removeContainerAndConfig(sandboxId),
  reachable: (place) => probeAgentGateway(place),
  unreachable: '컨테이너에서 b-studio에 닿지 못합니다. 이 도커 환경에서는 컨테이너가 이 컴퓨터의 루프백 주소(host.docker.internal)에 닿아야 세션 터미널을 쓸 수 있습니다',
  pause: (sandboxId) => pauseAgentContainer(sandboxId),
  unpause: (sandboxId) => unpauseAgentContainer(sandboxId),
};

/** 이 컴퓨터 방식에서 prepare가 쓴 관문. 감시(watch)가 폴더 경로를 열쇠로 꺼내 쓴다 */
interface HostGatewayWatch {
  address: AgentGatewayAddress;
  cli: HostCli;
  root: string;
  expected: Record<string, { content: string; mode: number }>;
}
// 개발 서버의 HMR로 모듈이 다시 로드돼도 기억한 관문을 잃지 않도록 전역에 둔다(터미널과 같은 이유)
const gatewayStore = globalThis as typeof globalThis & { __bStudioHostGateways?: Map<string, HostGatewayWatch> };
const hostGateways = (gatewayStore.__bStudioHostGateways ??= new Map());

/** 관문을 쓸 때 기억한 계정 폴더를 PTY 환경에도 둔다(#885). 감싸개가 같은 값을 CLI에 넘긴다 */
function hostAccountEnv(cli: HostCli | undefined): Record<string, string> {
  return cli?.configDir ? { [ACCOUNT_DIR_ENV[cli.kind]]: cli.configDir } : {};
}

const HOST_BACKEND: TerminalBackend = {
  prepare: async (target, gateway) => {
    // CLI를 먼저 찾는다. 못 찾으면 그 오류가 그대로 화면에 간다(터미널을 열어 놓고 "명령을 찾을 수 없음"을 보이지 않는다)
    const configDir = await target.accountDir?.();
    const found = await findHostCli(process.env, target.cli ?? 'claude');
    // 사용자의 Claude 상태 줄은 b-studio 상태 줄이 이어 부른다(#920). 읽기만 한다
    const statusLine = found.kind === 'claude' ? await userStatusLineCommand(configDir, undefined, target.root) : undefined;
    const cli = { ...found, ...(configDir ? { configDir } : {}), ...(statusLine ? { statusLine } : {}) };
    if (!gateway) return '';
    const root = defaultAgentGatewayRoot();
    const dir = await writeHostGatewayConfig(target.sandboxId, gateway, cli, root);
    // 감시가 꺼내 쓸 것을 폴더 경로로 기억한다. 기대 파일(내용·권한의 근거)을 여기서 한 번 만들어 두고 검사·복구에 쓴다
    hostGateways.set(dir, { address: gateway, cli, root, expected: expectedHostGatewayFiles(gateway, dir, cli) });
    return dir;
  },
  open: (place, options) =>
    openHostTerminal({
      id: options.id,
      size: options.size,
      cwd: options.target.root,
      gatewayDir: place || undefined,
      cli: options.target.cli ?? 'claude',
      accountEnv: hostAccountEnv(hostGateways.get(place)?.cli),
      ...(options.initialPrompt !== undefined ? { initialPrompt: options.initialPrompt } : {}),
      ...(options.resumeConversation !== undefined ? { resumeConversation: options.resumeConversation } : {}),
    }),
  acceptsInitialPrompt: true,
  acceptsResume: true,
  remove: (sandboxId) => removeHostGatewayConfig(sandboxId),
  reachable: (place) => probeHostGateway(place, process.execPath, hostGateways.get(place)?.cli.kind ?? 'claude'),
  unreachable: '이 컴퓨터에서 b-studio의 관문에 닿지 못합니다. 스튜디오를 다시 띄운 뒤 터미널을 다시 여세요',
  /**
   * 이 컴퓨터 방식에서는 CLI가 관문 파일을 고칠 수 있고, 셸에서 훅 없이 CLI를 직접 띄울 수 있다.
   * 미리 막을 수 없으니 관문 파일이 쓴 그대로인지 계속 보고, 훅 없이 뜬 CLI가 있으면 알린다(감지·복구)
   */
  watch: (place, terminal, target, report) => {
    // 관문 없이 연 터미널(place가 빈 값)은 감시하지 않는다
    if (!place) return () => {};
    const saved = hostGateways.get(place);
    // 개발 서버가 모듈을 다시 읽으면 기억한 관문이 비어 있을 수 있다. 조용히 넘어가면 감시가 꺼진 것을 모른다
    if (!saved) {
      report('관문 감시를 시작하지 못했습니다(기억한 관문이 없습니다). 터미널을 닫았다가 다시 여세요');
      return () => {};
    }
    const { address, cli, root, expected } = saved;
    const settingsPath = path.join(place, HOST_SETTINGS_FILE);
    // PTY의 pid. 이 아래에서 도는 프로세스 중 훅 없는 CLI를 찾는다(pid를 모르면 파일 검사만 한다)
    const rootPid = (terminal as AgentTerminal & { pid?: number }).pid;
    const warnedPids = new Set<number>();
    let stopped = false;
    let debounce: NodeJS.Timeout | undefined;
    let fileFailures = 0;
    let fileReported = false;
    let psFailures = 0;
    let psReported = false;
    let inFlight = false;
    let rerun = false;

    const inspect = async (): Promise<void> => {
      // 관문 파일 검사. 던지면 이 회차 파일 검사는 건너뛰되, 세 번 연달아 실패하면 감시가 조용히 꺼진 것처럼 보이지 않게 한 번 알린다
      let changed: string[] | undefined;
      try {
        changed = await checkHostGatewayConfig(place, expected);
        fileFailures = 0;
      } catch {
        fileFailures += 1;
        if (fileFailures >= 3 && !fileReported) {
          fileReported = true;
          report('관문 파일을 확인하지 못했습니다');
        }
      }
      if (changed && changed.length > 0) {
        // 쓴 그대로 되돌린다. 되돌리지 못하면 되돌렸다고 말하지 않는다(사유를 함께 남긴다)
        try {
          await writeHostGatewayConfig(target.sandboxId, address, cli, root);
          report(`관문 파일이 바뀌어 되돌렸습니다: ${changed.join(', ')}`);
        } catch (error) {
          report(`관문 파일이 바뀌었는데 되돌리지 못했습니다: ${changed.join(', ')} (${error instanceof Error ? error.message : String(error)})`);
        }
      }
      if (rootPid === undefined) return;
      let processes: ProcessEntry[];
      try {
        processes = await listProcesses();
      } catch {
        // 이번 회차는 건너뛴다. 세 번 연달아 실패하면 한 번 알린다
        psFailures += 1;
        if (psFailures >= 3 && !psReported) {
          psReported = true;
          report('터미널의 프로세스를 확인하지 못했습니다');
        }
        return;
      }
      psFailures = 0;
      for (const entry of findUnhookedCli(rootPid, processes, { settingsPath, cliPath: cli.cliPath, kind: cli.kind })) {
        // 같은 pid는 한 번만 알린다
        if (warnedPids.has(entry.pid)) continue;
        warnedPids.add(entry.pid);
        report(`검증이 붙지 않은 CLI가 터미널에서 돌고 있습니다(pid ${entry.pid}). 이 터미널의 ${cli.kind}는 b-studio가 붙여 주는 설정으로 띄워야 합니다`);
      }
    };

    // 주기 검사와 fs.watch 신호의 검사가 겹쳐 돌지 않게 한다. 돌고 있으면 끝난 뒤 한 번만 다시 돈다
    const check = async (): Promise<void> => {
      if (stopped) return;
      if (inFlight) {
        rerun = true;
        return;
      }
      inFlight = true;
      try {
        do {
          rerun = false;
          await inspect();
        } while (rerun && !stopped);
      } finally {
        inFlight = false;
      }
    };

    // fs.watch가 신호를 줄 때마다 곧바로 검사하지 않고 250ms로 모은다
    const schedule = (): void => {
      if (stopped) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void check(), HOST_WATCH_DEBOUNCE_MS);
    };
    // 관문 폴더와, 기대 파일이 놓인 폴더들(재귀 아님). 파일이 있는 자리에서 신호가 오게 한다
    const watchedDirs = new Set<string>([place]);
    for (const name of Object.keys(expected)) {
      const dir = path.dirname(name);
      if (dir && dir !== '.') watchedDirs.add(path.join(place, dir));
    }
    const watchers: Array<{ close(): void }> = [];
    for (const dir of watchedDirs) {
      try {
        watchers.push(watchFs(dir, schedule));
      } catch {
        // 폴더가 아직 없을 수 있다(주기 검사가 다음 회차에 잡는다)
      }
    }
    const timer = setInterval(() => void check(), HOST_WATCH_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
      if (debounce) clearTimeout(debounce);
      for (const watcher of watchers) {
        try {
          watcher.close();
        } catch {
          // 이미 닫혔다
        }
      }
      if (hostGateways.get(place) === saved) hostGateways.delete(place);
    };
  },
};

/** 지금 방식에 맞는 백엔드. 부를 때 정해진다 — 스튜디오를 다른 방식으로 띄우면 그 방식으로 연다 */
export function terminalBackend(mode: TerminalMode = sessionTerminalMode()): TerminalBackend {
  return mode === 'host' ? HOST_BACKEND : DOCKER_BACKEND;
}

/**
 * 검사 동안 에이전트 컨테이너를 멈추고 푸는 자리를 지금 백엔드에서 꺼낸다.
 * 두 메서드를 두지 않은 방식(이 컴퓨터)은 undefined다 — 멈출 컨테이너가 없다
 */
export function terminalPause(mode: TerminalMode = sessionTerminalMode(), backend: TerminalBackend = terminalBackend(mode)): TerminalPause | undefined {
  if (!backend.pause || !backend.unpause) return undefined;
  return { pause: (sandboxId) => backend.pause!(sandboxId), unpause: (sandboxId) => backend.unpause!(sandboxId) };
}

/**
 * 앞 방식이 남긴 찌꺼기(컨테이너, 토큰이 든 관문 설정)를 지운다. 스튜디오를 다른 방식으로 다시 띄웠을 때 두 방식을 모두 치운다.
 * 한쪽이 실패해도 다른 쪽을 부른다
 */
export async function removeTerminalLeftovers(sandboxId: string, backends: readonly TerminalBackend[] = [DOCKER_BACKEND, HOST_BACKEND]): Promise<void> {
  await Promise.allSettled(backends.map((backend) => backend.remove(sandboxId)));
}

// 개발 서버의 HMR로 모듈이 다시 로드돼도 열린 터미널을 잃지 않도록 전역에 둔다
const globalStore = globalThis as typeof globalThis & { __bStudioTerminals?: Map<string, TerminalState> };
const terminals = (globalStore.__bStudioTerminals ??= new Map());

/** 세션마다 상태는 하나다. 구독이 먼저 오든 열기가 먼저 오든 같은 것을 쓴다 */
function stateFor(sessionId: string): TerminalState {
  let state = terminals.get(sessionId);
  if (!state) {
    state = { sandboxId: '', chunks: [], bytes: 0, listeners: new Set(), size: clampTerminalSize({}), cli: false };
    terminals.set(sessionId, state);
  }
  return state;
}

function emit(state: TerminalState, message: TerminalMessage): void {
  for (const listener of state.listeners) {
    try {
      listener(message);
    } catch {
      // 구독자 하나의 오류가 다른 구독자에게 번지지 않게 한다
    }
  }
}

function remember(state: TerminalState, chunk: Buffer): void {
  state.chunks.push(chunk);
  state.bytes += chunk.length;
  while (state.bytes > REPLAY_BYTES && state.chunks.length > 1) state.bytes -= state.chunks.shift()!.length;
}

/**
 * 세션의 터미널을 연다. 이미 열려 있으면 크기만 맞추고 그대로 쓴다. 동시에 여러 번 불려도 컨테이너와 터미널은 하나만 만든다.
 * 컨테이너를 띄우거나 `.git` 보호를 확인하지 못하면 던지고, 그 사유를 연결된 화면에도 알린다.
 * initialPrompt(#836)는 이 부름이 터미널을 새로 열고 백엔드가 받을 때만 CLI 실행 인자로 넘긴다. 넘겼는지를 돌려준다
 * (이미 열려 있었거나, 다른 부름이 여는 중이었거나, 받지 않는 백엔드면 false)
 */
export async function openSessionTerminal(
  sessionId: string,
  target: TerminalTarget,
  size: { cols?: unknown; rows?: unknown },
  backend: TerminalBackend = terminalBackend(),
  options: { initialPrompt?: string } = {},
): Promise<{ initialPromptUsed: boolean }> {
  const wanted = clampTerminalSize(size);
  const state = stateFor(sessionId);
  // 세션을 다시 열어 샌드박스가 바뀌었으면 옛 터미널은 옛 컨테이너의 것이다. 터미널과 컨테이너만 정리하고,
  // 붙어 있는 화면(구독자)은 그대로 둔다 — 화면은 출력 통로를 먼저 열고 그다음에 "열기"를 보낸다
  if (state.sandboxId && state.sandboxId !== target.sandboxId) {
    closeSessionTerminal(sessionId);
    await backend.remove(state.sandboxId).catch(() => {});
    state.chunks = [];
    state.bytes = 0;
    state.opened = false;
  }
  state.sandboxId = target.sandboxId;
  if (state.terminal) {
    state.size = wanted;
    await state.terminal.resize(wanted);
    return { initialPromptUsed: false };
  }
  const current = state;
  if (current.opening) {
    await current.opening;
    return { initialPromptUsed: false };
  }
  const initialPrompt = backend.acceptsInitialPrompt === true ? options.initialPrompt : undefined;
  // 지난 대화는 이 스튜디오에서 이 샌드박스의 터미널을 처음 열 때만 이어 붙인다(스튜디오를 다시 띄웠거나 이어서 작업한 뒤). 첫 요청이 있으면 새 대화다(#872)
  const resumeConversation = backend.acceptsResume === true && initialPrompt === undefined && !current.opened ? target.resumeConversation?.() : undefined;
  current.opening = (async () => {
    emit(current, { kind: 'status', state: 'opening' });
    try {
      if (target.alive && !target.alive()) throw new Error('세션이 멈췄습니다');
      // 관문을 먼저 띄운다. 터미널 안의 CLI는 뜨자마자 훅을 부른다
      const gateway = target.gateway ? await target.gateway() : undefined;
      const place = await backend.prepare(target, gateway);
      // 자리를 준비하는 동안 세션이 멈췄으면 방금 만든 것을 지우고 열지 않는다
      if (target.alive && !target.alive()) {
        await backend.remove(target.sandboxId).catch(() => {});
        throw new Error('세션이 멈췄습니다');
      }
      // 관문에 닿지 못하면 열지 않는다. 관문 없이 열어 주면 그 터미널의 변경은 검증 없이 쌓이고,
      // "닿지 못하게 만들기"가 곧 검증을 끄는 방법이 된다
      if (gateway && !(await backend.reachable(place))) {
        throw new Error(backend.unreachable);
      }
      const terminal = await backend.open(place, {
        id: TERMINAL_ID,
        size: wanted,
        target,
        ...(initialPrompt !== undefined ? { initialPrompt } : {}),
        ...(resumeConversation !== undefined ? { resumeConversation } : {}),
      });
      current.terminal = terminal;
      current.opened = true;
      current.size = wanted;
      current.chunks = [];
      current.bytes = 0;
      terminal.onData((chunk) => {
        remember(current, chunk);
        emit(current, { kind: 'data', data: chunk.toString('base64') });
      });
      terminal.onExit((code) => {
        // 닫고 새로 연 뒤에 옛 프로세스의 종료가 늦게 와도 새 터미널을 지우지 않는다
        if (current.terminal !== terminal) return;
        current.terminal = undefined;
        stopWatching(current);
        setCli(current, false);
        emit(current, { kind: 'exit', code });
      });
      // 관문 파일 변조와 훅 없이 뜬 CLI를 감시한다. 찾으면 화면에 경고를 보내고 세션에 알린다(이슈 #695)
      if (backend.watch) {
        current.watchStop = backend.watch(place, terminal, target, (reason) => {
          emit(current, { kind: 'warning', message: reason });
          target.onViolation?.(reason);
        });
      }
      emit(current, { kind: 'status', state: 'open' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit(current, { kind: 'status', state: 'closed', message });
      throw new StudioError(502, `터미널을 열지 못했습니다: ${message}`);
    } finally {
      current.opening = undefined;
    }
  })();
  await current.opening;
  return { initialPromptUsed: initialPrompt !== undefined };
}

/** 구독하면 최근 출력과 지금 상태를 곧바로 받는다. 돌려준 함수로 구독을 푼다 */
export function subscribeSessionTerminal(sessionId: string, listener: Listener): () => void {
  // 아직 열지 않은 터미널도 구독해 둔다. 뒤따르는 "열기"가 같은 상태를 쓰므로 그 출력을 받는다
  const state = stateFor(sessionId);
  state.listeners.add(listener);
  if (state.chunks.length > 0) listener({ kind: 'data', data: Buffer.concat(state.chunks).toString('base64') });
  listener({ kind: 'status', state: state.terminal ? 'open' : state.opening ? 'opening' : 'closed' });
  listener({ kind: 'cli', alive: state.cli });
  return () => unsubscribe(sessionId, state, listener);
}

function setCli(state: TerminalState, alive: boolean): void {
  if (state.cli === alive) return;
  state.cli = alive;
  emit(state, { kind: 'cli', alive });
  // desk 사이드바의 CLI 표시가 바로 바뀌게 목록 통로(#923)에 알린다
  notifyAgentsChanged();
}

/**
 * 에이전트 CLI가 떴다·끝났다(관문의 세션 시작·끝 훅이 부른다). 터미널이 열려 있지 않으면 떴다는 알림은 받지 않는다 —
 * 닫힌 터미널에 "떠 있음"이 남으면 다음에 연 터미널(셸)에 글이 붙는다
 */
export function noteSessionTerminalCli(sessionId: string, alive: boolean): void {
  const state = terminals.get(sessionId);
  if (!state) return;
  setCli(state, alive && state.terminal !== undefined);
}

/** 이 프로세스에서 세션 터미널을 연 적이 있으면 그 CLI가 떠 있는지(studio desk 사이드바, #835). 연 적이 없으면 없다 */
export function sessionTerminalPresence(sessionId: string): { cliAlive: boolean } | undefined {
  const state = terminals.get(sessionId);
  return state ? { cliAlive: state.cli } : undefined;
}

/** 터미널 안에 에이전트 CLI가 떠 있는가. 열린 적 없는 세션이면 없다(거짓) */
export function sessionTerminalCliAlive(sessionId: string): boolean {
  return terminals.get(sessionId)?.cli ?? false;
}

/**
 * 터미널 패널의 경고 줄에 한 줄 보낸다(그 세션의 터미널이 화면에 열려 있을 때만). 감시가 찾은 위반과 같은 길이다.
 * 정체 알림처럼 세션 쪽에서 보내는 경고에 쓴다. 다시 연결한 화면에는 되풀이하지 않는다(마지막 경고를 저장하지 않는다)
 */
export function warnSessionTerminal(sessionId: string, message: string): void {
  const state = terminals.get(sessionId);
  if (!state) return;
  emit(state, { kind: 'warning', message });
}

function unsubscribe(sessionId: string, state: TerminalState, listener: Listener): void {
  state.listeners.delete(listener);
  // 열린 적 없는 빈 자리만 치운다. 열린 터미널은 화면이 닫혀도 살아 있다
  if (state.listeners.size === 0 && !state.terminal && !state.opening && state.chunks.length === 0 && terminals.get(sessionId) === state) terminals.delete(sessionId);
}

export function writeSessionTerminal(sessionId: string, data: string): void {
  if (Buffer.byteLength(data, 'utf8') > MAX_TERMINAL_INPUT) throw new StudioError(413, '터미널 입력이 너무 깁니다');
  const terminal = terminals.get(sessionId)?.terminal;
  if (!terminal) throw new StudioError(409, '터미널이 열려 있지 않습니다');
  terminal.write(data);
}

/**
 * 터미널 안의 CLI에 하던 일을 멈추라고 알린다(Esc). 화면에서 실행을 취소했을 때 쓴다.
 * 터미널이 없으면 아무 일도 하지 않는다. CLI가 아니라 셸이 떠 있으면 Esc는 아무 일도 하지 않는다
 */
export function interruptSessionTerminal(sessionId: string): void {
  terminals.get(sessionId)?.terminal?.write('\x1b');
}

export async function resizeSessionTerminal(sessionId: string, size: { cols?: unknown; rows?: unknown }): Promise<void> {
  const state = terminals.get(sessionId);
  if (!state?.terminal) return;
  state.size = clampTerminalSize(size);
  await state.terminal.resize(state.size);
}

/** 열려 있는 터미널의 감시를 멈춘다. 여러 번 불려도 안전하다(멈춤 함수를 한 번만 부른다) */
function stopWatching(state: TerminalState): void {
  const stop = state.watchStop;
  state.watchStop = undefined;
  if (!stop) return;
  try {
    stop();
  } catch {
    // 감시를 멈추지 못해도 터미널 정리를 막지 않는다
  }
}

/** 터미널만 닫는다. 컨테이너는 남는다(다시 열면 바로 붙는다) */
export function closeSessionTerminal(sessionId: string): void {
  const state = terminals.get(sessionId);
  if (!state?.terminal) return;
  const terminal = state.terminal;
  state.terminal = undefined;
  stopWatching(state);
  terminal.close();
  setCli(state, false);
  emit(state, { kind: 'status', state: 'closed' });
}

/** 세션이 멈출 때 부른다. 터미널을 닫고 컨테이너를 지운다. 열린 적이 없어도 컨테이너가 남아 있을 수 있어 지우기는 늘 한다 */
export async function disposeSessionTerminal(sessionId: string, sandboxId: string, backend: TerminalBackend = terminalBackend()): Promise<void> {
  // 열고 있는 중이면 끝나기를 기다린 뒤에 닫는다. 기다리지 않으면 지운 뒤에 컨테이너와 터미널이 생긴다
  await terminals.get(sessionId)?.opening?.catch(() => {});
  // 터미널이 없어도 감시가 남아 있으면 멈춘다(감시를 멈추지 않고 남기는 길이 없게 한다)
  const state = terminals.get(sessionId);
  if (state) stopWatching(state);
  closeSessionTerminal(sessionId);
  terminals.delete(sessionId);
  await backend.remove(sandboxId).catch(() => {});
}
