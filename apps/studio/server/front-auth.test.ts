import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signSession } from '@/lib/server/auth';
import { buildFront, repoRoot, startFront, startNodeDirect, type RunningFront, type RunningNode } from './front-test-helper';

/**
 * HTTP 차등 시험(ADR-195 4c): 같은 환경으로 띄운 진짜 Node 서버를 (가) 직접, (나) Rust 앞단 너머로 두고 같은 날것의 요청을 보내
 * 상태 코드·본문·머리가 같은지 본다. 앞단은 인증을 먼저 판단해 거절만 직접 답하고(Node와 같은 응답), 나머지는 Node가 답한다.
 * 연결 틀 머리(date·connection·keep-alive·transfer-encoding·content-length)는 각자 정하므로 견주지 않는다. 임시 폴더·임시 포트만 쓴다.
 * (설정 오류의 500은 Node가 /api/health에서도 500을 주어 앞단이 뜨지 않으므로 여기서 볼 수 없다. 벡터 시험이 본다)
 */
const FRAME_HEADERS = new Set(['date', 'connection', 'keep-alive', 'transfer-encoding', 'content-length']);

interface Reply {
  status: number;
  headers: [string, string][];
  body: string;
}

function parseChunked(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  while (at < body.length) {
    const lineEnd = body.indexOf('\r\n', at);
    if (lineEnd < 0) break;
    const size = parseInt(body.subarray(at, lineEnd).toString('latin1'), 16);
    if (!Number.isFinite(size) || size === 0) break;
    parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

/** 요청 줄·머리를 그대로 보내고(`Connection: close`를 더한다) 응답을 읽는다 */
function exchange(origin: string, requestLine: string, headers: [string, string][], isHead = false): Promise<Reply> {
  const url = new URL(origin);
  const text = [requestLine, ...headers.map(([n, v]) => `${n}: ${v}`), 'Connection: close', '', ''].join('\r\n');
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => socket.write(Buffer.from(text, 'latin1')));
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf('\r\n\r\n');
      if (split < 0) return reject(new Error(`응답 머리가 없습니다: ${raw.toString('latin1')}`));
      const [statusLine, ...lines] = raw.subarray(0, split).toString('latin1').split('\r\n');
      const parsed = lines.map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()] as [string, string];
      });
      const chunked = parsed.some(([n, v]) => n === 'transfer-encoding' && v.includes('chunked'));
      const rest = raw.subarray(split + 4);
      const body = isHead ? Buffer.alloc(0) : chunked ? parseChunked(rest) : rest;
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(statusLine!)?.[1]), headers: parsed.filter(([n]) => !FRAME_HEADERS.has(n)), body: body.toString('utf8') });
    });
  });
}

interface Case {
  name: string;
  line: string;
  headers: [string, string][];
  /** Node가 직접 준 상태 코드. 시험이 아무것도 보지 않는 일을 막는다 */
  status: number;
}

async function compare(direct: string, front: string, testCase: Case): Promise<void> {
  const isHead = testCase.line.startsWith('HEAD ');
  const [expected, actual] = [await exchange(direct, testCase.line, testCase.headers, isHead), await exchange(front, testCase.line, testCase.headers, isHead)];
  expect(expected.status, `${testCase.name}: Node 직접 상태`).toBe(testCase.status);
  expect(actual, testCase.name).toEqual(expected);
}

interface Pair {
  direct: RunningNode;
  front: RunningFront;
  dir: string;
}

async function startPair(extraEnv: Record<string, string>): Promise<Pair> {
  const binary = await buildFront();
  const dir = await mkdtemp(path.join('/tmp', 'bsa-'));
  const env = {
    NODE_ENV: 'test',
    PATH: process.env.PATH,
    HOME: dir,
    B_STUDIO_MODE: 'demo',
    B_STUDIO_SESSIONS_DIR: path.join(dir, 'sessions'),
    B_STUDIO_LOCAL_TOKEN_FILE: path.join(dir, 'local-token'),
    B_STUDIO_AUTH_STATE_DIR: path.join(dir, 'auth'),
    ...extraEnv,
  };
  const direct = await startNodeDirect(env);
  const front = await startFront(binary, ['--port', '0', '--hostname', '127.0.0.1', '--run-dir', path.join(dir, 'run'), '--', path.join(repoRoot, 'node_modules/.bin/tsx'), '--tsconfig', 'apps/studio/tsconfig.json', 'apps/studio/server/main.ts'], env, 120_000);
  return { direct, front, dir };
}

async function stopPair(pair: Pair | undefined): Promise<void> {
  await pair?.front.stop();
  await pair?.direct.stop();
  if (pair) await rm(pair.dir, { recursive: true, force: true });
}

const get = (target: string, headers: [string, string][], status: number, name = target): Case => ({ name: `GET ${name} ${JSON.stringify(headers)}`, line: `GET ${target} HTTP/1.1`, headers, status });
const withMethod = (method: string, target: string, headers: [string, string][], status: number): Case => ({ name: `${method} ${target} ${JSON.stringify(headers)}`, line: `${method} ${target} HTTP/1.1`, headers, status });

describe('인증 없음(기본) 설정', () => {
  let pair: Pair | undefined;
  beforeAll(async () => {
    pair = await startPair({ B_STUDIO_ALLOWED_HOSTS: 'studio.example' });
  }, 400_000);
  afterAll(() => stopPair(pair));

  const loopback: [string, string] = ['Host', 'localhost:3000'];
  const cases: Case[] = [
    // 통과: Node가 답한다
    get('/', [loopback], 404),
    get('/api/nope', [loopback], 404),
    get('/api/health/routes', [loopback], 200),
    withMethod('OPTIONS', '/api/agents', [loopback, ['Origin', 'http://localhost:3000']], 204),
    withMethod('HEAD', '/', [loopback], 404),
    get('/api/x/../nope', [loopback], 404),
    get('/api/%2e%2e/nope', [loopback], 404),
    // 거절: 앞단이 직접 답한다(Node와 같은 응답)
    get('/', [['Host', 'evil.example']], 403),
    get('/api/nope', [['Host', 'evil.example']], 403),
    withMethod('HEAD', '/', [['Host', 'evil.example']], 403),
    withMethod('HEAD', '/api/nope', [['Host', 'evil.example']], 403),
    withMethod('POST', '/api/nope', [loopback, ['Origin', 'http://evil.example']], 403),
    withMethod('DELETE', '/api/nope', [loopback, ['Origin', 'null']], 403),
    withMethod('POST', '/nope', [loopback, ['Origin', 'http://evil.example']], 404),
    get('/api/nope', [['Host', 'localhost'], ['Host', 'evil.example']], 404, 'Host 둘(첫 값만)'),
    get('/api/nope', [['Host', 'evil.example'], ['Host', 'localhost']], 403, 'Host 둘(첫 값만)'),
    // 허용 목록과 대소문자·포트
    get('/api/nope', [['Host', 'Studio.Example:8080']], 404),
    get('/api/nope', [['Host', ' studio.example ']], 404),
    get('/api/nope', [['Host', '[::1]:3000']], 404),
    get('/api/nope', [['Host', '[::1']], 500),
    get('/api/nope', [['Host', '127.0.0.1:']], 403),
    // 같은 출처: 기본 포트, x-forwarded-host, 겹친 Origin
    withMethod('POST', '/api/nope', [['Host', 'localhost'], ['Origin', 'http://localhost:80']], 404),
    withMethod('POST', '/api/nope', [['Host', 'localhost'], ['Origin', 'http://localhost']], 404),
    withMethod('POST', '/api/nope', [['Host', 'localhost'], ['Origin', 'http://LOCALHOST']], 404),
    withMethod('POST', '/api/nope', [['Host', 'localhost'], ['Origin', 'https://localhost:443']], 404),
    withMethod('POST', '/api/nope', [['Host', 'localhost'], ['Origin', 'https://localhost:80']], 403),
    withMethod('POST', '/api/nope', [['Host', 'localhost'], ['Origin', 'http://evil.example'], ['X-Forwarded-Host', 'evil.example']], 404),
    withMethod('POST', '/api/nope', [['Host', 'evil.example'], ['Origin', 'http://localhost'], ['X-Forwarded-Host', 'localhost']], 403),
    withMethod('POST', '/api/nope', [['Host', 'localhost'], ['Origin', 'http://localhost'], ['Origin', 'http://localhost']], 403),
    withMethod('POST', '/api/nope', [['Host', 'localhost'], ['Origin', 'http://localhost'], ['Connection', 'Origin']], 404),
    withMethod('POST', '/api/nope', [['Host', 'localhost'], ['Origin', 'http://é.example']], 403),
    withMethod('POST', '/api/nope', [['Host', 'xn--9ca.example'], ['Origin', 'http://é.example'], ['X-Forwarded-Host', 'xn--9ca.example']], 403),
    // Node가 판단 전에 실패하는 입력은 앞단이 넘기고 Node가 그대로 답한다
    get('/api/nope', [['Host', '']], 500),
    get('/api/nope', [['Host', 'a b']], 500),
    get('/api/nope', [['Host', 'u:p@localhost']], 500),
    get('//u:p@h/api/nope', [loopback], 500),
    get('///h/api/nope', [loopback], 404),
    get('//evil.example/api/nope', [['Host', 'evil.example']], 403),
    withMethod('TRACE', '/api/nope', [loopback], 500),
    get('/api/nope', [], 400, '(Host 없음)'),
    // 공개 경로(로그인 없이)와 경로 꼴
    withMethod('GET', '/api/health/', [['Host', 'evil.example']], 403),
    get('/api/health', [['Host', 'evil.example']], 200),
    get('/api/health/routes', [['Host', 'evil.example']], 200),
    get('/api/task-plans/x/board/mcp', [['Host', 'evil.example']], 401),
    get('/api\\health', [['Host', 'evil.example']], 200),
  ];

  for (const testCase of cases) {
    it(testCase.name, async () => {
      await compare(pair!.direct.origin, pair!.front.origin, testCase);
    });
  }
});

describe('token 설정(세션 쿠키와 무효화 기록)', () => {
  const secret = 'S'.repeat(32);
  const aliceToken = 'a'.repeat(24);
  let pair: Pair | undefined;
  beforeAll(async () => {
    pair = await startPair({ B_STUDIO_AUTH: 'token', B_STUDIO_AUTH_SECRET: secret, B_STUDIO_AUTH_TOKENS: `alice:${aliceToken}`, B_STUDIO_ALLOWED_HOSTS: 'studio.example' });
  }, 400_000);
  afterAll(() => stopPair(pair));

  const cookieFor = (user: string, sid: string, hours = 1) => `b_studio_session=${signSession(user, secret, Date.now(), hours, sid)}`;
  const host: [string, string] = ['Host', 'localhost:3000'];
  const sid = (n: number) => n.toString(16).padStart(32, '0');
  const writeState = async (content: string | undefined) => {
    const file = path.join(pair!.dir, 'auth', 'revocations.json');
    await mkdir(path.dirname(file), { recursive: true });
    await rm(file, { force: true });
    if (content !== undefined) await writeFile(file, content);
  };
  const run = (testCase: Case) => compare(pair!.direct.origin, pair!.front.origin, testCase);

  it('쿠키 없음·틀린 서명·만료·없는 사용자는 401(JSON과 text)', async () => {
    await writeState(undefined);
    await run(get('/api/nope', [host], 401));
    await run(get('/nope', [host], 401));
    await run(withMethod('HEAD', '/api/nope', [host], 401));
    await run(withMethod('HEAD', '/nope', [host], 401));
    await run(get('/api/nope', [host, ['Cookie', `b_studio_session=${signSession('alice', 'T'.repeat(32), Date.now(), 1, sid(1))}`]], 401));
    await run(get('/api/nope', [host, ['Cookie', cookieFor('alice', sid(1), -1)]], 401));
    await run(get('/api/nope', [host, ['Cookie', cookieFor('mallory', sid(1))]], 401));
    await run(get('/api/nope', [host, ['Cookie', `${cookieFor('alice', sid(1))}.x`]], 401));
    await run(get('/api/nope', [host, ['Cookie', cookieFor('alice', 'XYZ')]], 401));
  });

  it('맞는 쿠키는 통과하고, 같은 이름의 쿠키 둘과 Cookie 헤더 둘은 Node처럼 합쳐 읽는다', async () => {
    await writeState(undefined);
    const good = cookieFor('alice', sid(2));
    await run(get('/api/nope', [host, ['Cookie', good]], 404));
    await run(get('/nope', [host, ['Cookie', `a=1; ${good}; b=2`]], 404));
    await run(get('/api/nope', [host, ['Cookie', 'a=1'], ['Cookie', good]], 404));
    await run(get('/api/nope', [host, ['Cookie', `  b_studio_session  =  ${good.split('=')[1]}  `]], 404));
    await run(get('/api/nope', [host, ['Cookie', `b_studio_session=junk; ${good}`]], 401));
    await run(get('/api/nope', [host, ['Cookie', good], ['Cookie', cookieFor('alice', sid(3))]], 404));
    await run(withMethod('POST', '/api/nope', [host, ['Cookie', good], ['Origin', 'http://evil.example']], 403));
    await run(withMethod('POST', '/api/nope', [host, ['Cookie', good], ['Origin', 'http://localhost:3000']], 404));
  });

  it('무효화한 세션·사용자는 401', async () => {
    const revoked = cookieFor('alice', sid(4));
    await writeState(JSON.stringify({ version: 1, sessions: { [sid(4)]: Date.now() + 100_000 }, users: {} }));
    await run(get('/api/nope', [host, ['Cookie', revoked]], 401));
    await run(get('/api/nope', [host, ['Cookie', cookieFor('alice', sid(5))]], 404));
    await writeState(JSON.stringify({ version: 1, sessions: {}, users: { alice: Date.now() + 1000 } }));
    await run(get('/api/nope', [host, ['Cookie', cookieFor('alice', sid(6))]], 401));
    await writeState(JSON.stringify({ version: 1, sessions: {}, users: { alice: 1 }, padding: 'x'.repeat(5) }));
    await run(get('/api/nope', [host, ['Cookie', cookieFor('alice', sid(7))]], 404));
  });

  it('무효화 기록을 읽지 못하면 막는다(500). JSON 형식 오류 글은 같다', async () => {
    await writeState('{ not json');
    const good = cookieFor('alice', sid(8));
    const [direct, front] = [await exchange(pair!.direct.origin, 'GET /api/nope HTTP/1.1', [host, ['Cookie', good]]), await exchange(pair!.front.origin, 'GET /api/nope HTTP/1.1', [host, ['Cookie', good]])];
    expect(direct.status).toBe(500);
    // 파일 경로는 두 서버가 같은 상태 폴더를 쓰므로 같다
    expect(front).toEqual(direct);
    await writeState(JSON.stringify({ sessions: {}, users: [] }));
    const [d2, f2] = [await exchange(pair!.direct.origin, 'GET /nope HTTP/1.1', [host, ['Cookie', good]]), await exchange(pair!.front.origin, 'GET /nope HTTP/1.1', [host, ['Cookie', good]])];
    expect(d2.status).toBe(500);
    expect(f2).toEqual(d2);
    // 공개 경로는 기록을 읽지 않는다
    await run(get('/api/health', [host], 200));
    await writeState(undefined);
  });
});

describe('proxy 설정(사내 프록시 헤더)', () => {
  const secret = 'P'.repeat(32);
  let pair: Pair | undefined;
  beforeAll(async () => {
    pair = await startPair({ B_STUDIO_AUTH: 'proxy', B_STUDIO_AUTH_PROXY_SECRET: secret });
  }, 400_000);
  afterAll(() => stopPair(pair));

  const host: [string, string] = ['Host', 'sso.example'];
  const secretHeader = (value: string): [string, string] => ['X-B-Studio-Proxy-Secret', value];
  const cases: Case[] = [
    get('/api/nope', [host], 401),
    get('/nope', [host], 401),
    withMethod('HEAD', '/nope', [host], 401),
    get('/api/nope', [host, secretHeader(secret)], 401),
    get('/api/nope', [host, ['X-Forwarded-User', 'alice']], 401),
    get('/api/nope', [host, secretHeader(secret), ['X-Forwarded-User', 'alice']], 404),
    get('/api/nope', [host, secretHeader(` ${secret} `), ['X-Forwarded-User', '  alice  ']], 404),
    get('/api/nope', [host, secretHeader(`${secret}x`), ['X-Forwarded-User', 'alice']], 401),
    get('/api/nope', [host, secretHeader(secret), ['X-Forwarded-User', 'a b']], 401),
    get('/api/nope', [host, secretHeader(secret), ['X-Forwarded-User', 'a'.repeat(257)]], 401),
    get('/api/nope', [host, secretHeader(secret), ['X-Forwarded-User', 'a'.repeat(256)]], 404),
    get('/api/nope', [host, secretHeader(secret), ['X-Forwarded-User', 'é']], 401),
    get('/api/nope', [host, secretHeader(secret), ['X-Forwarded-User', 'alice'], ['X-Forwarded-User', 'bob']], 401),
    get('/api/nope', [host, secretHeader(secret), secretHeader(secret), ['X-Forwarded-User', 'alice']], 401),
    get('/api/nope', [host, secretHeader(secret), ['X-Forwarded-User', 'alice'], ['X-B-Studio-User', 'mallory']], 404),
    get('/api/health', [host], 200),
    withMethod('POST', '/api/nope', [host, secretHeader(secret), ['X-Forwarded-User', 'alice'], ['Origin', 'http://evil.example']], 403),
    withMethod('POST', '/api/nope', [host, secretHeader(secret), ['X-Forwarded-User', 'alice'], ['Origin', 'http://sso.example']], 404),
  ];
  for (const testCase of cases) {
    it(testCase.name, async () => {
      await compare(pair!.direct.origin, pair!.front.origin, testCase);
    });
  }
});
