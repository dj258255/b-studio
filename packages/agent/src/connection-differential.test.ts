import { appendFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Board } from './coordination/board';
import { LegacyBoard } from './coordination/board-legacy';
import { externalBoardAccess, runBoardMcpTool } from './board-mcp';
import { describeStep, isAllowedRequest, isAutomaticFavicon } from './browser-check';
import { rejectedChangeFeedback } from './change-tracker';
import * as legacy from './connection-legacy';
import { decodeNative, encodeNative, native } from '@b-studio/sandbox';
import { Gen, outcome, perturb, readEnvList, readEnvNumber, sameOutcome, wellFormed, type Outcome } from './differential-kit';
import { authorize, hostAllowed, tokenMatches } from './mcp-http-server';

/**
 * 연결·인증·조율 판정(ADR-191 3t)을 Rust로 옮기면서 옛 TS 구현(`connection-legacy.ts`, `coordination/board-legacy.ts`)과 새 껍데기에 같은 무작위 입력을 넣어
 * 결과를 JSON 글자로 견준다. 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * 의도한 차이:
 * - 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다(글을 만드는 함수의 출력은 같게 맞춘다). 견주는 값(토큰·호스트)은 단사 변환을 거치므로 오히려 옛 구현(토큰은 U+FFFD로 합쳐 같다고 읽음)보다 엄격하다
 * - 빈 토큰은 어떤 요청도 맞지 않는다(옛 구현은 `Bearer `와 빈 토큰이 맞았다)
 * 열린 쪽 뒤집힘(옛 구현이 막았는데 새 구현이 연 수): authorize·hostAllowed·tokenMatches·isAllowedRequest·isAutomaticFavicon·게시판 입력 검사에서 따로 센다. 0이어야 한다.
 *
 * 크기는 환경 변수로 바꾼다: CONN_DIFF_SEEDS(쉼표 목록), CONN_DIFF_ITERATIONS, CONN_DIFF_REPORT=<파일 경로>(분포를 덧붙인다)
 */

const SEEDS = readEnvList('CONN_DIFF_SEEDS', [1, 2, 3]);
const ITERATIONS = readEnvNumber('CONN_DIFF_ITERATIONS', 4000);
const REPORT = process.env['CONN_DIFF_REPORT'];

const LONE = ['\ud800', '\udbff', '\udc00', '\udfff', '\ud83d', '\ude00'];
const hasLone = (text: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);

// ---------------------------------------------------------------------------
// 호스트·토큰·인증(여는 쪽)
// ---------------------------------------------------------------------------

const HOST_NAMES = ['localhost', 'LOCALHOST', 'LocalHost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal', 'Host.Docker.Internal', 'evil.com', 'localhost.evil.com', 'evil.localhost', 'xlocalhost', 'localhost.', '127.0.0.1.', '0.0.0.0', '127.0.0.2', '', ' ', '[', ']', '[]', '[::1', '[::1]x', '[[::1]]', 'ΑΣ', 'ΑΣ:Β', 'ΑΣ.', 'İ', 'K', 'ǅ', 'ß', 'ẞ', 'ſ', 'ＬＯＣＡＬＨＯＳＴ', 'localhost\u0000', ...LONE.map((c) => `host${c}`), ...LONE];
const HOST_SUFFIXES = ['', '', '', ':80', ':', ':80:90', ' ', '\t', '\u0085', '﻿', ' ', ':65535', ']', '/', '@', ...LONE];

function hostHeader(g: Gen): string | undefined {
  if (g.chance(0.04)) return undefined;
  const base = g.pick(HOST_NAMES);
  const wrapped = g.chance(0.1) ? ` ${base}` : g.chance(0.05) ? `\u0085${base}` : base;
  return wrapped + g.pick(HOST_SUFFIXES);
}

function allowedHosts(g: Gen): string[] {
  return g.list(0, 3, () => g.pick(HOST_NAMES));
}

const TOKEN_CHARS = [...'0123456789abcdef', 'A', 'Z', 'é', '한', '😀', '\u0000', ' ', '|', ...LONE];

function tokenOf(g: Gen): string {
  if (g.chance(0.04)) return '';
  return g.text(g.chance(0.5) ? [...'0123456789abcdef'] : TOKEN_CHARS, g.chance(0.5) ? 48 : 1 + g.int(12));
}

function authorizationFor(g: Gen, token: string): string | undefined {
  const mutate = (text: string): string => {
    const kind = g.int(7);
    if (kind === 0) return text.slice(0, -1);
    if (kind === 1) return `${text}${g.pick(TOKEN_CHARS)}`;
    if (kind === 2) return `${g.pick(TOKEN_CHARS)}${text}`;
    if (kind === 3) return text.toUpperCase() === text ? text.toLowerCase() : text.toUpperCase();
    if (kind === 4 && text.length > 0) {
      const at = g.int(text.length);
      return text.slice(0, at) + g.pick(TOKEN_CHARS) + text.slice(at + 1);
    }
    if (kind === 5) return `${text} `;
    return g.text(TOKEN_CHARS, 1 + g.int(6));
  };
  switch (g.weighted<number>([[8, 0], [6, 1], [2, 2], [2, 3], [1, 4], [1, 5], [1, 6]])) {
    case 0: return `Bearer ${token}`;
    case 1: return `Bearer ${mutate(token)}`;
    case 2: return `bearer ${token}`;
    case 3: return `Bearer${token}`;
    case 4: return token;
    case 5: return g.pick(['', 'Bearer', 'Bearer ', 'Basic abc', ' Bearer x']);
    default: return undefined;
  }
}

interface AuthTally {
  runs: number;
  differ: number;
  openFlips: number;
  /** 옛 구현은 맞다고 했는데 새 구현은 막은 수와 그 이유별 개수 */
  closedFlips: Record<string, number>;
  dist: Record<string, number>;
}

function newTally(): AuthTally {
  return { runs: 0, differ: 0, openFlips: 0, closedFlips: {}, dist: {} };
}

function runAuthSeed(seed: number, iterations: number, hostAllowedImpl: typeof legacy.hostAllowed, tokenMatchesImpl: typeof legacy.tokenMatches): { host: AuthTally; token: AuthTally; auth: AuthTally } {
  const g = new Gen(seed);
  const host = newTally();
  const token = newTally();
  const auth = newTally();
  const count = (tally: AuthTally, key: string): void => {
    tally.dist[key] = (tally.dist[key] ?? 0) + 1;
  };
  for (let i = 0; i < iterations; i++) {
    const header = hostHeader(g);
    const allowed = allowedHosts(g);
    const secret = tokenOf(g);
    const authorization = authorizationFor(g, secret);

    const hostOld = legacy.hostAllowed(header, allowed);
    const hostNew = hostAllowedImpl(header, allowed);
    host.runs += 1;
    count(host, hostOld ? 'allowed' : 'denied');
    if (hostOld !== hostNew) {
      host.differ += 1;
      if (hostNew) host.openFlips += 1;
      else host.closedFlips['호스트(이유 없음)'] = (host.closedFlips['호스트(이유 없음)'] ?? 0) + 1;
    }

    const tokenOld = legacy.tokenMatches(authorization, secret);
    const tokenNew = tokenMatchesImpl(authorization, secret);
    token.runs += 1;
    count(token, tokenOld ? 'match' : 'no-match');
    if (tokenOld !== tokenNew) {
      token.differ += 1;
      if (tokenNew) token.openFlips += 1;
      else {
        const reason = secret === '' ? '빈 토큰' : hasLone(secret) || hasLone(authorization ?? '') ? '짝 없는 서로게이트(옛 구현은 U+FFFD로 합쳐 같다고 읽음)' : '이유 없음';
        token.closedFlips[reason] = (token.closedFlips[reason] ?? 0) + 1;
      }
    }

    // authorize는 호스트 → 토큰 순서
    const authOld = legacy.authorize(header, authorization, secret, allowed);
    const authNew = authorize(header, authorization, secret, allowed);
    auth.runs += 1;
    count(auth, authOld === undefined ? '통과' : String(authOld.status));
    if (JSON.stringify(authOld) !== JSON.stringify(authNew)) {
      auth.differ += 1;
      // 열린 쪽: 옛 구현은 막았는데(상태 있음) 새 구현이 통과(undefined)시켰거나, 403을 401로 풀어 준 경우
      if (authOld !== undefined && (authNew === undefined || (authOld.status === 403 && authNew.status !== 403))) auth.openFlips += 1;
      else {
        const reason = secret === '' ? '빈 토큰' : hasLone(secret) || hasLone(authorization ?? '') ? '짝 없는 서로게이트' : '이유 없음';
        auth.closedFlips[reason] = (auth.closedFlips[reason] ?? 0) + 1;
      }
    }
  }
  return { host, token, auth };
}

function report(line: string): void {
  if (REPORT) appendFileSync(REPORT, `${line}\n`);
}

describe('차등 시험: 호스트·토큰·인증(여는 쪽)', () => {
  for (const seed of SEEDS) {
    it(`시드 ${seed}: 열린 쪽 뒤집힘 0, 닫는 쪽 차이는 의도한 이유뿐`, () => {
      const { host, token, auth } = runAuthSeed(seed, ITERATIONS, hostAllowed, tokenMatches);
      report(`[차등] 호스트 시드 ${seed}: ${JSON.stringify(host)}`);
      report(`[차등] 토큰 시드 ${seed}: ${JSON.stringify(token)}`);
      report(`[차등] 인증 시드 ${seed}: ${JSON.stringify(auth)}`);
      for (const tally of [host, token, auth]) {
        expect(tally.runs).toBe(ITERATIONS);
        expect(tally.openFlips, '열린 쪽 뒤집힘').toBe(0);
        expect(tally.closedFlips['이유 없음'] ?? 0).toBe(0);
        expect(tally.closedFlips['호스트(이유 없음)'] ?? 0).toBe(0);
      }
      // 입력이 비지 않았다: 통과·거부, 맞음·안 맞음이 모두 나온다
      expect(host.dist['allowed']).toBeGreaterThan(ITERATIONS / 20);
      expect(host.dist['denied']).toBeGreaterThan(ITERATIONS / 20);
      expect(token.dist['match']).toBeGreaterThan(ITERATIONS / 20);
      expect(token.dist['no-match']).toBeGreaterThan(ITERATIONS / 20);
      expect(Object.keys(auth.dist).sort()).toEqual(['401', '403', '통과']);
    });
  }

  it('대조 장치: 같음 비교를 넓힌(접두·포함·대소문자 무시·길이 무시) 껍데기는 열린 쪽 뒤집힘으로 잡힌다', () => {
    const mutants: Array<{ name: string; host?: typeof legacy.hostAllowed; token?: typeof legacy.tokenMatches }> = [
      { name: '호스트: 허용 이름을 접두로', host: (h, a = []) => legacy.hostAllowed(h, a) || a.some((x) => legacy.hostnameOf(h).toLowerCase().startsWith(x.toLowerCase()) && x !== '') },
      { name: '호스트: 루프백 이름을 포함으로', host: (h, a = []) => legacy.hostAllowed(h, a) || /localhost/i.test(h ?? '') },
      { name: '호스트: 포트를 떼지 않은 값도', host: (h, a = []) => legacy.hostAllowed(h, a) || (h ?? '').toLowerCase().includes('127.0.0.1') },
      { name: '토큰: Bearer 접두 대소문자 무시', token: (au, t) => legacy.tokenMatches(au, t) || (au !== undefined && /^bearer /i.test(au) && au.slice(7) === t) },
      { name: '토큰: 접두만 맞으면', token: (au, t) => legacy.tokenMatches(au, t) || (au?.startsWith('Bearer ') === true && t.startsWith(au.slice(7)) && au.length > 7) },
      { name: '토큰: 길이가 다르면 앞쪽만', token: (au, t) => legacy.tokenMatches(au, t) || (au?.startsWith('Bearer ') === true && au.slice(7, 8) === t.slice(0, 1) && t !== '') },
    ];
    for (const mutant of mutants) {
      const { host, token } = runAuthSeed(7, ITERATIONS, mutant.host ?? hostAllowed, mutant.token ?? tokenMatches);
      const flips = host.openFlips + token.openFlips;
      expect(flips, mutant.name).toBeGreaterThan(0);
    }
    // 결과를 반대로 뒤집으면 모든 차이가 잡힌다
    const inverted = runAuthSeed(7, 500, (h, a) => !hostAllowed(h, a), (au, t) => !tokenMatches(au, t));
    expect(inverted.host.differ).toBe(500);
    // 뒤집은 결과가 옛 결과와 다른 수 = 500 − (옛·새가 이미 다른 수). 닫는 쪽 차이는 소수라 대부분이 잡힌다
    expect(inverted.token.differ).toBeGreaterThan(450);
  });
});

// ---------------------------------------------------------------------------
// 브라우저 허용 출처·파비콘·단계 설명(여는 쪽 / 글)
// ---------------------------------------------------------------------------

const SCHEMES = ['http', 'https', 'HTTP', 'ftp', 'file', 'data', 'blob', 'about', 'DATA', 'ws', 'javascript', 'chrome-extension', 'custom', ''];
const URL_HOSTS = ['localhost', 'LOCALHOST', '127.0.0.1', '[::1]', 'example.com', 'EXAMPLE.com', 'a.b', 'xn--bcher-kva.example', 'bücher.example', 'user@evil.com', 'localhost%2f', '0x7f.1', '2130706433', 'localhost.', 'ＬＯＣＡＬＨＯＳＴ', '�.example', ...LONE.map((c) => `h${c}.example`)];
const URL_PORTS = ['', '', '', ':80', ':443', ':3000', ':3001', ':0', ':65536', ':abc', ':'];
const URL_PATHS = ['', '/', '/favicon.ico', '/favicon.ico/', '/Favicon.ico', '/favicon.ico?x=1', '/favicon.ico#a', '/a/favicon.ico', '/%66avicon.ico', '/favicon%2Eico', '//favicon.ico', '/favicon.ico%00', '/a?b#c', '/�', ...LONE.map((c) => `/${c}`), '/./favicon.ico', '/x/../favicon.ico', '\\favicon.ico'];

function urlOf(g: Gen): string {
  if (g.chance(0.08)) return g.pick(['', 'not a url', '//host/path', '/relative', 'http://', 'http://[::1', 'http://a b/', 'data:text/html,<p>', 'blob:http://localhost:3000/uuid', 'about:blank', ':', 'http:/localhost', ...LONE.map((c) => `http://${c}`)]);
  const scheme = g.pick(SCHEMES);
  const auth = g.chance(0.1) ? 'user:pw@' : '';
  return `${scheme}://${auth}${g.pick(URL_HOSTS)}${g.pick(URL_PORTS)}${g.pick(URL_PATHS)}`;
}

const ORIGIN_POOL = ['http://localhost:3000', 'https://example.com', 'http://127.0.0.1', 'http://localhost', 'https://EXAMPLE.com', 'http://[::1]:3000', 'null', 'http://xn--bcher-kva.example', 'ftp://example.com', 'http://example.com:80', 'http://example.com', ...LONE.map((c) => `http://h${c}.example`)];

function allowedOrigins(g: Gen): Set<string> {
  return new Set(g.list(0, 4, () => g.pick(ORIGIN_POOL)));
}

interface BrowserTally {
  runs: number;
  differ: number;
  openFlips: number;
  dist: Record<string, number>;
}

function runBrowserSeed(seed: number, iterations: number, allowedImpl: typeof isAllowedRequest, faviconImpl: typeof isAutomaticFavicon): { request: BrowserTally; favicon: BrowserTally } {
  const g = new Gen(seed);
  const request: BrowserTally = { runs: 0, differ: 0, openFlips: 0, dist: {} };
  const favicon: BrowserTally = { runs: 0, differ: 0, openFlips: 0, dist: {} };
  for (let i = 0; i < iterations; i++) {
    const url = urlOf(g);
    const allowed = allowedOrigins(g);
    const oldAllowed = legacy.isAllowedRequest(url, allowed);
    const newAllowed = allowedImpl(url, allowed);
    request.runs += 1;
    request.dist[oldAllowed ? 'allowed' : 'denied'] = (request.dist[oldAllowed ? 'allowed' : 'denied'] ?? 0) + 1;
    if (oldAllowed !== newAllowed) {
      request.differ += 1;
      if (newAllowed) request.openFlips += 1;
    }
    const oldFavicon = outcome(() => legacy.isAutomaticFavicon(url));
    const newFavicon = outcome(() => faviconImpl(url));
    favicon.runs += 1;
    const key = oldFavicon.threw ? 'threw' : String((oldFavicon as { value: unknown }).value);
    favicon.dist[key] = (favicon.dist[key] ?? 0) + 1;
    if (!sameOutcome(oldFavicon, newFavicon)) {
      favicon.differ += 1;
      // 열린 쪽: 옛 구현은 파비콘이 아니라고(또는 던졌다고) 했는데 새 구현이 파비콘이라고 한 수
      if (!newFavicon.threw && newFavicon.value === true && (oldFavicon.threw || oldFavicon.value === false)) favicon.openFlips += 1;
    }
  }
  return { request, favicon };
}

describe('차등 시험: 허용 출처·파비콘(여는 쪽)', () => {
  for (const seed of SEEDS) {
    it(`시드 ${seed}: 다른 결과 0, 열린 쪽 뒤집힘 0`, () => {
      const { request, favicon } = runBrowserSeed(seed, ITERATIONS, isAllowedRequest, isAutomaticFavicon);
      report(`[차등] 출처 시드 ${seed}: ${JSON.stringify(request)}`);
      report(`[차등] 파비콘 시드 ${seed}: ${JSON.stringify(favicon)}`);
      expect(request.runs).toBe(ITERATIONS);
      expect(request.differ).toBe(0);
      expect(request.openFlips).toBe(0);
      expect(favicon.differ).toBe(0);
      expect(favicon.openFlips).toBe(0);
      expect(request.dist['allowed']).toBeGreaterThan(ITERATIONS / 50);
      expect(request.dist['denied']).toBeGreaterThan(ITERATIONS / 50);
      expect(favicon.dist['true']).toBeGreaterThan(ITERATIONS / 100);
      expect(favicon.dist['false']).toBeGreaterThan(ITERATIONS / 50);
      expect(favicon.dist['threw']).toBeGreaterThan(0);
    });
  }

  it('WHATWG 파싱이 낸 origin에는 짝 없는 서로게이트·U+FFFD가 없다(출처 비교에서 합쳐질 값이 없다)', () => {
    const g = new Gen(11);
    let checked = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      let origin: string;
      try {
        origin = new URL(urlOf(g)).origin;
      } catch {
        continue;
      }
      checked += 1;
      expect(/^[\x20-\x7e]*$/.test(origin), origin).toBe(true);
    }
    expect(checked).toBeGreaterThan(ITERATIONS / 4);
  });

  it('대조 장치: 출처 비교를 넓힌(대소문자 무시·접두·내부 스킴 확대) 껍데기는 열린 쪽 뒤집힘으로 잡힌다', () => {
    const wide: Array<[string, typeof isAllowedRequest]> = [
      ['대소문자 무시', (url, allowed) => legacy.isAllowedRequest(url, allowed) || [...allowed].some((a) => { try { return a.toLowerCase() === new URL(url).origin.toLowerCase(); } catch { return false; } })],
      ['접두', (url, allowed) => legacy.isAllowedRequest(url, allowed) || [...allowed].some((a) => { try { return new URL(url).origin.startsWith(a) && a !== ''; } catch { return false; } })],
      ['file: 스킴도 내부', (url, allowed) => legacy.isAllowedRequest(url, allowed) || /^file:/i.test(url)],
      ['파싱 실패도 허용', (url, allowed) => { try { new URL(url); } catch { return true; } return legacy.isAllowedRequest(url, allowed); }],
    ];
    for (const [name, impl] of wide) {
      expect(runBrowserSeed(5, ITERATIONS, impl, isAutomaticFavicon).request.openFlips, name).toBeGreaterThan(0);
    }
    const wideFavicon: Array<[string, typeof isAutomaticFavicon]> = [
      ['접두', (url) => new URL(url).pathname.startsWith('/favicon')],
      ['포함', (url) => new URL(url).pathname.includes('favicon.ico')],
      ['대소문자 무시', (url) => new URL(url).pathname.toLowerCase() === '/favicon.ico'],
      ['던지지 않고 거부', (url) => { try { return new URL(url).pathname === '/favicon.ico'; } catch { return false; } }],
    ];
    for (const [name, impl] of wideFavicon) {
      expect(runBrowserSeed(5, ITERATIONS, isAllowedRequest, impl).favicon.differ, name).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 단계 설명·거부 경로 안내(글)
// ---------------------------------------------------------------------------

const TEXTS = ['#a', '.b > c', 'button', 'Enter', 'a\nb', '', ' ', '한글', '😀', 'x'.repeat(40), ...LONE.map((c) => `s${c}`), '\u0085', '�', 'undefined', 'null'];

function stepOf(g: Gen): Record<string, unknown> {
  const step: Record<string, unknown> = {};
  if (g.chance(0.4)) step['click'] = g.pick(TEXTS);
  if (g.chance(0.4)) step['fill'] = { selector: g.pick(TEXTS), value: 'v' };
  if (g.chance(0.4)) step['press'] = g.pick(TEXTS);
  if (g.chance(0.5)) step['waitFor'] = g.pick(TEXTS);
  if (g.chance(0.05)) step['click'] = undefined;
  if (g.chance(0.05)) step['fill'] = { selector: undefined, value: 'v' };
  if (g.chance(0.03)) step['press'] = null;
  if (g.chance(0.03)) step['click'] = 5;
  return step;
}

describe('차등 시험: 단계 설명·거부 경로 안내', () => {
  for (const seed of SEEDS) {
    it(`시드 ${seed}: describeStep·rejectedChangeFeedback이 옛 글자와 같다(짝 없는 서로게이트는 U+FFFD로 맞춘다)`, () => {
      const g = new Gen(seed + 100);
      const dist: Record<string, number> = {};
      for (let i = 0; i < ITERATIONS; i++) {
        const step = stepOf(g);
        const oldStep = outcome(() => legacy.describeStep(step as legacy.LegacyPageStep));
        const newStep = outcome(() => describeStep(step as never));
        expect(sameOutcome(oldStep, newStep), JSON.stringify(step)).toBe(true);
        const prefix = (oldStep as { value: string }).value.split(' ')[0]!;
        dist[prefix] = (dist[prefix] ?? 0) + 1;

        const rejected = g.list(0, 45, () => g.pick([...TEXTS, 'src/a.ts', '.env', `dist/${g.int(99)}.js`]));
        const oldText = outcome(() => legacy.rejectedChangeFeedback(rejected));
        const newText = outcome(() => rejectedChangeFeedback(rejected));
        expect(sameOutcome(oldText, newText), JSON.stringify(rejected)).toBe(true);
        const bucket = rejected.length > 20 ? '20초과' : rejected.length === 20 ? '20' : rejected.length === 0 ? '0' : '1-19';
        dist[bucket] = (dist[bucket] ?? 0) + 1;
      }
      report(`[차등] 글 시드 ${seed}: ${JSON.stringify(dist)}`);
      for (const key of ['click', 'fill', 'press', 'waitFor', '0', '1-19', '20', '20초과']) expect(dist[key], key).toBeGreaterThan(0);
    });
  }

  it('대조 장치: 한 글자만 바뀐 결과, 경계가 어긋난 안내를 잡는다', () => {
    const rejected = Array.from({ length: 21 }, (_, i) => `f${i}`);
    const oldText = outcome(() => legacy.rejectedChangeFeedback(rejected));
    expect(sameOutcome(oldText, { threw: false, value: perturb((oldText as { value: string }).value) })).toBe(false);
    const off = (n: number) => ['x', ...rejected.slice(0, n).map((f) => `- ${f}`)].join('\n');
    expect(sameOutcome(oldText, { threw: false, value: off(19) })).toBe(false);
    expect(sameOutcome(outcome(() => legacy.describeStep({ press: 'a' })), { threw: false, value: 'press  a' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 게시판: Board.validate·read, board-mcp 입력 검사·formatNote
// ---------------------------------------------------------------------------

const BODIES = ['', ' ', '\t\n', '\u0085', '﻿', ' x', 'x', '계약: GET /orders', 'a'.repeat(10), 'a'.repeat(11), '가'.repeat(3), '가'.repeat(4), '😀'.repeat(2), '😀'.repeat(3), 'y'.repeat(60), 'z'.repeat(61), ...LONE.map((c) => `b${c}`), 'dup', 'dup', 'note'];
const LANES = ['a', 'b', 'hub', 'c'];
const KINDS = ['contract', 'failure', 'fact'] as const;
const TOPOLOGIES = ['star', 'hierarchical', 'mesh'] as const;
const GROUPS = ['g1', 'g2', undefined];
const REF_POOL = ['src/a.ts', 'api', '', '한글', `r${LONE[0]!}`];

function newClock(): () => Date {
  let tick = 0;
  // 같은 시각이 이어지도록 두세 번에 한 번만 앞으로 간다(같은 시각이면 id로 정렬하는 갈래를 밟는다)
  return () => new Date(Date.UTC(2026, 10, 10, 0, 0, Math.floor((tick += 1) / 3)));
}

function boardPair(g: Gen): { legacyBoard: LegacyBoard; board: Board } {
  const limits = {
    noteBytes: g.pick([10, 11, 12, 60, 2048]),
    writesPerLane: g.pick([2, 3, 8]),
    readLimit: g.pick([1, 2, 3, 20]),
    readBytesPerLane: g.pick([20, 25, 50, 200, 32768]),
  };
  const options = { topology: g.pick(TOPOLOGIES), limits, modelWrites: g.chance(0.85) };
  return { legacyBoard: new LegacyBoard({ ...options, now: newClock() }), board: new Board({ ...options, now: newClock() }) };
}

describe('차등 시험: 게시판(validate·read의 고르기)', () => {
  for (const seed of SEEDS) {
    it(`시드 ${seed}: post·read 결과와 통계가 옛 구현과 같다`, () => {
      const g = new Gen(seed + 200);
      const dist: Record<string, number> = {};
      const bump = (key: string): void => {
        dist[key] = (dist[key] ?? 0) + 1;
      };
      const runs = Math.max(20, Math.floor(ITERATIONS / 25));
      for (let run = 0; run < runs; run++) {
        const { legacyBoard, board } = boardPair(g);
        for (let step = 0; step < 40; step++) {
          if (g.chance(0.6)) {
            const input = {
              kind: g.pick(KINDS),
              body: g.pick(BODIES),
              ...(g.chance(0.7) ? { refs: g.list(0, 2, () => g.pick(REF_POOL)) } : {}),
              ...(g.chance(0.3) ? { group: g.pick(GROUPS) } : {}),
              ...(g.chance(0.15) ? { priority: g.pick([0, 1, 2, 3, 5, -1, 2.5, Infinity, -Infinity]) } : {}),
            };
            const as = { lane: g.pick(LANES), by: g.chance(0.75) ? ('model' as const) : ('platform' as const) };
            const oldResult = outcome(() => legacyBoard.post(input, as));
            const newResult = outcome(() => board.post(input, as));
            expect(sameOutcome(oldResult, newResult), JSON.stringify(input)).toBe(true);
            const value = (oldResult as { value: { ok: boolean; reason?: string } }).value;
            bump(value.ok ? '쓰기 통과' : `거부: ${value.reason!.replace(/\d+/g, 'N')}`);
          } else {
            const reader = { lane: g.pick(LANES), ...(g.chance(0.5) ? { group: g.pick(GROUPS.filter((x) => x !== undefined)) } : {}) };
            const options = {
              ...(g.chance(0.4) ? { kinds: g.list(0, 2, () => g.pick(KINDS)) } : {}),
              ...(g.chance(0.3) ? { since: g.pick(['2026-11-10T00:00:00.000Z', '2026-11-10T00:00:05.000Z', '', '2027', `x${LONE[0]!}`]) } : {}),
            };
            const oldResult = outcome(() => legacyBoard.read(reader, options));
            const newResult = outcome(() => board.read(reader, options));
            expect(sameOutcome(oldResult, newResult), JSON.stringify([reader, options])).toBe(true);
            const value = (oldResult as { value: { notes: unknown[]; truncated: boolean } }).value;
            bump(value.truncated ? '읽기 잘림' : value.notes.length === 0 ? '읽기 빔' : '읽기 값');
          }
        }
        expect(JSON.stringify(wellFormed(board.snapshot()))).toBe(JSON.stringify(wellFormed(legacyBoard.snapshot())));
        expect(board.stats()).toEqual(legacyBoard.stats());
      }
      report(`[차등] 게시판 시드 ${seed}: 시나리오 ${runs}, 분포 ${JSON.stringify(dist)}`);
      for (const key of ['쓰기 통과', '읽기 잘림', '읽기 빔', '읽기 값', '거부: 빈 메모는 쓸 수 없습니다', '거부: 실패 메모는 검증기만 씁니다', '거부: 계약 메모는 refs가 하나 이상 필요합니다']) {
        expect(dist[key], key).toBeGreaterThan(0);
      }
      expect(Object.keys(dist).some((key) => key.startsWith('거부: 메모가 너무 큽니다'))).toBe(true);
      expect(Object.keys(dist).some((key) => key.startsWith('거부: 레인 쓰기 한도'))).toBe(true);
    });
  }

  it('한도가 undefined이거나 NaN이면 그 상한은 걸리지 않는다(옛 비교와 같다)', () => {
    for (const noteBytes of [undefined, Number.NaN, Infinity]) {
      const limits = { noteBytes } as unknown as { noteBytes: number };
      const a = new LegacyBoard({ topology: 'mesh', limits });
      const b = new Board({ topology: 'mesh', limits });
      const big = 'x'.repeat(5000);
      expect(b.post({ kind: 'fact', body: big }, { lane: 'a', by: 'model' }).ok).toBe(a.post({ kind: 'fact', body: big }, { lane: 'a', by: 'model' }).ok);
    }
    const readLimit = { readLimit: Number.NaN } as unknown as { readLimit: number };
    // 두 게시판에 같은 시각을 준다. 실제 시각을 쓰면 옛 쪽과 새 쪽 쓰기 사이에 밀리초가 넘어갈 때 `at`이 달라 정렬이 갈린다(CI에서 흔들렸다, 이슈 #1112).
    // 실제 시각이 흐르는 상황을 가짜 타이머로 매번 만들어, 시계를 넣지 않으면 늘 실패하게 둔다
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 10, 0, 0, 0, 974) });
    try {
      const a = new LegacyBoard({ topology: 'mesh', limits: readLimit, now: newClock() });
      const b = new Board({ topology: 'mesh', limits: readLimit, now: newClock() });
      for (let i = 0; i < 5; i++) {
        a.post({ kind: 'fact', body: `n${i}` }, { lane: 'a', by: 'model' });
        vi.advanceTimersByTime(1);
        b.post({ kind: 'fact', body: `n${i}` }, { lane: 'a', by: 'model' });
      }
      expect(JSON.stringify(b.read({ lane: 'a' }))).toBe(JSON.stringify(a.read({ lane: 'a' })));
    } finally {
      vi.useRealTimers();
    }
  });

  it('대조 장치: 예산 경계(>→>=)·개수 경계·정렬 방향·시각 방향을 바꾼 가짜는 결과가 달라 잡힌다', () => {
    interface Item {
      priority: number;
      at: string;
      id: string;
      bytes: number;
    }
    type Mutation = 'none' | 'budget>=' | 'limit>' | 'priority-asc' | 'at-asc' | 'id-desc';
    // 옛 Board.read의 정렬·고르기를 그대로 옮긴 기준(JS). 변이는 한 곳만 바꾼다
    const reference = (items: Item[], readLimit: number, budget: number, mutation: Mutation): { selected: string[]; truncated: boolean; bytes: number } => {
      const compare = (a: Item, b: Item): number => {
        if (a.priority !== b.priority) return mutation === 'priority-asc' ? a.priority - b.priority : b.priority - a.priority;
        if (a.at !== b.at) return (mutation === 'at-asc' ? a.at > b.at : a.at < b.at) ? 1 : -1;
        return (mutation === 'id-desc' ? a.id > b.id : a.id < b.id) ? -1 : a.id > b.id || mutation === 'id-desc' && a.id < b.id ? 1 : 0;
      };
      const visible = [...items].sort(compare);
      const selected: string[] = [];
      let bytes = 0;
      // 처음의 `visible.length > readLimit`은 뒤의 개수 검사가 같은 값을 만들어 빼도 결과가 같다(동치): 변이 목록에서 뺐다
      let truncated = visible.length > readLimit;
      for (const note of visible) {
        if (mutation === 'limit>' ? selected.length > readLimit : selected.length >= readLimit) {
          truncated = true;
          break;
        }
        if (mutation === 'budget>=' ? bytes + note.bytes >= budget : bytes + note.bytes > budget) {
          truncated = true;
          break;
        }
        selected.push(note.id);
        bytes += note.bytes;
      }
      return { selected, truncated, bytes };
    };
    const g = new Gen(41);
    const caught = new Set<Mutation>();
    let compared = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const items = g.list(0, 7, (): Item => ({ priority: g.pick([1, 2, 3]), at: g.pick(['t1', 't2', 't3']), id: `note-${g.int(100)}`, bytes: 1 + g.int(5) }));
      // id는 겹치지 않게 한다(실제 id는 하나씩 늘어난다)
      items.forEach((item, index) => { item.id = `note-${index + 1}`; });
      const readLimit = g.pick([1, 2, 3, 20]);
      const budget = g.pick([0, 3, 5, 8, 12, 100]);
      const real = decodeNative<{ selected: number[]; truncated: boolean; bytes: number }>(native.coordBoardPickNotes(encodeNative(items), readLimit, budget));
      const actual = { selected: real.selected.map((index) => items[index]!.id), truncated: real.truncated, bytes: real.bytes };
      expect(JSON.stringify(actual)).toBe(JSON.stringify(reference(items, readLimit, budget, 'none')));
      compared += 1;
      for (const mutation of ['budget>=', 'limit>', 'priority-asc', 'at-asc', 'id-desc'] as const) {
        if (JSON.stringify(reference(items, readLimit, budget, mutation)) !== JSON.stringify(actual)) caught.add(mutation);
      }
    }
    expect(compared).toBe(ITERATIONS);
    expect([...caught].sort()).toEqual(['at-asc', 'budget>=', 'id-desc', 'limit>', 'priority-asc']);
  });
});

// board-mcp: 입력 검사와 글

const MCP_KINDS: unknown[] = ['contract', 'fact', 'failure', 'Fact', 'FACT', ' fact', 'fact ', 'facts', 'fac', '', 5, null, undefined, true, ['fact'], { a: 1 }, `fact${LONE[0]!}`, 'fact\u0000'];
const MCP_BODIES: unknown[] = ['환경: node 22', 'x', '', ' ', 5, null, undefined, ['x'], 'y'.repeat(3000), `b${LONE[0]!}`, 'dup'];
const MCP_REFS: unknown[] = [[], ['a.ts'], ['a', 'b'], [''], [1], ['a', 2], 'a.ts', null, undefined, {}, [null], [undefined], [['a']], [`r${LONE[1]!}`]];
const MCP_READ_KINDS: unknown[] = [[], ['fact'], ['contract', 'failure'], ['failure'], ['facts'], ['Fact'], [''], ['fact', 3], 'fact', null, undefined, [[]], ['contract', 'x', 'y'], [`f${LONE[2]!}`]];

function mcpArgs(g: Gen, tool: string): Record<string, unknown> {
  const args: Record<string, unknown> = tool === 'post_note' ? { kind: g.pick(MCP_KINDS), body: g.pick(MCP_BODIES), refs: g.pick(MCP_REFS) } : { kinds: g.pick(MCP_READ_KINDS) };
  if (g.chance(0.1)) delete args[g.pick(Object.keys(args))!];
  if (g.chance(0.05)) args['extra'] = 1;
  return args;
}

describe('차등 시험: board-mcp 입력 검사(막는 쪽)와 글', () => {
  for (const seed of SEEDS) {
    it(`시드 ${seed}: runBoardMcpTool 결과가 옛 구현과 같고, 옛 구현이 거부한 입력을 새 구현이 받은 수는 0이다`, async () => {
      const g = new Gen(seed + 300);
      const dist: Record<string, number> = {};
      let openFlips = 0;
      const runs = Math.max(20, Math.floor(ITERATIONS / 20));
      for (let run = 0; run < runs; run++) {
        const options = { topology: g.pick(TOPOLOGIES), limits: { readLimit: g.pick([2, 20]), readBytesPerLane: g.pick([60, 32768]), writesPerLane: 5 }, modelWrites: g.chance(0.9) };
        const legacyBoard = new LegacyBoard({ ...options, now: newClock() });
        const board = new Board({ ...options, now: newClock() });
        const identity = { lane: g.pick(['a', 'b']), ...(g.chance(0.3) ? { group: 'g1' } : {}) };
        const legacyAccess = externalBoardAccess(legacyBoard as unknown as Board, identity);
        const access = externalBoardAccess(board, identity);
        for (let step = 0; step < 20; step++) {
          const tool = g.pick(['post_note', 'post_note', 'read_notes', 'read_notes', 'unknown_tool']);
          const args = mcpArgs(g, tool);
          const oldResult = await legacy.runBoardMcpTool(tool, args, legacyAccess);
          const newResult = await runBoardMcpTool(tool, args, access);
          const same = sameOutcome({ threw: false, value: oldResult }, { threw: false, value: newResult });
          // 메시지에 든 짝 없는 서로게이트는 U+FFFD가 된다. 그 밖의 글자는 모두 같아야 한다
          expect(same, `${tool} ${JSON.stringify(args)}\n옛: ${JSON.stringify(oldResult)}\n새: ${JSON.stringify(newResult)}`).toBe(true);
          if (!oldResult.ok && newResult.ok) openFlips += 1;
          const key = `${tool}:${oldResult.ok ? 'ok' : oldResult.content.replace(/".*?"/g, '"k"').replace(/Unknown note kind: .*/, 'Unknown note kind').replace(/\d+/g, 'N').slice(0, 40)}`;
          dist[key] = (dist[key] ?? 0) + 1;
        }
      }
      report(`[차등] board-mcp 시드 ${seed}: 시나리오 ${runs}, 열린 쪽 뒤집힘 ${openFlips}, 분포 ${JSON.stringify(dist)}`);
      expect(openFlips).toBe(0);
      for (const key of ['post_note:ok', 'read_notes:ok', '"k" must be a string'.padStart(0)]) {
        if (key.startsWith('post_note') || key.startsWith('read_notes')) expect(dist[key], key).toBeGreaterThan(0);
      }
      const keys = Object.keys(dist);
      expect(keys.some((key) => key.includes('must be a string'))).toBe(true);
      expect(keys.some((key) => key.includes('must be an array of strings'))).toBe(true);
      expect(keys.some((key) => key.includes('Unknown note kind'))).toBe(true);
      expect(keys.some((key) => key.includes('Unknown tool'))).toBe(true);
    });
  }
});
