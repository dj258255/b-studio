import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { LocalDockerProvider } from './compose-provider';

/**
 * ready.path로 다른 호스트를 확인하던 결함(트러블슈팅 192)을 고정하는 시험. 진짜 docker도 바깥 네트워크도 쓰지 않는다:
 * docker는 가짜 셸 스크립트, 서버는 127.0.0.1의 시험 서버, 옛 구현이 부르던 전역 fetch는 기록만 하고 바깥 주소에는 응답을 지어낸다.
 */

const roots: string[] = [];
const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

interface Received {
  requestLine: string;
  host: string | undefined;
}

async function listen(): Promise<{ port: number; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    received.push({ requestLine: `${request.method} ${request.url}`, host: request.headers.host });
    response.statusCode = 200;
    response.end('ok');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, received };
}

async function fakeDocker(dir: string, state: string, script: Record<string, string>): Promise<string> {
  await mkdir(state, { recursive: true });
  const scripts = path.join(dir, 'script');
  await mkdir(scripts, { recursive: true });
  for (const [name, value] of Object.entries(script)) await writeFile(path.join(scripts, name), value);
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
if [ "$key" = ps ]; then for a in "$@"; do [ "$a" = --quiet ] && { echo c1; exit 0; }; done; fi
n=$(cat "$S/n.$key" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$S/n.$key"
if [ -f "$D/$key.$n.out" ]; then cat "$D/$key.$n.out"; elif [ -f "$D/$key.out" ]; then cat "$D/$key.out"; fi
if [ -f "$D/$key.$n.code" ]; then exit "$(cat "$D/$key.$n.code")"; elif [ -f "$D/$key.code" ]; then exit "$(cat "$D/$key.code")"; fi
exit 0
`,
  );
  await chmod(bin, 0o755);
  return bin;
}

const project = (root: string, readyPath: string): LoadedProject =>
  ({
    spec: { name: 'p' },
    root,
    composePath: path.join(root, 'compose.yaml'),
    managed: [['api', { template: 'node', path: '.', port: 3000, ready: { path: readyPath, expectStatus: 200 } }]],
    composeServices: ['api'],
    sharedVolumes: [],
    external: [],
  }) as unknown as LoadedProject;

interface Run {
  sandbox: Awaited<ReturnType<LocalDockerProvider['create']>>;
  foreign: string[];
  received: Received[];
  port: number;
  calls: string[];
  events: string[];
  retries: unknown[];
  /** 지금까지 부른 docker 인자(호출마다 다시 읽는다) */
  readCalls: () => Promise<string[]>;
  /** `restart`가 던진 오류(`expectFailure`일 때) */
  error?: unknown;
}

interface RunOptions {
  secrets?: Record<string, string>;
  /** 꺼 둔 서비스 */
  off?: string[];
  /** 다시 켜지 않고 샌드박스만 만든다 */
  skipRestart?: boolean;
  expectFailure?: boolean;
}

async function restartWith(readyPath: string, extra: Record<string, string> = {}, opts: RunOptions = {}): Promise<Run> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'ready-hardened-')));
  roots.push(dir);
  const root = path.join(dir, 'proj');
  await mkdir(path.join(root, '.git', 'b-studio'), { recursive: true });
  await writeFile(path.join(root, '.git', 'config'), '[core]\n\tbare = false\n');
  const { port, received } = await listen();
  const container = (mounts: object[], id: string) =>
    JSON.stringify([
      {
        Id: 'c1',
        Name: '/c1',
        Config: { Labels: { 'com.docker.compose.service': 'api' } },
        HostConfig: { NetworkMode: `${id}_b-studio-sandbox` },
        NetworkSettings: { Networks: { [`${id}_b-studio-sandbox`]: {} } },
        Mounts: mounts,
      },
    ]);
  const mounts = [
    { Type: 'bind', Source: root, Destination: '/app', RW: true },
    { Type: 'bind', Source: path.join(root, '.git'), Destination: '/app/.git', RW: false },
    { Type: 'bind', Source: path.join(root, '.git', 'b-studio-empty'), Destination: '/app/.git/b-studio', RW: false },
  ];
  const bin = await fakeDocker(dir, path.join(dir, 'state'), {
    'config.out': JSON.stringify({ services: { api: { volumes: [{ type: 'bind', source: root, target: '/app' }] } } }),
    'ps.out': '{"Service":"api","State":"running"}\n',
    'volume.out': '[]',
    'other.out': `0.0.0.0:${port}\n`,
    ...extra,
  });
  // 옛 구현이 부르는 전역 fetch: 127.0.0.1만 진짜로 보내고, 그 밖의 주소는 응답을 지어내 기록만 한다(바깥에는 접속하지 않는다)
  const foreign: string[] = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (new URL(url).hostname === '127.0.0.1') return realFetch(url, init);
    foreign.push(url);
    return new Response(null, { status: 200 });
  });
  const loaded = { ...project(root, readyPath), ...(opts.off ? { offServices: new Set(opts.off) } : {}) } as LoadedProject;
  const sandbox = await new LocalDockerProvider({ dockerBin: bin, readiness: { intervalMs: 5, timeoutMs: 5_000, successThreshold: 2 }, dependencyPollMs: 1 }).create(loaded, opts.secrets ? { secrets: opts.secrets } : {});
  await writeFile(path.join(dir, 'script', 'inspect.out'), container(mounts, sandbox.id));
  const events: string[] = [];
  const retries: unknown[] = [];
  let error: unknown;
  if (!opts.skipRestart) {
    await sandbox.restart('api', { onStatus: (event) => events.push(event.phase), onTransientRetry: (event) => retries.push(event) }).catch((caught: unknown) => {
      if (!opts.expectFailure) throw caught;
      error = caught;
    });
  }
  const readCalls = async () => (await readFile(path.join(dir, 'state', 'calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { sandbox, foreign, received, port, calls: await readCalls(), readCalls, events, retries, ...(error === undefined ? {} : { error }) };
}

describe('ready.path가 다른 호스트를 가리킬 수 없다(트러블슈팅 192)', () => {
  it.each([
    ['/\\example.com/', '/%5Cexample.com/'],
    ['/\t/example.com/', '/%09/example.com/'],
    ['/\n/example.com/', '/%0A/example.com/'],
  ])('%j는 127.0.0.1의 경로로만 간다', async (readyPath, target) => {
    const { foreign, received, port } = await restartWith(readyPath);
    expect(foreign).toEqual([]);
    expect(received.length).toBeGreaterThanOrEqual(2);
    for (const request of received) {
      expect(request.requestLine).toBe(`GET ${target}`);
      expect(request.host).toBe(`127.0.0.1:${port}`);
    }
  }, 30_000);
});

describe('LocalDockerSandbox: 일시 오류로 죽어 다시 만들 때도 만들기 반복(#upQueue·확인·시작)을 지난다', () => {
  it('ETXTBSY로 죽으면 up --force-recreate가 확인·시작까지 한 번 더 돌고 두 번째 시도에서 준비된다', async () => {
    const exited = '{"Service":"api","State":"exited"}\n';
    const running = '{"Service":"api","State":"running"}\n';
    const { calls, events, retries } = await restartWith('/', {
      'ps.1.out': exited,
      'ps.out': running,
      'other.2.out': 'api-1  | 2026-01-01T00:00:01Z Error: spawn ETXTBSY\n',
    });
    expect(events.length).toBeGreaterThan(0);
    expect(retries).toEqual([{ service: 'api', reason: 'Error: spawn ETXTBSY' }]);
    const verb = (call: string) => call.split(' ').find((word) => ['up', 'ps', 'logs', 'start', 'port', 'inspect'].includes(word));
    const flow = calls.map(verb);
    // 만들기(up --no-start)는 다시 만들기 때도 한 번 더 돌고, 시작은 확인한 컨테이너의 id로 한다
    expect(flow.filter((word) => word === 'up')).toHaveLength(2);
    expect(calls.filter((call) => call.includes(' up ') && call.includes('--force-recreate') && call.includes('--no-start'))).toHaveLength(2);
    expect(calls.filter((call) => call.startsWith('start c1'))).toHaveLength(2);
    expect(events.filter((phase) => phase === 'starting')).toHaveLength(2);
    expect(events.at(-1)).toBe('ready');
  }, 30_000);
});

describe('LocalDockerSandbox: 모르는 프로세스 검사는 준비된 뒤 남긴 기준선과 견준다(#765)', () => {
  const running = '{"Service":"api","State":"running"}\n';

  it('준비되면 프로세스 목록을 기준선으로 남기고, 그 뒤 검사는 기준선에 없던 것만 알린다', async () => {
    const { sandbox } = await restartWith('/', { 'exec.1.out': '7 100 node\n', 'exec.2.out': '7 100 node\n15 200 sh -c loop\n', 'ps.out': running });
    expect(await sandbox.strayProcesses!()).toEqual([{ service: 'api', processes: [{ pid: 15, command: 'sh -c loop' }] }]);
  }, 30_000);

  it('기준선을 읽지 못하면 이전 기준선을 지워서, 다음 검사가 모든 프로세스를 모르는 것으로 본다', async () => {
    // exec 1번째: 첫 준비의 기준선(7번), 2번째: 다시 켠 뒤의 기준선 읽기(실패), 3번째: 검사
    const { sandbox } = await restartWith('/', { 'exec.1.out': '7 100 node\n', 'exec.2.code': '3', 'exec.3.out': '7 100 node\n', 'ps.out': running });
    await sandbox.restart('api');
    expect(await sandbox.strayProcesses!()).toEqual([{ service: 'api', processes: [{ pid: 7, command: 'node' }] }]);
  }, 30_000);
});

describe('LocalDockerSandbox: 시크릿과 꺼 둔 서비스', () => {
  it('죽은 컨테이너의 앱 로그에 든 시크릿은 가려서 실패 이유에 붙는다', async () => {
    const { error } = await restartWith(
      '/',
      { 'ps.out': '{"Service":"api","State":"exited"}\n', 'other.2.out': 'api-1  | 2026-01-01T00:00:01Z Error: bad token SECRETVALUE1\n' },
      { secrets: { TOKEN: 'SECRETVALUE1' }, expectFailure: true },
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('앱 로그 마지막 줄:\nError: bad token');
    expect(message).not.toContain('SECRETVALUE1');
  }, 30_000);

  it('찾기 결과의 명령 줄에 든 시크릿도 가려서 알린다', async () => {
    const { sandbox } = await restartWith('/', { 'exec.1.out': '', 'exec.2.out': '15 200 curl token=SECRETVALUE1\n' }, { secrets: { TOKEN: 'SECRETVALUE1' } });
    const reports = await sandbox.strayProcesses!();
    expect(JSON.stringify(reports)).not.toContain('SECRETVALUE1');
    expect(reports).toHaveLength(1);
  }, 30_000);

  it('꺼 둔 서비스는 상태도 찾기도 하지 않는다', async () => {
    const { sandbox, calls } = await restartWith('/', { 'exec.out': '15 200 sh\n' }, { off: ['api'], skipRestart: true });
    expect(await sandbox.strayProcesses!()).toEqual([]);
    expect(calls.filter((call) => call.includes(' exec '))).toEqual([]);
  }, 30_000);
});

describe('LocalDockerSandbox.ensureInfra: 없는 컨테이너를 올리는 up도 만들기 반복을 지난다', () => {
  it('확인(ps)은 Rust가 하고, 올리는 up은 만들기 → 확인 → 확인한 컨테이너 시작을 거친 뒤 다시 확인한다', async () => {
    const { sandbox, readCalls } = await restartWith(
      '/',
      { 'ps.1.out': '{"Service":"b-studio-edge","State":"running"}\n', 'ps.2.out': '{"Service":"api","State":"running"}\n' },
      { skipRestart: true },
    );
    const result = await sandbox.ensureInfra!(['api']);
    expect(result).toEqual({ ok: true, recovered: ['api'] });
    const calls = await readCalls();
    // 없는 서비스만, 이미지를 다시 빌드하지 않고(--build 없음) 만든 뒤(--no-start) 확인한 컨테이너의 id로 시작한다
    const created = calls.filter((call) => call.includes(' up ') && call.includes('--no-start'));
    expect(created).toHaveLength(1);
    expect(created[0]).toContain('--no-deps');
    expect(created[0]).not.toContain('--build');
    expect(created[0]!.endsWith(' api')).toBe(true);
    expect(calls.filter((call) => call.startsWith('start c1'))).toHaveLength(1);
    // 올리기 전·뒤에 두 번 확인한다(첫 확인은 edge·api 둘, 다시 확인은 올린 것만)
    const checks = calls.filter((call) => call.includes('ps --all --format json'));
    expect(checks.map((call) => call.split('ps --all --format json ')[1])).toEqual(['api b-studio-edge', 'api']);
  }, 30_000);
});
