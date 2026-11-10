import { encodeLoneSurrogates } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { Gen, readEnvNumber } from './differential-kit';
import { judge } from './explore-qa';
import { verifySpecQuote } from './requirements';
import { verifySpecQuote as legacyVerifySpecQuote } from './requirements-legacy';

/**
 * 짝 없는 서로게이트가 Rust 경계에서 모두 U+FFFD가 되는 문제(ADR-191 3p 검토): 부분 문자열 비교로 통과·실패를 가르는 두 자리(탐색 QA `judge`의 확인 문구,
 * 3j `verifySpecQuote`의 인용)가 서로 다른 짝 없는 서로게이트를 "같다"로 읽어 실패를 통과로 뒤집었다. 견줄 두 글자를 `encodeLoneSurrogates`(단사)로 바꿔 보내 고쳤다.
 * 성질: 옛 구현(JS `includes`)이 "없다"인데 새 구현이 "있다"인 쌍(열린 쪽)은 0이고, 옛 "있다"·새 "없다"(닫는 쪽)는 B의 짝 없는 서로게이트가 A에서는 짝의 일부일 때뿐이다.
 * 크기는 SURROGATE_PAIRS 환경 변수로 바꾼다.
 */
const ALPHABET = ['\ud800', '\udbff', '\udc00', '\udfff', '😀', '\ud83d', '\ude00', '', '', '', '', '', '�', 'd', '8', '0', 'a', 'b', '1', 'f'];
const PAIRS = readEnvNumber('SURROGATE_PAIRS', 30_000);

const isHigh = (u: number) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number) => u >= 0xdc00 && u <= 0xdfff;

/** 글자 안에서 짝 없는 서로게이트 단위 */
function loneUnits(text: string): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < text.length; i++) {
    const u = text.charCodeAt(i);
    if (isHigh(u) && i + 1 < text.length && isLow(text.charCodeAt(i + 1))) i += 1;
    else if (isHigh(u) || isLow(u)) out.add(u);
  }
  return out;
}

/** 글자 안에서 짝의 일부인 서로게이트 단위 */
function pairedUnits(text: string): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i + 1 < text.length; i++) {
    if (isHigh(text.charCodeAt(i)) && isLow(text.charCodeAt(i + 1))) {
      out.add(text.charCodeAt(i));
      out.add(text.charCodeAt(i + 1));
    }
  }
  return out;
}

/** B의 짝 없는 서로게이트 단위가 A에서는 짝의 일부인가 — 단사 인코딩이 닫는 쪽으로만 달라지는 유일한 이유 */
function pairSplitReason(a: string, b: string): boolean {
  const paired = pairedUnits(a);
  for (const u of loneUnits(b)) if (paired.has(u)) return true;
  return false;
}

function pairOf(g: Gen): [string, string] {
  const a = g.text(ALPHABET, 1 + g.int(7));
  let b: string;
  const mode = g.int(4);
  if (mode === 0) b = g.text(ALPHABET, 1 + g.int(4));
  else {
    // A의 코드 단위 부분 문자열(짝을 가를 수 있다)을 그대로 또는 한 글자 바꿔서
    const from = g.int(a.length);
    const to = from + 1 + g.int(Math.max(1, a.length - from));
    b = a.slice(from, to);
    if (mode === 3) b = b.slice(0, -1) + g.pick(ALPHABET);
    if (b === '') b = g.pick(ALPHABET);
  }
  return [a, b];
}

describe('짝 없는 서로게이트·예약 글자의 단사 인코딩과 판정 경계', () => {
  it('인코딩한 두 글자의 includes는 옛 includes와 같고, 다른 쌍은 짝을 가르는 경우뿐이다(열린 쪽 0)', () => {
    const g = new Gen(2026);
    let open = 0;
    let closed = 0;
    let same = 0;
    for (let i = 0; i < PAIRS * 5; i++) {
      const [a, b] = pairOf(g);
      const old = a.includes(b);
      const now = encodeLoneSurrogates(a).includes(encodeLoneSurrogates(b));
      if (old === now) same += 1;
      else if (!old && now) open += 1;
      else {
        closed += 1;
        expect(pairSplitReason(a, b), JSON.stringify([a, b])).toBe(true);
      }
    }
    expect(open).toBe(0);
    expect(closed).toBeGreaterThan(0);
    expect(same).toBeGreaterThan(PAIRS);
  });

  it('인코딩은 단사다(서로 다른 글자는 서로 다른 글자가 된다)', () => {
    const g = new Gen(7);
    const seen = new Map<string, string>();
    for (let i = 0; i < PAIRS * 5; i++) {
      const text = g.text(ALPHABET, g.int(5));
      const encoded = encodeLoneSurrogates(text);
      const prior = seen.get(encoded);
      if (prior !== undefined) expect(prior).toBe(text);
      seen.set(encoded, text);
    }
    expect(encodeLoneSurrogates('\ud800')).not.toBe(encodeLoneSurrogates('\udc00'));
    expect(encodeLoneSurrogates('\ud800')).not.toBe('d800');
    expect(encodeLoneSurrogates('')).not.toBe(encodeLoneSurrogates(''));
    expect(encodeLoneSurrogates('abc가 😀')).toBe('abc가 😀');
  });

  it('judge: 확인 문구를 못 찾은 옛 fail이 pass로 뒤집힌 쌍은 0이다', () => {
    const g = new Gen(11);
    const clean = { consoleErrors: [], pageErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 0, accessibilityViolations: [] };
    let open = 0;
    let closed = 0;
    for (let i = 0; i < PAIRS; i++) {
      const [page, confirm] = pairOf(g);
      const found = page.includes(confirm);
      const status = judge({ confirmText: confirm }, clean, page, undefined).status;
      if (!found && status === 'pass') open += 1;
      if (found && status === 'fail') {
        closed += 1;
        expect(pairSplitReason(page, confirm), JSON.stringify([page, confirm])).toBe(true);
      }
      if (found && status === 'pass') continue;
      if (!found) expect(status).toBe('fail');
    }
    expect(open).toBe(0);
    expect(closed).toBeGreaterThan(0);
  });

  it('judge: 검토에서 찾은 두 재현 입력은 옛 구현처럼 fail이다', () => {
    const clean = { consoleErrors: [], pageErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 0, accessibilityViolations: [] };
    expect(judge({ confirmText: '\udc00' }, clean, 'a\ud800b', undefined).status).toBe('fail');
    expect(judge({ confirmText: 'x\udc00' }, clean, 'x\ud83d', undefined).status).toBe('fail');
    // 같은 짝 없는 서로게이트가 화면에 있으면 통과한다
    expect(judge({ confirmText: '\ud800' }, clean, 'a\ud800b', undefined).status).toBe('pass');
  });

  it('verifySpecQuote: 옛 "없다"가 "있다"로 뒤집힌 쌍은 0이고 다른 쌍은 짝을 가르는 경우뿐이다', () => {
    const g = new Gen(13);
    let open = 0;
    let closed = 0;
    for (let i = 0; i < PAIRS; i++) {
      const [spec, quote] = pairOf(g);
      const old = legacyVerifySpecQuote(quote, spec);
      const now = verifySpecQuote(quote, spec);
      if (!old && now) open += 1;
      if (old && !now) {
        closed += 1;
        expect(pairSplitReason(spec, quote), JSON.stringify([spec, quote])).toBe(true);
      }
    }
    expect(open).toBe(0);
    expect(closed).toBeGreaterThan(0);
  });

  it('verifySpecQuote: 예전 인코딩(d800 꼴)이 겹치던 입력도 구별한다', () => {
    expect(legacyVerifySpecQuote('d800', 'x\ud800y')).toBe(false);
    expect(verifySpecQuote('d800', 'x\ud800y')).toBe(false);
    expect(verifySpecQuote('x\ud800y', 'z x\ud800y z')).toBe(true);
  });
});
