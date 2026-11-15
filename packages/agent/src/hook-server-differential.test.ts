import { appendFileSync } from 'node:fs';
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHookServer, type HookServer } from './hook-server';
import { startHookServer as startLegacy } from './hook-server-legacy';

/**
 * 훅 서버의 전송을 Rust로 옮긴 것(ADR-201, 4f A7a)을 옛 `node:http` 서버(hook-server-legacy.ts)와 견준다.
 * 같은 routes로 둘을 띄우고 **같은 바이트의 원시 HTTP 요청**을 `node:net`으로 보내 상태·content-type·본문을 견준다(Date·Keep-Alive·전송 방식은 뺀다).
 *
 * 규칙: 두 서버의 결과가 같아야 한다. 다른 것은 INTENDED에 이유와 함께 적은 것뿐이고, 그것도 **거절 쪽으로만** 다를 수 있다:
 * 새 서버가 200을 줬는데 옛 서버가 주지 않았으면 어떤 경우에도 실패다(넓어짐).
 */

interface Seen {
  route: string;
  input: unknown;
}

interface Pair {
  legacy: HookServer;
  native: HookServer;
  legacySeen: Seen[];
  nativeSeen: Seen[];
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

async function startPair(allowedHosts: string[]): Promise<Pair> {
  const legacySeen: Seen[] = [];
  const nativeSeen: Seen[] = [];
  const legacy = await startLegacy(routesFor(legacySeen) as never, { allowedHosts });
  const native = await startHookServer(routesFor(nativeSeen) as never, { allowedHosts });
  return { legacy, native, legacySeen, nativeSeen };
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

/** 다르게 나와도 되는 요청과 그 이유. 모두 새 서버가 더 좁게(거절로) 읽는 쪽이다 */
const INTENDED: Record<string, string> = {
  '요청 줄 공백 둘': 'llhttp는 요청 줄의 공백 여럿을 받는다. 새 서버는 받는 꼴을 RFC의 엄격한 부분집합으로 고정해 응답 없이 끊는다',
  'HTTP/0.9 꼴': 'Node는 버전 없는 요청 줄을 받는다. 새 서버는 응답 없이 끊는다',
  'HTTP/2.0 버전 글자': 'Node는 HTTP/2.0이라 적힌 요청을 HTTP/1.1처럼 받는다. 새 서버는 HTTP/1.0·1.1만 받고 나머지는 끊는다',
  '머리: Expect가 100-continue가 아님': 'Node는 417로 답한다. 새 서버는 응답 없이 끊는다(둘 다 거절)',
  '머리: 앞에 빈 줄': 'Node는 요청 줄 앞의 빈 줄을 건너뛴다. 새 서버는 받지 않는다',
  '본문: Content-Length가 본문보다 짧음(남는 바이트는 다음 요청으로 읽힌다)': 'Node는 남은 바이트를 다음 요청으로 읽다 깨져 연결을 끊고, 이미 처리한 첫 요청의 응답이 나가기 전에 사라질 수 있다. 새 서버는 첫 요청의 답을 준다(처리 횟수는 같다)',
  '본문: Content-Length 없는 POST 뒤에 본문 바이트': '위와 같다(본문이 없는 요청 뒤의 바이트는 다음 요청으로 읽힌다)',
  '본문: 4MiB 넘는 본문이어도 토큰이 틀리면 401': 'Node는 본문을 읽지 않은 채 응답해 클라이언트가 보내는 중에 RST가 나면 응답이 사라진다. 새 서버는 보내던 것을 흘려 보내며 응답을 전달한다',
  '본문: 4MiB 넘는 본문이어도 라우트가 없으면 404': '위와 같다',
  '본문: 4MiB 넘는 본문이어도 Host가 나쁘면 403': '위와 같다',
  '본문: chunked로 4MiB보다 1MiB 큼(413)': '위와 같다(상한을 넘은 뒤 응답했는데 클라이언트가 계속 보내는 중이라 Node에서는 응답이 사라질 수 있다)',
};

const counts = { legacy: new Map<number, number>(), native: new Map<number, number>() };
const tally = (map: Map<number, number>, status: number): void => void map.set(status, (map.get(status) ?? 0) + 1);

let plain: Pair;
let container: Pair;

beforeAll(async () => {
  plain = await startPair([]);
  // 'é'는 비 ASCII 허용 이름이다(Node는 헤더를 latin1로 읽는다)
  container = await startPair(['host.docker.internal', 'é']);
});

afterAll(async () => {
  for (const pair of [plain, container]) {
    await pair.legacy.close();
    await pair.native.close();
  }
  // eslint-disable-next-line no-console
  console.log(`[hook-server 차등] 옛 서버 결과 분포 ${JSON.stringify(Object.fromEntries([...counts.legacy].sort()))}, 새 서버 ${JSON.stringify(Object.fromEntries([...counts.native].sort()))}`);
});

interface Case {
  name: string;
  request: (ctx: Ctx) => Buffer;
  /** 둘째 쌍(허용 이름이 없는 서버)에서 돌릴지. 기본 container */
  on?: 'plain' | 'container';
  halfClose?: boolean;
  /** 이 요청에서 처리가 불리는 횟수가 같아야 하는지(기본 true) */
  timeoutMs?: number;
}

function tokenOf(ctx: Ctx, mutate: (token: string) => string): string {
  return mutate(ctx.token);
}

const cases: Case[] = [];
const add = (name: string, options: RequestOptions | ((ctx: Ctx) => Buffer), more: Partial<Case> = {}): void => {
  cases.push({ name, request: typeof options === 'function' ? options : http(options), ...more });
};

// ── Host ──
for (const [label, host] of [
  ['루프백 127.0.0.1(포트 없음)', '127.0.0.1'],
  ['루프백 127.0.0.1:포트', '127.0.0.1:{port}'],
  ['localhost', 'localhost'],
  ['localhost:포트', 'localhost:{port}'],
  ['대문자 LOCALHOST:포트', 'LOCALHOST:{port}'],
  ['[::1]', '[::1]'],
  ['[::1]:포트', '[::1]:{port}'],
  ['여는 대괄호만 [::1', '[::1'],
  ['대괄호 없는 ::1', '::1'],
  ['허용 이름', 'host.docker.internal'],
  ['허용 이름:포트', 'host.docker.internal:{port}'],
  ['허용 이름 대소문자 섞임', 'HOST.Docker.Internal:{port}'],
  ['허용 이름 접두 xhost', 'xhost.docker.internal'],
  ['허용 이름 접미 .evil.com', 'host.docker.internal.evil.com'],
  ['허용 이름 끝 점', 'host.docker.internal.'],
  ['허용 이름 뒤 @', 'host.docker.internal@evil.com'],
  ['@ 앞 허용 이름', 'host.docker.internal:80@evil.com'],
  ['허용 이름의 앞 공백', ' host.docker.internal'],
  ['허용 이름의 뒤 공백', 'host.docker.internal '],
  ['허용 이름 한 글자 짧음', 'host.docker.interna'],
  ['루프백 끝 점 127.0.0.1.', '127.0.0.1.'],
  ['루프백 접미 localhost.evil.com', 'localhost.evil.com'],
  ['루프백 접두 evil.localhost', 'evil.localhost'],
  ['다른 이름', 'evil.com'],
  ['빈 Host', ''],
  ['쉼표로 이은 Host', 'localhost, evil.com'],
  ['탭이 낀 Host', 'local\thost'],
  ['포트가 둘', 'localhost:80:90'],
  ['IPv4 0.0.0.0', '0.0.0.0'],
  ['IPv6 전체 표기', '[0:0:0:0:0:0:0:1]'],
  ['비 ASCII 허용 이름 é를 latin1 한 바이트(0xE9)로', Buffer.from([0xe9])],
  ['비 ASCII 허용 이름 é를 UTF-8(0xC3 0xA9)로', Buffer.from('é', 'utf8')],
  ['전각 localhost(UTF-8)', Buffer.from('ｌｏｃａｌｈｏｓｔ', 'utf8')],
  ['잘못된 바이트 0xFF 0xFE', Buffer.from([0xff, 0xfe])],
  ['localhost 뒤에 0xA0(NBSP)', Buffer.concat([Buffer.from('localhost'), Buffer.from([0xa0])])],
] as const) {
  add(`Host: ${label}`, { host: host as string | Buffer });
  add(`Host(허용 이름 없는 서버): ${label}`, { host: host as string | Buffer }, { on: 'plain' });
}
add('Host 줄 없음(HTTP/1.1)', { host: null });
add('Host 줄 없음(HTTP/1.0)', { host: null, version: 'HTTP/1.0' });
add('Host 중복: 루프백, 다른 이름', { host: ['localhost:{port}', 'evil.com'] });
add('Host 중복: 다른 이름, 루프백', { host: ['evil.com', 'localhost:{port}'] });
add('Host 중복: 루프백 둘', { host: ['localhost:{port}', '127.0.0.1:{port}'] });
add('Host 중복: 허용 이름, 다른 이름', { host: ['host.docker.internal', 'evil.com'] });
add('Host 중복(허용 이름 없는 서버): 허용 이름, 루프백', { host: ['host.docker.internal', 'localhost'] }, { on: 'plain' });

// ── 토큰 ──
add('토큰: 맞음', {});
add('토큰: Authorization 없음', { auth: null });
add('토큰: 빈 값', { auth: '' });
add('토큰: 한 글자 다름', (ctx) => http({ auth: `Bearer ${tokenOf(ctx, (t) => t.slice(0, -1) + (t.endsWith('a') ? 'b' : 'a'))}` })(ctx));
add('토큰: 첫 글자 다름', (ctx) => http({ auth: `Bearer ${tokenOf(ctx, (t) => (t.startsWith('a') ? 'b' : 'a') + t.slice(1))}` })(ctx));
add('토큰: 앞부분만(접두)', (ctx) => http({ auth: `Bearer ${tokenOf(ctx, (t) => t.slice(0, 20))}` })(ctx));
add('토큰: 뒤에 한 글자 더', { auth: 'Bearer {token}x' });
add('토큰: Bearer 소문자', { auth: 'bearer {token}' });
add('토큰: BEARER 대문자', { auth: 'BEARER {token}' });
add('토큰: Bearer 뒤 공백 둘', { auth: 'Bearer  {token}' });
add('토큰: 접두 없음', { auth: '{token}' });
add('토큰: Bearer만', { auth: 'Bearer' });
add('토큰: Bearer 뒤 공백만', { auth: 'Bearer ' });
add('토큰: Basic', { auth: 'Basic {token}' });
add('토큰: 뒤 공백(헤더 값 끝 공백은 헤더 해석이 걷어낸다)', { auth: 'Bearer {token} ' });
add('토큰: 뒤 탭', { auth: 'Bearer {token}\t' });
add('토큰: 앞에 탭', { auth: '\tBearer {token}' });
add('토큰: 대문자로 바꾼 토큰', (ctx) => http({ auth: `Bearer ${ctx.token.toUpperCase()}` })(ctx));
add('토큰: 중복 Authorization(맞음, 틀림)', (ctx) => http({ auth: [`Bearer ${ctx.token}`, 'Bearer nope'] })(ctx));
add('토큰: 중복 Authorization(틀림, 맞음)', (ctx) => http({ auth: ['Bearer nope', `Bearer ${ctx.token}`] })(ctx));
add('토큰: 비 ASCII 바이트', { auth: Buffer.concat([Buffer.from('Bearer '), Buffer.from([0xff])]) as unknown as string });
add('검사 순서: Host가 나쁘고 토큰도 틀리면 403', { host: 'evil.com', auth: 'Bearer nope' });
add('검사 순서: 토큰이 틀리고 라우트도 없으면 401', { auth: 'Bearer nope', target: '/nope' });
add('검사 순서: Host가 나쁘고 라우트도 없으면 403', { host: 'evil.com', target: '/nope' });

// ── 라우트와 메서드 ──
for (const [label, target] of [
  ['등록된 라우트', '/stop'],
  ['쿼리를 붙임', '/stop?x=1'],
  ['빈 쿼리', '/stop?'],
  ['쿼리가 이름의 일부인 라우트', '/query?x=1'],
  ['쿼리가 이름의 일부인 라우트에서 쿼리를 뗌', '/query'],
  ['쿼리가 이름의 일부인 라우트에서 쿼리 값이 다름', '/query?x=2'],
  ['끝 슬래시', '/stop/'],
  ['대문자', '/STOP'],
  ['퍼센트 인코딩 %2F를 앞에', '/%2Fstop'],
  ['퍼센트 인코딩 글자 /st%6Fp', '/st%6Fp'],
  ['경로 접두 /stopx', '/stopx'],
  ['경로 접미 /xstop', '/xstop'],
  ['슬래시 둘', '//stop'],
  ['점 구간 /./stop', '/./stop'],
  ['점 점 /a/../stop', '/a/../stop'],
  ['루트', '/'],
  ['별표', '*'],
  ['절대 형식', 'http://127.0.0.1:{port}/stop'],
  ['절대 형식 localhost', 'http://localhost/stop'],
  ['절대 형식 쿼리 있는 라우트', 'http://127.0.0.1:{port}/query?x=1'],
  ['권한 형식', '127.0.0.1:{port}'],
  ['/__proto__', '/__proto__'],
  ['/constructor', '/constructor'],
  ['/hasOwnProperty', '/hasOwnProperty'],
  ['/toString', '/toString'],
  ['프래그먼트', '/stop#x'],
  ['역슬래시', '\\stop'],
  ['/stop 뒤 세미콜론', '/stop;a=b'],
  ['던지는 라우트', '/boom'],
  ['던지는 라우트(문자열을 던짐)', '/boom-text'],
] as const) {
  add(`라우트: ${label}`, { target });
}
for (const method of ['GET', 'PUT', 'HEAD', 'DELETE', 'PATCH', 'OPTIONS', 'get', 'Post', 'FOO', 'CONNECT', 'TRACE']) {
  add(`메서드: ${method}`, { method, body: method === 'GET' || method === 'HEAD' ? undefined : '{}' });
}
add('요청 줄 공백 둘', (ctx) => Buffer.from(http({})(ctx).toString('latin1').replace('POST /stop', 'POST  /stop'), 'latin1'));
add('HTTP/1.0 POST', { version: 'HTTP/1.0' });
add('HTTP/0.9 꼴', (ctx) => latin1(`POST /stop\r\nHost: 127.0.0.1:${ctx.port}\r\n\r\n`));
add('HTTP/2.0 버전 글자', { version: 'HTTP/2.0' });
add('요청 줄에 비 ASCII', (ctx) => Buffer.concat([latin1(`POST /`), Buffer.from('é', 'utf8'), latin1(` HTTP/1.1\r\nHost: 127.0.0.1:${ctx.port}\r\nAuthorization: Bearer ${ctx.token}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)]));

// ── 본문 ──
const bodies: Array<[string, Buffer | string | undefined]> = [
  ['본문 없음', undefined],
  ['빈 객체', '{}'],
  ['객체', '{"tool_name":"Write","tool_input":{"file_path":"a.txt"}}'],
  ['배열', '[1,2]'],
  ['숫자', '42'],
  ['문자열', '"글자"'],
  ['null', 'null'],
  ['true', 'true'],
  ['깨진 JSON', '{깨진 json'],
  ['공백만', '   '],
  ['짝 없는 서로게이트 이스케이프', '{"a":"\\ud800"}'],
  ['짝 없는 낮은 서로게이트 이스케이프', '{"a":"\\udc00x"}'],
  ['짝 있는 서로게이트 이스케이프', '{"a":"\\ud83d\\ude00"}'],
  ['키가 짝 없는 서로게이트', '{"\\ud800":1}'],
  ['중복 키', '{"a":1,"a":2}'],
  ['큰 정수', '{"n":12345678901234567890}'],
  ['큰 지수', '{"n":1e999}'],
  ['음수 영', '{"n":-0}'],
  ['__proto__ 키', '{"__proto__":{"x":1}}'],
  ['BOM이 앞에', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')])],
  ['잘못된 UTF-8 바이트가 문자열 안에', Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xfe, 0xc3]), Buffer.from('"}')])],
  ['잘못된 UTF-8 바이트만', Buffer.from([0xff, 0xfe, 0xfd])],
  ['NUL 바이트가 문자열 안에', Buffer.from('{"a":"\u0000"}')],
  ['제어 문자가 문자열 안에', Buffer.from('{"a":"\n"}')],
  ['깊은 중첩', `${'['.repeat(500)}${']'.repeat(500)}`],
  ['깊은 중첩 객체', `${'{"a":'.repeat(500)}1${'}'.repeat(500)}`],
];
for (const [label, body] of bodies) add(`본문: ${label}`, { body });
for (const [label, body] of bodies.slice(1, 12)) add(`본문(chunked): ${label}`, { body, chunked: true });
add('던지는 라우트에 본문', { target: '/boom', body: '{"a":1}' });
add('던지는 라우트에 chunked 본문', { target: '/boom-text', body: '{"a":1}', chunked: true });
add('본문: Content-Length 없는 POST', { contentLength: null });
add('본문: Content-Length가 본문보다 짧음(남는 바이트는 다음 요청으로 읽힌다)', { body: '{"a":1}XXXXXXXX', contentLength: 7 });
add('본문: Content-Length가 본문보다 김(보내다 만다)', { body: '{"a":1}', contentLength: 100 }, { halfClose: true });
add('본문: Content-Length 없는 POST 뒤에 본문 바이트', { body: '{}', contentLength: null });
add('본문: Content-Length가 숫자가 아님', { body: '{}', extraHeaders: ['Content-Length: abc'], contentLength: null });
add('본문: Content-Length 둘(같은 값)', { body: '{}', extraHeaders: ['Content-Length: 2'] });
add('본문: Content-Length 둘(다른 값)', { body: '{}', extraHeaders: ['Content-Length: 3'] });
add('본문: Content-Length와 chunked를 함께', { body: '{}', extraHeaders: ['Content-Length: 2'], chunked: true });
add('본문: Content-Length 음수', { body: '{}', contentLength: -1 });
add('머리: Upgrade(Connection: Upgrade)', { extraHeaders: ['Connection: Upgrade', 'Upgrade: websocket'], body: '{}' });
add('머리: Upgrade 헤더만', { extraHeaders: ['Upgrade: websocket'], body: '{}' });
add('머리: Expect가 100-continue가 아님', { extraHeaders: ['Expect: nope'], body: '{}' });
add('머리: 앞에 빈 줄', (ctx) => Buffer.concat([latin1('\r\n'), http({})(ctx)]));
add('본문: Expect 100-continue', { body: '{"a":1}', extraHeaders: ['Expect: 100-continue'] });

const MAX = 4 * 1024 * 1024;
const sized = (total: number): Buffer => {
  const prefix = '{"a":"';
  const suffix = '"}';
  return Buffer.from(prefix + 'x'.repeat(total - prefix.length - suffix.length) + suffix);
};
add('본문: 4MiB보다 100바이트 큼(413)', { target: '/size', body: sized(MAX + 100) });
add('본문: chunked로 4MiB보다 1MiB 큼(413)', { target: '/size', body: sized(MAX + 1024 * 1024), chunked: true });
add('본문: 정확히 4MiB(받는다)', { target: '/size', body: sized(MAX) });
add('본문: 4MiB보다 1바이트 큼(413)', { target: '/size', body: sized(MAX + 1) });
add('본문: 4MiB보다 1바이트 작음', { target: '/size', body: sized(MAX - 1) });
add('본문: chunked로 정확히 4MiB', { target: '/size', body: sized(MAX), chunked: true });
add('본문: chunked로 4MiB + 1', { target: '/size', body: sized(MAX + 1), chunked: true });
add('본문: 4MiB 넘는 본문이어도 Host가 나쁘면 403', { target: '/size', host: 'evil.com', body: sized(MAX + 1000) });
add('본문: 4MiB 넘는 본문이어도 토큰이 틀리면 401', { target: '/size', auth: 'Bearer nope', body: sized(MAX + 1000) });
add('본문: 4MiB 넘는 본문이어도 라우트가 없으면 404', { target: '/nope', body: sized(MAX + 1000) });

// ── 머리 ──
add('머리: 16000바이트짜리 헤더 값(받는다)', { extraHeaders: [`X: ${'a'.repeat(16000)}`], body: '{}' });
add('머리: 17000바이트짜리 헤더 값(받지 않는다)', { extraHeaders: [`X: ${'a'.repeat(17000)}`], body: '{}' });
add('머리: 헤더 200개', { extraHeaders: Array.from({ length: 200 }, (_, i) => `X-${i}: v`), body: '{}' });
add('머리: 헤더 이름에 공백', { extraHeaders: ['X Y: 1'], body: '{}' });
add('머리: 콜론 앞 공백', { extraHeaders: ['X : 1'], body: '{}' });
add('머리: 콜론 없는 줄', { extraHeaders: ['garbage'], body: '{}' });
add('머리: 줄 접기(obs-fold)', { extraHeaders: ['X: 1', ' folded'], body: '{}' });
add('머리: 헤더 값에 제어 문자', { extraHeaders: ['X: a\u0001b'], body: '{}' });
add('머리: LF만으로 줄 끝', (ctx) => latin1(`POST /stop HTTP/1.1\nHost: 127.0.0.1:${ctx.port}\nAuthorization: Bearer ${ctx.token}\nConnection: close\nContent-Length: 2\n\n{}`));
add('머리: Host 헤더 이름이 소문자', (ctx) => latin1(`POST /stop HTTP/1.1\r\nhost: 127.0.0.1:${ctx.port}\r\nauthorization: Bearer ${ctx.token}\r\nconnection: close\r\ncontent-length: 2\r\n\r\n{}`));
add('머리: Host 헤더 이름이 대문자', (ctx) => latin1(`POST /stop HTTP/1.1\r\nHOST: 127.0.0.1:${ctx.port}\r\nAUTHORIZATION: Bearer ${ctx.token}\r\nconnection: close\r\ncontent-length: 2\r\n\r\n{}`));
add('머리: 값 앞뒤 공백이 많은 Host', { host: '   localhost:{port}   ' });
add('머리: 값 앞뒤 공백이 많은 Authorization', { auth: '   Bearer {token}   ' });

describe('훅 서버 차등: 같은 원시 HTTP 요청에 옛 서버와 같은 상태·content-type·본문', () => {
  for (const testCase of cases) {
    const intended = INTENDED[testCase.name];
    it(`${intended ? '[의도한 차이, 거절 쪽] ' : ''}${testCase.name}`, async () => {
      const pair = testCase.on === 'plain' ? plain : container;
      const [legacy, native] = [pair.legacy, pair.native];
      const legacySeenBefore = pair.legacySeen.length;
      const nativeSeenBefore = pair.nativeSeen.length;
      const oldResult = await send(legacy.port, testCase.request({ port: legacy.port, token: legacy.token }), { halfClose: testCase.halfClose, timeoutMs: testCase.timeoutMs });
      const newResult = await send(native.port, testCase.request({ port: native.port, token: native.token }), { halfClose: testCase.halfClose, timeoutMs: testCase.timeoutMs });
      tally(counts.legacy, oldResult.status);
      tally(counts.native, newResult.status);
      // 처리가 불린 횟수와 받은 입력도 같아야 한다(입력은 echo로 응답 본문에도 실린다)
      const oldCalls = pair.legacySeen.slice(legacySeenBefore);
      const newCalls = pair.nativeSeen.slice(nativeSeenBefore);
      // 차이를 파일에 남긴다(HOOK_DIFF_LOG=경로). INTENDED를 채울 때 쓴다
      if (process.env.HOOK_DIFF_LOG && JSON.stringify(oldResult) !== JSON.stringify(newResult)) appendFileSync(process.env.HOOK_DIFF_LOG, `${JSON.stringify({ name: testCase.name, old: oldResult, new: newResult, oldCalls: oldCalls.length, newCalls: newCalls.length })}\n`);
      if (intended === undefined) {
        expect(newResult).toEqual(oldResult);
        expect(newCalls).toEqual(oldCalls);
        return;
      }
      // 의도한 차이: 새 서버는 옛 서버가 받지 않은 것을 받지 않는다. 처리가 불린 횟수와 받은 입력이 옛 서버가 처리한 것의 앞부분이어야 한다
      // (옛 서버는 응답이 사라질 수 있어 상태만으로는 받았는지 알 수 없다)
      expect(newCalls.length).toBeLessThanOrEqual(oldCalls.length);
      expect(newCalls).toEqual(oldCalls.slice(0, newCalls.length));
    }, 20000);
  }

  it('어떤 경우에도 새 서버가 옛 서버가 받지 않은 요청을 받지 않는다(넓어지지 않음)', () => {
    // 위 개별 시험이 같음을 요구하므로 이 시험은 분포만 본다: 옛 서버의 200이 새 서버의 200과 같은 수여야 한다
    expect(counts.native.get(200) ?? 0).toBeLessThanOrEqual(counts.legacy.get(200) ?? 0);
  });

  it('결과 분포가 한쪽으로 쏠리지 않았다(200·401·403·404·413·500이 모두 나왔다)', () => {
    for (const status of [200, 401, 403, 404, 413, 500]) {
      expect(counts.legacy.get(status) ?? 0, `옛 서버 ${status}`).toBeGreaterThanOrEqual(3);
      expect(counts.native.get(status) ?? 0, `새 서버 ${status}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('훅 서버 차등: 처리 시간과 동시성', () => {
  it('느린 처리(수 초) 중에도 연결을 끊지 않고 같은 답을 준다', async () => {
    const request = (ctx: Ctx) => http({ target: '/slow', body: '{}' })(ctx);
    const old = await send(container.legacy.port, request({ port: container.legacy.port, token: container.legacy.token }));
    const now = await send(container.native.port, request({ port: container.native.port, token: container.native.token }));
    expect(old).toEqual({ status: 200, contentType: 'application/json', body: '{"slow":true}' });
    expect(now).toEqual(old);
  }, 20000);

  it('머리를 천천히 보내도(시간 제한 없음) 같은 답을 준다', async () => {
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
    const old = await slowly(container.legacy);
    const now = await slowly(container.native);
    expect(old.status).toBe(200);
    expect(now).toEqual(old);
  }, 20000);

  it('동시 요청 여러 개: 느린 요청 둘이 도는 동안 빠른 요청은 막히지 않고, 모두 같은 답을 준다', async () => {
    const run = async (server: HookServer): Promise<{ results: Result[]; fastMs: number }> => {
      const ctx = { port: server.port, token: server.token };
      const slow = [send(server.port, http({ target: '/slow', body: '{}' })(ctx)), send(server.port, http({ target: '/slow', body: '{}' })(ctx))];
      await new Promise((resolve) => setTimeout(resolve, 200));
      const started = Date.now();
      const fast = await Promise.all(Array.from({ length: 6 }, (_, i) => send(server.port, http({ body: JSON.stringify({ i }) })(ctx))));
      const fastMs = Date.now() - started;
      return { results: [...fast, ...(await Promise.all(slow))], fastMs };
    };
    const old = await run(container.legacy);
    const now = await run(container.native);
    expect(now.results).toEqual(old.results);
    expect(old.fastMs).toBeLessThan(1500);
    expect(now.fastMs).toBeLessThan(1500);
  }, 30000);

  it('keep-alive로 같은 연결에 요청 둘을 이어 보내도 같은 답을 준다', async () => {
    const twice = async (server: HookServer): Promise<string[]> => {
      const ctx = { port: server.port, token: server.token };
      const first = http({ body: '{"n":1}' })(ctx).toString('latin1').replace('Connection: close', 'Connection: keep-alive');
      const second = http({ body: '{"n":2}' })(ctx);
      return new Promise((resolve) => {
        const socket = connect(server.port, '127.0.0.1');
        const chunks: Buffer[] = [];
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.on('close', () => resolve(bodiesOf(Buffer.concat(chunks))));
        socket.on('error', () => {});
        socket.write(Buffer.concat([latin1(first), second]));
      });
    };
    const old = await twice(container.legacy);
    const now = await twice(container.native);
    expect(old).toEqual(['{"echo":{"n":1}}', '{"echo":{"n":2}}']);
    expect(now).toEqual(old);
  });

  it('파이프라인으로 토큰이 맞는 요청 뒤에 틀린 요청을 이어 보내도 두 번째는 판정을 거친다', async () => {
    const pipelined = async (server: HookServer): Promise<string[]> => {
      const ctx = { port: server.port, token: server.token };
      const first = http({ body: '{}' })(ctx).toString('latin1').replace('Connection: close', 'Connection: keep-alive');
      const second = http({ auth: 'Bearer nope', body: '{}' })(ctx);
      return new Promise((resolve) => {
        const socket = connect(server.port, '127.0.0.1');
        const chunks: Buffer[] = [];
        socket.on('data', (chunk) => chunks.push(chunk));
        socket.on('close', () => resolve(bodiesOf(Buffer.concat(chunks))));
        socket.on('error', () => {});
        socket.write(Buffer.concat([latin1(first), second]));
      });
    };
    const old = await pipelined(container.legacy);
    const now = await pipelined(container.native);
    expect(old).toEqual(['{"echo":{}}', '{"error":"unauthorized"}']);
    expect(now).toEqual(old);
  });
});
