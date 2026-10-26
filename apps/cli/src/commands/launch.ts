import { execFile, spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, openSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** launch가 띄울 수 있는 모드. local은 개인 PC의 Claude Code 로그인(B_STUDIO_MODE=claude-code)을 쓴다 */
export type LaunchMode = 'local' | 'demo' | 'commandcode' | 'codex';

export const LAUNCH_MODES: readonly LaunchMode[] = ['local', 'demo', 'commandcode', 'codex'];

/** 모드 → B_STUDIO_MODE 값. local은 README의 studio:local과 같게 claude-code를 쓴다 */
export const MODE_ENV: Record<LaunchMode, string> = { local: 'claude-code', demo: 'demo', commandcode: 'commandcode', codex: 'codex' };

/** 이미 떠 있는지 확인할 때 `/api/health` 본문의 `app`에 있어야 하는 b-studio 표지 */
export const STUDIO_MARKER = 'b-studio';

/** 떠 있는지·준비됐는지 보는 경로. 응답 본문의 `app`이 b-studio 표지다. 스튜디오에는 화면이 없다(ADR-186) */
export const HEALTH_PATH = '/api/health';

const READY_TIMEOUT_MS = 90_000;
const READY_INTERVAL_MS = 1_000;
const LOG_TAIL_LINES = 20;

/**
 * 중첩 라우트가 살아 있는지 확인하는 경로(`app/api/health/routes/route.ts`). 오래 켜둔 dev 서버가
 * 병합을 여러 번 겪으면 최상위 라우트(`/`, `/api/health`)는 응답해도 이 라우트는 스테일한 라우트 표 때문에
 * HTML 404를 돌려주는 경우가 있었다 — 그 차이로 "이미 떠 있는 서버"가 재시작이 필요한지를 가른다.
 */
const NESTED_HEALTH_PATH = '/api/health/routes';
/** 스테일한 서버를 죽인 뒤 포트가 풀릴 때까지 기다리는 한도·간격 */
const EXIT_WAIT_TIMEOUT_MS = 5_000;
const EXIT_WAIT_INTERVAL_MS = 200;

export interface ProbeResult {
  /** 응답을 받았는지(상태 코드와 무관) */
  reachable: boolean;
  /** HTTP 상태 코드(응답을 못 받았으면 0) */
  status: number;
  body: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * `studio launch`가 쓰는 바깥 세계. 테스트는 이걸 바꿔 끼워 colima를 켜거나 스튜디오를 실제로 띄우지 않는다.
 */
export interface LaunchDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** 저장소 루트. 여기서 스튜디오 서버를 띄운다 */
  repoRoot: string;
  /** 로그·PID 파일 경로 */
  paths: { log: string; pid: string };
  /** http 확인 */
  probe: (url: string) => Promise<ProbeResult>;
  /** 준비 확인 사이의 지연 */
  sleep: (ms: number) => Promise<void>;
  /** 명령을 실행하고 출력을 모은다 (docker info·colima) */
  exec: (command: string, args: readonly string[]) => Promise<ExecResult>;
  /** 분리된 자식 프로세스를 띄운다(부모가 끝나도 살아 있게). stdout·stderr는 logPath로 보낸다 */
  spawn: (command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; logPath: string }) => { pid: number | undefined };
  /** pid가 살아 있는지(스테일한 서버를 죽이기 전에 확인한다) */
  isAlive: (pid: number) => boolean;
  /** 분리해 띄운 프로세스 그룹에 신호를 보낸다(`studio stop`과 같은 방식) */
  killGroup: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * 지금 pnpm-lock.yaml의 해시. 읽을 수 없으면(예: 테스트의 가짜 repoRoot) undefined를 돌려주고,
   * 그러면 의존성 확인 단계를 건너뛴다 — 실제 저장소에는 항상 pnpm-lock.yaml이 있다
   */
  lockfileHash: () => Promise<string | undefined>;
  /** 마지막으로 `pnpm install`을 성공시킨 시점의 lockfileHash. 적힌 적 없으면 undefined */
  readInstallMarker: () => Promise<string | undefined>;
  /** `pnpm install`이 성공한 뒤 지금 해시를 적어 둔다(다음 launch가 다시 설치하지 않게) */
  writeInstallMarker: (hash: string) => Promise<void>;
  readyTimeoutMs?: number;
  readyIntervalMs?: number;
  /**
   * 사람에게 예/아니오를 묻는다(#943). 터미널이 아니면(파이프·CI·에이전트) 없다 — 그때는 묻지 않고 바깥 상태를 바꾸는 일(colima start)을 하지 않는다
   */
  ask?: (question: string) => Promise<boolean>;
}

export interface LaunchOptions {
  mode: LaunchMode;
  port: number;
  /** 새로 띄울 때 서버 환경에 채울 값. 사용자가 이미 정한 변수는 덮어쓰지 않는다 */
  serverEnv?: Record<string, string>;
  /** 새로 띄운 서버를 기다리는 동안 확인할 때마다 지난 시간(ms)을 알린다(진행 표시용) */
  onWaiting?: (elapsedMs: number) => void;
}

/** 요청에 쓰는 주소(경로 포함) */
export function studioUrl(port: number): string {
  return `${studioOrigin(port)}/`;
}

/** 스튜디오 주소(끝 슬래시 없음). 터미널 작업대가 붙는 곳이다 */
export function studioOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** `/api/health` 본문에 b-studio 표지(`app`)가 있는지 */
export function isBStudioHealth(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { app?: unknown } | null;
    return parsed?.app === STUDIO_MARKER;
  } catch {
    return false;
  }
}

/**
 * `studio launch`가 부르는 pnpm 인자(저장소 루트에서 부른다). 순수 함수라 테스트로 확인한다.
 * Next 없이 도는 API 서버(apps/studio/server, tsx로 바로 돈다)만 띄운다. 화면이 없어 next dev 길은 두지 않는다(ADR-186, ADR-188)
 */
export function launchArgs(port: number): string[] {
  return ['exec', 'tsx', '--tsconfig', 'apps/studio/tsconfig.json', 'apps/studio/server/main.ts', '--hostname', '127.0.0.1', '--port', String(port)];
}

/**
 * 스튜디오를 화면 없이 뒤에서 띄운다. 이미 떠 있으면 재사용하고, Docker가 꺼져 있으면 물어서 colima를 켠다(묻지 못하면 켜는 법만 알린다).
 * 브라우저는 열지 않는다(화면은 터미널 작업대뿐, ADR-186). 실패하면 로그 끝을 보여 주고 종료 코드 1.
 */
export async function runLaunch(options: LaunchOptions, deps: LaunchDeps): Promise<number> {
  const url = studioUrl(options.port);
  const origin = studioOrigin(options.port);
  const envMode = MODE_ENV[options.mode];
  const info = (text: string) => console.log(text);

  // 1. 이미 떠 있나 — 새로 띄우지 않고 재사용한다. 단, 중첩 라우트 표가 스테일하면(아래) 재시작한다.
  // 헬스의 표지로 알아본다(화면이 없으니 첫 화면은 보지 않는다)
  const existing = await deps.probe(`${origin}${HEALTH_PATH}`);
  if (existing.reachable) {
    if (!isBStudioHealth(existing.body)) {
      console.error(`포트 ${options.port}에 다른 프로그램이 응답합니다. --port로 다른 포트를 지정하세요.`);
      return 1;
    }
    const stored = await readPidFile(deps.paths.pid, envMode);
    // 오래 켜둔 dev 서버는 병합을 여러 번 겪으면 최상위 라우트는 응답해도 중첩 라우트 표가 스테일해질 수 있다.
    // 그러면 여기서 재사용하지 않고 죽인 뒤 2·3단계로 내려가 새로 띄운다
    const nested = await deps.probe(`${origin}${NESTED_HEALTH_PATH}`);
    const stale = !nested.reachable || nested.status !== 200;
    if (!stale) {
      info(`이미 스튜디오가 ${url}에서 실행 중입니다 (모드 ${stored.mode}).`);
      finish(info);
      return 0;
    }
    info(`스튜디오가 떠 있지만 라우트 표가 오래된 것 같아 다시 켭니다 (포트 ${options.port}).`);
    if (stored.pid !== null && deps.isAlive(stored.pid)) {
      try {
        deps.killGroup(stored.pid, 'SIGTERM');
      } catch (error) {
        console.error(`스테일한 서버(PID ${stored.pid})를 멈추지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      await waitForExit(deps, stored.pid);
    }
    // 여기서 return하지 않고 2·3단계(Docker 확인 → 새로 띄우기)로 이어진다
  }

  // 2. Docker — 이미 켜져 있으면 건드리지 않는다
  const docker = await deps.exec('docker', ['info']);
  if (docker.code !== 0) {
    const colima = await deps.exec('colima', ['version']);
    if (colima.code !== 0) {
      console.error('Docker를 켤 수 없습니다. Docker Desktop이나 colima를 켜세요(colima가 있으면 `colima start`).');
      return 1;
    }
    // colima start는 VM을 켜거나(처음이면) 새로 만든다. 다른 프로젝트와 함께 쓰는 VM이라 묻고 켠다(#943).
    // 물을 수 없으면(터미널이 아님) 켜지 않고 켜는 법만 알린다 — HOME이 다른 환경에서 새 VM을 만들려 한 적이 있다
    const agreed = deps.ask ? await deps.ask('Docker가 꺼져 있습니다. colima를 켤까요? (colima start)') : false;
    if (!agreed) {
      console.error('Docker가 꺼져 있습니다. `colima start`(또는 Docker Desktop)로 켠 뒤 다시 실행하세요.');
      return 1;
    }
    info('colima를 시작합니다… (colima start)');
    const started = await deps.exec('colima', ['start']);
    if (started.stdout.trim()) info(started.stdout.trimEnd());
    if (started.stderr.trim()) console.error(started.stderr.trimEnd());
    if (started.code !== 0) {
      console.error('colima start가 실패했습니다. 위 출력을 확인하세요.');
      return 1;
    }
  }

  // 3. 의존성 — pnpm-lock.yaml이 마지막으로 설치를 끝냈을 때와 달라졌으면 먼저 설치한다.
  // git pull로 새 의존성이 들어와도 아무도 pnpm install을 불러 주지 않아서, 안 그러면 Next.js가
  // "Module not found" 오류 화면을 띄운 채로 서버가 뜬다
  const lockHash = await deps.lockfileHash();
  if (lockHash !== undefined && lockHash !== (await deps.readInstallMarker())) {
    info('pnpm-lock.yaml이 바뀌어 의존성을 설치합니다… (pnpm install)');
    const install = await deps.exec('pnpm', ['install', '--frozen-lockfile', '--prefer-offline']);
    if (install.stdout.trim()) info(install.stdout.trimEnd());
    if (install.stderr.trim()) console.error(install.stderr.trimEnd());
    if (install.code !== 0) {
      console.error('pnpm install이 실패했습니다. 깨진 서버를 띄우지 않고 멈춥니다. 위 출력을 확인하세요.');
      return 1;
    }
    await deps.writeInstallMarker(lockHash);
  }

  // 4. 띄우기 — 부모가 끝나도 살아 있게 분리하고, 로그·PID를 남긴다
  await mkdir(path.dirname(deps.paths.pid), { recursive: true });
  const env = { ...withDefaults(deps.env, options.serverEnv), B_STUDIO_MODE: envMode };
  const child = deps.spawn('pnpm', launchArgs(options.port), { cwd: deps.repoRoot, env, logPath: deps.paths.log });
  await writeFile(deps.paths.pid, `${JSON.stringify({ pid: child.pid, port: options.port, mode: options.mode }, null, 2)}\n`, { mode: 0o600 });
  info(`스튜디오를 시작합니다 (모드 ${options.mode}, 포트 ${options.port}, 로그 ${deps.paths.log})`);

  // 5. 준비 확인 — 최대 90초, 1초 간격
  const timeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const intervalMs = deps.readyIntervalMs ?? READY_INTERVAL_MS;
  const ready = await waitForReady(deps, `${origin}${HEALTH_PATH}`, timeoutMs, intervalMs, options.onWaiting);
  if (!ready) {
    console.error(`스튜디오가 ${Math.round(timeoutMs / 1_000)}초 안에 응답하지 않았습니다. 로그 끝 ${LOG_TAIL_LINES}줄:`);
    for (const line of await tailLog(deps.paths.log, LOG_TAIL_LINES)) console.error(`  ${line}`);
    console.error(`전체 로그: ${deps.paths.log}`);
    return 1;
  }

  // 6. 안내
  info(`스튜디오가 떴습니다: ${url}`);
  info(`종료: pnpm studio stop · 로그: ${deps.paths.log}`);
  finish(info);
  return 0;
}

/** 다음에 할 일을 알린다. 토큰은 찍지 않는다(터미널 기록에 남는다) */
function finish(info: (text: string) => void): void {
  info('터미널 작업대: pnpm studio desk');
}

/** base에 없는(또는 빈) 변수만 defaults로 채운다 */
function withDefaults(base: NodeJS.ProcessEnv, defaults: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [key, value] of Object.entries(defaults ?? {})) {
    if (!env[key]?.trim()) env[key] = value;
  }
  return env;
}

/** PID 파일에서 pid와 CLI 모드를 읽는다. 없거나 깨졌으면 pid=null, mode=요청한 모드의 B_STUDIO_MODE 값 */
async function readPidFile(file: string, fallbackMode: string): Promise<{ pid: number | null; mode: string }> {
  const raw = await readFile(file, 'utf8').catch(() => undefined);
  if (raw === undefined) return { pid: null, mode: fallbackMode };
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; mode?: unknown };
    const pid = typeof parsed.pid === 'number' ? parsed.pid : null;
    const mode = typeof parsed.mode === 'string' ? (MODE_ENV[parsed.mode as LaunchMode] ?? parsed.mode) : fallbackMode;
    return { pid, mode };
  } catch {
    return { pid: null, mode: fallbackMode };
  }
}

/** 헬스가 200을 돌려줄 때까지 기다린다. 응답이 와도 200이 아니면(아직 컴파일 중인 오류 화면 등) 더 기다린다 */
async function waitForReady(deps: LaunchDeps, url: string, timeoutMs: number, intervalMs: number, onWaiting?: (elapsedMs: number) => void): Promise<boolean> {
  for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
    if (waited > 0) await deps.sleep(intervalMs);
    onWaiting?.(waited);
    const result = await deps.probe(url);
    if (result.reachable && result.status === 200) return true;
  }
  return false;
}

/** 스테일한 서버에 SIGTERM을 보낸 뒤 포트가 풀릴 때까지(프로세스가 죽을 때까지) 잠깐 기다린다 */
async function waitForExit(deps: LaunchDeps, pid: number): Promise<void> {
  for (let waited = 0; waited < EXIT_WAIT_TIMEOUT_MS && deps.isAlive(pid); waited += EXIT_WAIT_INTERVAL_MS) {
    await deps.sleep(EXIT_WAIT_INTERVAL_MS);
  }
}

async function tailLog(file: string, lines: number): Promise<string[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line.length > 0).slice(-lines);
}

async function realProbe(url: string): Promise<ProbeResult> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    return { reachable: true, status: response.status, body: await response.text().catch(() => '') };
  } catch {
    return { reachable: false, status: 0, body: '' };
  }
}

function realExec(command: string, args: readonly string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, [...args], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/**
 * launch가 남기는 로그 파일을 연다. 없으면 0600으로 만들고, 이미 있으면 권한을 0600으로 조인다 —
 * 개발 서버가 요청 주소를 쿼리까지 찍으므로, 그 로그는 이 사용자만 읽을 수 있어야 한다
 * (같은 컴퓨터의 다른 사용자 계정도 읽을 수 있으면 토큰이 막으려던 상대에게 그대로 열린다)
 */
export function openLaunchLog(file: string): number {
  const fd = openSync(file, 'a', 0o600);
  try {
    chmodSync(file, 0o600);
  } catch {
    // 권한을 조이지 못해도 로그를 남기는 것은 막지 않는다
  }
  return fd;
}

function realSpawn(command: string, args: readonly string[], { cwd, env, logPath }: { cwd: string; env: NodeJS.ProcessEnv; logPath: string }): { pid: number | undefined } {
  // 로그 파일을 열어 자식의 stdout·stderr로 넘긴다. 부모는 곧 끝나므로 연 fd는 바로 닫는다(자식은 복사본을 갖는다)
  const log = openLaunchLog(logPath);
  try {
    const child = spawnProcess(command, [...args], { cwd, env, detached: true, stdio: ['ignore', log, log] });
    child.unref();
    return { pid: child.pid };
  } finally {
    closeSync(log);
  }
}

/** 저장소 루트의 pnpm-lock.yaml 해시. 파일이 없으면(가짜 repoRoot 등) undefined */
async function realLockfileHash(repoRoot: string): Promise<string | undefined> {
  try {
    const content = await readFile(path.join(repoRoot, 'pnpm-lock.yaml'));
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return undefined;
  }
}

/** 마지막 설치 표지 파일. 없으면(한 번도 설치한 적 없음) undefined */
async function realReadInstallMarker(file: string): Promise<string | undefined> {
  const raw = await readFile(file, 'utf8').catch(() => undefined);
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

async function realWriteInstallMarker(file: string, hash: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${hash}\n`, { mode: 0o600 });
}

/** 실제 환경에서 도는 launch deps */
export function createLaunchDeps(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): LaunchDeps {
  const launchDir = path.join(env.HOME ?? homedir(), '.cache', 'b-studio', 'launch');
  const repoRoot = path.resolve(import.meta.dirname, '../../../..');
  const installMarker = path.join(launchDir, 'install.hash');
  return {
    platform,
    env,
    repoRoot,
    paths: { log: path.join(launchDir, 'studio.log'), pid: path.join(launchDir, 'studio.pid') },
    probe: realProbe,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    exec: realExec,
    spawn: realSpawn,
    lockfileHash: () => realLockfileHash(repoRoot),
    readInstallMarker: () => realReadInstallMarker(installMarker),
    writeInstallMarker: (hash) => realWriteInstallMarker(installMarker, hash),
    // `studio stop`과 같은 방식: 살아 있는지는 신호 0으로, 죽이기는 프로세스 그룹(-pid)으로
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    killGroup: (pid, signal) => {
      process.kill(-pid, signal);
    },
    // 입력과 출력이 모두 터미널일 때만 묻는다(#943)
    ...(process.stdin.isTTY && process.stderr.isTTY ? { ask: askYesNo } : {}),
  };
}

/** 터미널에서 예/아니오를 묻는다. 빈 답은 예다 */
async function askYesNo(question: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await prompt.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes' || answer === '예' || answer === 'ㅛ';
  } finally {
    prompt.close();
  }
}

/** CLI 진입점. 실제 deps로 runLaunch를 부른다 */
export function launch(options: LaunchOptions): Promise<number> {
  return runLaunch(options, createLaunchDeps());
}
