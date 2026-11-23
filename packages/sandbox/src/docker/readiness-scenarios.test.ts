import { readFileSync } from 'node:fs';
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
import { runCommand } from '../stream-exec';
import type { ExecResult, ServiceEndpoint, ServiceStatusEvent } from '../types';
import { composeEnvironment } from './compose-env';
import { describeDockerFailure } from './compose-provider';
import { edgePortFor } from '../edge-config';
import { awaitReady, ensureInfra, missingServices, type InfraContext, type ReadyContext } from './ready';

/**
 * 준비 확인·인프라 확인(ADR-195 4f A4c-3a) 시험: Rust 함수 + TS 껍데기가 **같은 가짜 docker, 같은 127.0.0.1 시험 서버**에서 결과·이벤트 순서·docker 호출 순서를 내는지 본다.
 * 진짜 docker도 바깥 네트워크도 쓰지 않는다 — 가짜 docker는 준비한 출력을 호출 순서대로 내놓는 셸 스크립트, 서버는 127.0.0.1에 띄운 net 서버다.
 * 옛 TS 사본과 견주던 시험(#1347에서 사본을 지웠다)에서 사본과 무관한 확인만 남겼다. `HARDENED`·`의도한 차이` 표시는 옛 쪽보다 더 막거나 다르게 하는 동작이다.
 * ready.path가 요청 줄로 바뀌는 규칙의 기대값은 옛 쪽(`fetch`)이 보낸 줄을 `readiness-request-targets.json`에 고정한 것이다.
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

async function observeReady(scenario: ReadyScenario, env: Env): Promise<ReadyObserved> {
  const server = scenario.replies === 'closed' ? { port: await closedPort(), requests: [] as Request[] } : await listen(scenario.replies ?? [{ status: 200 }]);
  const side = await fakeDocker(env, 'now', scenario.script(server.port));
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
  const result: Promise<ServiceEndpoint> = awaitReady(ctx, 'api', options);
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

async function runReady(scenario: ReadyScenario) {
  const env = await environment();
  const now = await observeReady(scenario, env);
  return { now };
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

describe('준비 확인', () => {
  it('일시 오류 재시도는 이벤트 순서가 probing → starting → onTransientRetry 뒤 starting → probing → ready이다', async () => {
    const scenario = readyScenarios.find((item) => item.name.startsWith('재시도: 일시 오류'))!;
    const { now } = await runReady(scenario);
    expect((now.events as Array<{ phase: string }>).map((event) => event.phase)).toEqual(['probing', 'starting', 'probing', 'probing', 'ready']);
    expect(now.retries).toEqual([{ service: 'api', reason: 'Error: spawn ETXTBSY' }]);
    // 호출 순서: port → ps → logs → up → port → ps → ps
    expect(now.calls.map((call) => call.split(' ').find((word) => ['port', 'ps', 'logs', 'up'].includes(word)))).toEqual(['port', 'ps', 'logs', 'up', 'port', 'ps', 'ps']);
  });
});

// ── 요청 줄 ──────────────────────────────────────────────────────────────

/** ready.path를 Rust 쪽이 서버에 어떻게 보내는지 */
async function requestsFor(readyPath: string): Promise<Request[]> {
  const nowServer = await listen([{ status: 200 }]);
  const env = await environment();
  const spec = SPEC({ path: readyPath, expectStatus: 200 });
  const policy: ReadinessPolicy = { successThreshold: 1, timeoutMs: 1_500, intervalMs: 5 };
  const nowSide = await fakeDocker(env, 'now', okScript(nowServer.port));
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
  return nowServer.requests.map((request) => ({ requestLine: request.requestLine, host: request.host?.replace(String(nowServer.port), '<PORT>'), headers: request.headers }));
}

// 기대값(요청 줄의 경로)은 옛 쪽(fetch)이 같은 경로에 보낸 줄이다. 옛 쪽을 지우기 전에 한 번 재서 JSON으로 고정했다
const REQUEST_TARGETS = JSON.parse(readFileSync(new URL('./readiness-request-targets.json', import.meta.url), 'utf8')) as Array<[string, string]>;

describe('ready.path를 요청 줄로 바꾸는 규칙이 fetch와 같다', () => {
  it.each(REQUEST_TARGETS)('%j는 %j로 간다', async (readyPath, target) => {
    const now = await requestsFor(readyPath);
    expect(now.map((request) => request.requestLine)).toEqual([`GET ${target} HTTP/1.1`]);
    expect(now[0]?.host).toBe('127.0.0.1:<PORT>');
  }, 60_000);

  it('고정한 기대값이 35개다', () => {
    expect(REQUEST_TARGETS.length).toBe(35);
  });
});

describe('준비 확인 HARDENED: 컨테이너 상태를 읽지 못하면 HTTP가 맞아도 성공이 아니다', () => {
  it.each([['JSON이 아니다', 'not json'], ['출력이 없다', ''], ['State가 없다', '{"Service":"api"}\n'], ['모르는 State다', '{"Service":"api","State":"weird"}\n']])('ps 출력이 %s', async (_name, psOut) => {
    const scenario: ReadyScenario = { name: 'x', policy: { timeoutMs: 120 }, timing: true, script: (p) => ({ other: { out: port(p) }, ps: { out: psOut } }) };
    const { now } = await runReady(scenario);
    // 옛 쪽은 상태를 읽지 못해도(unknown) HTTP가 연속으로 맞으면 준비됐다고 봤다
    expect(now.outcome).toMatchObject({ ok: false, name: 'ReadinessError', message: '0초 안에 준비되지 않았습니다 (마지막 확인: HTTP 200, 컨테이너 unknown)' });
    for (const event of now.events as Array<{ phase: string; probe?: { ok: boolean; containerState: string } }>) {
      if (event.phase === 'probing') expect(event.probe).toMatchObject({ ok: false, containerState: 'unknown' });
    }
  }, 30_000);
});

describe('ready.path HARDENED: 127.0.0.1만 확인한다(옛 쪽은 다른 호스트를 확인했다, 트러블슈팅 192)', () => {
  it.each([
    ['/\\example.com/', '/%5Cexample.com/'],
    ['/\t/example.com/', '/%09/example.com/'],
    ['/\n/example.com/', '/%0A/example.com/'],
    ['/\r/example.com/', '/%0D/example.com/'],
  ])('%j', async (readyPath, target) => {
    const now = await requestsFor(readyPath);
    // 옛 쪽은 URL이 example.com으로 풀려 127.0.0.1 서버는 한 번도 받지 못했다. 새 쪽: 요청은 127.0.0.1의 서버로만 가고, 경로는 요청 줄 안에 그대로 인코딩돼 들어간다
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
    const now = await requestsFor(readyPath);
    expect(now[0]?.requestLine).toBe(`GET ${newTarget} HTTP/1.1`);
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

const intendedScenario: InfraScenario = { name: '의도한 차이: ps 출력을 해석하지 못하면 모두 running이 아니다', services: ['api'], intended: true, script: { ps: { out: '{not json' }, up: {} } };

interface InfraObserved {
  outcome: { ok: true; value: unknown } | { ok: false; name: string; message: string };
  calls: string[];
}

async function observeInfra(scenario: InfraScenario, env: Env): Promise<InfraObserved> {
  const side = await fakeDocker(env, 'now', scenario.script);
  const secrets = scenario.secrets ?? {};
  const redactor = new Redactor(secrets);
  const controller = new AbortController();
  if (scenario.abort) controller.abort();
  const compose = (args: string[], signal?: AbortSignal): Promise<ExecResult> => runCommand(side.bin, composeArgs(env, args), { signal, env: dockerEnv(secrets) });
  const redact = (text: string) => redactor.redact(text);
  const run = ensureInfra(
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

describe('인프라 확인', () => {
  it('의도한 차이: ps 출력을 해석하지 못하면 옛 쪽은 던지고 새 쪽은 모두 running이 아닌 것으로 읽어 올린 뒤 다시 확인하고도 실패로 끝낸다', async () => {
    const scenario = intendedScenario;
    const env = await environment();
    const now = await observeInfra(scenario, env);
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
