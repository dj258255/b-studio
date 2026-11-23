import { describe, expect, it, vi } from 'vitest';
import { Board } from './coordination/board';
import { Gen } from './differential-kit';

/**
 * 연결·인증·조율 판정(ADR-191 3t)에서 옛 TS 사본과 무관한 경계 확인(#1347): URL 파서가 낸 origin의 글자 범위, 게시판 한도가 `undefined`·`NaN`일 때.
 * 호스트·토큰·인증·허용 출처·게시판 입력 검사의 기대값은 `connection-vectors.test.ts`가 가진다.
 */

const ITERATIONS = 4000;
const LONE = ['\ud800', '\udbff', '\udc00', '\udfff', '\ud83d', '\ude00'];

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

describe('경계 확인: 출처와 게시판 한도', () => {
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

  it('한도가 undefined이거나 NaN이면 그 상한은 걸리지 않는다', () => {
    for (const noteBytes of [undefined, Number.NaN, Infinity]) {
      const limits = { noteBytes } as unknown as { noteBytes: number };
      const board = new Board({ topology: 'mesh', limits });
      expect(board.post({ kind: 'fact', body: 'x'.repeat(5000) }, { lane: 'a', by: 'model' }).ok, String(noteBytes)).toBe(true);
    }
  });

  it('읽기 한도가 NaN이면 읽기 상한이 걸리지 않고 최근 것부터 모두 읽는다', () => {
    const readLimit = { readLimit: Number.NaN } as unknown as { readLimit: number };
    // 실제 시각이 흐르는 상황을 가짜 타이머로 만든다(시계를 넣지 않으면 정렬이 흔들린다, 이슈 #1112)
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 10, 0, 0, 0, 974) });
    try {
      const board = new Board({ topology: 'mesh', limits: readLimit, now: () => new Date(Date.now()) });
      for (let i = 0; i < 5; i++) {
        board.post({ kind: 'fact', body: `n${i}` }, { lane: 'a', by: 'model' });
        vi.advanceTimersByTime(1);
      }
      const read = board.read({ lane: 'a' });
      expect(read.notes.map((note) => note.id)).toEqual(['note-5', 'note-4', 'note-3', 'note-2', 'note-1']);
      expect(read.truncated).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
