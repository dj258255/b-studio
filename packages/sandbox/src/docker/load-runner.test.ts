import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { LOAD_DEADLINE_MS, LOAD_REQUEST_TIMEOUT_MS, loadConfig, loadRunArgs, loadScript, loadThreads, parseLoadOutput } from './load-runner';

const RUNNER = new URL('../../load/runner.mjs', import.meta.url);

describe('loadThreads', () => {
  it('연결 250개마다 스레드 하나, 최대 4개', () => {
    expect(loadThreads(1, 12)).toBe(1);
    expect(loadThreads(250, 12)).toBe(1);
    expect(loadThreads(251, 12)).toBe(2);
    expect(loadThreads(1000, 12)).toBe(4);
  });

  it('도커가 쓸 수 있는 CPU의 절반을 넘지 않는다. CPU 수를 모르면 하나만 쓴다', () => {
    expect(loadThreads(1000, 4)).toBe(2);
    expect(loadThreads(1000, 2)).toBe(1);
    expect(loadThreads(1000, 1)).toBe(1);
    expect(loadThreads(1000, undefined)).toBe(1);
  });
});

describe('loadRunArgs', () => {
  const args = loadRunArgs({ name: 'studio-shop-abc-load-1', network: 'studio-shop-abc_b-studio-sandbox', sandboxId: 'studio-shop-abc', threads: 4 });

  it('샌드박스의 internal 네트워크에만 붙이고, 끝나면 지워지며, 이미지를 새로 받지 않는다', () => {
    expect(args.slice(0, 5)).toEqual(['run', '--rm', '--interactive', '--pull', 'never']);
    expect(args[args.indexOf('--network') + 1]).toBe('studio-shop-abc_b-studio-sandbox');
    expect(args.filter((arg) => arg === '--network')).toHaveLength(1);
    expect(args[args.indexOf('--name') + 1]).toBe('studio-shop-abc-load-1');
    expect(args).toContain('b-studio.sandbox=studio-shop-abc');
  });

  it('호스트의 파일·포트·환경 변수를 주지 않고 권한을 내려놓는다', () => {
    for (const flag of ['--volume', '-v', '--mount', '--publish', '-p', '--env', '-e', '--env-file', '--privileged', '--pid', '--cap-add', '--device']) expect(args).not.toContain(flag);
    expect(args).toContain('--read-only');
    expect(args[args.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(args[args.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
    expect(args[args.indexOf('--user') + 1]).toBe('65534:65534');
  });

  it('스레드 수만큼 CPU를 주고 메모리·프로세스 수를 묶는다', () => {
    expect(args[args.indexOf('--cpus') + 1]).toBe('4');
    expect(args[args.indexOf('--memory') + 1]).toBe('512m');
    expect(args[args.indexOf('--pids-limit') + 1]).toBe('256');
  });

  it('스크립트는 표준 입력으로만 받는다', () => {
    expect(args.slice(-3)).toEqual(['node', '--input-type=module', '-']);
  });

  it('샌드박스가 쓰는 런타임이 있으면 같은 런타임으로 돌린다', () => {
    const isolated = loadRunArgs({ name: 'n', network: 'net', sandboxId: 'id', threads: 1, runtime: 'runsc' });
    expect(isolated[isolated.indexOf('--runtime') + 1]).toBe('runsc');
    expect(args).not.toContain('--runtime');
  });
});

describe('loadConfig · loadScript', () => {
  it('대상은 서비스 이름과 컨테이너 포트로만 정해진다', () => {
    const config = loadConfig({ service: 'api', method: 'POST', path: '/orders?x={{seq}}', body: '{"a":"\'`${x}"}', headers: { 'X-Key': '{{uuid}}' }, concurrent: 10, requests: 20, latencyOf: [409] }, { port: 8080, threads: 2 });
    expect(config).toEqual({
      host: 'api',
      port: 8080,
      method: 'POST',
      path: '/orders?x={{seq}}',
      headers: { 'X-Key': '{{uuid}}' },
      body: '{"a":"\'`${x}"}',
      requests: 20,
      concurrent: 10,
      warmup: 0,
      latencyOf: [409],
      threads: 2,
      requestTimeoutMs: LOAD_REQUEST_TIMEOUT_MS,
      deadlineMs: LOAD_DEADLINE_MS,
    });
    // 본문에 따옴표·백틱·${}가 있어도 스크립트의 코드가 되지 않는다
    const script = loadScript('RUNNER', config);
    expect(script.endsWith('\nRUNNER')).toBe(true);
    const literal = script.slice('globalThis.B_STUDIO_LOAD = '.length, script.indexOf(';\nRUNNER'));
    expect(JSON.parse(literal)).toEqual(config);
  });
});

const VALID = {
  requests: 10,
  concurrent: 5,
  threads: 1,
  completed: 9,
  elapsedMs: 12.3,
  statuses: { '200': 8, '409': 1 },
  errors: { TIMEOUT: 1 },
  latency: { count: 9, p50: 1, p95: 2, p99: 3, max: 4 },
  connect: { count: 5, p50: 1, p95: 2, p99: 3, max: 4, errors: 0 },
  loopDelay: { p99: 1.5, max: 2 },
  warmup: { requests: 0, errors: 0 },
};
const request = { requests: 10, concurrent: 5 };

describe('parseLoadOutput', () => {
  it('마지막 줄의 결과를 읽는다', () => {
    expect(parseLoadOutput(`경고 한 줄\n\n${JSON.stringify(VALID)}\n`, request)).toEqual(VALID);
  });

  it('표본이 없으면 count만 0으로 읽는다', () => {
    const empty = { ...VALID, completed: 0, statuses: {}, errors: { ECONNREFUSED: 10 }, latency: { count: 0 }, connect: { count: 0, errors: 5 } };
    expect(parseLoadOutput(JSON.stringify(empty), request)).toMatchObject({ completed: 0, latency: { count: 0 }, connect: { count: 0, errors: 5 } });
  });

  it.each([
    ['빈 출력', ''],
    ['JSON이 아님', 'Error: boom'],
    ['배열', '[]'],
    ['필드 없음', JSON.stringify({ requests: 10 })],
    ['받은 응답 수가 상태 코드 합과 다름', JSON.stringify({ ...VALID, completed: 10 })],
    ['응답과 실패의 합이 보낸 수보다 적음(덜 센 결과)', JSON.stringify({ ...VALID, errors: {} })],
    ['요청 수가 요청한 것과 다름', JSON.stringify({ ...VALID, requests: 5, statuses: { '200': 4 }, completed: 4 })],
    ['동시 수가 요청한 것과 다름', JSON.stringify({ ...VALID, concurrent: 1 })],
    ['응답 시간 표본이 받은 응답보다 많음', JSON.stringify({ ...VALID, latency: { ...VALID.latency, count: 10 } })],
    ['응답 시간이 숫자가 아님', JSON.stringify({ ...VALID, latency: { ...VALID.latency, p95: 'fast' } })],
    ['음수 응답 시간', JSON.stringify({ ...VALID, latency: { ...VALID.latency, p95: -1 } })],
    ['상태 코드가 아닌 키', JSON.stringify({ ...VALID, statuses: { ok: 9 } })],
    ['건수가 정수가 아님', JSON.stringify({ ...VALID, statuses: { '200': 8.5, '409': 0.5 } })],
  ])('%s이면 읽지 못한 것으로 돌려준다', (_label, stdout) => {
    expect(parseLoadOutput(stdout, request)).toBeUndefined();
  });
});

describe('runner.mjs (실제로 실행한다)', () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
      }),
    );
  });

  /** 받은 요청을 기록하고 handler가 정한 대로 답하는 서버 */
  async function target(handler: (request: { url: string; headers: http.IncomingHttpHeaders; body: string }) => { status: number; delayMs?: number } | undefined) {
    const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const entry = { url: req.url ?? '', headers: req.headers, body };
        seen.push(entry);
        const answer = handler(entry);
        if (!answer) return; // 응답하지 않는다
        setTimeout(() => {
          res.writeHead(answer.status, { 'content-type': 'application/json' });
          res.end('{}');
        }, answer.delayMs ?? 0);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as AddressInfo).port, seen };
  }

  async function run(config: Record<string, unknown>): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const script = loadScript(await readFile(RUNNER, 'utf8'), { host: '127.0.0.1', method: 'GET', path: '/', warmup: 0, threads: 1, requestTimeoutMs: 2000, deadlineMs: 10_000, ...config });
    const child = spawn(process.execPath, ['--input-type=module', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.stdin.end(script);
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    return { stdout, stderr, code };
  }

  it('요청마다 번호와 새 값을 채워 보내고 상태 코드별로 센다', async () => {
    const { port, seen } = await target(({ url }) => ({ status: Number(url.split('/').at(-1)) % 5 === 0 ? 201 : 409 }));
    const { stdout, code, stderr } = await run({ port, method: 'POST', path: '/orders/{{seq}}', headers: { 'X-Key': 'k-{{uuid}}' }, body: '{"n":{{seq}}}', requests: 40, concurrent: 10 });

    expect(stderr).toBe('');
    expect(code).toBe(0);
    const result = parseLoadOutput(stdout, { requests: 40, concurrent: 10 });
    expect(result).toMatchObject({ completed: 40, statuses: { '201': 8, '409': 32 }, errors: {}, threads: 1, warmup: { requests: 0, errors: 0 } });
    expect(result?.latency.count).toBe(40);
    expect(result?.connect).toMatchObject({ count: 10, errors: 0 });
    // 번호는 1부터 겹치지 않게, 새 값은 요청마다 다르게
    expect(seen.map((entry) => Number(entry.url.split('/').at(-1))).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    expect(new Set(seen.map((entry) => entry.headers['x-key'])).size).toBe(40);
    for (const entry of seen) {
      expect(entry.body).toBe(`{"n":${entry.url.split('/').at(-1)}}`);
      expect(entry.headers['content-type']).toBe('application/json');
      expect(entry.headers.host).toBe(`127.0.0.1:${port}`);
    }
  });

  it('latencyOf를 주면 그 상태 코드의 응답만 응답 시간에 넣는다', async () => {
    const { port } = await target(({ url }) => ({ status: Number(url.split('/').at(-1)) <= 3 ? 201 : 409 }));
    const { stdout } = await run({ port, path: '/{{seq}}', requests: 20, concurrent: 5, latencyOf: [409] });
    const result = parseLoadOutput(stdout, { requests: 20, concurrent: 5 });
    expect(result?.statuses).toEqual({ '201': 3, '409': 17 });
    expect(result?.latency.count).toBe(17);
  });

  it('응답 시간에 서버가 쓴 시간이 들어간다', async () => {
    const { port } = await target(() => ({ status: 200, delayMs: 80 }));
    const { stdout } = await run({ port, requests: 10, concurrent: 10 });
    const result = parseLoadOutput(stdout, { requests: 10, concurrent: 10 });
    expect(result?.latency.p50).toBeGreaterThanOrEqual(75);
    expect(result?.latency.max).toBeLessThan(1000);
  });

  it('GET에는 본문을 보내지 않는다', async () => {
    const { port, seen } = await target(() => ({ status: 200 }));
    await run({ port, method: 'GET', body: '{"a":1}', requests: 2, concurrent: 1 });
    expect(seen.map((entry) => entry.body)).toEqual(['', '']);
  });

  it('준비 요청은 세지 않고, 재는 요청의 번호는 그 뒤부터 이어진다', async () => {
    const { port, seen } = await target(() => ({ status: 200 }));
    const { stdout } = await run({ port, path: '/{{seq}}', requests: 10, concurrent: 5, warmup: 6 });
    const result = parseLoadOutput(stdout, { requests: 10, concurrent: 5 });
    expect(result).toMatchObject({ completed: 10, warmup: { requests: 6, errors: 0 } });
    expect(seen).toHaveLength(16);
    expect(seen.map((entry) => Number(entry.url.slice(1))).sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, index) => index + 1));
  });

  it('스레드로 나눠도 요청 수와 번호가 맞는다', async () => {
    const { port, seen } = await target(() => ({ status: 200 }));
    const { stdout } = await run({ port, path: '/{{seq}}', requests: 25, concurrent: 10, threads: 3 });
    const result = parseLoadOutput(stdout, { requests: 25, concurrent: 10 });
    expect(result).toMatchObject({ completed: 25, threads: 3 });
    expect(result?.connect.count).toBe(10);
    expect(new Set(seen.map((entry) => entry.url)).size).toBe(25);
  });

  it('제한 시간 안에 응답하지 않은 요청은 응답을 받지 못한 요청으로 센다', async () => {
    const { port } = await target(({ url }) => (url === '/1' ? undefined : { status: 200 }));
    const { stdout } = await run({ port, path: '/{{seq}}', requests: 4, concurrent: 4, requestTimeoutMs: 300 });
    const result = parseLoadOutput(stdout, { requests: 4, concurrent: 4 });
    expect(result).toMatchObject({ completed: 3, errors: { TIMEOUT: 1 } });
    expect(result?.latency.count).toBe(3);
  });

  it('전체 제한 시간을 넘기면 남은 요청을 보내지 않고 그 수를 남긴다', async () => {
    const { port } = await target(() => ({ status: 200, delayMs: 200 }));
    const { stdout } = await run({ port, requests: 50, concurrent: 1, deadlineMs: 500 });
    const result = parseLoadOutput(stdout, { requests: 50, concurrent: 1 });
    expect(result?.completed).toBeGreaterThan(0);
    expect(result?.completed).toBeLessThan(10);
    expect(result?.errors.DEADLINE).toBe(50 - (result?.completed ?? 0));
  });

  it('연결할 수 없으면 모두 응답을 받지 못한 요청이다', async () => {
    const { port } = await target(() => ({ status: 200 }));
    await new Promise((resolve) => servers[0]!.close(resolve));
    const { stdout } = await run({ port, requests: 3, concurrent: 3 });
    const result = parseLoadOutput(stdout, { requests: 3, concurrent: 3 });
    expect(result).toMatchObject({ completed: 0, errors: { ECONNREFUSED: 3 }, latency: { count: 0 } });
    expect(result?.connect.errors).toBe(3);
  });
});
