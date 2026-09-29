import { execFile, spawn as spawnProcess } from 'node:child_process';
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

export interface ProbeResult {
  /** 응답을 받았는지(상태 코드와 무관) */
  reachable: boolean;
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

  // 1. 이미 떠 있나 — 새로 띄우지 않고 브라우저만 연다
  const existing = await deps.probe(url);
  if (existing.reachable) {
    if (!isBStudio(existing.body)) {
      console.error(`포트 ${options.port}에 다른 프로그램이 응답합니다. --port로 다른 포트를 지정하세요.`);
      return 1;
    }
    const stored = await readPidFile(deps.paths.pid, envMode);
    if (json) {
      console.log(launchResultJson({ url: origin, port: options.port, mode: stored.mode, pid: stored.pid, started: false }));
      return 0;
    }
    info(`이미 스튜디오가 ${url}에서 실행 중입니다.`);
    if (open) await deps.open(url);
    else info(url);
    return 0;
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

  // 3. 띄우기 — 부모가 끝나도 살아 있게 분리하고, 로그·PID를 남긴다
  await mkdir(path.dirname(deps.paths.pid), { recursive: true });
  const env = { ...deps.env, B_STUDIO_MODE: envMode };
  const child = deps.spawn('pnpm', launchArgs(options.port), { cwd: deps.repoRoot, env, logPath: deps.paths.log });
  await writeFile(deps.paths.pid, `${JSON.stringify({ pid: child.pid, port: options.port, mode: options.mode }, null, 2)}\n`, { mode: 0o600 });
  info(`스튜디오를 시작합니다 (모드 ${options.mode}, 포트 ${options.port}, 로그 ${deps.paths.log})`);

  // 4. 준비 확인 — 최대 90초, 1초 간격
  const timeoutMs = deps.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const intervalMs = deps.readyIntervalMs ?? READY_INTERVAL_MS;
  const ready = await waitForReady(deps, url, timeoutMs, intervalMs);
  if (!ready) {
    console.error(`스튜디오가 ${Math.round(timeoutMs / 1_000)}초 안에 응답하지 않았습니다. 로그 끝 ${LOG_TAIL_LINES}줄:`);
    for (const line of await tailLog(deps.paths.log, LOG_TAIL_LINES)) console.error(`  ${line}`);
    console.error(`전체 로그: ${deps.paths.log}`);
    return 1;
  }

  // 5. 열기 / JSON 한 줄
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

async function tailLog(file: string, lines: number): Promise<string[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.split('\n').filter((line) => line.length > 0).slice(-lines);
}

async function realProbe(url: string): Promise<ProbeResult> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    return { reachable: true, body: await response.text().catch(() => '') };
  } catch {
    return { reachable: false, body: '' };
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
  return {
    platform,
    env,
    repoRoot: path.resolve(import.meta.dirname, '../../../..'),
    paths: { log: path.join(launchDir, 'studio.log'), pid: path.join(launchDir, 'studio.pid') },
    probe: realProbe,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    exec: realExec,
    spawn: realSpawn,
    open: realOpen(platform),
  };
}

/** CLI 진입점. 실제 deps로 runLaunch를 부른다 */
export function launch(options: LaunchOptions): Promise<number> {
  return runLaunch(options, createLaunchDeps());
}
