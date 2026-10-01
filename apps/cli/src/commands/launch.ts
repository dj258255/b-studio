import { execFile, spawn as spawnProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** launch가 띄울 수 있는 모드. local은 개인 PC의 Claude Code 로그인(B_STUDIO_MODE=claude-code)을 쓴다 */
export type LaunchMode = 'local' | 'demo' | 'commandcode' | 'codex';

export const LAUNCH_MODES: readonly LaunchMode[] = ['local', 'demo', 'commandcode', 'codex'];

/** 모드 → B_STUDIO_MODE 값. local은 README의 studio:local과 같게 claude-code를 쓴다 */
export const MODE_ENV: Record<LaunchMode, string> = { local: 'claude-code', demo: 'demo', commandcode: 'commandcode', codex: 'codex' };

/** 이미 떠 있는지 확인할 때 응답 본문에 있어야 하는 b-studio 표지 */
export const STUDIO_MARKER = 'b-studio';

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
  /** 저장소 루트. 여기서 next dev를 띄운다 */
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
  /** 브라우저 열기 */
  open: (url: string) => Promise<void>;
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
}

export interface LaunchOptions {
  mode: LaunchMode;
  port: number;
  /** 브라우저를 연다. false면 주소만 출력한다 */
  open: boolean;
  /** true면 브라우저를 열지 않고, 준비되면 stdout에 한 줄 JSON만 쓴다(진행 안내는 stderr). Electron 앱이 이 출력을 읽는다 */
  json?: boolean;
}

/** `launch --json`이 stdout에 쓰는 한 줄. Electron 앱이 기대는 계약이라 테스트로 고정한다 */
export interface LaunchResult {
  url: string;
  port: number;
  /** B_STUDIO_MODE 값(예: claude-code) */
  mode: string;
  /** 이번에 띄운 프로세스의 PID. 이미 떠 있었고 PID 파일도 없으면 null */
  pid: number | null;
  /** 이번에 새로 띄웠으면 true, 이미 떠 있었으면 false */
  started: boolean;
}

export function launchResultJson(result: LaunchResult): string {
  return JSON.stringify(result);
}

/** 요청에 쓰는 주소(경로 포함) */
export function studioUrl(port: number): string {
  return `${studioOrigin(port)}/`;
}

/** `--json`이 내보내는 주소(끝 슬래시 없음). Electron 앱이 기대는 계약이다 */
export function studioOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** 응답 본문이 b-studio인지. 아니면 다른 프로그램이 그 포트를 쓰는 것이다 */
export function isBStudio(body: string): boolean {
  return body.includes(STUDIO_MARKER);
}

/** 더블클릭 앱·`studio launch`가 부르는 명령 인자. 순수 함수라 테스트로 확인한다 */
export function launchArgs(port: number): string[] {
  return ['--filter', '@b-studio/studio', 'exec', 'next', 'dev', '--hostname', '127.0.0.1', '-p', String(port)];
}

/**
 * 스튜디오를 띄운다. 이미 떠 있으면 브라우저만 열고, Docker가 꺼져 있으면 colima를 켠다.
 * 준비되면 브라우저를 열고, 실패하면 로그 끝을 보여 주고 종료 코드 1.
 */
export async function runLaunch(options: LaunchOptions, deps: LaunchDeps): Promise<number> {
  const url = studioUrl(options.port);
  const origin = studioOrigin(options.port);
  const json = options.json === true;
  // --json이면 브라우저를 열지 않는다(--no-open 포함)
  const open = options.open && !json;
  const envMode = MODE_ENV[options.mode];
  // 진행 안내는 --json일 때 stderr로 보낸다. stdout에는 JSON 한 줄만 남긴다
  const info = (text: string) => (json ? console.error(text) : console.log(text));

  // 1. 이미 떠 있나 — 새로 띄우지 않고 브라우저만 연다. 단, 중첩 라우트 표가 스테일하면(아래) 재시작한다
  const existing = await deps.probe(url);
  if (existing.reachable) {
    if (!isBStudio(existing.body)) {
      console.error(`포트 ${options.port}에 다른 프로그램이 응답합니다. --port로 다른 포트를 지정하세요.`);
      return 1;
    }
    const stored = await readPidFile(deps.paths.pid, envMode);
    // 오래 켜둔 dev 서버는 병합을 여러 번 겪으면 최상위 라우트는 응답해도 중첩 라우트 표가 스테일해질 수 있다.
    // 그러면 여기서 재사용하지 않고 죽인 뒤 2·3단계로 내려가 새로 띄운다
    const nested = await deps.probe(`${origin}${NESTED_HEALTH_PATH}`);
    const stale = !nested.reachable || nested.status !== 200;
    if (!stale) {
      if (json) {
        console.log(launchResultJson({ url: origin, port: options.port, mode: stored.mode, pid: stored.pid, started: false }));
        return 0;
      }
      info(`이미 스튜디오가 ${url}에서 실행 중입니다.`);
      if (open) await deps.open(url);
      else info(url);
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
    info('Docker가 꺼져 있어 colima를 시작합니다… (colima start)');
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
  const env = { ...deps.env, B_STUDIO_MODE: envMode };
  const child = deps.spawn('pnpm', launchArgs(options.port), { cwd: deps.repoRoot, env, logPath: deps.paths.log });
  await writeFile(deps.paths.pid, `${JSON.stringify({ pid: child.pid, port: options.port, mode: options.mode }, null, 2)}\n`, { mode: 0o600 });
  info(`스튜디오를 시작합니다 (모드 ${options.mode}, 포트 ${options.port}, 로그 ${deps.paths.log})`);

  // 5. 준비 확인 — 최대 90초, 1초 간격
  const timeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const intervalMs = deps.readyIntervalMs ?? READY_INTERVAL_MS;
  const ready = await waitForReady(deps, url, timeoutMs, intervalMs);
  if (!ready) {
    console.error(`스튜디오가 ${Math.round(timeoutMs / 1_000)}초 안에 응답하지 않았습니다. 로그 끝 ${LOG_TAIL_LINES}줄:`);
    for (const line of await tailLog(deps.paths.log, LOG_TAIL_LINES)) console.error(`  ${line}`);
    console.error(`전체 로그: ${deps.paths.log}`);
    return 1;
  }

  // 6. 열기 / JSON 한 줄
  if (json) {
    console.log(launchResultJson({ url: origin, port: options.port, mode: envMode, pid: child.pid ?? null, started: true }));
    return 0;
  }
  info(`스튜디오가 떴습니다: ${url}`);
  info(`종료: pnpm studio stop · 로그: ${deps.paths.log}`);
  if (open) await deps.open(url);
  else info(url);
  return 0;
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

async function waitForReady(deps: LaunchDeps, url: string, timeoutMs: number, intervalMs: number): Promise<boolean> {
  for (let waited = 0; waited <= timeoutMs; waited += intervalMs) {
    if (waited > 0) await deps.sleep(intervalMs);
    if ((await deps.probe(url)).reachable) return true;
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

function realSpawn(command: string, args: readonly string[], { cwd, env, logPath }: { cwd: string; env: NodeJS.ProcessEnv; logPath: string }): { pid: number | undefined } {
  // 로그 파일을 열어 자식의 stdout·stderr로 넘긴다. 부모는 곧 끝나므로 연 fd는 바로 닫는다(자식은 복사본을 갖는다)
  const log = openSync(logPath, 'a');
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

function realOpen(platform: NodeJS.Platform) {
  const command = platform === 'darwin' ? 'open' : 'xdg-open';
  return (url: string): Promise<void> =>
    new Promise((resolve) => {
      execFile(command, [url], () => resolve());
    });
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
    open: realOpen(platform),
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
  };
}

/** CLI 진입점. 실제 deps로 runLaunch를 부른다 */
export function launch(options: LaunchOptions): Promise<number> {
  return runLaunch(options, createLaunchDeps());
}
