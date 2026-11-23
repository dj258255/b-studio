import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHookServer, type HookServer } from './hook-server';

/**
 * 훅 서버의 전송(ADR-201, 4f A7a)의 처리 시간과 동시성을 새 서버만으로 확인한다: 느린 처리 중에도 연결을 끊지 않고, 머리를 천천히 보내도 답하고,
 * 느린 요청이 도는 동안 빠른 요청이 막히지 않고, keep-alive·파이프라인에서도 두 번째 요청이 판정을 거친다.
 * 옛 `node:http` 서버 사본과 같은 원시 HTTP 요청을 견주던 시험(`hook-server-differential.test.ts`)에서 사본과 무관한 확인만 남겼다(#1347).
 */

interface Seen {
  route: string;
  input: unknown;
}

function routesFor(seen: Seen[]) {
  return {
    '/stop': async (input: unknown) => {
      seen.push({ route: '/stop', input });
      return { echo: input };
    },
    // 큰 본문도 응답은 작게
    '/size': async (input: unknown) => {
      seen.push({ route: '/size', input: Object.keys(input as object).length });
      return { n: JSON.stringify(input).length };
    },
    '/boom': async () => {
      seen.push({ route: '/boom', input: null });
      throw new Error('안에서 실패');
    },
    '/boom-text': async () => {
      seen.push({ route: '/boom-text', input: null });
      throw 'plain string';
    },
    '/slow': async () => {
      seen.push({ route: '/slow', input: null });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return { slow: true };
    },
    '/query?x=1': async () => {
      seen.push({ route: '/query?x=1', input: null });
      return { query: true };
    },
  };
}
interface Ctx {
  port: number;
  token: string;
}

interface Result {
  /** 0이면 응답 없이 연결이 끊겼다 */
  status: number;
  contentType: string | null;
  body: string;
}

const latin1 = (text: string): Buffer => Buffer.from(text, 'latin1');

interface RequestOptions {
  method?: string;
  target?: string;
  version?: string;
  /** undefined: 루프백 Host. null: Host 줄 없음. 배열: 줄 여러 개. 문자열 안의 `{port}`는 서버 포트로 바뀐다 */
  host?: string | Buffer | string[] | null;
  auth?: string | string[] | null;
  extraHeaders?: string[];
  body?: Buffer | string;
  /** undefined: 본문 길이. null: 줄 없음 */
  contentLength?: number | null;
  chunked?: boolean;
}

function http(options: RequestOptions): (ctx: Ctx) => Buffer {
  return (ctx) => {
    const sub = (text: string): string => text.replaceAll('{port}', String(ctx.port)).replaceAll('{token}', ctx.token);
    const body = typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : (options.body ?? Buffer.alloc(0));
    const parts: Buffer[] = [latin1(`${options.method ?? 'POST'} ${sub(options.target ?? '/stop')} ${options.version ?? 'HTTP/1.1'}\r\n`)];
    const line = (value: string | Buffer): Buffer => (typeof value === 'string' ? latin1(sub(value)) : value);
    const host = options.host === undefined ? '127.0.0.1:{port}' : options.host;
    if (host !== null) for (const value of Array.isArray(host) ? host : [host]) parts.push(latin1('Host: '), line(value), latin1('\r\n'));
    const auth = options.auth === undefined ? 'Bearer {token}' : options.auth;
    if (auth !== null) for (const value of Array.isArray(auth) ? auth : [auth]) parts.push(latin1('Authorization: '), line(value), latin1('\r\n'));
    parts.push(latin1('Content-Type: application/json\r\nConnection: close\r\n'));
    for (const extra of options.extraHeaders ?? []) parts.push(line(extra), latin1('\r\n'));
    if (options.chunked) {
      parts.push(latin1('Transfer-Encoding: chunked\r\n\r\n'));
      for (let at = 0; at < body.length; at += 1000) {
        const piece = body.subarray(at, at + 1000);
        parts.push(latin1(`${piece.length.toString(16)}\r\n`), piece, latin1('\r\n'));
      }
      parts.push(latin1('0\r\n\r\n'));
    } else {
      if (options.contentLength !== null) parts.push(latin1(`Content-Length: ${options.contentLength ?? body.length}\r\n`));
      parts.push(latin1('\r\n'), body);
    }
    return Buffer.concat(parts);
  };
}

/** 요청을 보내고 연결이 닫힐 때까지 읽은 응답. 연결 오류(RST 등)는 읽은 데까지로 본다 */
function send(port: number, request: Buffer, { halfClose = false, timeoutMs = 8000 }: { halfClose?: boolean; timeoutMs?: number } = {}): Promise<Result> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(parse(Buffer.concat(chunks)));
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('close', finish);
    socket.on('error', () => {});
    socket.on('connect', () => {
      socket.write(request, () => {
        if (halfClose) socket.end();
      });
    });
  });
}

/** 한 연결에 이어 온 응답들의 본문. 전송 방식과 상관없이 응답마다 본문만 꺼낸다 */
function bodiesOf(data: Buffer): string[] {
  const out: string[] = [];
  let rest = data;
  for (;;) {
    const end = rest.indexOf('\r\n\r\n');
    if (end < 0) return out;
    const head = rest.subarray(0, end).toString('latin1').split('\r\n');
    const headers = new Map(head.slice(1).map((entry) => [entry.slice(0, entry.indexOf(':')).toLowerCase(), entry.slice(entry.indexOf(':') + 1).trim()]));
    let after = rest.subarray(end + 4);
    let body: Buffer;
    if (headers.get('transfer-encoding')?.toLowerCase() === 'chunked') {
      const terminator = after.indexOf('\r\n0\r\n\r\n');
      const total = terminator < 0 ? after.length : terminator + 7;
      body = responseBody(after.subarray(0, total), headers);
      after = after.subarray(total);
    } else {
      const length = Number(headers.get('content-length') ?? after.length);
      body = after.subarray(0, length);
      after = after.subarray(length);
    }
    out.push(body.toString('utf8'));
    rest = after;
  }
}

function parse(input: Buffer): Result {
  // 100 Continue 같은 중간 응답은 건너뛴다
  let data = input;
  while (data.subarray(0, 10).toString('latin1').startsWith('HTTP/1.1 1')) {
    const interim = data.indexOf('\r\n\r\n');
    if (interim < 0) break;
    data = data.subarray(interim + 4);
  }
  const end = data.indexOf('\r\n\r\n');
  if (end < 0) return { status: 0, contentType: null, body: '' };
  const head = data.subarray(0, end).toString('latin1').split('\r\n');
  const status = Number(head[0]?.split(' ')[1] ?? 0);
  const headers = new Map(head.slice(1).map((entry) => [entry.slice(0, entry.indexOf(':')).toLowerCase(), entry.slice(entry.indexOf(':') + 1).trim()]));
  const rest = data.subarray(end + 4);
  return { status, contentType: headers.get('content-type') ?? null, body: responseBody(rest, headers).toString('utf8') };
}

/** 전송 방식(Content-Length·chunked·연결 끝까지)은 견주지 않는다. 본문 바이트만 꺼낸다 */
function responseBody(rest: Buffer, headers: Map<string, string>): Buffer {
  if (headers.get('transfer-encoding')?.toLowerCase() === 'chunked') {
    const pieces: Buffer[] = [];
    let at = 0;
    for (;;) {
      const lineEnd = rest.indexOf('\r\n', at);
      if (lineEnd < 0) break;
      const size = Number.parseInt(rest.subarray(at, lineEnd).toString('latin1'), 16);
      if (!Number.isFinite(size) || size === 0) break;
      pieces.push(rest.subarray(lineEnd + 2, lineEnd + 2 + size));
      at = lineEnd + 2 + size + 2;
    }
    return Buffer.concat(pieces);
  }
  const length = headers.get('content-length');
  return length === undefined ? rest : rest.subarray(0, Number(length));
}

let container: HookServer;

beforeAll(async () => {
  // 'é'는 비 ASCII 허용 이름이다(Node는 헤더를 latin1로 읽는다)
  container = await startHookServer(routesFor([]) as never, { allowedHosts: ['host.docker.internal', 'é'] });
});

afterAll(async () => {
  await container.close();
});

describe('훅 서버: 처리 시간과 동시성', () => {
  it('느린 처리(수 초) 중에도 연결을 끊지 않고 답을 준다', async () => {
    const request = (ctx: Ctx) => http({ target: '/slow', body: '{}' })(ctx);
    const now = await send(container.port, request({ port: container.port, token: container.token }));
    expect(now).toEqual({ status: 200, contentType: 'application/json', body: '{"slow":true}' });
  }, 20000);

  it('머리를 천천히 보내도(시간 제한 없음) 답을 준다', async () => {
    const slowly = async (pair: HookServer): Promise<Result> => {
      const full = http({ body: '{"a":1}' })({ port: pair.port, token: pair.token });
      const cut = full.indexOf('Authorization');
      const socket = connect(pair.port, '127.0.0.1');
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('error', () => {});
      await new Promise((resolve) => socket.once('connect', resolve));
      socket.write(full.subarray(0, cut));
      await new Promise((resolve) => setTimeout(resolve, 1500));
      socket.write(full.subarray(cut));
      await new Promise((resolve) => socket.once('close', resolve));
      return parse(Buffer.concat(chunks));
    };
    const now = await slowly(container);
    expect(now.status).toBe(200);
    expect(now.body).toBe('{"echo":{"a":1}}');
  }, 20000);

  it('동시 요청 여러 개: 느린 요청 둘이 도는 동안 빠른 요청은 막히지 않고, 모두 제대로 답한다', async () => {
    const ctx = { port: container.port, token: container.token };
    const slow = [send(container.port, http({ target: '/slow', body: '{}' })(ctx)), send(container.port, http({ target: '/slow', body: '{}' })(ctx))];
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    const fast = await Promise.all(Array.from({ length: 6 }, (_, i) => send(container.port, http({ body: JSON.stringify({ i }) })(ctx))));
    const fastMs = Date.now() - started;
    const results = [...fast, ...(await Promise.all(slow))];
    expect(results.slice(0, 6).map((result) => [result.status, result.body])).toEqual(Array.from({ length: 6 }, (_, i) => [200, `{"echo":{"i":${i}}}`]));
    expect(results.slice(6).map((result) => [result.status, result.body])).toEqual([[200, '{"slow":true}'], [200, '{"slow":true}']]);
    expect(fastMs).toBeLessThan(1500);
  }, 30000);

  it('keep-alive로 같은 연결에 요청 둘을 이어 보내면 둘 다 답한다', async () => {
    const ctx = { port: container.port, token: container.token };
    const first = http({ body: '{"n":1}' })(ctx).toString('latin1').replace('Connection: close', 'Connection: keep-alive');
    const second = http({ body: '{"n":2}' })(ctx);
    const now = await new Promise<string[]>((resolve) => {
      const socket = connect(container.port, '127.0.0.1');
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('close', () => resolve(bodiesOf(Buffer.concat(chunks))));
      socket.on('error', () => {});
      socket.write(Buffer.concat([latin1(first), second]));
    });
    expect(now).toEqual(['{"echo":{"n":1}}', '{"echo":{"n":2}}']);
  });

  it('파이프라인으로 토큰이 맞는 요청 뒤에 틀린 요청을 이어 보내도 두 번째는 판정을 거친다', async () => {
    const ctx = { port: container.port, token: container.token };
    const first = http({ body: '{}' })(ctx).toString('latin1').replace('Connection: close', 'Connection: keep-alive');
    const second = http({ auth: 'Bearer nope', body: '{}' })(ctx);
    const now = await new Promise<string[]>((resolve) => {
      const socket = connect(container.port, '127.0.0.1');
      const chunks: Buffer[] = [];
      socket.on('data', (chunk) => chunks.push(chunk));
      socket.on('close', () => resolve(bodiesOf(Buffer.concat(chunks))));
      socket.on('error', () => {});
      socket.write(Buffer.concat([latin1(first), second]));
    });
    expect(now).toEqual(['{"echo":{}}', '{"error":"unauthorized"}']);
  });
});
