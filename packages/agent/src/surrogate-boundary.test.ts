import { encodeLoneSurrogates, native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { Gen, readEnvNumber } from './differential-kit';
import { judge } from './explore-qa';
import { containsApiValue, nextErrorMarker, usesInRunValue, viewportProblems } from './gate';
import * as legacyGate from './gate-helpers-legacy';
import { verifySpecQuote } from './requirements';
import { verifySpecQuote as legacyVerifySpecQuote } from './requirements-legacy';

/**
 * 짝 없는 서로게이트가 Rust 경계에서 모두 U+FFFD가 되는 문제(ADR-191 3p 검토): 부분 문자열 비교로 통과·실패를 가르는 두 자리(탐색 QA `judge`의 확인 문구,
 * 3j `verifySpecQuote`의 인용)가 서로 다른 짝 없는 서로게이트를 "같다"로 읽어 실패를 통과로 뒤집었다. 견줄 두 글자를 `encodeLoneSurrogates`(단사)로 바꿔 보내 고쳤다.
 * 성질: 옛 구현(JS `includes`)이 "없다"인데 새 구현이 "있다"인 쌍(열린 쪽)은 0이고, 옛 "있다"·새 "없다"(닫는 쪽)는 B의 짝 없는 서로게이트가 A에서는 짝의 일부일 때뿐이다.
 * ADR-191 3r(게이트 보조 판정)에서 같은 성질을 세 자리 더 본다: `containsApiValue`(글자 값이 화면에 있으면 통과), `viewportProblems`(첫 화면 글자의 짝짓기), `usesInRunValue`(받아들인 값 사용 판정),
 * 그리고 표지가 ASCII라 단사로 보내지 않는 `nextErrorMarker`(표시가 있으면 실패)에서 옛 "표시 있음"이 새 "없음"으로 뒤집히지 않는다.
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

describe('게이트 보조 판정(3r)의 짝 없는 서로게이트 경계', () => {
  it('경계를 그대로 넘기면 서로 다른 짝 없는 서로게이트가 같아진다(껍데기가 단사로 바꿔 보내는 까닭)', () => {
    expect(native.gateContainsApiText('a\ud800b', '\udc00')).toBe(true);
    expect(containsApiValue('a\ud800b', '\udc00')).toBe(false);
    expect(legacyGate.containsApiValue('a\ud800b', '\udc00')).toBe(false);
  });

  it('containsApiValue(글자): 옛 "없다"가 "있다"로 뒤집힌 쌍은 0이고, 다른 쌍은 짝을 가르는 경우뿐이다', () => {
    const g = new Gen(17);
    let open = 0;
    let closed = 0;
    let same = 0;
    for (let i = 0; i < PAIRS * 3; i++) {
      const [text, value] = pairOf(g);
      const old = legacyGate.containsApiValue(text, value);
      const now = containsApiValue(text, value);
      if (old === now) same += 1;
      else if (!old && now) open += 1;
      else {
        closed += 1;
        expect(pairSplitReason(text, value), JSON.stringify([text, value])).toBe(true);
      }
    }
    expect(open).toBe(0);
    expect(closed).toBeGreaterThan(0);
    expect(same).toBeGreaterThan(PAIRS);
  });

  it('containsApiValue: 검토 재현 입력은 옛 구현처럼 "없다"이다', () => {
    expect(containsApiValue('가격 \ufffd', '\ud800')).toBe(false);
    expect(containsApiValue('x\ud800y', '\ufffd')).toBe(false);
    expect(containsApiValue('\ue010d800', '\ud800')).toBe(false);
    expect(containsApiValue('x\ud800y', 'd800')).toBe(false);
    expect(containsApiValue('x\ud800y', '\ud800')).toBe(true);
  });

  it('viewportProblems: 글자를 찾았다고 읽은 쪽(문제 없음)으로 뒤집힌 쌍은 0이고 결과는 옛 구현과 같다', () => {
    const g = new Gen(19);
    let open = 0;
    let found = 0;
    let missing = 0;
    for (let i = 0; i < PAIRS; i++) {
      const [a, b] = pairOf(g);
      const report = { width: 1280, height: 800, findings: [{ text: a, visible: true }] };
      const old = legacyGate.viewportProblems([b], report);
      const now = viewportProblems([b], report);
      if (old.length > 0 && now.length === 0) open += 1;
      expect(now.map((m) => m.replace(/[\ud800-\udfff]/g, '\ufffd')), JSON.stringify([a, b])).toEqual(old.map((m) => m.replace(/[\ud800-\udfff]/g, '\ufffd')));
      if (old.length === 0) found += 1;
      else missing += 1;
    }
    expect(open).toBe(0);
    expect(found).toBeGreaterThan(0);
    expect(missing).toBeGreaterThan(0);
    // 검토 재현: 다른 짝 없는 서로게이트는 같은 글자가 아니다
    const report = { width: 1, height: 1, findings: [{ text: '\udc00', visible: true }] };
    expect(viewportProblems(['\ud800'], report)).toHaveLength(1);
    expect(viewportProblems(['\ud800'], { ...report, findings: [{ text: '\ud800', visible: true }] })).toHaveLength(0);
    expect(viewportProblems(['\ufffd'], { ...report, findings: [{ text: '\ud800', visible: true }] })).toHaveLength(1);
  });

  it('usesInRunValue: 옛 "쓰지 않는다"가 "쓴다"로 뒤집힌 쌍은 0이고 결과는 옛 구현과 같다', () => {
    const g = new Gen(23);
    const names = ['\ud800', '\udc00', '\ufffd', 'a', '\ue010d800', 'a\ud800', '😀'];
    let open = 0;
    let used = 0;
    let notUsed = 0;
    for (let i = 0; i < PAIRS; i++) {
      const name = g.pick(names);
      const key = g.pick(names);
      const route = { file: `app/[${name}]/page.tsx` };
      const latest = { config: {}, notes: [], inRunKeys: new Set([key]), inRunSampleIdFrom: false } as unknown as Parameters<typeof usesInRunValue>[1];
      const old = legacyGate.usesInRunValue(route, latest);
      const now = usesInRunValue(route, latest);
      if (!old && now) open += 1;
      expect(now, JSON.stringify([name, key])).toBe(old);
      if (old) used += 1;
      else notUsed += 1;
    }
    expect(open).toBe(0);
    expect(used).toBeGreaterThan(0);
    expect(notUsed).toBeGreaterThan(0);
  });

  it('nextErrorMarker: 옛 "표시 있음"이 "없음"으로 뒤집힌 쌍은 0이고 결과는 옛 구현과 같다(표지는 ASCII라 본문을 그대로 보낸다)', () => {
    const g = new Gen(29);
    const pieces = ['Application error: a server-side exception has occurred', 'Unhandled Runtime Error', 'This page could not be found', 'Unhandled', ' Runtime Error', 'This page', ' could not be found', ...ALPHABET];
    let open = 0;
    let marked = 0;
    let clean = 0;
    for (let i = 0; i < PAIRS * 2; i++) {
      const text = g.text(pieces, 1 + g.int(5));
      const status = g.pick([200, 404]);
      const old = legacyGate.nextErrorMarker(text, status);
      const now = nextErrorMarker(text, status);
      if (old !== undefined && now === undefined) open += 1;
      expect(now, JSON.stringify([text, status])).toBe(old);
      if (old === undefined) clean += 1;
      else marked += 1;
    }
    expect(open).toBe(0);
    expect(marked).toBeGreaterThan(0);
    expect(clean).toBeGreaterThan(0);
  });
});
