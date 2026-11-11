import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildFront, repoRoot, startFront, startNodeDirect } from '../front-test-helper';
import { normalizer, type Normalizer } from './normalize';

/**
 * 세션 경로의 "바깥 동작"을 기준 사진으로 고정하는 시험 장치(ADR-195 4f F0).
 *
 * 진짜 studio 서버(앞단 bstudio-server + Node)를 임시 HOME·임시 세션 폴더·임시 프로젝트(git 저장소)로 띄우고, HTTP로 세션을 만들어 실행을 몬다.
 * 서버가 부르는 `docker`와 `claude`는 PATH 맨 앞의 가짜 실행 파일이다(진짜 docker·진짜 모델은 한 번도 부르지 않는다).
 * 서버 주소(origin)만 바꾸면 같은 시나리오를 다른 서버(나중의 Rust 서버)에 돌릴 수 있도록, 서버를 띄우는 일(`Target`)과 시나리오를 모는 일(`Driver`)을 나눴다.
 */
const execFileAsync = promisify(execFile);
const FIXTURES = path.join(repoRoot, 'packages/agent/src/fixtures');

export interface DockerRule {
  /** docker 인자(compose 공통 옵션을 뗀 하위 명령)의 부분열. 예: ['compose', 'up'] */
  when: string[];
  /** 이 횟수만 쓴다(없으면 계속) */
  times?: number;
  reply?: { stdout?: string; stderr?: string; exit?: number };
  delayMs?: number;
  /** compose 서비스 이름 → `docker inspect` 결과에 덧씌울 값(정책 위반이 든 컨테이너 흉내) */
  inspectPatch?: Record<string, Record<string, unknown>>;
}

export interface DockerScenario {
  services?: string[];
  state?: 'running' | 'exited';
  readyPort?: number;
  logs?: string[];
  rules?: DockerRule[];
}

export interface WorldOptions {
  /** 프로젝트(git 저장소) 파일. 기본은 최소 프로젝트 하나 */
  files?: Record<string, string>;
  /** 가짜 CLI 시나리오(packages/agent/src/fake-claude-cli.ts의 FakeCliScenario) */
  claude?: Record<string, unknown>;
  docker?: DockerScenario;
  /** 세션 터미널(실험 기능) 경로: `claude`가 PTY 안에서 입력을 기다리는 가짜가 되고, 서버가 터미널을 열 수 있게 환경을 켠다 */
  terminal?: boolean;
  /** 서버에 더 줄 환경 변수 */
  env?: Record<string, string>;
}

export interface World {
  root: string;
  home: string;
  sessionsDir: string;
  projectsDir: string;
  projectId: string;
  projectRoot: string;
  binDir: string;
  env: NodeJS.ProcessEnv;
  /** 준비 확인(HTTP GET)에 200을 돌려주는 가짜 서비스 */
  readyPort: number;
  setDocker: (scenario: DockerScenario) => Promise<void>;
  dockerCalls: () => Promise<DockerCall[]>;
  cleanup: () => Promise<void>;
}

export interface DockerCall {
  argv: string[];
  sub: string[];
  project?: string;
  cwd: string;
  how: string;
  exit: number | null;
}

const MINIMAL_FILES: Record<string, string> = {
  'studio.yaml': `version: 1
name: demo
workflow:
  required: [implement, checkpoint]
services:
  app:
    source: managed
    template: nextjs
    path: app
    port: 3000
    preview: browser
    ready: { path: /, timeoutSeconds: 20 }
`,
  'compose.yaml': `services:
  app:
    image: busybox:1.37
    command: ["sleep", "3600"]
`,
  'app/readme.txt': '데모 앱\n',
  'app/hello.txt': '안녕\n',
};

/**
 * 서버가 부르는 명령을 찾는 PATH: 가짜 bin 폴더, node, git, 기본 시스템 도구. 가짜 bin이 맨 앞이라 `docker`는 언제나 가짜가 잡힌다.
 * 뒤 폴더(CI 실행기는 `/usr/bin/docker`가 있다)에 진짜 docker가 있어도 이름으로는 닿지 않는다 — 서버 코드는 docker를 절대 경로로 부르지 않는다(코드 검색으로 확인)
 */
async function safePath(binDir: string): Promise<string> {
  const gitDir = await firstDirWith('git');
  return [...new Set([binDir, path.dirname(process.execPath), ...(gitDir ? [gitDir] : []), '/usr/bin', '/bin'])].join(path.delimiter);
}

/** PATH 순서대로 처음 `name` 실행 파일이 든 폴더 */
export async function firstDirWith(name: string, searchPath: string = process.env.PATH ?? ''): Promise<string | undefined> {
  for (const dir of searchPath.split(path.delimiter)) {
    try {
      await access(path.join(dir, name), fsConstants.X_OK);
      return dir;
    } catch {
      // 다음 폴더
    }
  }
  return undefined;
}

async function git(cwd: string, args: string[]): Promise<string> {
  // 사용자의 git 설정(서명, 훅, 별칭)을 읽지 않는다
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'seed',
    GIT_AUTHOR_EMAIL: 'seed@example.com',
    GIT_COMMITTER_NAME: 'seed',
    GIT_COMMITTER_EMAIL: 'seed@example.com',
  };
  const { stdout } = await execFileAsync('git', args, { cwd, env });
  return stdout;
}

/** 가짜 `docker` 실행 파일이 이 포트로 준비 확인에 답하도록 200만 주는 작은 서버를 연다 */
async function startReadyServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/plain' }).end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** 파일이 한동안 더 자라지 않을 때까지 기다린다(서버가 끝나며 따로 띄운 `compose down`이 마저 기록하는 것을 기다린다) */
async function quiet(file: string, ms = 400, limitMs = 15_000): Promise<void> {
  const size = () => stat(file).then((info) => info.size, () => -1);
  const deadline = Date.now() + limitMs;
  for (let last = await size(); Date.now() < deadline; ) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    const now = await size();
    if (now === last) return;
    last = now;
  }
}

export async function createWorld(options: WorldOptions = {}): Promise<World> {
  // /tmp 아래 짧은 경로(unix 소켓·macOS 경로 길이)에 두고, 심볼릭 링크를 푼 실제 경로를 쓴다(macOS의 /tmp → /private/tmp)
  const root = await realpath(await mkdtemp(path.join('/tmp', 'bsb-')));
  const home = path.join(root, 'home');
  const sessionsDir = path.join(root, 'sessions');
  const projectsDir = path.join(root, 'projects');
  const binDir = path.join(root, 'bin');
  const projectId = 'demo';
  const projectRoot = path.join(projectsDir, projectId);
  await Promise.all([home, sessionsDir, projectsDir, binDir, path.join(root, 'tmp')].map((dir) => mkdir(dir, { recursive: true })));

  for (const [file, content] of Object.entries({ ...MINIMAL_FILES, ...options.files })) {
    await mkdir(path.dirname(path.join(projectRoot, file)), { recursive: true });
    await writeFile(path.join(projectRoot, file), content);
  }
  await git(projectRoot, ['init', '--quiet', '--initial-branch=main']);
  await git(projectRoot, ['add', '-A']);
  await git(projectRoot, ['commit', '--quiet', '-m', '데모 프로젝트']);

  // 가짜 실행 파일: 셸 한 줄 래퍼가 node로 스크립트를 부른다. 시나리오와 기록은 bin 폴더에 둔다(서버가 환경을 걸러도 닿는다)
  const wrap = async (name: string, script: string, ...args: string[]) => {
    const file = path.join(binDir, name);
    await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" ${args.map((arg) => `"${arg}"`).join(' ')} "$@"\n`);
    await chmod(file, 0o755);
  };
  await wrap('docker', path.join(import.meta.dirname, 'fake-docker.mjs'), binDir);
  if (options.terminal) await wrap('claude', path.join(import.meta.dirname, 'fake-claude-terminal.mjs'), path.join(binDir, 'claude-terminal.jsonl'));
  else await wrap('claude', path.join(FIXTURES, 'fake-claude-cli.mjs'), path.join(binDir, 'claude-scenario.json'), path.join(binDir, 'claude-log'));
  await writeFile(path.join(binDir, 'claude-scenario.json'), JSON.stringify(options.claude ?? {}));

  const ready = await startReadyServer();
  const writeDocker = (scenario: DockerScenario) => writeFile(path.join(binDir, 'docker-scenario.json'), JSON.stringify({ readyPort: ready.port, ...scenario }));
  await writeDocker(options.docker ?? {});

  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: await safePath(binDir),
    HOME: home,
    TMPDIR: path.join(root, 'tmp'),
    B_STUDIO_MODE: 'claude-code',
    B_STUDIO_SESSIONS_DIR: sessionsDir,
    B_STUDIO_PROJECTS_DIR: projectsDir,
    B_STUDIO_LOCAL_TOKEN_FILE: path.join(root, 'local-token'),
    B_STUDIO_AUTH_STATE_DIR: path.join(root, 'auth'),
    B_STUDIO_USAGE_DIR: path.join(root, 'usage'),
    B_STUDIO_TASK_PLANS_DIR: path.join(root, 'task-plans'),
    B_STUDIO_FLEETS_DIR: path.join(root, 'fleets'),
    B_STUDIO_MODEL_OBSERVATIONS_FILE: path.join(root, 'model-observations.json'),
    B_STUDIO_MODEL_DEFAULTS_FILE: path.join(root, 'model-defaults.json'),
    ...(options.terminal ? { B_STUDIO_EXPERIMENTAL: '1', B_STUDIO_TERMINAL: 'host', B_STUDIO_AGENT_GATEWAY_DIR: path.join(root, 'gateway') } : {}),
    B_STUDIO_GIT_AUTHOR_NAME: 'b-studio',
    B_STUDIO_GIT_AUTHOR_EMAIL: 'b-studio@example.invalid',
    ...options.env,
  };

  return {
    root,
    home,
    sessionsDir,
    projectsDir,
    projectId,
    projectRoot,
    binDir,
    env,
    readyPort: ready.port,
    setDocker: (scenario) => writeDocker(scenario),
    dockerCalls: async () => {
      await quiet(path.join(binDir, 'docker-calls.jsonl'));
      const text = await readFile(path.join(binDir, 'docker-calls.jsonl'), 'utf8').catch(() => '');
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as DockerCall);
    },
    cleanup: async () => {
      await ready.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

// ── 서버를 띄우는 일: origin만 돌려주면 시나리오는 어느 서버든 같은 방식으로 몬다 ──
export interface Target {
  origin: string;
  stop: () => Promise<void>;
}

/** 앞단(bstudio-server) 너머로 Node 서버를 띄운다. 지금의 기준선이다 */
export async function startFrontTarget(world: World): Promise<Target> {
  const binary = await buildFront();
  const front = await startFront(
    binary,
    ['--port', '0', '--hostname', '127.0.0.1', '--run-dir', path.join(world.root, 'run'), '--', path.join(repoRoot, 'node_modules/.bin/tsx'), '--tsconfig', 'apps/studio/tsconfig.json', 'apps/studio/server/main.ts'],
    world.env,
    120_000,
  );
  return { origin: front.origin, stop: front.stop };
}

/** 앞단 없이 Node 서버만 띄운다(앞단이 결과를 바꾸지 않는지 견주는 용도) */
export async function startNodeTarget(world: World): Promise<Target> {
  const node = await startNodeDirect(world.env);
  return { origin: node.origin, stop: node.stop };
}

// ── 시나리오를 모는 일 ──
export interface Exchange {
  step: string;
  method: string;
  path: string;
  status: number;
  body: unknown;
}

export interface SseEvent {
  seq: number;
  event: Record<string, unknown>;
}

export class Driver {
  readonly exchanges: Exchange[] = [];
  readonly events: SseEvent[] = [];
  #abort: AbortController | undefined;
  #reading: Promise<void> | undefined;

  constructor(
    readonly origin: string,
    readonly world: World,
  ) {}

  /** HTTP 호출 하나. 응답은 기준 사진에 남기고 파싱한 본문을 돌려준다 */
  async call(step: string, method: string, pathname: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(new URL(pathname, this.origin), {
      method,
      headers: { 'content-type': 'application/json', host: 'localhost:3000', ...(pathname.endsWith('/terminal') ? { cookie: `b_studio_local=${await this.#localToken()}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      // JSON이 아닌 본문은 글 그대로 남긴다
    }
    this.exchanges.push({ step, method, path: pathname, status: response.status, body: parsed });
    return { status: response.status, body: parsed as Record<string, unknown> };
  }

  /**
   * 터미널 CLI가 훅 명령을 부르는 것과 같게, 관문 폴더의 훅 스크립트(`b-studio-hook.mjs <이벤트>`)를 같은 입력(JSON)으로 부른다.
   * 응답(JSON)을 돌려주고 입력과 함께 기준 사진에 남긴다. 진짜 CLI의 훅 입력을 흉내 낸 값이라, 진짜 CLI가 보내는 모양과 같다는 보장은 없다
   */
  async hook(step: string, event: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const gateway = path.join(this.world.root, 'gateway');
    // 터미널을 연 직후에는 관문 폴더가 아직 없을 수 있다
    let dirs = await readdir(gateway).catch(() => [] as string[]);
    for (let attempt = 0; dirs.length === 0 && attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      dirs = await readdir(gateway).catch(() => [] as string[]);
    }
    if (dirs.length !== 1) throw new Error(`관문 폴더가 하나여야 합니다: ${dirs.join(', ')}`);
    const script = path.join(gateway, dirs[0]!, 'b-studio-hook.mjs');
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [script, event], { env: { ...this.world.env }, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (error, out) => (error ? reject(error) : resolve(out)));
      child.stdin!.end(JSON.stringify(input));
    });
    const output = stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : {};
    this.exchanges.push({ step, method: 'HOOK', path: `/${event}`, status: 0, body: { input, output } });
    return output;
  }

  /** 터미널 통로가 요구하는 로컬 토큰(서버가 시작할 때 파일에 쓴다. 터미널 작업대가 같은 파일을 읽어 쿠키로 싣는다) */
  async #localToken(): Promise<string> {
    const file = this.world.env.B_STUDIO_LOCAL_TOKEN_FILE!;
    for (let attempt = 0; attempt < 40; attempt++) {
      const text = await readFile(file, 'utf8').catch(() => '');
      if (text.trim()) return text.trim();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('로컬 토큰 파일이 없습니다');
  }

  /** `/api/sessions/[id]/events`를 열어 이벤트를 모은다(snapshot부터 온다) */
  async subscribe(sessionId: string): Promise<void> {
    this.#abort = new AbortController();
    const response = await fetch(new URL(`/api/sessions/${sessionId}/events`, this.origin), { headers: { host: 'localhost:3000' }, signal: this.#abort.signal });
    if (!response.ok || !response.body) throw new Error(`이벤트 연결 실패: ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    this.#reading = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
            const frame = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const line = frame.split('\n').find((candidate) => candidate.startsWith('data: '));
            if (line) this.events.push({ seq: this.events.length, event: JSON.parse(line.slice(6)) as Record<string, unknown> });
          }
        }
      } catch {
        // 연결을 닫으면 읽기가 끝난다
      }
    })();
  }

  /** 조건을 만족하는 이벤트(지금까지 온 것 포함)가 올 때까지 기다린다 */
  async waitFor(label: string, predicate: (event: Record<string, unknown>) => boolean, timeoutMs = 60_000, from = 0): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.slice(from).find((entry) => predicate(entry.event));
      if (found) return found.event;
      if (Date.now() > deadline) throw new Error(`이벤트를 기다리다 시간이 지났습니다(${label}). 지금까지:\n${this.events.map((entry) => JSON.stringify(entry.event).slice(0, 200)).join('\n')}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async close(): Promise<void> {
    this.#abort?.abort();
    await this.#reading;
  }
}

/**
 * 객체의 키를 이름순으로 다시 쌓는다(배열의 순서는 그대로). session.json의 키 순서는 값이 도착한 순서(사용량 타이머·토큰 이벤트)를 따라
 * 실행마다 달라질 수 있어(#1175), 그 순서가 사진을 흔들지 않게 한다. JSON 객체의 키 순서에는 뜻이 없다
 */
export function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])]),
  );
}

/** 작업 복사본의 git 기록과 파일 상태를 읽는다. 내 폴더(local) 방식은 git 저장소가 세션 폴더(stateDir)에 있고 작업 트리는 프로젝트 폴더다 */
export async function readDisk(session: { workDir: string; stateDir?: string }, files: string[] = []): Promise<DiskState> {
  const gitDir = path.join(session.stateDir ?? session.workDir, '.git');
  const run = async (args: string[]) => (await git(session.workDir, ['--git-dir', gitDir, '--work-tree', session.workDir, ...args])).trimEnd();
  const log = (await run(['log', '--format=%H%x1f%B%x1e', '--reverse'])).split('\x1e').map((entry) => entry.trim()).filter(Boolean);
  const refs = (await run(['for-each-ref', '--format=%(refname) %(objectname)'])).split('\n').filter(Boolean);
  const status = (await run(['status', '--porcelain', '--untracked-files=all'])).split('\n').filter(Boolean);
  const sessionJson = sortedKeys(JSON.parse(await readFile(path.join(gitDir, 'b-studio', 'session.json'), 'utf8').catch(() => 'null')) as unknown);
  const contents: Record<string, string | null> = {};
  for (const file of files) contents[file] = await readFile(path.join(session.workDir, file), 'utf8').catch(() => null);
  return {
    commits: log.map((entry) => {
      const [sha = '', message = ''] = entry.split('\x1f');
      return { sha, message };
    }),
    refs: refs.map((line) => {
      const [name = '', sha = ''] = line.split(' ');
      return { name, sha };
    }),
    status,
    sessionJson,
    files: contents,
  };
}

export interface DiskState {
  commits: Array<{ sha: string; message: string }>;
  refs: Array<{ name: string; sha: string }>;
  status: string[];
  sessionJson: unknown;
  files: Record<string, string | null>;
}

// ── 기준 사진 ──
export interface BaselineSnapshot {
  http: unknown;
  events: unknown;
  disk: unknown;
  docker: unknown;
}

/** docker 호출은 읽기 전용 확인(ps·inspect·stats…)이 타이머로 몇 번 불리는지가 시각에 달려 있어, 상태를 바꾸는 호출만 순서대로 남기고 읽기 호출은 종류만 모은다 */
const READ_ONLY = new Set(['ps', 'inspect', 'stats', 'port', 'logs', 'config', 'info', 'version', 'ls', 'events', 'top']);
export function summarizeDocker(calls: DockerCall[], n: Normalizer, shutdownFrom = calls.length): { mutating: string[]; atShutdown: string[]; readKinds: string[]; unknown: string[] } {
  const shorten = (token: string) => (token.length > 120 ? `<script:${createHash('sha256').update(token).digest('hex').slice(0, 8)}>` : token);
  const kind = (call: DockerCall) => n.text(call.sub.filter((token, index) => index < 3 && !token.startsWith('-') && !/^[0-9a-f]{64}$/.test(token)).join(' '));
  const mutating: string[] = [];
  const atShutdown: string[] = [];
  const reads = new Set<string>();
  const unknown: string[] = [];
  for (const [index, call] of calls.entries()) {
    if (call.how === 'unknown') unknown.push(n.text(call.argv.join(' ')));
    const verb = call.sub[0] === 'compose' ? call.sub[1] : call.sub[0];
    const nested = call.sub[0] === 'volume' || call.sub[0] === 'image' || call.sub[0] === 'network' ? call.sub[1] : undefined;
    if (READ_ONLY.has(verb ?? '') || nested === 'inspect' || nested === 'ls') reads.add(kind(call));
    // 서버가 끝나며 따로 띄우는 정리 명령(compose down, 에이전트 컨테이너 rm)은 서로 겹쳐 돌아 순서가 일정하지 않다. 집합으로 남긴다
    else (index >= shutdownFrom ? atShutdown : mutating).push(n.text(call.sub.map(shorten).join(' ')));
  }
  return { mutating, atShutdown: atShutdown.sort(), readKinds: [...reads].sort(), unknown };
}

/** 시각에 따라 개수·자리가 달라지는 이벤트(5초 타이머의 사용량)는 사진에서 뺀다 */
const NOISE_EVENTS = new Set(['usage']);

/**
 * 이벤트 열은 세 줄로 나눠 남긴다: 실행(runId가 있는 이벤트), 플랫폼(상태·서비스·알림 등), 파일 변경 알림.
 * 각 줄 안의 순서는 고정하지만 두 줄 사이의 끼어드는 순서는 서버 안의 타이머에 달려 있어 고정하지 않는다. 같은 이벤트가 연달아 오면 한 번으로 센다
 */
export function laneEvents(events: SseEvent[]): { run: unknown[]; platform: unknown[]; files: unknown[] } {
  const run: unknown[] = [];
  const platform: unknown[] = [];
  const files: unknown[] = [];
  const push = (lane: unknown[], event: unknown) => {
    if (JSON.stringify(lane.at(-1)) !== JSON.stringify(event)) lane.push(event);
  };
  for (const { event } of events) {
    if (NOISE_EVENTS.has(event.type as string)) continue;
    // 파일 감시의 변경 알림은 서비스 재시작과 같은 시각에 오지만 어느 쪽이 먼저인지는 감시 타이머에 달려 있다. 따로 센다
    push(event.runId !== undefined ? run : event.type === 'files_changed' ? files : platform, event);
  }
  return { run, platform, files };
}

export async function snapshotOf(world: World, driver: Driver, session: { id: string; workDir: string; stateDir?: string }, files: string[] = [], shutdownFrom?: number): Promise<BaselineSnapshot> {
  const n = normalizer(world, session.id);
  const disk = await readDisk(session, files);
  n.learnShas([...disk.commits.map((commit) => commit.sha), ...disk.refs.map((ref) => ref.sha)]);
  n.learnRuns(driver.events.map((entry) => entry.event));
  n.learnRuns(driver.exchanges.map((exchange) => exchange.body));
  const lanes = laneEvents(driver.events);
  return {
    http: driver.exchanges.map((exchange) => ({ ...exchange, path: n.text(exchange.path), body: n.value(exchange.body) })),
    events: { run: n.value(lanes.run), platform: n.value(lanes.platform), files: n.value(lanes.files) },
    disk: n.value({
      commits: disk.commits.map((commit) => ({ sha: commit.sha, message: commit.message })),
      refs: disk.refs,
      status: disk.status,
      files: disk.files,
      sessionJson: disk.sessionJson,
    }),
    docker: summarizeDocker(await world.dockerCalls(), n, shutdownFrom),
  };
}
