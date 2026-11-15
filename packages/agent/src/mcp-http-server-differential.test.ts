import { appendFileSync } from 'node:fs';
import { connect } from 'node:net';
import type { LoadedProject } from '@b-studio/spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startToolServer, type ToolServer, type ToolServerOptions } from './mcp-http-server';
import { startToolServer as startLegacy } from './mcp-http-server-legacy';
import { createOrdersProject } from './test-helpers';
import { buildTools, type ToolOutcome } from './tools';

/**
 * MCP 도구 서버의 전송·프로토콜을 Rust로 옮긴 것(ADR-201, 4f A7b)을 옛 서버(mcp-http-server-legacy.ts: node:http + @modelcontextprotocol/sdk)와 견준다.
 * 같은 specs·run으로 둘을 띄우고 **같은 바이트의 원시 HTTP 요청**을 `node:net`으로 보내 상태·content-type·본문을 견준다(SSE는 `data:` 줄을 풀어 JSON으로 견준다).
 * 도구 실행 쪽은 두 서버가 `run`에 넘긴 이름·인자(zod가 모르는 키를 지운 값)도 견준다.
 *
 * 규칙: 두 서버의 결과가 같아야 한다. 다른 것은 INTENDED에 이유와 함께 적은 것뿐이고, 그것도 **거절 쪽으로만** 다를 수 있다.
 */

interface Seen {
  name: string;
  args: unknown;
}

interface Pair {
  legacy: ToolServer;
  native: ToolServer;
  legacySeen: Seen[];
  nativeSeen: Seen[];
}

const IMAGE = { data: 'QUJD', mimeType: 'image/png' };

function runFor(seen: Seen[]): (name: string, args: unknown) => Promise<ToolOutcome> {
  return async (name, args) => {
    seen.push({ name, args });
    if (name === 'boom') throw new Error('안에서 실패');
    if (name === 'boom_text') throw 'plain string';
    if (name === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { ok: true, content: 'slow 끝' };
    }
    if (name === 'shot') return { ok: true, content: '화면', images: [IMAGE, { data: 'REVG', mimeType: 'image/jpeg' }] };
    if (name === 'lone') return { ok: false, content: 'a\ud800b\udc00  끝' };
    return { ok: name !== 'fail', content: JSON.stringify({ name, args }) };
  };
}

const SYNTHETIC = [
  {
    name: 'a_tool',
    description: 'Desc A',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'p' },
        n: { type: 'integer' },
        mode: { type: 'string', enum: ['x', 'y'], description: 'm' },
        flag: { type: 'boolean', description: 'f' },
        list: { type: 'array', items: { type: 'string' }, description: 'l' },
        opt: { type: 'string' },
        num_enum: { type: 'string', enum: ['b', '2', '1', 'b', 'a'] },
      },
      required: ['path', 'n', 'mode', 'flag', 'list', 'num_enum'],
    },
  },
  { name: 'empty', description: 'E', input_schema: { type: 'object', properties: {} } },
  { name: 'nodesc', input_schema: { type: 'object', properties: { s: { type: 'string' } } } },
  { name: 'write_file', description: 'W', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'boom', description: 'B', input_schema: { type: 'object', properties: { x: { type: 'string' } } } },
  { name: 'boom_text', description: 'BT', input_schema: { type: 'object', properties: {} } },
  { name: 'slow', description: 'S', input_schema: { type: 'object', properties: {} } },
  { name: 'shot', description: 'I', input_schema: { type: 'object', properties: {} } },
  { name: 'lone', description: 'L', input_schema: { type: 'object', properties: {} } },
  { name: 'fail', description: 'F', input_schema: { type: 'object', properties: { v: { type: 'integer' } }, required: ['v'] } },
];

async function startPair(options: Omit<ToolServerOptions, 'run'>): Promise<Pair> {
  const legacySeen: Seen[] = [];
  const nativeSeen: Seen[] = [];
  const legacy = await startLegacy({ ...options, run: runFor(legacySeen) });
  const native = await startToolServer({ ...options, run: runFor(nativeSeen) });
  return { legacy, native, legacySeen, nativeSeen };
}

type PairName = 'strict' | 'honor' | 'empty' | 'real';

interface Ctx {
  port: number;
  token: string;
}

interface Result {
  /** 0이면 응답 없이 연결이 끊겼다 */
  status: number;
  contentType: string | null;
  allow: string | null;
  /** SSE가 아니면 본문 글자 */
  body: string;
  /** SSE의 `data:` 줄을 JSON으로 푼 것(keepalive 주석은 뺀다) */
  events: unknown[] | null;
}

const latin1 = (text: string): Buffer => Buffer.from(text, 'latin1');

interface RequestOptions {
  method?: string;
  target?: string;
  version?: string;
  /** undefined: 루프백 Host. null: Host 줄 없음. 배열: 줄 여러 개. `{port}`는 서버 포트로 바뀐다 */
  host?: string | Buffer | string[] | null;
  auth?: string | string[] | null;
  /** undefined: 둘 다 받는다. null: 줄 없음. 배열: 줄 여러 개 */
  accept?: string | string[] | null;
  contentType?: string | string[] | null;
  protocolVersion?: string | string[] | null;
  extraHeaders?: string[];
  body?: Buffer | string;
  /** undefined: 본문 길이. null: 줄 없음 */
  contentLength?: number | null;
  chunked?: boolean;
  /** `Connection: close`를 붙일지(기본 붙임) */
  keepAlive?: boolean;
}

function http(options: RequestOptions): (ctx: Ctx) => Buffer {
  return (ctx) => {
    const sub = (text: string): string => text.replaceAll('{port}', String(ctx.port)).replaceAll('{token}', ctx.token);
    const body = typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : (options.body ?? Buffer.alloc(0));
    const parts: Buffer[] = [latin1(`${options.method ?? 'POST'} ${sub(options.target ?? '/mcp')} ${options.version ?? 'HTTP/1.1'}\r\n`)];
    const line = (value: string | Buffer): Buffer => (typeof value === 'string' ? latin1(sub(value)) : value);
    const header = (name: string, value: string | Buffer | string[] | null | undefined, fallback: string | null): void => {
      const resolved = value === undefined ? fallback : value;
      if (resolved === null) return;
      for (const item of Array.isArray(resolved) ? resolved : [resolved]) parts.push(latin1(`${name}: `), line(item), latin1('\r\n'));
    };
    header('Host', options.host, '127.0.0.1:{port}');
    header('Authorization', options.auth, 'Bearer {token}');
    header('Accept', options.accept, 'application/json, text/event-stream');
    header('Content-Type', options.contentType, 'application/json');
    header('mcp-protocol-version', options.protocolVersion, null);
    if (options.keepAlive !== true) parts.push(latin1('Connection: close\r\n'));
    for (const extra of options.extraHeaders ?? []) parts.push(line(extra), latin1('\r\n'));
    if (options.chunked) {
      parts.push(latin1('Transfer-Encoding: chunked\r\n\r\n'));
      for (let at = 0; at < body.length; at += 100_000) {
        const piece = body.subarray(at, at + 100_000);
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

/**
 * 응답 하나가 다 왔는가. 옛 서버의 SSE 응답은 `connection: keep-alive`를 명시해서 요청이 `Connection: close`여도 연결을 5초 동안 열어 두므로
 * 연결이 닫히기를 기다리지 않고 본문이 끝난 것(chunked 끝 표시·Content-Length만큼·본문 없는 응답)으로 끝을 안다
 */
function responseComplete(data: Buffer, headOnly: boolean): boolean {
  let view = data;
  for (;;) {
    if (!view.subarray(0, 10).toString('latin1').startsWith('HTTP/1.1 1')) break;
    const interim = view.indexOf('\r\n\r\n');
    if (interim < 0) return false;
    view = view.subarray(interim + 4);
  }
  const end = view.indexOf('\r\n\r\n');
  if (end < 0) return false;
  const headers = headerMap(view.subarray(0, end).toString('latin1').split('\r\n').slice(1));
  const rest = view.subarray(end + 4);
  if (headOnly) return true;
  if (headers.get('transfer-encoding')?.toLowerCase() === 'chunked') return rest.indexOf('0\r\n\r\n') >= 0 && rest.subarray(-5).toString('latin1') === '0\r\n\r\n';
  if (headers.has('content-length')) return rest.length >= Number(headers.get('content-length'));
  return false;
}

/** 요청을 보내고 응답이 다 오거나 연결이 닫힐 때까지(또는 시간 제한) 읽은 응답. 연결 오류(RST 등)는 읽은 데까지로 본다 */
function send(port: number, request: Buffer, { halfClose = false, timeoutMs = 8000, hold = false }: { halfClose?: boolean; timeoutMs?: number; hold?: boolean } = {}): Promise<Result> {
  const headOnly = request.subarray(0, 5).toString('latin1') === 'HEAD ';
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
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (!hold && responseComplete(Buffer.concat(chunks), headOnly)) finish();
    });
    socket.on('close', finish);
    socket.on('error', () => {});
    socket.on('connect', () => {
      socket.write(request, () => {
        if (halfClose) socket.end();
      });
    });
  });
}

function headerMap(lines: string[]): Map<string, string> {
  return new Map(lines.map((entry) => [entry.slice(0, entry.indexOf(':')).toLowerCase(), entry.slice(entry.indexOf(':') + 1).trim()]));
}

function dechunk(rest: Buffer): Buffer {
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

function parse(input: Buffer): Result {
  let data = input;
  while (data.subarray(0, 10).toString('latin1').startsWith('HTTP/1.1 1')) {
    const interim = data.indexOf('\r\n\r\n');
    if (interim < 0) break;
    data = data.subarray(interim + 4);
  }
  const end = data.indexOf('\r\n\r\n');
  if (end < 0) return { status: 0, contentType: null, allow: null, body: '', events: null };
  const head = data.subarray(0, end).toString('latin1').split('\r\n');
  const status = Number(head[0]?.split(' ')[1] ?? 0);
  const headers = headerMap(head.slice(1));
  const rest = data.subarray(end + 4);
  const raw = headers.get('transfer-encoding')?.toLowerCase() === 'chunked' ? dechunk(rest) : headers.has('content-length') ? rest.subarray(0, Number(headers.get('content-length'))) : rest;
  const text = raw.toString('utf8');
  const contentType = headers.get('content-type') ?? null;
  let events: unknown[] | null = null;
  if (contentType?.startsWith('text/event-stream')) {
    events = text
      .split('\n\n')
      .map((block) => block.split('\n').filter((entry) => entry.startsWith('data: ')))
      .filter((lines) => lines.length > 0)
      .map((lines) => JSON.parse(lines.map((entry) => entry.slice(6)).join('\n')) as unknown);
  }
  return { status, contentType, allow: headers.get('allow') ?? null, body: events === null ? text : '', events };
}

/** 다르게 나와도 되는 요청과 그 이유. 모두 새 서버가 더 좁게(거절로) 읽거나 같은 거절의 글만 다른 쪽이다 */
const INTENDED: Record<string, string> = {
  '토큰이 틀리면 4MiB가 넘는 본문이어도 401': 'Node는 본문을 읽지 않은 채 응답해 클라이언트가 보내는 중에 RST가 나면 응답이 사라진다(상태 0). 새 서버는 보내던 것을 흘려 보내며 응답을 전달한다(둘 다 거절)',
  'Host가 나쁘면 4MiB가 넘는 본문이어도 403': '위와 같다',
  '본문: 4MiB + 1': '위와 같다(상한을 넘은 뒤 413을 썼는데 클라이언트가 계속 보내는 중이라 옛 서버에서는 응답이 사라진다)',
  '본문: Content-Length 없는 POST': 'Node는 본문이 없는 요청으로 읽고 뒤따른 바이트를 다음 요청으로 읽다 깨져 응답이 나가기 전에 연결을 끊는다. 새 서버는 400을 준다(처리 횟수는 같다: 둘 다 0)',
};

const counts = { legacy: new Map<string, number>(), native: new Map<string, number>() };
const tally = (map: Map<string, number>, result: Result): void => {
  const key = `${result.status}${result.events !== null ? '/sse' : ''}`;
  map.set(key, (map.get(key) ?? 0) + 1);
};

const pairs = {} as Record<PairName, Pair>;
let project: LoadedProject;

beforeAll(async () => {
  project = await createOrdersProject('mcp-diff-');
  pairs.strict = await startPair({ specs: SYNTHETIC as never, allowedHosts: ['host.docker.internal', 'é'] });
  pairs.honor = await startPair({ specs: SYNTHETIC as never, honorRequired: true, name: '이름 \ud800 x' });
  pairs.empty = await startPair({ specs: [] });
  pairs.real = await startPair({ specs: buildTools(project), name: 'b-studio' });
});

afterAll(async () => {
  for (const pair of Object.values(pairs)) {
    await pair.legacy.close();
    await pair.native.close();
  }
  const line = `[mcp-server 차등] 옛 서버 결과 분포 ${JSON.stringify(Object.fromEntries([...counts.legacy].sort()))}, 새 서버 ${JSON.stringify(Object.fromEntries([...counts.native].sort()))}`;
  // eslint-disable-next-line no-console
  console.log(line);
  if (process.env.MCP_DIFF_LOG) appendFileSync(process.env.MCP_DIFF_LOG, `${line}\n`);
});

interface Case {
  name: string;
  request: (ctx: Ctx) => Buffer;
  on?: PairName;
  halfClose?: boolean;
  timeoutMs?: number;
  /** 열려 있는 SSE(GET)는 응답이 끝나지 않는다. 이 시간만 읽고 비교한다 */
  hold?: boolean;
}

const cases: Case[] = [];
const add = (name: string, options: RequestOptions | ((ctx: Ctx) => Buffer), more: Partial<Case> = {}): void => {
  cases.push({ name, request: typeof options === 'function' ? options : http(options), ...more });
};

const rpc = (method: string, params?: unknown, id: unknown = 1): string => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const call = (name: string, args?: unknown, extra: Record<string, unknown> = {}): string => rpc('tools/call', { name, ...(args === undefined ? {} : { arguments: args }), ...extra });
const PING = rpc('ping');
const INIT = (version = '2025-03-26'): string => rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'c', version: '1' } });

// ── 인증(Host·토큰) ──
for (const [label, host] of [
  ['루프백 127.0.0.1(포트 없음)', '127.0.0.1'],
  ['루프백 127.0.0.1:포트', '127.0.0.1:{port}'],
  ['localhost:포트', 'localhost:{port}'],
  ['대문자 LOCALHOST:포트', 'LOCALHOST:{port}'],
  ['[::1]:포트', '[::1]:{port}'],
  ['[::1]', '[::1]'],
  ['여는 대괄호만 [::1', '[::1'],
  ['허용 이름:포트', 'host.docker.internal:{port}'],
  ['허용 이름 대소문자 섞임', 'HOST.Docker.Internal:{port}'],
  ['허용 이름 접두 xhost', 'xhost.docker.internal'],
  ['허용 이름 접미 .evil.com', 'host.docker.internal.evil.com'],
  ['허용 이름 끝 점', 'host.docker.internal.'],
  ['허용 이름 뒤 @', 'host.docker.internal@evil.com'],
  ['허용 이름 한 글자 짧음', 'host.docker.interna'],
  ['다른 이름', 'evil.com'],
  ['빈 Host', ''],
  ['쉼표로 이은 Host', 'localhost, evil.com'],
  ['포트가 둘', 'localhost:80:90'],
  ['포트 범위 밖 127.0.0.1:99999', '127.0.0.1:99999'],
  ['포트 0', '127.0.0.1:0'],
  ['포트 비어 있음 127.0.0.1:', '127.0.0.1:'],
  ['포트가 글자 127.0.0.1:abc', '127.0.0.1:abc'],
  ['비 ASCII 허용 이름 é를 latin1 한 바이트(0xE9)로', Buffer.from([0xe9])],
  ['비 ASCII 허용 이름 é를 UTF-8(0xC3 0xA9)로', Buffer.from('é', 'utf8')],
  ['전각 localhost(UTF-8)', Buffer.from('ｌｏｃａｌｈｏｓｔ', 'utf8')],
  ['잘못된 바이트 0xFF 0xFE', Buffer.from([0xff, 0xfe])],
] as const) {
  add(`Host: ${label}`, { host: host as string | Buffer, body: PING });
}
add('Host 줄 없음(HTTP/1.1)', { host: null, body: PING });
add('Host 줄 없음(HTTP/1.0)', { host: null, version: 'HTTP/1.0', body: PING });
add('Host 중복: 루프백, 다른 이름', { host: ['localhost:{port}', 'evil.com'], body: PING });
add('Host 중복: 다른 이름, 루프백', { host: ['evil.com', 'localhost:{port}'], body: PING });
add('토큰: 없음', { auth: null, body: PING });
add('토큰: 빈 값', { auth: '', body: PING });
add('토큰: 한 글자 다름', (ctx) => http({ auth: `Bearer ${ctx.token.slice(0, -1)}${ctx.token.endsWith('a') ? 'b' : 'a'}`, body: PING })(ctx));
add('토큰: 앞부분만(접두)', (ctx) => http({ auth: `Bearer ${ctx.token.slice(0, 20)}`, body: PING })(ctx));
add('토큰: 뒤에 한 글자 더', { auth: 'Bearer {token}x', body: PING });
add('토큰: Bearer 소문자', { auth: 'bearer {token}', body: PING });
add('토큰: Bearer 뒤 공백 둘', { auth: 'Bearer  {token}', body: PING });
add('토큰: 접두 없음', { auth: '{token}', body: PING });
add('토큰: Bearer만', { auth: 'Bearer', body: PING });
add('토큰: 뒤 공백', { auth: 'Bearer {token} ', body: PING });
add('토큰: 중복 줄(맞는 것이 첫째)', { auth: ['Bearer {token}', 'Bearer x'], body: PING });
add('토큰: 중복 줄(틀린 것이 첫째)', { auth: ['Bearer x', 'Bearer {token}'], body: PING });
add('토큰이 틀리면 4MiB가 넘는 본문이어도 401', { auth: 'Bearer x', body: Buffer.alloc(5 * 1024 * 1024, 0x20) });
add('Host가 나쁘면 4MiB가 넘는 본문이어도 403', { host: 'evil.com', body: Buffer.alloc(5 * 1024 * 1024, 0x20) });

// ── 경로(옛 서버는 경로를 보지 않는다) ──
for (const target of ['/mcp', '/', '/other', '/mcp/', '/mcp?x=1', '//mcp', '/a/../mcp', '/%2e%2e/x', '/MCP', '/a b'.replace(' ', '%20'), '/%zz', '/mcp#frag', '*', 'http://127.0.0.1:1/mcp', 'https://example.com/x', 'mcp', '/mcp\\x', "/'", '/é']) {
  add(`경로: ${target}`, { target, body: PING });
}
add('경로: 아주 긴 경로', { target: `/${'a'.repeat(8000)}`, body: PING });

// ── 메서드 ──
for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'PROPFIND', 'LINK', 'PURGE']) {
  add(`메서드: ${method}(Accept 둘 다)`, { method, contentLength: null, accept: 'application/json, text/event-stream' }, { hold: method === 'GET' });
  add(`메서드: ${method}(Accept JSON만)`, { method, contentLength: null, accept: 'application/json' });
  add(`메서드: ${method}(Accept 없음)`, { method, contentLength: null, accept: null });
}
add('GET: 지원하지 않는 프로토콜 버전', { method: 'GET', contentLength: null, accept: 'text/event-stream', protocolVersion: '1999' });
add('GET: 지원하는 프로토콜 버전', { method: 'GET', contentLength: null, accept: 'text/event-stream', protocolVersion: '2025-03-26' }, { hold: true });
add('GET: Accept에 text/event-stream이 섞임', { method: 'GET', contentLength: null, accept: 'text/html, text/event-stream;q=0.9' }, { hold: true });
add('GET: Accept 대문자(Text/Event-Stream)', { method: 'GET', contentLength: null, accept: 'Text/Event-Stream' });
add('GET: 본문이 붙음', { method: 'GET', accept: 'text/event-stream', body: '{}' }, { hold: true });
add('DELETE: 지원하지 않는 프로토콜 버전', { method: 'DELETE', contentLength: null, protocolVersion: '1999' });
add('DELETE: 지원하는 프로토콜 버전', { method: 'DELETE', contentLength: null, protocolVersion: '2024-11-05' });
add('DELETE: 본문이 붙음', { method: 'DELETE', body: '{}' });
add('PUT: 본문이 붙음', { method: 'PUT', body: PING });

// ── POST 헤더(Accept·Content-Type·프로토콜 버전) ──
for (const [label, accept] of [
  ['없음', null],
  ['application/json만', 'application/json'],
  ['text/event-stream만', 'text/event-stream'],
  ['*/*', '*/*'],
  ['둘 다 + q 값', 'application/json;q=0.9, text/event-stream;q=0.8'],
  ['순서 바꿈', 'text/event-stream, application/json'],
  ['대문자', 'Application/JSON, Text/Event-Stream'],
  ['한 줄 하나씩 두 줄', ['application/json', 'text/event-stream']],
  ['application/json이 부분 문자열(x-application/json-x)', 'x-application/json-x, x-text/event-stream-x'],
  ['빈 값', ''],
] as const) {
  add(`Accept: ${label}`, { accept: accept as string | string[] | null, body: PING });
}
for (const [label, contentType] of [
  ['없음', null],
  ['빈 값', ''],
  ['text/plain', 'text/plain'],
  ['application/json; charset=utf-8', 'application/json; charset=utf-8'],
  ['application/json;charset=utf-8', 'application/json;charset=utf-8'],
  ['대문자 Application/JSON', 'Application/JSON'],
  ['앞뒤 공백', '  application/json  '],
  ['application/jsonx', 'application/jsonx'],
  ['application/json;(끝에 세미콜론)', 'application/json;'],
  ['application/json; charset(값 없는 매개변수)', 'application/json; charset'],
  ['application/json; a="b,c"', 'application/json; a="b,c"'],
  ['application/json; a=b, c=d', 'application/json; a=b, c=d'],
  ['application/json, text/plain', 'application/json, text/plain'],
  ['두 줄 application/json', ['application/json', 'application/json']],
  ['두 줄 application/json, text/plain', ['application/json', 'text/plain']],
  ['application/json 뒤 공백 매개변수 ; a=b', 'application/json ; a=b'],
  ['application/json + 비 ASCII 매개변수', 'application/json; a=é'],
  ['application/ json', 'application/ json'],
  ['application/vnd.api+json', 'application/vnd.api+json'],
  ['*/*', '*/*'],
] as const) {
  add(`Content-Type: ${label}`, { contentType: contentType as string | string[] | null, body: PING });
}
for (const [label, version] of [
  ['2025-11-25', '2025-11-25'],
  ['2025-06-18', '2025-06-18'],
  ['2025-03-26', '2025-03-26'],
  ['2024-11-05', '2024-11-05'],
  ['2024-10-07', '2024-10-07'],
  ['지원하지 않음 1999', '1999'],
  ['빈 값', ''],
  ['대문자 섞임', '2025-11-25 '],
  ['두 줄', ['2025-11-25', '2025-03-26']],
  ['두 줄(같은 값)', ['2025-11-25', '2025-11-25']],
] as const) {
  add(`mcp-protocol-version: ${label}(ping)`, { protocolVersion: version as string | string[], body: PING });
  add(`mcp-protocol-version: ${label}(initialize는 건너뛴다)`, { protocolVersion: version as string | string[], body: INIT() });
  add(`mcp-protocol-version: ${label}(알림만)`, { protocolVersion: version as string | string[], body: rpc('notifications/initialized').replace(/"id":1,/, '') });
}

// ── 메시지 ──
add('ping', { body: PING });
add('ping(id 문자열)', { body: rpc('ping', undefined, 'abc') });
add('ping(params 객체)', { body: rpc('ping', { x: 1 }) });
add('ping(params null)', { body: '{"jsonrpc":"2.0","id":1,"method":"ping","params":null}' });
add('ping(params 배열)', { body: '{"jsonrpc":"2.0","id":1,"method":"ping","params":[]}' });
add('ping(_meta.progressToken 문자열)', { body: rpc('ping', { _meta: { progressToken: 'p' } }) });
add('ping(_meta.progressToken 실수)', { body: rpc('ping', { _meta: { progressToken: 1.5 } }) });
add('ping(_meta 배열)', { body: rpc('ping', { _meta: [] }) });
add('ping(_meta related-task 맞음)', { body: rpc('ping', { _meta: { 'io.modelcontextprotocol/related-task': { taskId: 't' } } }) });
add('ping(_meta related-task taskId 수)', { body: rpc('ping', { _meta: { 'io.modelcontextprotocol/related-task': { taskId: 1 } } }) });
for (const [label, id] of [
  ['id 1e2', '1e2'],
  ['id -0', '-0'],
  ['id 1.0', '1.0'],
  ['id 1.5', '1.5'],
  ['id 2^53-1', '9007199254740991'],
  ['id 2^53', '9007199254740992'],
  ['id -(2^53-1)', '-9007199254740991'],
  ['id 1e999', '1e999'],
  ['id null', 'null'],
  ['id true', 'true'],
  ['id 배열', '[1]'],
  ['id 짝 없는 서로게이트 문자열', '"\\ud800"'],
  ['id 예약 글자 문자열', '""'],
  ['id 빈 문자열', '""'],
  ['id 한글', '"아이디"'],
] as const) {
  add(`메시지: ${label}`, { body: `{"jsonrpc":"2.0","id":${id},"method":"ping"}` });
}
add('메시지: 알림만', { body: '{"jsonrpc":"2.0","method":"notifications/initialized"}' });
add('메시지: 알림(params 포함)', { body: '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}' });
add('메시지: 알림이 id를 가짐(id 실수)', { body: '{"jsonrpc":"2.0","id":1.5,"method":"notifications/initialized"}' });
add('메시지: 성공 응답만', { body: '{"jsonrpc":"2.0","id":1,"result":{}}' });
add('메시지: 성공 응답(result 배열)', { body: '{"jsonrpc":"2.0","id":1,"result":[]}' });
add('메시지: 오류 응답만', { body: '{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"m"}}' });
add('메시지: 오류 응답(id 없음)', { body: '{"jsonrpc":"2.0","error":{"code":-1,"message":"m"}}' });
add('메시지: 오류 응답(code 실수)', { body: '{"jsonrpc":"2.0","id":1,"error":{"code":1.5,"message":"m"}}' });
add('메시지: 오류 응답(message 없음)', { body: '{"jsonrpc":"2.0","id":1,"error":{"code":1}}' });
add('메시지: 모르는 키', { body: '{"jsonrpc":"2.0","id":1,"method":"ping","foo":1}' });
add('메시지: jsonrpc 1.0', { body: '{"jsonrpc":"1.0","id":1,"method":"ping"}' });
add('메시지: jsonrpc 없음', { body: '{"id":1,"method":"ping"}' });
add('메시지: method가 수', { body: '{"jsonrpc":"2.0","id":1,"method":5}' });
add('메시지: 빈 객체', { body: '{}' });
add('메시지: null', { body: 'null' });
add('메시지: 수', { body: '5' });
add('메시지: 문자열', { body: '"ping"' });
add('메시지: 모르는 메서드', { body: rpc('foo/bar') });
add('메시지: 모르는 메서드(resources/list)', { body: rpc('resources/list') });
add('메시지: prompts/list', { body: rpc('prompts/list') });
add('메시지: 키가 중복(뒤 값이 이김)', { body: '{"jsonrpc":"2.0","id":1,"id":2,"method":"ping"}' });
add('메시지: 키가 중복(method)', { body: '{"jsonrpc":"2.0","id":1,"method":"nope","method":"ping"}' });
add('본문: 빈 본문', { body: '' });
add('본문: 깨진 JSON', { body: '{' });
add('본문: 공백만', { body: '   ' });
add('본문: 앞뒤 공백이 있는 JSON', { body: `  \n${PING}\n  ` });
add('본문: BOM이 붙은 JSON', { body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(PING)]) });
add('본문: BOM 둘', { body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from(PING)]) });
add('본문: 잘못된 UTF-8 바이트가 문자열 안에', { body: Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":"'), Buffer.from([0xff, 0xc3, 0x28, 0xe2, 0x82]), Buffer.from('","method":"ping"}')]) });
add('본문: UTF-16 BOM', { body: Buffer.from([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]) });
add('본문: NUL 바이트', { body: Buffer.concat([Buffer.from(PING), Buffer.from([0])]) });
add('본문: 끝에 쓰레기', { body: `${PING}x` });
add('본문: 주석 섞인 JSON', { body: '{"jsonrpc":"2.0",/*c*/"id":1,"method":"ping"}' });
add('본문: 작은따옴표 JSON', { body: "{'jsonrpc':'2.0','id':1,'method':'ping'}" });
add('본문: 후행 쉼표', { body: '{"jsonrpc":"2.0","id":1,"method":"ping",}' });
add('본문: 매우 깊은 중첩 배열(5000)', { body: `${'['.repeat(5000)}${']'.repeat(5000)}` });
add('본문: 깊은 중첩 params(500)', { body: `{"jsonrpc":"2.0","id":1,"method":"ping","params":${'{"a":'.repeat(500)}1${'}'.repeat(500)}}` });
add('본문: 큰 정수 params', { body: '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"n":123456789012345678901234567890}}' });
add('본문: 값 이스케이프(\\u0000·\\ud800·\\udc00)', { body: '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"s":"\\u0000\\ud800\\udc00"}}' });
add('본문: Content-Length 없는 POST', { body: PING, contentLength: null });
add('본문: Content-Length가 본문보다 큼(연결을 반쯤 닫음)', { body: PING, contentLength: PING.length + 10 }, { halfClose: true, timeoutMs: 1500 });
add('본문: chunked', { body: PING, chunked: true });

// 상한: 요청 본문 전체가 정확히 4MiB(4194304바이트)면 받고 1바이트 넘으면 413이다
const PAD = (total: number): string => {
  const head = '{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":"';
  const tail = '"}}';
  return head + 'x'.repeat(total - head.length - tail.length) + tail;
};
add('본문: 정확히 4MiB', { body: PAD(4 * 1024 * 1024) });
add('본문: 4MiB + 1', { body: PAD(4 * 1024 * 1024 + 1) });
add('본문: 4MiB - 1', { body: PAD(4 * 1024 * 1024 - 1) });
add('본문: chunked 정확히 4MiB', { body: PAD(4 * 1024 * 1024), chunked: true });
add('본문: chunked 4MiB + 1', { body: PAD(4 * 1024 * 1024 + 1), chunked: true });
add('본문: 1MiB 큰 도구 인자', { body: call('write_file', { path: 'a', content: 'ㅎ'.repeat(300_000) }) });

// ── 배치 ──
add('배치: 빈 배열', { body: '[]' });
add('배치: ping 둘', { body: `[${rpc('ping', undefined, 1)},${rpc('ping', undefined, 2)}]` });
add('배치: ping과 알림', { body: `[${rpc('ping')},{"jsonrpc":"2.0","method":"notifications/initialized"}]` });
add('배치: 알림만 둘', { body: '[{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"2.0","method":"notifications/initialized"}]' });
add('배치: tools/list와 ping', { body: `[${rpc('tools/list', undefined, 'a')},${rpc('ping', undefined, 'b')}]` });
add('배치: 모르는 항목이 섞임', { body: `[${PING},5]` });
add('배치: initialize와 ping', { body: `[${INIT()},${rpc('ping', undefined, 2)}]` });
add('배치: 항목이 100개', { body: `[${Array.from({ length: 100 }, (_, i) => rpc('ping', undefined, i)).join(',')}]` });
add('배치: 항목이 101개', { body: `[${Array.from({ length: 101 }, (_, i) => rpc('ping', undefined, i)).join(',')}]` });
add('배치: id가 같은 둘', { body: `[${rpc('ping', undefined, 1)},${rpc('ping', undefined, 1)}]` });
add('배치: 느린 도구와 빠른 도구(완료 순서대로 나온다)', { body: `[${call('slow')},${rpc('ping', undefined, 2)}]` });
add('배치: 도구 호출 둘', { body: `[${call('a_tool', { path: 'p', n: 1, mode: 'x', flag: true, list: [], num_enum: '1' })},${rpc('tools/call', { name: 'fail', arguments: { v: 2 } }, 2)}]` });
add('배치: 중첩 배열', { body: `[[${PING}]]` });
add('초기화: 알림으로 보낸 initialize', { body: '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}', protocolVersion: '1999' });

// ── initialize ──
for (const version of ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07', '1999', '']) {
  add(`initialize: ${version || '빈 버전'}`, { body: INIT(version) });
}
add('initialize: params 없음', { body: rpc('initialize') });
add('initialize: protocolVersion이 수', { body: rpc('initialize', { protocolVersion: 5, capabilities: {}, clientInfo: { name: 'c', version: '1' } }) });
add('initialize: capabilities 없음', { body: rpc('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'c', version: '1' } }) });
add('initialize: clientInfo 없음', { body: rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {} }) });
add('initialize: clientInfo.name 없음', { body: rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { version: '1' } }) });
add('initialize: capabilities에 roots·sampling·elicitation', { body: rpc('initialize', { protocolVersion: '2025-03-26', capabilities: { roots: { listChanged: true }, sampling: {}, elicitation: {} }, clientInfo: { name: 'c', version: '1', title: 't' } }) });
add('initialize: 모든 필드가 틀림', { body: rpc('initialize', { protocolVersion: 5, capabilities: 'x', clientInfo: [] }) });
add('initialize: 도구 목록이 비었을 때(capabilities {})', { body: INIT() }, { on: 'empty' });
add('initialize: 서버 이름에 짝 없는 서로게이트', { body: INIT() }, { on: 'honor' });

// ── tools/list ──
add('tools/list(모두 필수)', { body: rpc('tools/list') }, { on: 'strict' });
add('tools/list(honorRequired)', { body: rpc('tools/list') }, { on: 'honor' });
add('tools/list(buildTools의 실제 도구)', { body: rpc('tools/list') }, { on: 'real' });
add('tools/list(도구 없음: Method not found)', { body: rpc('tools/list') }, { on: 'empty' });
add('tools/call(도구 없음)', { body: call('x', {}) }, { on: 'empty' });
add('tools/list(cursor 문자열)', { body: rpc('tools/list', { cursor: 'c' }) });
add('tools/list(cursor 수)', { body: rpc('tools/list', { cursor: 5 }) });
add('tools/list(cursor null)', { body: rpc('tools/list', { cursor: null }) });
add('tools/list(params 빈 객체)', { body: rpc('tools/list', {}) });

// ── tools/call: 이름·인자 ──
const OK_ARGS = { path: 'p', n: 1, mode: 'x', flag: true, list: ['a'], num_enum: 'b' };
for (const on of ['strict', 'honor'] as const) {
  const tag = on === 'honor' ? '(honorRequired)' : '';
  add(`call${tag}: 정상`, { body: call('a_tool', OK_ARGS) }, { on });
  add(`call${tag}: 모르는 키를 지운다`, { body: call('a_tool', { ...OK_ARGS, extra: 1, __proto__x: [1], zz: { a: 1 } }) }, { on });
  add(`call${tag}: 선택 인자 포함`, { body: call('a_tool', { ...OK_ARGS, opt: 'o' }) }, { on });
  add(`call${tag}: 선택 인자가 null`, { body: call('a_tool', { ...OK_ARGS, opt: null }) }, { on });
  add(`call${tag}: 선택 인자가 수`, { body: call('a_tool', { ...OK_ARGS, opt: 5 }) }, { on });
  add(`call${tag}: 인자 없음(arguments 없음)`, { body: call('a_tool') }, { on });
  add(`call${tag}: arguments가 빈 객체`, { body: call('a_tool', {}) }, { on });
  add(`call${tag}: arguments가 null`, { body: call('a_tool', null) }, { on });
  add(`call${tag}: arguments가 배열`, { body: call('a_tool', [1]) }, { on });
  add(`call${tag}: arguments가 문자열`, { body: call('a_tool', 'x') }, { on });
  add(`call${tag}: arguments가 수`, { body: call('a_tool', 5) }, { on });
  add(`call${tag}: arguments가 true`, { body: call('a_tool', true) }, { on });
  add(`call${tag}: 타입이 모두 틀림`, { body: call('a_tool', { path: 1, n: 'a', mode: 'z', flag: 'no', list: [1, 'a', null], opt: null, num_enum: 3 }) }, { on });
  add(`call${tag}: 필수가 모두 빠짐`, { body: call('a_tool', { opt: 'x' }) }, { on });
  add(`call${tag}: list가 문자열`, { body: call('a_tool', { ...OK_ARGS, list: 'a' }) }, { on });
  add(`call${tag}: list가 객체`, { body: call('a_tool', { ...OK_ARGS, list: { 0: 'a' } }) }, { on });
  add(`call${tag}: list 항목이 객체·배열·불리언`, { body: call('a_tool', { ...OK_ARGS, list: [{}, [], true] }) }, { on });
  add(`call${tag}: enum 대문자`, { body: call('a_tool', { ...OK_ARGS, mode: 'X' }) }, { on });
  add(`call${tag}: enum 앞뒤 공백`, { body: call('a_tool', { ...OK_ARGS, mode: ' x' }) }, { on });
  add(`call${tag}: enum 빈 문자열`, { body: call('a_tool', { ...OK_ARGS, mode: '' }) }, { on });
  add(`call${tag}: enum에 객체`, { body: call('a_tool', { ...OK_ARGS, mode: {} }) }, { on });
  add(`call${tag}: enum 숫자 꼴 이름 순서('1','2','b','a')`, { body: call('a_tool', { ...OK_ARGS, num_enum: 'z' }) }, { on });
  add(`call${tag}: flag가 문자열 true`, { body: call('a_tool', { ...OK_ARGS, flag: 'true' }) }, { on });
  add(`call${tag}: flag가 0`, { body: call('a_tool', { ...OK_ARGS, flag: 0 }) }, { on });
  for (const [label, n] of [
    ['1.0', '1.0'],
    ['1e2', '1e2'],
    ['-0', '-0'],
    ['0', '0'],
    ['1.5', '1.5'],
    ['2^53-1', '9007199254740991'],
    ['2^53', '9007199254740992'],
    ['2^53+1', '9007199254740993'],
    ['-(2^53-1)', '-9007199254740991'],
    ['-(2^53)', '-9007199254740992'],
    ['2^63', '9223372036854775808'],
    ['2^64', '18446744073709551616'],
    ['1e300', '1e300'],
    ['-1e300', '-1e300'],
    ['1e999', '1e999'],
    ['-1e999', '-1e999'],
    ['문자열 "1"', '"1"'],
    ['null', 'null'],
    ['true', 'true'],
    ['배열', '[1]'],
    ['객체', '{}'],
    ['0.1', '0.1'],
    ['5e-324', '5e-324'],
  ] as const) {
    add(`call${tag}: n=${label}`, { body: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"a_tool","arguments":{"path":"p","n":${n},"mode":"x","flag":true,"list":[],"num_enum":"1"}}}` }, { on });
  }
  add(`call${tag}: 중복 키는 뒤 값이 이긴다`, { body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"a_tool","arguments":{"path":1,"path":"p","n":1,"n":2,"mode":"x","flag":true,"list":[],"num_enum":"1"}}}' }, { on });
  add(`call${tag}: 키 이름이 prototype 속성`, { body: call('a_tool', { ...OK_ARGS, constructor: 1, toString: 2, hasOwnProperty: 3 }) }, { on });
  add(`call${tag}: __proto__ 키(JSON 원문)`, { body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"a_tool","arguments":{"__proto__":{"x":1},"path":"p","n":1,"mode":"x","flag":true,"list":[],"num_enum":"1"}}}' }, { on });
}
add('call: 모르는 도구', { body: call('nope', {}) });
for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__lookupSetter__']) {
  add(`call: 도구 이름이 Object.prototype의 ${name}`, { body: call(name, {}) });
}
add('call: 도구 이름 대소문자(A_TOOL)', { body: call('A_TOOL', OK_ARGS) });
add('call: 도구 이름 빈 문자열', { body: call('', {}) });
add('call: 도구 이름 앞 공백', { body: call(' a_tool', OK_ARGS) });
add('call: 도구 이름에 짝 없는 서로게이트', { body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"a\\ud800b","arguments":{}}}' });
add('call: 도구 이름에 예약 글자', { body: call('ab', {}) });
add('call: name이 수', { body: rpc('tools/call', { name: 5 }) });
add('call: name 없음', { body: rpc('tools/call', { arguments: {} }) });
add('call: params 없음', { body: rpc('tools/call') });
add('call: params가 배열', { body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":[]}' });
add('call: task가 객체(작업 생성 거절)', { body: call('a_tool', OK_ARGS, { task: {} }) });
add('call: task.ttl이 수', { body: call('a_tool', OK_ARGS, { task: { ttl: 5 } }) });
add('call: task.ttl이 문자열', { body: call('a_tool', OK_ARGS, { task: { ttl: 'x' } }) });
add('call: task가 문자열', { body: call('a_tool', OK_ARGS, { task: 'x' }) });
add('call: task가 null', { body: call('a_tool', OK_ARGS, { task: null }) });
add('call: _meta.progressToken', { body: call('a_tool', OK_ARGS, { _meta: { progressToken: 7 } }) });
add('call: 이름이 틀리고 인자도 틀림', { body: call('nope', 5) });
add('call: empty 도구(arguments 없음)', { body: call('empty') });
add('call: empty 도구(인자가 있어도 모두 지운다)', { body: call('empty', { a: 1 }) });
add('call: nodesc 도구', { body: call('nodesc', { s: 'x' }) });

// ── tools/call: 결과 ──
add('call: ok false(isError)', { body: call('fail', { v: 3 }) });
add('call: run이 Error를 던짐', { body: call('boom', { x: 'a' }) });
add('call: run이 문자열을 던짐', { body: call('boom_text', {}) });
add('call: 이미지 둘', { body: call('shot', {}) });
add('call: 결과 글에 짝 없는 서로게이트와 예약 글자', { body: call('lone', {}) });
add('call: 인자에 짝 없는 서로게이트(write_file)', { body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write_file","arguments":{"path":"a\\ud800","content":"x\\udc00y\\ud83d\\ude00z\\ud83d"}}}' });
add('call: 인자에 글자 그대로의 예약 글자', { body: call('write_file', { path: 'a', content: '' }) });
add('call: 인자에 이모지·한글·제어 문자', { body: call('write_file', { path: '한글/😀.ts', content: 'a\u0000b\u001fc d e\u007f' }) });
add('call: 인자에 U+FEFF가 앞에 붙음', { body: call('write_file', { path: '﻿a', content: '﻿' }) });
add('call: 인자에 잘못된 UTF-8 바이트', { body: Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write_file","arguments":{"path":"a","content":"'), Buffer.from([0xff, 0xc3, 0x28]), Buffer.from('"}}}')]) });
add('call: 인자의 큰 문자열(2MiB)', { body: call('write_file', { path: 'a', content: 'x'.repeat(2 * 1024 * 1024) }) });
add('call: 키 순서가 달라도 같은 인자', { body: '{"params":{"arguments":{"content":"c","path":"p"},"name":"write_file"},"method":"tools/call","id":1,"jsonrpc":"2.0"}' });

// ── 도구 목록이 buildTools의 실제 도구일 때 ──
add('real: initialize', { body: INIT() }, { on: 'real' });
add('real: 모르는 도구', { body: call('nope', {}) }, { on: 'real' });
add('real: list_files 인자 검사', { body: call('list_files', { path: 5 }) }, { on: 'real' });
add('real: read_file 정상', { body: call('read_file', { path: 'api/src/Order.java' }) }, { on: 'real' });

interface Outcome {
  legacy: Result;
  native: Result;
  legacySeen: Seen[];
  nativeSeen: Seen[];
}

async function runCase(entry: Case): Promise<Outcome> {
  const pair = pairs[entry.on ?? 'strict'];
  const options = { halfClose: entry.halfClose, timeoutMs: entry.hold ? 1200 : (entry.timeoutMs ?? 8000), hold: entry.hold };
  const before = { legacy: pair.legacySeen.length, native: pair.nativeSeen.length };
  const legacy = await send(pair.legacy.port, entry.request({ port: pair.legacy.port, token: pair.legacy.token }), options);
  const native = await send(pair.native.port, entry.request({ port: pair.native.port, token: pair.native.token }), options);
  return { legacy, native, legacySeen: pair.legacySeen.slice(before.legacy), nativeSeen: pair.nativeSeen.slice(before.native) };
}

describe('MCP 서버 차등: 옛 SDK 서버와 같은 요청에 같은 답', () => {
  it('요청 하나하나가 옛 서버와 같은 상태·content-type·본문·처리 호출을 낸다', async () => {
    const mismatches: string[] = [];
    // 같은 서버를 동시에 두드려도 `seen`이 섞이지 않게 이 시험은 요청을 차례로 보낸다(느린 도구가 있어 시험 시간 제한을 넉넉히 둔다)
    // MCP_DIFF_ONLY(정규식)는 변이 시험처럼 일부 요청만 빨리 돌릴 때 쓴다. 기본은 전부다
    const only = process.env.MCP_DIFF_ONLY ? new RegExp(process.env.MCP_DIFF_ONLY) : null;
    const queue = cases.filter((entry) => only === null || only.test(entry.name));
    for (const entry of queue) {
      const { legacy, native, legacySeen, nativeSeen } = await runCase(entry);
      tally(counts.legacy, legacy);
      tally(counts.native, native);
      const same = JSON.stringify([legacy, legacySeen]) === JSON.stringify([native, nativeSeen]);
      if (same) continue;
      const intended = INTENDED[entry.name];
      if (intended !== undefined) {
        // 의도한 차이도 거절 쪽으로만 다를 수 있다: 옛 서버가 거절했는데 새 서버가 처리하면(상태 2xx, 처리 호출이 더 많음) 넓어진 것이다
        const widened = (legacy.status >= 400 || legacy.status === 0) && native.status >= 200 && native.status < 300;
        if (widened || nativeSeen.length > legacySeen.length) mismatches.push(`[넓어짐] ${entry.name}\n  옛: ${JSON.stringify([legacy.status, legacySeen.length])}\n  새: ${JSON.stringify([native.status, nativeSeen.length])}`);
        continue;
      }
      const brief = (result: Result): string => JSON.stringify(result).slice(0, 700);
      mismatches.push(`${entry.name}\n  옛: ${brief(legacy)} seen=${JSON.stringify(legacySeen).slice(0, 200)}\n  새: ${brief(native)} seen=${JSON.stringify(nativeSeen).slice(0, 200)}`);
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
    if (only === null) expect(cases.length).toBeGreaterThan(400);
  }, 600_000);

  it('결과 분포가 한쪽으로 쏠리지 않았다(통과·거절·SSE가 모두 있다)', () => {
    if (process.env.MCP_DIFF_ONLY) return;
    for (const key of ['200/sse', '202', '400', '401', '403', '405', '406', '413', '415']) {
      expect(counts.native.get(key) ?? 0, `새 서버 ${key}`).toBeGreaterThan(0);
      expect(counts.legacy.get(key) ?? 0, `옛 서버 ${key}`).toBeGreaterThan(0);
    }
  });
});
