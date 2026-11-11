import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ManagedServiceSpec } from '@b-studio/spec';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { isDockerUnreachable, SandboxError } from '../errors';
import { ReadinessError, type ReadinessPolicy } from '../readiness';
import { Redactor } from '../secrets';
import { runCommand, runCommandLogStream } from '../stream-exec';
import type { ContainerState, ExecResult, LogLine, LogOptions, ServiceEndpoint, ServiceStatusEvent } from '../types';
import { composeEnvironment } from './compose-env';
import { describeDockerFailure } from './compose-provider';
import { edgePortFor } from '../edge-config';
import { parseContainerState, parseHostPort, parseLogLine } from './format';
import { awaitReady, ensureInfra, missingServices, readProcessBaseline, strayProcessReports, type InfraContext, type ReadyContext } from './ready';
import { awaitReadyLegacy, ensureInfraLegacy, recordProcessBaselineLegacy, strayProcessesLegacy, type LegacyInfraContext, type LegacyReadyContext, type LegacyStrayContext } from './ready-legacy';
import type { ScannedProcess } from './stray-processes';

/**
 * 준비 확인·모르는 프로세스 검사·인프라 확인(ADR-195 4f A4c-3a)의 차등 시험: 옛 TS(`ready-legacy.ts`)와 지금(Rust 함수 + TS 껍데기)이 **같은 가짜 docker, 같은 127.0.0.1 시험 서버**에
 * 같은 결과(반환값 또는 같은 글·종류의 오류), 같은 이벤트 순서, 같은 docker 호출 순서를 내는지 본다.
 * 진짜 docker도 바깥 네트워크도 쓰지 않는다 — 가짜 docker는 준비한 출력을 호출 순서대로 내놓는 셸 스크립트, 서버는 127.0.0.1에 띄운 net 서버다.
 * 옛 쪽과 다른 점은 모두 "더 막는 쪽"이거나 의도한 차이고, 아래 `HARDENED`·`의도한 차이` 표시가 붙은 입력에서만 나온다(그 밖의 입력은 한 글자도 다르지 않아야 한다).
 * 시간에 기대는 값(확인 횟수, 시각)은 정규화한다: 연속으로 같은 확인·호출은 하나로 접고 `at`은 지운다.
 */

const roots: string[] = [];
const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

// ── 시험 서버 ────────────────────────────────────────────────────────────

type Reply = { status: number; location?: string } | 'close' | 'garbage' | 'hang' | 'reset' | 'bad-header' | 'raw-late' | 'html-404' | 'body-200';
interface Request {
  requestLine: string;
  host: string | undefined;
  /** 요청 머리글(Host·Connection 말고) */
  headers: string[];
}
interface Server {
  port: number;
  requests: Request[];
}

/** 요청마다 `replies[요청 번호]`(목록보다 많으면 마지막 것)로 답한다 */
async function listen(replies: Reply[]): Promise<Server> {
  const requests: Request[] = [];
  const server = net.createServer((socket) => {
    let received = '';
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      if (!received.includes('\r\n\r\n')) return;
      const head = received.split('\r\n');
      const host = head.find((line) => line.toLowerCase().startsWith('host:'))?.slice(5).trim();
      received = '';
      const reply = replies[Math.min(requests.length, replies.length - 1)]!;
      requests.push({
        requestLine: head[0]!,
        host,
        headers: head.slice(1).filter((line) => line && !/^(host|connection):/i.test(line)).map((line) => line.toLowerCase()),
      });
      if (reply === 'hang') return;
      if (reply === 'close') return void socket.end();
      if (reply === 'reset') return void socket.resetAndDestroy();
      if (reply === 'garbage') return void socket.end('hello world\r\n\r\n');
      if (reply === 'bad-header') return void socket.end('HTTP/1.1 200 OK\r\nbad header line\r\n\r\n');
      if (reply === 'raw-late') return void socket.end('HTTP/1.1 200 OK\r\n');
      // busybox httpd처럼 머리와 본문(낱개 LF가 든 HTML)을 한 번에 보낸다(실측에서 Rust 쪽이 본문의 LF를 머리의 것으로 읽어 실패했다)
      if (reply === 'html-404') return void socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-type: text/html\r\n\r\n<HTML><HEAD><TITLE>404 Not Found</TITLE></HEAD>\n<BODY><H1>404 Not Found</H1>\n</BODY></HTML>\n');
      if (reply === 'body-200') return void socket.end('HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n# shop\n\n');
      socket.end(`HTTP/1.1 ${reply.status} X\r\n${reply.location ? `Location: ${reply.location}\r\n` : ''}Content-Length: 0\r\n\r\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, requests };
}

/** 닫힌 포트(연결 거부) */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// ── 가짜 docker ──────────────────────────────────────────────────────────

interface Step {
  code?: number;
  out?: string;
  err?: string;
}
type Script = Record<string, Step | Step[]>;

interface Side {
  dir: string;
  bin: string;
  state: string;
  scripts: string;
}

interface Env {
  dir: string;
  root: string;
  composePath: string;
  overridePath: string;
}

async function environment(): Promise<Env> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'ready-diff-')));
  roots.push(dir);
  const root = path.join(dir, 'proj');
  await mkdir(root, { recursive: true });
  return { dir, root, composePath: path.join(root, 'compose.yaml'), overridePath: path.join(dir, 'compose.override.yaml') };
}

/** 한 번 돌리는 쪽(옛 쪽, 새 쪽)마다 따로 두는 가짜 docker. 상태·대본 폴더를 쪽마다 따로 둔다(서버 포트가 쪽마다 다르다) */
async function fakeDocker(env: Env, kind: string, script: Script): Promise<Side> {
  const dir = path.join(env.dir, kind);
  const state = path.join(dir, 'state');
  const scripts = path.join(dir, 'script');
  await mkdir(state, { recursive: true });
  await mkdir(scripts, { recursive: true });
  const bin = path.join(dir, 'docker');
  await writeFile(
    bin,
    `#!/bin/sh
S='${state}'
D='${scripts}'
printf '%s\\n' "$*" >> "$S/calls"
key=other
case "$1" in
  run) key=run ;;
  inspect) key=inspect ;;
  volume) key=volume ;;
  rm) key=rm ;;
  start) key=startid ;;
  compose) for a in "$@"; do case "$a" in config) key=config ;; up) key=up ;; ps) key=ps ;; down) key=down ;; start) key=start ;; rm) key=composerm ;; exec) key=exec ;; esac; done ;;
esac
# 서비스마다 다른 답: \`ps@<서비스>\` 응답이 있으면 마지막 인자(서비스 이름)로 고른다. 동시에 부르는 검사는 호출 순서가 정해지지 않는다
if [ "$key" = ps ]; then for last in "$@"; do :; done; if [ -f "$D/ps@$last.out" ]; then key="ps@$last"; fi; fi
n=$(cat "$S/n.$key" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$S/n.$key"
pick() { if [ -f "$D/$key.$n.$1" ]; then cat "$D/$key.$n.$1"; elif [ -f "$D/$key.$1" ]; then cat "$D/$key.$1"; fi; }
pick out
pick err >&2
code=$(pick code)
exit \${code:-0}
`,
  );
  await chmod(bin, 0o755);
  for (const [key, value] of Object.entries(script)) {
    const steps = Array.isArray(value) ? value : [value];
    const write = async (prefix: string, step: Step) => {
      await writeFile(path.join(scripts, `${prefix}.out`), step.out ?? '');
      await writeFile(path.join(scripts, `${prefix}.err`), step.err ?? '');
      await writeFile(path.join(scripts, `${prefix}.code`), String(step.code ?? 0));
    };
    for (const [index, step] of steps.entries()) await write(`${key}.${index + 1}`, step);
    // 호출 수가 목록보다 많으면 마지막 것을 되풀이한다
    await write(key, steps[steps.length - 1]!);
  }
  return { dir, bin, state, scripts };
}

const composeArgs = (env: Env, args: string[]) => ['compose', '--project-name', 'studio-p', '--project-directory', env.root, '--file', env.composePath, '--file', env.overridePath, ...args];
const dockerEnv = (secrets: Record<string, string> = {}) => composeEnvironment(secrets);
const readCalls = async (state: string) => readFile(path.join(state, 'calls'), 'utf8').catch(() => '');

const normalizeText = (text: string, env: Env, side: Side, port: number) =>
  text.split(side.dir).join('<RUN>').split(env.dir).join('<ENV>').split(`127.0.0.1:${port}`).join('127.0.0.1:<PORT>').split(`0.0.0.0:${port}`).join('0.0.0.0:<PORT>');

const collapse = <T>(items: T[]): T[] => items.filter((item, index) => JSON.stringify(items[index - 1]) !== JSON.stringify(item));

// ── 준비 확인 ────────────────────────────────────────────────────────────

const SPEC = (ready: ManagedServiceSpec['ready'] | undefined): ManagedServiceSpec => ({ template: 'node', path: '.', port: 3000, ...(ready ? { ready } : {}) }) as unknown as ManagedServiceSpec;

const RUNNING = '{"Service":"api","State":"running"}\n';
const EXITED = '{"Service":"api","State":"exited"}\n';
const DEAD = '{"Service":"api","State":"dead"}\n';

interface ReadyScenario {
  name: string;
  /** 시험 서버의 응답. 없으면 닫힌 포트 */
  replies?: Reply[] | 'closed';
  ready?: ManagedServiceSpec['ready'] | null;
  policy?: Partial<ReadinessPolicy>;
  /** 가짜 docker 대본. `other`는 `compose port`(1번째)와 `logs`(그 뒤)가 번갈아 쓴다 */
  script: (port: number) => Script;
  secrets?: Record<string, string>;
  /** 확인 횟수가 시간에 달려 있다 */
  timing?: boolean;
  abort?: 'before' | 'after-first-probe';
  throwOnProbe?: boolean;
  /** 이 포트 문자열을 `compose port`가 낸다(서버 포트 대신) */
  portOutput?: string;
}

interface ReadyObserved {
  outcome: { ok: true; endpoint: ServiceEndpoint } | { ok: false; name: string; message: string; detail?: string | undefined; platform?: boolean; history?: unknown; constructorName: string };
  events: unknown[];
  retries: unknown[];
  calls: string[];
  requests: Request[];
}

function normalizeEvent(event: ServiceStatusEvent, env: Env, side: Side, port: number): unknown {
  const text = JSON.stringify(event, (key, value) => (key === 'at' ? undefined : value)) as string;
  return JSON.parse(normalizeText(text, env, side, port));
}

async function observeReady(kind: 'legacy' | 'now', scenario: ReadyScenario, env: Env): Promise<ReadyObserved> {
  const server = scenario.replies === 'closed' ? { port: await closedPort(), requests: [] as Request[] } : await listen(scenario.replies ?? [{ status: 200 }]);
  const side = await fakeDocker(env, kind, scenario.script(server.port));
  const secrets = scenario.secrets ?? {};
  const redactor = new Redactor(secrets);
  const redact = (text: string) => redactor.redact(text);
  const project = { root: env.root, composePath: env.composePath };
  const service = SPEC(scenario.ready === null ? undefined : (scenario.ready ?? { path: '/', expectStatus: 200 }));
  const policy: ReadinessPolicy = { successThreshold: 2, timeoutMs: 1_500, intervalMs: 5, ...scenario.policy };
  const run = (args: string[], signal?: AbortSignal): Promise<ExecResult> => runCommand(side.bin, composeArgs(env, args), { signal, env: dockerEnv(secrets) });
  const composeFailure = (command: string, result: ExecResult) =>
    new SandboxError(`docker compose ${command} 실패 (studio-p)`, describeDockerFailure(redact(result.stderr)), { platform: isDockerUnreachable(result.stderr) });
  const composeOrThrow = async (args: string[], signal?: AbortSignal) => {
    const result = await run(args, signal);
    if (result.exitCode !== 0) throw composeFailure(args[0]!, result);
    return result;
  };
  const events: ServiceStatusEvent[] = [];
  const retries: unknown[] = [];
  const controller = new AbortController();
  if (scenario.abort === 'before') controller.abort();
  const options = {
    signal: controller.signal,
    onStatus: (event: ServiceStatusEvent) => {
      events.push(event);
      if (scenario.abort === 'after-first-probe' && event.phase === 'probing') controller.abort();
      if (scenario.throwOnProbe && event.phase === 'probing') throw new Error('알림을 처리하다 던졌습니다');
    },
    onTransientRetry: (event: { service: string; reason: string }) => retries.push(event),
  };

  let result: Promise<ServiceEndpoint>;
  if (kind === 'legacy') {
    const ctx: LegacyReadyContext = {
      managed: () => service,
      endpoint: async (name) => {
        const { stdout } = await composeOrThrow(['port', 'edge', String(edgePortFor({ managed: [[name, service]] } as never, name))]);
        return { service: name, containerPort: service.port, url: `http://127.0.0.1:${parseHostPort(stdout)}` };
      },
      state: async (name): Promise<ContainerState> => parseContainerState((await run(['ps', '--all', '--format', 'json', name])).stdout),
      logs: (logOptions: LogOptions) => legacyLogs(side, env, redactor, logOptions),
      composeOrThrow,
      policyFor: () => policy,
    };
    result = awaitReadyLegacy(ctx, 'api', options);
  } else {
    const ctx: ReadyContext = {
      id: 'studio-p',
      project,
      dockerBin: side.bin,
      env: dockerEnv(secrets),
      overridePath: env.overridePath,
      secrets,
      edgeService: 'edge',
      edgePort: (name) => edgePortFor({ managed: [[name, service]] } as never, name),
      managed: () => service,
      policyFor: () => policy,
      recreate: (name, signal) => composeOrThrow(['up', '--detach', '--build', '--no-deps', '--force-recreate', name], signal),
      composeFailure,
    };
    result = awaitReady(ctx, 'api', options);
  }
  const outcome: ReadyObserved['outcome'] = await result.then(
    (endpoint) => ({ ok: true as const, endpoint: { ...endpoint, url: normalizeText(endpoint.url, env, side, server.port) } }),
    (error: unknown) => {
      if (error instanceof SandboxError) return { ok: false as const, name: error.name, message: normalizeText(error.message, env, side, server.port), detail: error.detail, platform: error.platform, constructorName: error.constructor.name };
      if (error instanceof ReadinessError) {
        return { ok: false as const, name: error.name, message: error.message, history: error.history.map(({ at: _at, ...rest }) => rest), constructorName: error.constructor.name };
      }
      if (error instanceof Error) return { ok: false as const, name: error.name, message: error.message, constructorName: error.constructor.name };
      throw error;
    },
  );
  const calls = (await readCalls(side.state)).split('\n').filter(Boolean).map((line) => normalizeText(line, env, side, server.port));
  const norm = scenario.timing ? collapse : <T>(items: T[]): T[] => items;
  return {
    outcome,
    events: norm(events.map((event) => normalizeEvent(event, env, side, server.port))),
    retries: retries.map((retry) => JSON.parse(normalizeText(JSON.stringify(retry), env, side, server.port)) as unknown),
    calls: norm(calls),
    requests: server.requests.map((request) => ({ requestLine: request.requestLine, host: request.host?.replace(String(server.port), '<PORT>'), headers: request.headers })),
  };
}

/** 옛 `logs()`: Rust 줄 스트림 → `parseLogLine` → 시크릿 가림 */
async function* legacyLogs(side: Side, env: Env, redactor: Redactor, { services = [], tail = 200, follow = true }: LogOptions): AsyncIterable<LogLine> {
  const args = composeArgs(env, ['logs', ...(follow ? ['--follow'] : []), '--no-color', '--timestamps', '--tail', String(tail), ...services]);
  for await (const raw of runCommandLogStream(side.bin, args, { env: dockerEnv() })) {
    const line = parseLogLine(raw);
    if (line) yield { ...line, text: redactor.redact(line.text) };
  }
}

async function bothReady(scenario: ReadyScenario) {
  const env = await environment();
  const legacy = await observeReady('legacy', scenario, env);
  const now = await observeReady('now', scenario, env);
  return { legacy, now };
}

const port = (p: number) => `0.0.0.0:${p}\n`;
const okScript = (p: number): Script => ({ other: { out: port(p) }, ps: { out: RUNNING } });
const LOG_ETXTBSY = 'api-1  | 2026-01-01T00:00:01.123456789Z Error: spawn ETXTBSY\n';
const LOG_BOOM = 'api-1  | 2026-01-01T00:00:00Z starting\napi-1  | 2026-01-01T00:00:01Z Error: boom\n';
const EDGE_DENY = 'edge-1  | 2026-01-01T00:00:00Z {"edge":"egress","decision":"deny","host":"x.com","port":443,"method":"GET","reason":"not allowed","at":"2026-01-01T00:00:00Z"}\n';

const readyScenarios: ReadyScenario[] = [
  { name: '정상: 두 번 연속 200', script: okScript },
  { name: '정상: ready가 없으면 엔드포인트만 읽는다', ready: null, script: okScript },
  { name: '정상: 처음 몇 번은 503, 그 뒤 200', replies: [{ status: 503 }, { status: 503 }, { status: 200 }], script: okScript },
  { name: '정상: 한 번 200 뒤 503이면 연속이 끊겨 다시 센다', replies: [{ status: 200 }, { status: 503 }, { status: 200 }, { status: 200 }], script: okScript },
  { name: '정상: 기대 상태가 302이면 리다이렉트를 따르지 않고 302를 받는다', ready: { path: '/', expectStatus: 302 }, replies: [{ status: 302, location: 'http://example.com/' }], script: okScript },
  { name: '정상: 기대 상태가 404', ready: { path: '/missing', expectStatus: 404 }, replies: [{ status: 404 }], script: okScript },
  { name: '정상: 머리와 본문을 한 번에 보내는 200(본문에 낱개 LF)', replies: ['body-200'], script: okScript },
  { name: '정상: 기대 상태가 404이고 본문이 낱개 LF가 든 HTML', ready: { path: '/missing', expectStatus: 404 }, replies: ['html-404'], script: okScript },
  { name: '실패: 기대와 다른 404가 본문과 함께 오면 이유에 404가 든다', replies: ['html-404'], policy: { timeoutMs: 120 }, timing: true, script: okScript },
  { name: '실패: 기대 상태가 302인데 200이 온다', ready: { path: '/', expectStatus: 302 }, policy: { timeoutMs: 120 }, timing: true, script: okScript },
  { name: '실패: 계속 503이면 시간 초과 이유에 마지막 확인이 든다', replies: [{ status: 503 }], policy: { timeoutMs: 150 }, timing: true, script: okScript },
  { name: '실패: 연결할 수 없다(ECONNREFUSED)', replies: 'closed', policy: { timeoutMs: 120 }, timing: true, script: okScript },
  { name: '실패: 응답 없이 연결을 끊는다(UND_ERR_SOCKET)', replies: ['close'], policy: { timeoutMs: 120 }, timing: true, script: okScript },
  { name: '실패: HTTP가 아닌 응답(HPE_INVALID_CONSTANT)', replies: ['garbage'], policy: { timeoutMs: 120 }, timing: true, script: okScript },
  { name: '실패: 상태 줄은 맞고 헤더가 HTTP가 아니다', replies: ['bad-header'], policy: { timeoutMs: 120 }, timing: true, script: okScript },
  { name: '실패: 상태 줄만 보내고 끊는다', replies: ['raw-late'], policy: { timeoutMs: 120 }, timing: true, script: okScript },
  { name: '실패: 연결을 재설정한다(ECONNRESET)', replies: ['reset'], policy: { timeoutMs: 120 }, timing: true, script: okScript },
  { name: '실패: 응답이 없다(TIMEOUT)', replies: ['hang'], policy: { timeoutMs: 100, intervalMs: 5 }, script: okScript },
  { name: '상태: ps가 비0으로 끝나도 출력을 읽는다', script: (p) => ({ other: { out: port(p) }, ps: { code: 1, err: 'daemon', out: RUNNING } }) },
  { name: '죽음: 바로 실패하고 앱 로그의 오류 줄이 붙는다', script: (p) => ({ other: [{ out: port(p) }, { out: LOG_BOOM }, { out: '' }], ps: { out: EXITED } }) },
  { name: '죽음(dead): 앱 로그와 egress 기록이 함께 붙는다', script: (p) => ({ other: [{ out: port(p) }, { out: LOG_BOOM }, { out: EDGE_DENY }], ps: { out: DEAD } }) },
  { name: '죽음: 오류다운 줄이 없으면 마지막 몇 줄이 붙는다', script: (p) => ({ other: [{ out: port(p) }, { out: 'api-1  | 2026-01-01T00:00:00Z a\napi-1  | 2026-01-01T00:00:01Z b\n' }, { out: '' }], ps: { out: EXITED } }) },
  { name: '죽음: 로그가 비어 있으면 원래 이유만 남는다', script: (p) => ({ other: [{ out: port(p) }, { out: '' }, { out: '' }], ps: { out: EXITED } }) },
  { name: '죽음: 로그를 못 읽어도(비0) 이유는 남는다', script: (p) => ({ other: [{ out: port(p) }, { code: 1, err: 'no logs' }, { code: 1, err: 'no logs' }], ps: { out: EXITED } }) },
  { name: '죽음: 로그의 시크릿은 가린다', secrets: { TOKEN: 'SECRETVALUE1' }, script: (p) => ({ other: [{ out: port(p) }, { out: 'api-1  | 2026-01-01T00:00:01Z Error: bad token SECRETVALUE1\n' }, { out: '' }], ps: { out: EXITED } }) },
  { name: '죽음: 긴 줄은 300자에서 자른다', script: (p) => ({ other: [{ out: port(p) }, { out: `api-1  | 2026-01-01T00:00:01Z Error: ${'x'.repeat(400)}\n` }, { out: '' }], ps: { out: EXITED } }) },
  { name: '죽음: 서비스 접두가 없는 줄과 상태 줄', script: (p) => ({ other: [{ out: port(p) }, { out: 'plain error text\n\u001b[2Kapi-1  exited with code 1\n' }, { out: '' }], ps: { out: EXITED } }) },
  { name: '재시도: 일시 오류(ETXTBSY)로 죽으면 다시 만들고 두 번째 시도에서 준비된다', script: (p) => ({ other: [{ out: port(p) }, { out: LOG_ETXTBSY }, { out: port(p) }], ps: [{ out: EXITED }, { out: RUNNING }], up: {} }) },
  { name: '재시도: 다시 만든 뒤에도 죽으면 한 번만 다시 만든다(두 번째는 이유를 붙여 실패)', script: (p) => ({ other: [{ out: port(p) }, { out: LOG_ETXTBSY }, { out: port(p) }, { out: LOG_ETXTBSY }, { out: '' }], ps: { out: EXITED }, up: {} }) },
  { name: '재시도: 다시 만들기(up)가 실패하면 그 오류가 나가고 failed는 알리지 않는다', script: (p) => ({ other: [{ out: port(p) }, { out: LOG_ETXTBSY }], ps: { out: EXITED }, up: { code: 1, err: 'build failed' } }) },
  { name: '엔드포인트: compose port가 비0으로 끝나면 확인 전의 오류다', script: () => ({ other: { code: 1, err: 'no such service: edge' } }) },
  { name: '엔드포인트: 도커 데몬에 닿지 못하면 platform 실패다', script: () => ({ other: { code: 1, err: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' } }) },
  { name: '엔드포인트: 포트를 읽지 못한다', script: () => ({ other: { out: 'nothing here\n' } }) },
  { name: '엔드포인트: TCP 포트가 아닌 값(70000)이면 Invalid URL로 실패한다', portOutput: '0.0.0.0:70000\n', script: () => ({ other: { out: '0.0.0.0:70000\n' } }) },
  { name: '엔드포인트: ready가 없으면 TCP 포트가 아니어도 그대로 돌려준다', ready: null, script: () => ({ other: { out: '0.0.0.0:70000\n' } }) },
  { name: '취소: 이미 취소돼 있으면 확인하지 않는다', abort: 'before', script: okScript },
  { name: '취소: 쉬는 중에 취소하면 AbortError다', abort: 'after-first-probe', replies: [{ status: 503 }], policy: { intervalMs: 5_000, timeoutMs: 60_000 }, script: okScript },
  { name: '알림: onStatus가 던지면 그 오류로 실패한다', throwOnProbe: true, script: okScript },
];

describe('준비 확인이 옛 #awaitReady와 같다', () => {
  it.each(readyScenarios.map((scenario) => [scenario.name, scenario] as const))('%s', async (_name, scenario) => {
    const { legacy, now } = await bothReady(scenario);
    expect(now.outcome).toEqual(legacy.outcome);
    expect(now.events).toEqual(legacy.events);
    expect(now.retries).toEqual(legacy.retries);
    expect(now.calls).toEqual(legacy.calls);
    expect(scenario.timing ? collapse(now.requests) : now.requests).toEqual(scenario.timing ? collapse(legacy.requests) : legacy.requests);
  }, 60_000);

  it('시나리오 수', () => {
    expect(readyScenarios.length).toBeGreaterThanOrEqual(35);
  });

  it('일시 오류 재시도는 이벤트 순서가 probing → starting → onTransientRetry 뒤 starting → probing → ready이다', async () => {
    const scenario = readyScenarios.find((item) => item.name.startsWith('재시도: 일시 오류'))!;
    const { now } = await bothReady(scenario);
    expect((now.events as Array<{ phase: string }>).map((event) => event.phase)).toEqual(['probing', 'starting', 'probing', 'probing', 'ready']);
    expect(now.retries).toEqual([{ service: 'api', reason: 'Error: spawn ETXTBSY' }]);
    // 호출 순서: port → ps → logs → up → port → ps → ps
    expect(now.calls.map((call) => call.split(' ').find((word) => ['port', 'ps', 'logs', 'up'].includes(word)))).toEqual(['port', 'ps', 'logs', 'up', 'port', 'ps', 'ps']);
  });
});

// ── 요청 줄 ──────────────────────────────────────────────────────────────

/** 같은 경로를 옛 쪽(fetch)과 새 쪽(Rust)이 서버에 어떻게 보내는지 */
async function requestsFor(readyPath: string): Promise<{ legacy: Request[]; now: Request[]; legacyUrl: string }> {
  const legacyServer = await listen([{ status: 200 }]);
  const nowServer = await listen([{ status: 200 }]);
  const env = await environment();
  const spec = SPEC({ path: readyPath, expectStatus: 200 });
  const policy: ReadinessPolicy = { successThreshold: 1, timeoutMs: 1_500, intervalMs: 5 };
  const legacyUrl = new URL(readyPath, `http://127.0.0.1:${legacyServer.port}`).toString();
  // 옛 쪽: 바깥 호스트로 풀리는 경로는 응답을 지어내 기록만 한다(바깥에는 접속하지 않는다)
  const realFetch = globalThis.fetch;
  const foreign: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (new URL(url).hostname === '127.0.0.1') return realFetch(url, init);
    foreign.push(url);
    return new Response(null, { status: 200 });
  });
  const legacySide = await fakeDocker(env, 'legacy', okScript(legacyServer.port));
  const nowSide = await fakeDocker(env, 'now', okScript(nowServer.port));
  const run = (side: Side, args: string[]) => runCommand(side.bin, composeArgs(env, args), { env: dockerEnv() });
  const legacyCtx: LegacyReadyContext = {
    managed: () => spec,
    endpoint: async (name) => ({ service: name, containerPort: 3000, url: `http://127.0.0.1:${legacyServer.port}` }),
    state: async () => parseContainerState((await run(legacySide, ['ps', '--all', '--format', 'json', 'api'])).stdout),
    logs: () => (async function* () {})(),
    composeOrThrow: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    policyFor: () => policy,
  };
  await awaitReadyLegacy(legacyCtx, 'api', {});
  const nowCtx: ReadyContext = {
    id: 'studio-p',
    project: { root: env.root, composePath: env.composePath },
    dockerBin: nowSide.bin,
    env: dockerEnv(),
    overridePath: env.overridePath,
    secrets: {},
    edgeService: 'edge',
    edgePort: () => 3000,
    managed: () => spec,
    policyFor: () => policy,
    recreate: async () => undefined,
    composeFailure: (command) => new Error(command),
  };
  await awaitReady(nowCtx, 'api', {});
  vi.unstubAllGlobals();
  const normalize = (server: Server): Request[] => server.requests.map((request) => ({ requestLine: request.requestLine, host: request.host?.replace(String(server.port), '<PORT>'), headers: request.headers }));
  return { legacy: [...normalize(legacyServer), ...foreign.map((url) => ({ requestLine: `FOREIGN ${url}`, host: undefined, headers: [] as string[] }))], now: normalize(nowServer), legacyUrl };
}

describe('ready.path를 요청 줄로 바꾸는 규칙이 fetch와 같다', () => {
  it.each([
    '/',
    '/health',
    '/actuator/health/readiness',
    '/health?x=1',
    '/health?',
    '/a b',
    '/a"b',
    '/a<b>c',
    '/a`b',
    '/a{b}c',
    '/a^b|c',
    "/a'b",
    "/a?x'y",
    '/a?x{y}`z',
    '/a?x\\y',
    '/a?x y',
    '/검색',
    '/a?q=검색',
    '/a%zz',
    '/a%2',
    '/%',
    '/a#frag',
    '/a?b#c',
    '/a/../b',
    '/a/./b',
    '/..',
    '/a/..',
    '/a/.',
    '/a/%2e%2e/b',
    '/a/.%2E/b',
    '/a//../b',
    '/a ',
    '/a\u007fb',
    '/a\u0001b',
    '/a$b&c=d;e,f:g@h[i]j~k!l*m(n)o+p',
  ])('%j는 같은 요청 줄로 간다', async (readyPath) => {
    const { legacy, now } = await requestsFor(readyPath);
    expect(now).toEqual(legacy);
    expect(now[0]?.host).toBe('127.0.0.1:<PORT>');
  });
});

describe('준비 확인 HARDENED: 컨테이너 상태를 읽지 못하면 HTTP가 맞아도 성공이 아니다', () => {
  it.each([['JSON이 아니다', 'not json'], ['출력이 없다', ''], ['State가 없다', '{"Service":"api"}\n'], ['모르는 State다', '{"Service":"api","State":"weird"}\n']])('ps 출력이 %s', async (_name, psOut) => {
    const scenario: ReadyScenario = { name: 'x', policy: { timeoutMs: 120 }, timing: true, script: (p) => ({ other: { out: port(p) }, ps: { out: psOut } }) };
    const { legacy, now } = await bothReady(scenario);
    // 옛 쪽은 상태를 읽지 못해도(unknown) HTTP가 연속으로 맞으면 준비됐다고 봤다
    expect(legacy.outcome.ok).toBe(true);
    expect(now.outcome).toMatchObject({ ok: false, name: 'ReadinessError', message: '0초 안에 준비되지 않았습니다 (마지막 확인: HTTP 200, 컨테이너 unknown)' });
    for (const event of now.events as Array<{ phase: string; probe?: { ok: boolean; containerState: string } }>) {
      if (event.phase === 'probing') expect(event.probe).toMatchObject({ ok: false, containerState: 'unknown' });
    }
  }, 30_000);
});

describe('ready.path HARDENED: 옛 쪽은 다른 호스트를 확인했고 새 쪽은 127.0.0.1만 확인한다(트러블슈팅 192)', () => {
  it.each([
    ['/\\example.com/', '/%5Cexample.com/'],
    ['/\t/example.com/', '/%09/example.com/'],
    ['/\n/example.com/', '/%0A/example.com/'],
    ['/\r/example.com/', '/%0D/example.com/'],
  ])('%j', async (readyPath, target) => {
    const { legacy, now, legacyUrl } = await requestsFor(readyPath);
    // 옛 쪽: URL이 example.com으로 풀려, 127.0.0.1 서버는 한 번도 받지 못하고 바깥 호스트에 대한 요청만 있었다
    expect(legacyUrl).toBe('http://example.com/');
    expect(legacy.every((request) => request.requestLine.startsWith('FOREIGN http://example.com/'))).toBe(true);
    expect(legacy.length).toBeGreaterThan(0);
    // 새 쪽: 요청은 127.0.0.1의 서버로만 가고, 경로는 요청 줄 안에 그대로 인코딩돼 들어간다
    expect(now.length).toBeGreaterThan(0);
    for (const request of now) {
      expect(request.requestLine).toBe(`GET ${target} HTTP/1.1`);
      expect(request.host).toBe('127.0.0.1:<PORT>');
    }
  });

  it.each([
    ['/a\\b/c', '/a/b/c', '/a%5Cb/c'],
    ['/a\tb', '/ab', '/a%09b'],
    ['/a\nb', '/ab', '/a%0Ab'],
  ])('같은 호스트 안의 경로도 %j는 더 인코딩해서 보낸다(옛 쪽은 %j)', async (readyPath, oldTarget, newTarget) => {
    const { legacy, now } = await requestsFor(readyPath);
    expect(legacy[0]?.requestLine).toBe(`GET ${oldTarget} HTTP/1.1`);
    expect(now[0]?.requestLine).toBe(`GET ${newTarget} HTTP/1.1`);
  });
});

// ── 모르는 프로세스 검사 ─────────────────────────────────────────────────

interface StrayScenario {
  name: string;
  managed?: string[];
  off?: string[];
  baseline?: Record<string, ScannedProcess[]>;
  script: Script;
  secrets?: Record<string, string>;
  abort?: boolean;
  /** 서비스가 둘 이상이라 호출 순서가 섞인다 */
  sortCalls?: boolean;
}

interface StrayObserved {
  outcome: { ok: true; reports: unknown } | { ok: false; name: string; message: string };
  baseline: Record<string, ScannedProcess[]>;
  calls: string[];
}

async function observeStray(kind: 'legacy' | 'now', scenario: StrayScenario, env: Env): Promise<StrayObserved> {
  const side = await fakeDocker(env, kind, scenario.script);
  const secrets = scenario.secrets ?? {};
  const redactor = new Redactor(secrets);
  const managed = scenario.managed ?? ['api'];
  const baseline = new Map<string, ScannedProcess[]>(Object.entries(scenario.baseline ?? {}));
  const controller = new AbortController();
  if (scenario.abort) controller.abort();
  const run = (args: string[], signal?: AbortSignal): Promise<ExecResult> => runCommand(side.bin, composeArgs(env, args), { signal, env: dockerEnv(secrets) });
  let outcome: StrayObserved['outcome'];
  if (kind === 'legacy') {
    const ctx: LegacyStrayContext = {
      exec: async (name, command, options) => {
        const result = await run(['exec', '-T', name, ...command], options?.signal);
        return { ...result, stdout: redactor.redact(result.stdout), stderr: redactor.redact(result.stderr) };
      },
      state: async (name) => parseContainerState((await run(['ps', '--all', '--format', 'json', name])).stdout),
      baseline,
      managedNames: managed,
      offServices: new Set(scenario.off ?? []),
    };
    outcome = await strayProcessesLegacy(ctx, { signal: controller.signal }).then(
      (reports) => ({ ok: true as const, reports }),
      (error: Error) => ({ ok: false as const, name: error.name, message: error.message }),
    );
  } else {
    const names = managed.filter((name) => !scenario.off?.includes(name));
    outcome = await strayProcessReports(
      { id: 'studio-p', project: { root: env.root, composePath: env.composePath }, dockerBin: side.bin, env: dockerEnv(secrets), overridePath: env.overridePath, secrets },
      names,
      baseline,
      controller.signal,
    ).then(
      (reports) => ({ ok: true as const, reports }),
      (error: Error) => ({ ok: false as const, name: error.name, message: error.message }),
    );
  }
  const calls = (await readCalls(side.state)).split('\n').filter(Boolean).map((line) => line.split(side.dir).join('<RUN>').split(env.dir).join('<ENV>'));
  return { outcome, baseline: Object.fromEntries(baseline), calls: scenario.sortCalls ? [...calls].sort() : calls };
}

const P = (pid: number, start: string, command = 'sh -c loop'): ScannedProcess => ({ pid, start, command });

const strayScenarios: StrayScenario[] = [
  { name: '기준선에 없던 프로세스만 알린다', baseline: { api: [P(7, '100', 'node')] }, script: { ps: { out: RUNNING }, exec: { out: '7 100 node\n15 200 sh -c loop\n' } } },
  { name: '기준선과 같으면 아무것도 알리지 않는다', baseline: { api: [P(7, '100', 'node'), P(15, '200')] }, script: { ps: { out: RUNNING }, exec: { out: '7 100 node\n15 200 sh -c loop\n' } } },
  { name: '기준선이 없으면 모두 모르는 프로세스다', script: { ps: { out: RUNNING }, exec: { out: '7 100 node\n15 200 sh -c loop\n' } } },
  { name: '같은 pid라도 시작 시각이 다르면 모르는 프로세스다', baseline: { api: [P(15, '999')] }, script: { ps: { out: RUNNING }, exec: { out: '15 200 sh -c loop\n' } } },
  { name: '멈춘 서비스는 건너뛴다(찾기를 돌리지 않는다)', script: { ps: { out: EXITED }, exec: { out: '7 100 node\n' } } },
  { name: '컨테이너가 없으면(ps 출력이 없다) 건너뛴다', script: { ps: { out: '' }, exec: { out: '7 100 node\n' } } },
  { name: '꺼 둔 서비스는 보지 않는다', off: ['api'], script: { ps: { out: RUNNING }, exec: { out: '7 100 node\n' } } },
  { name: '찾기가 실패하면 그 서비스는 오류로 보고한다', baseline: { api: [P(7, '100')] }, script: { ps: { out: RUNNING }, exec: { code: 3, err: '/proc/1/stat를 읽지 못했습니다\n' } } },
  { name: 'sh가 없으면 그 까닭으로 보고한다(127)', script: { ps: { out: RUNNING }, exec: { code: 127, err: '' } } },
  { name: 'sh가 없으면 그 까닭으로 보고한다(실행 파일을 찾지 못함)', script: { ps: { out: RUNNING }, exec: { code: 1, err: 'OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH' } } },
  { name: '종료 코드만 있고 stderr가 없으면 종료 코드를 알린다', script: { ps: { out: RUNNING }, exec: { code: 2, err: '' } } },
  { name: '명령 줄의 시크릿은 가려서 알린다', secrets: { TOKEN: 'SECRETVALUE1' }, script: { ps: { out: RUNNING }, exec: { out: '15 200 curl -H token=SECRETVALUE1\n' } } },
  { name: '오류의 시크릿도 가린다', secrets: { TOKEN: 'SECRETVALUE1' }, script: { ps: { out: RUNNING }, exec: { code: 1, err: 'boom SECRETVALUE1' } } },
  { name: '출력의 모양을 모르는 줄은 건너뛴다', script: { ps: { out: RUNNING }, exec: { out: 'noise\n20 5 b\n3 4 a\n\n' } } },
  { name: '상태를 읽지 못하면(JSON이 아님) 전체가 실패한다', script: { ps: { out: '{not json' }, exec: { out: '' } } },
  { name: '서비스 둘: 하나는 멈췄고 하나는 모르는 프로세스가 있다', managed: ['api', 'web'], sortCalls: true, script: { 'ps@api': { out: RUNNING }, 'ps@web': { out: '{"Service":"web","State":"exited"}\n' }, exec: { out: '15 200 sh -c loop\n' } } },
  { name: '이미 취소된 신호는 옛 runCommand처럼 등록 전 취소를 모른다(찾기는 끝까지 읽는다)', abort: true, script: { ps: { out: RUNNING }, exec: { out: '15 200 sh\n' } } },
];

describe('모르는 프로세스 검사가 옛 strayProcesses와 같다', () => {
  it.each(strayScenarios.map((scenario) => [scenario.name, scenario] as const))('%s', async (_name, scenario) => {
    const env = await environment();
    const legacy = await observeStray('legacy', scenario, env);
    const now = await observeStray('now', scenario, env);
    expect(now.outcome).toEqual(legacy.outcome);
    expect(now.baseline).toEqual(legacy.baseline);
    expect(now.calls).toEqual(legacy.calls);
  }, 30_000);

  it('시나리오 수', () => {
    expect(strayScenarios.length).toBeGreaterThanOrEqual(17);
  });
});

interface BaselineScenario {
  name: string;
  before?: ScannedProcess[];
  script: Script;
  secrets?: Record<string, string>;
}

const baselineScenarios: BaselineScenario[] = [
  { name: '읽으면 기준선으로 남긴다', script: { exec: { out: '7 100 node\n15 200 sh -c loop\n' } } },
  { name: '프로세스가 없어도(빈 목록) 기준선으로 남긴다', script: { exec: { out: '' } } },
  { name: '읽지 못하면 이전 기준선을 지운다', before: [P(7, '100')], script: { exec: { code: 3, err: '/proc/1/stat를 읽지 못했습니다' } } },
  { name: 'sh가 없어도 이전 기준선을 지운다', before: [P(7, '100')], script: { exec: { code: 127 } } },
  { name: '기준선의 명령 줄에서 시크릿은 가려진다', secrets: { TOKEN: 'SECRETVALUE1' }, script: { exec: { out: '15 200 curl token=SECRETVALUE1\n' } } },
];

describe('준비된 서비스의 프로세스 기준선이 옛 #recordProcessBaseline과 같다', () => {
  it.each(baselineScenarios.map((scenario) => [scenario.name, scenario] as const))('%s', async (_name, scenario) => {
    const env = await environment();
    const secrets = scenario.secrets ?? {};
    const redactor = new Redactor(secrets);
    const legacySide = await fakeDocker(env, 'legacy', scenario.script);
    const nowSide = await fakeDocker(env, 'now', scenario.script);
    const legacyBaseline = new Map<string, ScannedProcess[]>(scenario.before ? [['api', scenario.before]] : []);
    const nowBaseline = new Map<string, ScannedProcess[]>(scenario.before ? [['api', scenario.before]] : []);
    const legacyCtx: LegacyStrayContext = {
      exec: async (name, command) => {
        const result = await runCommand(legacySide.bin, composeArgs(env, ['exec', '-T', name, ...command]), { env: dockerEnv(secrets) });
        return { ...result, stdout: redactor.redact(result.stdout), stderr: redactor.redact(result.stderr) };
      },
      state: async () => 'running',
      baseline: legacyBaseline,
      managedNames: ['api'],
    };
    await recordProcessBaselineLegacy(legacyCtx, 'api');
    const found = await readProcessBaseline({ id: 'studio-p', project: { root: env.root, composePath: env.composePath }, dockerBin: nowSide.bin, env: dockerEnv(secrets), overridePath: env.overridePath, secrets }, 'api');
    if (found) nowBaseline.set('api', found);
    else nowBaseline.delete('api');
    expect(Object.fromEntries(nowBaseline)).toEqual(Object.fromEntries(legacyBaseline));
  });
});

// ── 인프라 확인 ──────────────────────────────────────────────────────────

interface InfraScenario {
  name: string;
  services: string[];
  script: Script;
  secrets?: Record<string, string>;
  abort?: boolean;
  /** 의도한 차이: 옛 쪽은 던졌고 새 쪽은 running이 아닌 것으로 읽는다 */
  intended?: boolean;
}

const ps = (...rows: Array<[string, string]>) => rows.map(([service, state]) => JSON.stringify({ Service: service, State: state })).join('\n') + '\n';

const infraScenarios: InfraScenario[] = [
  { name: '모두 running이면 아무것도 올리지 않는다', services: ['api'], script: { ps: { out: ps(['edge', 'running'], ['api', 'running']) } } },
  { name: '없는 서비스만 올리고 다시 확인한다', services: ['api', 'db'], script: { ps: [{ out: ps(['edge', 'running'], ['api', 'running']) }, { out: ps(['db', 'running']) }], up: {} } },
  { name: 'running이 아닌 서비스도 올린다(exited)', services: ['api'], script: { ps: [{ out: ps(['edge', 'exited'], ['api', 'running']) }, { out: ps(['edge', 'running']) }], up: {} } },
  { name: '올리지 못하면(up이 비0) 이유에 디스크 안내가 붙는다', services: ['api'], script: { ps: { out: ps(['edge', 'running']) }, up: { code: 1, err: 'write: no space left on device' } } },
  { name: '올렸는데도 running이 아니면 일부만 복구된 것으로 알린다', services: ['api', 'db'], script: { ps: [{ out: ps(['edge', 'running']) }, { out: ps(['api', 'running']) }], up: {} } },
  { name: '올린 뒤에도 하나도 없으면 모두 못 올린 것이다', services: ['api'], script: { ps: { out: '' }, up: {} } },
  { name: '시크릿이 든 up 실패는 가려서 알린다', services: ['api'], secrets: { TOKEN: 'SECRETVALUE1' }, script: { ps: { out: '' }, up: { code: 1, err: 'denied SECRETVALUE1' } } },
  { name: '이미 취소된 신호도 옛 runCommand처럼 ps를 끝까지 읽는다', services: ['api'], abort: true, script: { ps: { out: ps(['edge', 'running'], ['api', 'running']) }, up: {} } },
  { name: '의도한 차이: ps 출력을 해석하지 못하면 모두 running이 아니다(옛 쪽은 던졌다)', services: ['api'], intended: true, script: { ps: { out: '{not json' }, up: {} } },
];

interface InfraObserved {
  outcome: { ok: true; value: unknown } | { ok: false; name: string; message: string };
  calls: string[];
}

async function observeInfra(kind: 'legacy' | 'now', scenario: InfraScenario, env: Env): Promise<InfraObserved> {
  const side = await fakeDocker(env, kind, scenario.script);
  const secrets = scenario.secrets ?? {};
  const redactor = new Redactor(secrets);
  const controller = new AbortController();
  if (scenario.abort) controller.abort();
  const compose = (args: string[], signal?: AbortSignal): Promise<ExecResult> => runCommand(side.bin, composeArgs(env, args), { signal, env: dockerEnv(secrets) });
  const redact = (text: string) => redactor.redact(text);
  const run =
    kind === 'legacy'
      ? ensureInfraLegacy({ compose, redact } satisfies LegacyInfraContext, scenario.services, { signal: controller.signal })
      : ensureInfra(
          {
            id: 'studio-p',
            project: { root: env.root, composePath: env.composePath },
            dockerBin: side.bin,
            env: dockerEnv(secrets),
            overridePath: env.overridePath,
            secrets,
            edgeService: 'edge',
            compose,
            describeFailure: (stderr) => describeDockerFailure(redact(stderr)),
          } satisfies InfraContext,
          scenario.services,
          { signal: controller.signal },
        );
  const outcome = await run.then(
    (value) => ({ ok: true as const, value }),
    (error: Error) => ({ ok: false as const, name: error.name, message: error.message }),
  );
  return { outcome, calls: (await readCalls(side.state)).split('\n').filter(Boolean).map((line) => line.split(side.dir).join('<RUN>').split(env.dir).join('<ENV>')) };
}

describe('인프라 확인이 옛 ensureInfra와 같다', () => {
  it.each(infraScenarios.filter((scenario) => !scenario.intended).map((scenario) => [scenario.name, scenario] as const))('%s', async (_name, scenario) => {
    const env = await environment();
    const legacy = await observeInfra('legacy', scenario, env);
    const now = await observeInfra('now', scenario, env);
    expect(now.outcome).toEqual(legacy.outcome);
    expect(now.calls).toEqual(legacy.calls);
  }, 30_000);

  it('시나리오 수', () => {
    expect(infraScenarios.length).toBeGreaterThanOrEqual(9);
  });

  it('의도한 차이: ps 출력을 해석하지 못하면 옛 쪽은 던지고 새 쪽은 모두 running이 아닌 것으로 읽어 올린 뒤 다시 확인하고도 실패로 끝낸다', async () => {
    const scenario = infraScenarios.find((item) => item.intended)!;
    const env = await environment();
    const legacy = await observeInfra('legacy', scenario, env);
    const now = await observeInfra('now', scenario, env);
    expect(legacy.outcome.ok).toBe(false);
    expect(now.outcome).toEqual({ ok: true, value: { ok: false, recovered: [], missing: ['api', 'edge'], reason: '다시 올렸지만 api, edge 컨테이너가 여전히 running 상태가 아닙니다' } });
    // 통과가 아니다: 해석하지 못한 출력을 running으로 읽는 길은 없다
    expect(now.calls.filter((call) => call.includes(' up ')).length).toBe(1);
  });

  it('없는 목록이 비어 있으면 docker를 부르지 않는다', async () => {
    const env = await environment();
    const side = await fakeDocker(env, 'now', {});
    const missing = await missingServices({ id: 'studio-p', project: { root: env.root, composePath: env.composePath }, dockerBin: side.bin, env: dockerEnv(), overridePath: env.overridePath, secrets: {} }, [], undefined);
    expect(missing).toEqual([]);
    expect(await readCalls(side.state)).toBe('');
  });
});
