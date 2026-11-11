/**
 * 인증 판단 벡터 생성기(ADR-195 4c). 기대값은 옛 TS(apps/studio/lib/server/auth.ts 그대로)가 만든다.
 * 요청마다 진짜 `node:http` 서버가 날것의 바이트를 받고(헤더 합치기·Latin-1 읽기는 Node가 한다), 서버의 요청 처리와 같은 순서로
 * `toWebRequest` → `decideRequest`를 부른다(apps/studio/server/app.ts의 인증 단계). 그 판단을 `auth-vectors.json`에 적는다.
 * Rust 쪽(tests/auth_vectors.rs)이 같은 날것의 입력을 읽어 `bstudio_server::auth::decide`와 견준다.
 *
 * 실행(저장소 루트): pnpm exec tsx crates/bstudio-server/tests/vectors/gen-auth-vectors.ts
 * 씨앗이 고정이라 같은 코드·같은 Node면 같은 파일이 나온다. 임시 폴더만 쓴다. 3000번 포트·실제 서비스는 쓰지 않는다
 */
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { decideRequest, SESSION_COOKIE, signSession } from '../../../../apps/studio/lib/server/auth';
import { readRevocations } from '../../../../apps/studio/lib/server/auth-state';
import { cookieValue } from '../../../../apps/studio/lib/server/cookies';
import { toWebRequest } from '../../../../apps/studio/server/http';

const COUNT = Number(process.env.VECTOR_COUNT ?? 7000);
const NOW = 1_800_000_000_000;
const OUT = process.env.VECTOR_OUT ?? path.join(import.meta.dirname, 'auth-vectors.json');
const ROOT_PLACEHOLDER = '{ROOT}';

// ── 씨앗이 고정인 난수 ──
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(Number(process.env.VECTOR_SEED ?? 1151));
const int = (n: number) => Math.floor(rand() * n);
const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
const pickHost = () => (chance(0.75) ? pick(GOOD_HOSTS) : pickHost());
const chance = (p: number) => rand() < p;
function weighted<T>(items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((sum, [, w]) => sum + w, 0);
  let at = rand() * total;
  for (const [item, w] of items) {
    at -= w;
    if (at < 0) return item;
  }
  return items[items.length - 1]![0];
}
const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[int(16)]).join('');

type Env = Record<string, string>;
const root = mkdtempSync(path.join('/tmp', 'bsv-'));
mkdirSync(path.join(root, 'rev'), { recursive: true });
let revCount = 0;

// ── 환경 설정 풀 ──
const SECRET32 = 'S'.repeat(32);
const EMOJI_SECRET = '😀'.repeat(16); // UTF-16으로 32
const ALICE_TOKEN = 'a'.repeat(24);
const BOB_HASH = createHash('sha256').update('bob-token-value-0123456789abcd', 'utf8').digest('hex');
const GOOD_TOKENS = `alice:${ALICE_TOKEN},bob:sha256:${BOB_HASH}`;

function validEnvs(): Env[] {
  return [
    {},
    { B_STUDIO_AUTH: 'none' },
    { B_STUDIO_AUTH: 'none', B_STUDIO_ALLOWED_HOSTS: 'studio.example,Other.Example:8080, [::1] ,,' },
    { B_STUDIO_AUTH: ' none ', B_STUDIO_ALLOWED_HOSTS: 'STUDIO.EXAMPLE' },
    { B_STUDIO_AUTH: 'token', B_STUDIO_AUTH_SECRET: SECRET32, B_STUDIO_AUTH_TOKENS: GOOD_TOKENS },
    { B_STUDIO_AUTH: 'token', B_STUDIO_AUTH_SECRET: EMOJI_SECRET, B_STUDIO_AUTH_TOKENS: `alice:${ALICE_TOKEN}, bob.b@x-y_z:${'😀'.repeat(12)} ,` },
    { B_STUDIO_AUTH: 'token', B_STUDIO_AUTH_SECRET: `${'가'.repeat(20)}${'k'.repeat(14)}`, B_STUDIO_AUTH_TOKENS: GOOD_TOKENS, B_STUDIO_AUTH_SESSION_HOURS: '0x10' },
    { B_STUDIO_AUTH: 'token', B_STUDIO_AUTH_SECRET: SECRET32, B_STUDIO_AUTH_TOKENS: GOOD_TOKENS, B_STUDIO_ALLOWED_HOSTS: 'studio.example', B_STUDIO_AUTH_SESSION_HOURS: ' 720 ' },
    { B_STUDIO_AUTH: 'proxy', B_STUDIO_AUTH_PROXY_SECRET: SECRET32 },
    { B_STUDIO_AUTH: 'proxy', B_STUDIO_AUTH_PROXY_SECRET: SECRET32, B_STUDIO_AUTH_USER_HEADER: ' X-Remote-User ' },
    { B_STUDIO_AUTH: 'proxy', B_STUDIO_AUTH_PROXY_SECRET: EMOJI_SECRET, B_STUDIO_AUTH_USER_HEADER: 'x-user' },
    { B_STUDIO_AUTH: 'proxy', B_STUDIO_AUTH_PROXY_SECRET: 'é'.repeat(32), B_STUDIO_AUTH_USER_HEADER: 'x-user' },
    { B_STUDIO_AUTH: 'proxy', B_STUDIO_AUTH_PROXY_SECRET: SECRET32, B_STUDIO_AUTH_USER_HEADER: 'cookie' },
    { B_STUDIO_AUTH: 'proxy', B_STUDIO_AUTH_PROXY_SECRET: SECRET32, B_STUDIO_AUTH_USER_HEADER: 'referer' },
  ];
}

function brokenEnvs(): Env[] {
  const token = (extra: Env): Env => ({ B_STUDIO_AUTH: 'token', B_STUDIO_AUTH_SECRET: SECRET32, B_STUDIO_AUTH_TOKENS: GOOD_TOKENS, ...extra });
  return [
    { B_STUDIO_AUTH: 'bogus' },
    { B_STUDIO_AUTH: 'TOKEN' },
    { B_STUDIO_AUTH: ' tok en ' },
    { B_STUDIO_AUTH: '\u{FEFF}none\u{FEFF}' },
    { B_STUDIO_AUTH: '' },
    { B_STUDIO_AUTH: 'none', B_STUDIO_AUTH_SESSION_HOURS: 'abc' },
    { B_STUDIO_AUTH: 'none', B_STUDIO_AUTH_SESSION_HOURS: '0' },
    { B_STUDIO_AUTH: 'none', B_STUDIO_AUTH_SESSION_HOURS: '721' },
    { B_STUDIO_AUTH: 'none', B_STUDIO_AUTH_SESSION_HOURS: '-1' },
    { B_STUDIO_AUTH: 'none', B_STUDIO_AUTH_SESSION_HOURS: 'Infinity' },
    { B_STUDIO_AUTH: 'none', B_STUDIO_AUTH_SESSION_HOURS: '1_0' },
    { B_STUDIO_AUTH: 'none', B_STUDIO_AUTH_SESSION_HOURS: '1e3' },
    { B_STUDIO_AUTH: 'none', B_STUDIO_AUTH_SESSION_HOURS: '0b101' },
    { B_STUDIO_AUTH: 'none', B_STUDIO_AUTH_SESSION_HOURS: ' ' },
    { B_STUDIO_AUTH: 'token' },
    { B_STUDIO_AUTH: 'token', B_STUDIO_AUTH_SECRET: 'S'.repeat(31), B_STUDIO_AUTH_TOKENS: GOOD_TOKENS },
    { B_STUDIO_AUTH: 'token', B_STUDIO_AUTH_SECRET: '😀'.repeat(15), B_STUDIO_AUTH_TOKENS: GOOD_TOKENS },
    token({ B_STUDIO_AUTH_TOKENS: '' }),
    token({ B_STUDIO_AUTH_TOKENS: ' , ,' }),
    token({ B_STUDIO_AUTH_TOKENS: 'alice' }),
    token({ B_STUDIO_AUTH_TOKENS: ':abcdefghijklmnopqrstuvwxyz' }),
    token({ B_STUDIO_AUTH_TOKENS: 'a b:abcdefghijklmnopqrstuvwxyz' }),
    token({ B_STUDIO_AUTH_TOKENS: `${'n'.repeat(65)}:${ALICE_TOKEN}` }),
    token({ B_STUDIO_AUTH_TOKENS: 'alice:short' }),
    token({ B_STUDIO_AUTH_TOKENS: `alice:${'a'.repeat(23)}` }),
    token({ B_STUDIO_AUTH_TOKENS: `alice:sha256:${'A'.repeat(64)}` }),
    token({ B_STUDIO_AUTH_TOKENS: `alice:sha256:${'a'.repeat(63)}` }),
    token({ B_STUDIO_AUTH_TOKENS: `alice:${ALICE_TOKEN},alice:${'b'.repeat(24)}` }),
    token({ B_STUDIO_AUTH_TOKENS: `alice:${ALICE_TOKEN},bob:${ALICE_TOKEN}` }),
    token({ B_STUDIO_AUTH_TOKENS: `alice:${ALICE_TOKEN},bob:sha256:${createHash('sha256').update(ALICE_TOKEN).digest('hex')}` }),
    token({ B_STUDIO_AUTH_TOKENS: '가나다' }),
    token({ B_STUDIO_AUTH_TOKENS: '😀' }),
    token({ B_STUDIO_AUTH_TOKENS: 'a😀' }),
    token({ B_STUDIO_AUTH_TOKENS: '😀😀😀😀😀😀😀😀😀😀:x' }),
    token({ B_STUDIO_AUTH_TOKENS: ':😀😀😀😀😀😀😀😀😀😀' }),
    token({ B_STUDIO_AUTH_TOKENS: ':abcdefghijklmnop😀' }),
    token({ B_STUDIO_AUTH_TOKENS: 'x' }),
    { B_STUDIO_AUTH: 'proxy' },
    { B_STUDIO_AUTH: 'proxy', B_STUDIO_AUTH_PROXY_SECRET: 'S'.repeat(31) },
    { B_STUDIO_AUTH: 'proxy', B_STUDIO_AUTH_PROXY_SECRET: SECRET32, B_STUDIO_AUTH_USER_HEADER: 'x user' },
    { B_STUDIO_AUTH: 'proxy', B_STUDIO_AUTH_PROXY_SECRET: SECRET32, B_STUDIO_AUTH_USER_HEADER: 'x-user:' },
    { B_STUDIO_AUTH: 'proxy', B_STUDIO_AUTH_PROXY_SECRET: SECRET32, B_STUDIO_AUTH_USER_HEADER: 'x-úser' },
  ];
}

// ── 토큰 모드 세션 쿠키 ──
const USERS = ['alice', 'bob', 'bob.b@x-y_z', 'eve'];
function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}
function sign(payloadB64: string, secret: string): string {
  return `${payloadB64}.${createHmac('sha256', secret).update(payloadB64).digest('base64url')}`;
}
interface CookieMade {
  value: string;
  sid?: string;
  user?: string;
  iat?: number;
}
function makeCookie(secret: string, tokenUsers: string[]): CookieMade {
  const user = chance(0.8) && tokenUsers.length > 0 ? pick(tokenUsers) : pick(USERS);
  const sid = chance(0.9) ? hex(32) : weighted([[hex(31), 1], [hex(33), 1], [hex(32).toUpperCase(), 1], [`${hex(31)}g`, 1], ['', 1]] as const);
  const kind = weighted([
    ['valid', 40],
    ['wrongkey', 5],
    ['expired', 6],
    ['expEdge', 3],
    ['future', 3],
    ['extra', 3],
    ['nodot', 2],
    ['junkpayload', 4],
    ['shape', 8],
    ['tampered', 4],
    ['empty', 2],
    ['bigNumber', 2],
  ] as const);
  const iat = NOW - int(5) * 1000 - 1;
  const good = { u: user, sid, iat, exp: NOW + 3_600_000 };
  switch (kind) {
    case 'valid':
      return { value: sign(b64url(JSON.stringify(good)), secret), sid, user, iat };
    case 'wrongkey':
      return { value: sign(b64url(JSON.stringify(good)), `${secret}x`), sid, user, iat };
    case 'expired':
      return { value: sign(b64url(JSON.stringify({ ...good, exp: NOW - 1 - int(1000) })), secret), sid, user, iat };
    case 'expEdge':
      return { value: sign(b64url(JSON.stringify({ ...good, exp: pick([NOW, NOW + 1, NOW - 1]) })), secret), sid, user, iat };
    case 'future':
      return { value: sign(b64url(JSON.stringify({ ...good, iat: NOW + 5000 })), secret), sid, user, iat: NOW + 5000 };
    case 'extra':
      return { value: `${sign(b64url(JSON.stringify(good)), secret)}.${pick(['', 'x', 'y.z'])}` };
    case 'nodot':
      return { value: pick(['abc', b64url(JSON.stringify(good)), '.', '.sig', 'payload.', '']) };
    case 'junkpayload': {
      const payloads = ['not json', '[1,2]', 'null', '5', '"str"', '{', '{"u":"alice"}', '[]', 'true', '{"u":"alice","sid":"' + sid + '","iat":1,"exp":1e999}', '\u{FEFF}{}'];
      return { value: sign(b64url(pick(payloads)), secret) };
    }
    case 'shape': {
      const variants: Record<string, unknown>[] = [
        { ...good, u: 5 },
        { ...good, sid: 5 },
        { ...good, sid: undefined },
        { ...good, iat: String(iat) },
        { ...good, exp: String(NOW + 1000) },
        { ...good, iat: null },
        { ...good, exp: undefined },
        { u: user, iat, exp: NOW + 5000 },
        { ...good, extra: { nested: [1, 2, 3] } },
        { ...good, exp: NOW + 5000.5 },
        { ...good, iat: -1 },
      ];
      return { value: sign(b64url(JSON.stringify(pick(variants))), secret) };
    }
    case 'tampered': {
      const signed = sign(b64url(JSON.stringify(good)), secret);
      const at = int(signed.length);
      return { value: signed.slice(0, at) + (signed[at] === 'A' ? 'B' : 'A') + signed.slice(at + 1) };
    }
    case 'empty':
      return { value: '' };
    case 'bigNumber':
      return { value: sign(b64url(`{"u":"${user}","sid":"${sid}","iat":${iat},"exp":123456789012345678901234567890,"exp":${NOW + 99999}}`), secret), sid, user, iat };
  }
}

function cookieHeaders(secret: string, tokenUsers: string[], made: CookieMade | undefined): [string, string][] {
  if (!made && chance(0.5)) return [];
  const value = made?.value ?? '';
  const form = weighted([
    ['plain', 40],
    ['others', 15],
    ['spaced', 8],
    ['dupName', 5],
    ['twoHeaders', 8],
    ['noEq', 3],
    ['prefixName', 3],
    ['empty', 2],
    ['semicolons', 3],
  ] as const);
  const name = SESSION_COOKIE;
  switch (form) {
    case 'plain':
      return [['Cookie', `${name}=${value}`]];
    case 'others':
      return [['cookie', `a=1; ${name}=${value}; b=2`]];
    case 'spaced':
      return [['Cookie', `  ${name} =  ${value}  ; x=1`]];
    case 'dupName': {
      const other = makeCookie(secret, tokenUsers).value;
      return [['Cookie', `${name}=${other}; ${name}=${value}`]];
    }
    case 'twoHeaders':
      return [
        ['Cookie', 'a=1'],
        ['Cookie', `${name}=${value}`],
      ];
    case 'noEq':
      return [['Cookie', `${name}; ${name}=${value}`]];
    case 'prefixName':
      return [['Cookie', `x${name}=${value}; ${name}x=${value}`]];
    case 'empty':
      return [['Cookie', '']];
    case 'semicolons':
      return [['Cookie', `;;${name}=${value};;`]];
  }
}

// ── 요청 조각 ──
const GOOD_HOSTS = ['127.0.0.1:3000', '127.0.0.1', 'localhost', 'localhost:3000', 'LOCALHOST:80', '[::1]:3000', '[::1]', 'studio.example', 'Studio.Example:8080', 'other.example', 'evil.example', 'xn--e1afmkfd.example', 'é.example'];
const HOSTS = [
  '127.0.0.1:3000', '127.0.0.1', 'localhost', 'localhost:3000', 'LOCALHOST:80', 'LocalHost', '[::1]:3000', '[::1]', '[::1', '[::1]x', '127.0.0.1:', '127.0.0.1:abc',
  '127.0.0.1:3000:4000', 'studio.example', 'Studio.Example:8080', 'STUDIO.EXAMPLE', 'other.example', 'other.example:8080', 'Other.Example', '', 'a b', 'u:p@127.0.0.1', 'a/b', 'a?b',
  'a\\b', '0x7f.1', '127.1', '127.0.0.1.', 'localhost.', 'xn--e1afmkfd.example', 'é.example', '[::ffff:127.0.0.1]', '[0:0:0:0:0:0:0:1]', 'localhost:99999', '::1', 'evil.example',
  'localhost ', ' localhost', 'localhost:٣', '1.2.3.256', 'a%2Fb', '[::1]:', 'LOCALHOST:3000', '127.0.0.1:03000', 'a:1@b',
];
const ORIGIN_SUFFIX = ['', '/', '/path?q=1', ':80', ':443', ':3000', ':0', ':65536'];
const SCHEMES = ['http', 'https', 'HTTP', 'ws', 'wss', 'ftp', 'foo', 'file', 'data', 'javascript'];
function originFor(host: string): string | undefined {
  const base = weighted([
    ['same', 30],
    ['sameUpper', 5],
    ['scheme', 12],
    ['random', 10],
    ['special', 20],
    ['other', 10],
  ] as const);
  switch (base) {
    case 'same':
      return `http://${host}`;
    case 'sameUpper':
      return `HTTP://${host.toUpperCase()}`;
    case 'scheme':
      return `${pick(SCHEMES)}://${host}${pick(ORIGIN_SUFFIX)}`;
    case 'random':
      return `${pick(['http', 'https'])}://${pickHost()}${pick(ORIGIN_SUFFIX)}`;
    case 'other':
      return `http://evil.example${pick(ORIGIN_SUFFIX)}`;
    case 'special':
      return pick([
        'null', '', ' ', 'http://', 'http://[::1]:3000', 'http://[::1]', 'http://localhost:80', 'https://localhost:443', 'https://localhost:80', 'http://127.0.0.1:3000', 'HTTP://LOCALHOST:3000',
        'http://localhost.', 'http://é.example', 'http://xn--9ca.example', 'http://É.example', 'http://xn--e1afmkfd.example', 'foo://a:80', 'ws://a:80', 'wss://a:443', 'ftp://a:21', 'file:///', 'data:,x',
        'http://a@b', 'http://a:b@c', 'javascript:alert(1)', 'http://studio.example:8080', 'http://Studio.Example:8080', 'http://studio.example', ' http://localhost ', 'http://0x7f.1', 'http://127.1', 'http://127.0.0.1.',
        'http://[::ffff:127.0.0.1]', 'http://[0:0:0:0:0:0:0:1]:3000', 'http://a b', 'http://a%2Fb', 'localhost', '//localhost', 'http:localhost', 'http:/localhost', 'http:\\\\localhost', 'http://localhost ',
        'http://127.0.0.1:03000', 'http://127.0.0.1:3000:4000', 'http://1.2.3.256', 'http://ａ.example', 'http://a.example.', 'HtTp://LocalHost', 'http://[::1', 'http://%31%32%37.0.0.1:3000',
      ]);
  }
}

const PATHS = [
  '/', '/api/agents', '/api/health', '/api/health/routes', '/api/auth/login', '/api/auth/logout', '/api/health/', '/api/health/routes/', '/api//health', '/api/./health', '/api/x/../health',
  '/api/%2e%2e/api/health', '/api/%2E/health', '/api\\health', '/API/health', '/Api/auth/login', '/api/auth/login/', '//api/health', '/\\api/health', '/./api/health', '/api/health?x=1', '/api/auth/login?next=/x',
  '/api/auth/%6cogin', '/api/auth/login%00', '/x', '/index.html', '/api', '/api/', '/api/task-plans/abc/board/mcp', '/api/task-plans//board/mcp', '/api/task-plans/a/b/board/mcp', '/api/task-plans/abc/board/mcp/',
  '/api/task-plans/abc/board/mcp?x', '/api/task-plans/a%2Fb/board/mcp', '/api/task-plans/../board/mcp', '/api/task-plans/./board/mcp', '/api/task-plans/x/board/MCP', '/api/task-plans/x/board',
  '//evil.example/api/agents', '//evil.example/api/health', '//127.0.0.1/api/agents', '/\\evil.example/api/agents', '*', '/*', '/a/../api/agents', '/api/sessions/s1/events', '/api/%61gents', '/api/agents%2F',
  '//u:p@h/api/x', '//a b/api/x', '//[::1]/api/health', '//:80/api/x', '/api/..%2fhealth', '/api/%2e%2e%2fhealth', '/api/health#x'.replace('#x', '?%23'), '/../api/health', '/%2e%2e/api/health', '/api/.%2e/health',
  '//LOCALHOST/api/health', '//xn--e1afmkfd.example/x', '//é/x', '//127.1/api/x', '//0x7f.1/api/x', '//1.2.3.256/api/x', '//[::1/x', '/\t/api/health',
];
function randomPath(): string {
  if (chance(0.7)) return pick(PATHS);
  const segs = Array.from({ length: 1 + int(4) }, () => pick(['api', 'health', 'auth', 'login', 'logout', 'x', '..', '.', '%2e', '%2E%2e', '', 'routes', 'task-plans', 'board', 'mcp', 'a%2Fb', '%']));
  return `${pick(['/', '/', '//', '/\\'])}${segs.join(pick(['/', '/', '\\']))}${chance(0.2) ? '?q=1' : ''}`;
}

const METHODS = [
  ['GET', 45],
  ['POST', 20],
  ['HEAD', 6],
  ['PUT', 6],
  ['DELETE', 6],
  ['PATCH', 5],
  ['OPTIONS', 5],
  ['M-SEARCH', 1],
  ['QUERY', 1],
  ['PROPFIND', 1],
  ['TRACE', 1],
  ['LINK', 1],
] as const;

type Rev = { kind: 'absent' } | { kind: 'text'; text: string } | { kind: 'isdir' } | { kind: 'enotdir' };

function noiseHeaders(): [string, string][] {
  const out: [string, string][] = [];
  if (chance(0.3)) out.push(['User-Agent', 'test']);
  if (chance(0.1)) out.push(['Accept', 'a'], ['Accept', 'b']);
  if (chance(0.05)) out.push(['Referer', 'r1'], ['Referer', 'r2']);
  if (chance(0.05)) out.push(['Connection', 'keep-alive, Origin']);
  if (chance(0.03)) out.push(['X-B-Studio-User', 'mallory']);
  return out;
}

interface Vector {
  id: number;
  env: Env;
  e?: number;
  now: number;
  method: string;
  target: string;
  headers: [string, string][];
  rev: Rev;
  expected: Record<string, unknown>;
}

function buildVector(id: number, envs: { env: Env; valid: boolean }[]): Omit<Vector, 'expected'> {
  const { env } = weighted(envs.map((e) => [e, e.valid ? 8 : 1] as const));
  const tokenUsers = (env.B_STUDIO_AUTH_TOKENS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(':')[0]!);
  const method = weighted(METHODS);
  const target = randomPath();
  const headers: [string, string][] = [];

  // Host
  const hostMode = weighted([['one', 90], ['none', 2], ['two', 6], ['upper', 2]] as const);
  const host = chance(0.15) && env.B_STUDIO_ALLOWED_HOSTS ? pick(env.B_STUDIO_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean).concat(['127.0.0.1:3000'])) : pickHost();
  if (hostMode === 'one') headers.push(['Host', host]);
  else if (hostMode === 'two') headers.push(['Host', host], ['Host', pickHost()]);
  else if (hostMode === 'upper') headers.push(['HOST', host]);

  // Origin·x-forwarded-host
  if (chance(0.5)) {
    const origin = originFor(host);
    if (origin !== undefined) headers.push(['Origin', origin]);
    if (chance(0.08)) headers.push(['Origin', pick(['http://a', 'null', ''])]);
  }
  if (chance(0.15)) headers.push(['X-Forwarded-Host', chance(0.5) ? host : pickHost()]);
  if (chance(0.03)) headers.push(['X-Forwarded-Host', '']);

  // 사용자 확인 입력
  const secret = env.B_STUDIO_AUTH_SECRET ?? '';
  let made: CookieMade | undefined;
  if (env.B_STUDIO_AUTH === 'token' || chance(0.1)) {
    made = chance(0.85) ? makeCookie(secret, tokenUsers) : undefined;
    headers.push(...cookieHeaders(secret, tokenUsers, made));
  }
  if (env.B_STUDIO_AUTH === 'proxy' || chance(0.05)) {
    const proxySecret = env.B_STUDIO_AUTH_PROXY_SECRET ?? SECRET32;
    const given = weighted([
      [proxySecret, 60],
      [`${proxySecret}x`, 5],
      [proxySecret.slice(0, -1), 5],
      [` ${proxySecret} `, 5],
      ['', 3],
      [`\t${proxySecret}\t`, 2],
      [proxySecret.toUpperCase(), 2],
      [proxySecret.replace(/./, ' '), 2],
    ] as const);
    if (chance(0.95)) headers.push(['X-B-Studio-Proxy-Secret', given]);
    if (chance(0.04)) headers.push(['X-B-Studio-Proxy-Secret', proxySecret]);
    const userName = (env.B_STUDIO_AUTH_USER_HEADER ?? 'x-forwarded-user').trim().toLowerCase() || 'x-forwarded-user';
    const userValue = weighted([
      ['alice', 40],
      ['  alice  ', 5],
      ['', 4],
      ['a'.repeat(256), 3],
      ['a'.repeat(257), 3],
      ['a b', 4],
      ['é', 3],
      [' alice', 2],
      ['\u0085alice', 2],
      ['al~ice!', 3],
      ['alice~', 1],
      ['a,b', 2],
    ] as const);
    if (/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(userName) && chance(0.92)) {
      headers.push([userName === 'x-forwarded-user' ? 'X-Forwarded-User' : userName, userValue]);
      if (chance(0.05)) headers.push([userName, 'second']);
    } else if (chance(0.3)) headers.push(['X-Forwarded-User', userValue]);
  }
  headers.push(...noiseHeaders());
  // 순서를 섞는다(합치기는 같은 이름 안의 순서만 본다)
  for (let i = headers.length - 1; i > 0; i--) {
    const j = int(i + 1);
    [headers[i], headers[j]] = [headers[j]!, headers[i]!];
  }

  // 무효화 기록
  let rev: Rev = { kind: 'absent' };
  if (env.B_STUDIO_AUTH === 'token') {
    const roll = rand();
    const sid = made?.sid ?? hex(32);
    const user = made?.user ?? 'alice';
    const iat = made?.iat ?? NOW - 1;
    if (roll < 0.5) rev = { kind: 'absent' };
    else if (roll < 0.62) rev = { kind: 'text', text: JSON.stringify({ version: 1, sessions: {}, users: {} }) };
    else if (roll < 0.72) rev = { kind: 'text', text: JSON.stringify({ version: 1, sessions: { [sid]: NOW + 1000, [hex(32)]: 5 }, users: {} }) };
    else if (roll < 0.82) rev = { kind: 'text', text: JSON.stringify({ version: 1, sessions: {}, users: { [user]: pick([iat, iat + 1, iat - 1, NOW + 10, 0]), other: 5 } }) };
    else if (roll < 0.86) rev = { kind: 'text', text: JSON.stringify({ sessions: { [sid]: 1 }, users: {} }).replace('{"sessions"', '{"sessions":{"dup":1},"sessions"') };
    else if (roll < 0.92)
      rev = { kind: 'text', text: pick(['', '{', 'null', '5', '[]', '{}', '{"sessions":{},"users":[]}', '{"sessions":{"a":"x"},"users":{}}', '{"sessions":null,"users":{}}', '\u{FEFF}{"sessions":{},"users":{}}', ' {"sessions":{},"users":{}} \n', '{"sessions":{},"users":{"alice":1e5}}']) };
    else if (roll < 0.94) rev = { kind: 'isdir' };
    else if (roll < 0.96) rev = { kind: 'enotdir' };
    else rev = { kind: 'text', text: JSON.stringify({ sessions: {}, users: { [user]: iat } }) };
  }
  // 헤더 값은 바이트(Latin-1)로 보낸다. 보낼 수 있는 값만 적는다
  const sendable = headers.map(([n, v]) => [n, Buffer.from(v, 'latin1').toString('latin1')] as [string, string]);
  return { id, env, now: NOW, method, target, headers: sendable, rev };
}

// ── 진짜 Node 서버 ──
let current: Omit<Vector, 'expected'> | undefined;
const envList: Env[] = [];
function envIndex(env: Env): number {
  const key = JSON.stringify(env);
  const at = envList.findIndex((e) => JSON.stringify(e) === key);
  if (at >= 0) return at;
  envList.push(env);
  return envList.length - 1;
}

function nodeHandler(req: http.IncomingMessage, res: http.ServerResponse): void {
  void (async () => {
    const vector = current!;
    let outcome: Record<string, unknown>;
    try {
      // apps/studio/server/app.ts의 인증 단계와 같다
      const request = await toWebRequest(req, { maxBodyBytes: 10 * 1024 * 1024, signal: new AbortController().signal });
      const url = new URL(request.url);
      const decision = decideRequest(
        { method: request.method, pathname: url.pathname, search: url.search, headers: request.headers, cookie: cookieValue(request.headers, SESSION_COOKIE) },
        vector.env,
        vector.now,
        () => readRevocations(),
      );
      outcome = decision.kind === 'reject' ? { kind: 'reject', status: decision.status, message: decision.message, api: url.pathname.startsWith('/api/') } : decision.kind === 'allow' ? { kind: 'allow', user: decision.user } : { kind: 'pass' };
    } catch (error) {
      outcome = { kind: 'nodefail', error: error instanceof Error ? error.message : String(error) };
    }
    // HEAD 응답에는 본문이 없으므로 결과를 머리에 싣는다
    res.setHeader('x-outcome', Buffer.from(JSON.stringify(outcome)).toString('base64'));
    res.end();
  })();
}

function rawRequest(port: number, vector: Omit<Vector, 'expected'>): Promise<{ status: number; body: string }> {
  const lines = [`${vector.method} ${vector.target} HTTP/1.1`, ...vector.headers.map(([n, v]) => `${n}: ${v}`), 'Connection: close', '', ''];
  const bytes = Buffer.from(lines.join('\r\n'), 'latin1');
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(bytes));
    const chunks: Buffer[] = [];
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('error', reject);
    socket.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0);
      resolve({ status, body: Buffer.from(/\r\nx-outcome: (\S+)/i.exec(text)?.[1] ?? '', 'base64').toString('utf8') });
    });
  });
}

function materialize(rev: Rev): string {
  const dir = path.join(root, 'rev', String(revCount++));
  if (rev.kind === 'absent') return dir;
  mkdirSync(dir, { recursive: true });
  if (rev.kind === 'text') writeFileSync(path.join(dir, 'revocations.json'), rev.text);
  else if (rev.kind === 'isdir') mkdirSync(path.join(dir, 'revocations.json'));
  else if (rev.kind === 'enotdir') {
    rmSync(dir, { recursive: true });
    writeFileSync(dir, 'file');
  }
  return dir;
}

// ── 상태 폴더 계산(path.resolve) ──
function stateDirCases(): { input: string; cwd: string; expected: string }[] {
  const inputs = ['/a/b', '/a//b/./c/../d/', '/', '/..', '/../../x', '', '.', '..', 'rel', './rel/../x', '../up', 'a/b/../../..', '/a/b/', '//a', '/a/.../b', '/a/..b/c', '/ a /b', '/한글/폴더'];
  const cwds = ['/work/app', '/', '/x/y/z'];
  return inputs.flatMap((input) => cwds.map((cwd) => ({ input, cwd, expected: path.resolve(cwd, input) })));
}

async function main(): Promise<void> {
  const envs = [...validEnvs().map((env) => ({ env, valid: true })), ...brokenEnvs().map((env) => ({ env, valid: false }))];
  const server = http.createServer(nodeHandler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  const originalEnv = { dir: process.env.B_STUDIO_AUTH_STATE_DIR, home: process.env.HOME };
  const vectors: Vector[] = [];
  const counts: Record<string, number> = {};
  for (let id = 0; id < COUNT; id++) {
    const base = buildVector(id, envs);
    const dir = materialize(base.rev);
    process.env.B_STUDIO_AUTH_STATE_DIR = dir;
    const env: Env = { ...base.env, B_STUDIO_AUTH_STATE_DIR: dir };
    current = { ...base, env };
    const answer = await rawRequest(port, current);
    let expected: Record<string, unknown>;
    if (answer.status === 200 && answer.body) expected = JSON.parse(answer.body) as Record<string, unknown>;
    else expected = { kind: 'nodeparse', status: answer.status };
    // 짝 없는 서로게이트가 든 메시지는 JSON으로 적을 수 없다(Rust 문자열로도 못 담는다). 표시를 하고 U+FFFD로 바꿔 적는다
    if (typeof expected.message === 'string' && !expected.message.isWellFormed()) {
      expected.message = expected.message.toWellFormed();
      expected.loneSurrogate = true;
    }
    counts[String(expected.kind)] = (counts[String(expected.kind)] ?? 0) + 1;
    // 폴더 경로는 {ROOT}로 바꿔 적는다(Rust 시험이 자기 임시 폴더에 같은 모양을 만든다)
    const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value).split(root).join(ROOT_PLACEHOLDER)) as T;
    vectors.push(clean({ id, e: envIndex(base.env), now: NOW, method: base.method, target: base.target, headers: base.headers, rev: base.rev, expected }));
  }
  process.env.B_STUDIO_AUTH_STATE_DIR = originalEnv.dir;
  server.close();

  const output = { generatedWith: process.version, now: NOW, counts, stateDirs: stateDirCases(), vectors };
  const lines = ['{', `"generatedWith":${JSON.stringify(output.generatedWith)},`, `"now":${NOW},`, `"counts":${JSON.stringify(counts)},`, `"stateDirs":${JSON.stringify(output.stateDirs)},`, `"envs":${JSON.stringify(envList)},`, '"vectors":['];
  vectors.forEach((v, i) => lines.push(JSON.stringify(v) + (i + 1 < vectors.length ? ',' : '')));
  lines.push(']', '}', '');
  writeFileSync(OUT, lines.join('\n'));
  rmSync(root, { recursive: true, force: true });
  console.log(`벡터 ${vectors.length}개`, counts, '->', OUT);
  process.exit(0);
}

void main();
