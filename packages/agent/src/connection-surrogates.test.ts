import { native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import * as legacy from './connection-legacy';
import { Gen, readEnvNumber } from './differential-kit';
import { hostAllowed, tokenMatches } from './mcp-http-server';

/**
 * 짝 없는 서로게이트가 Rust 경계에서 모두 U+FFFD가 되는 문제(ADR-191 3t): 토큰·호스트처럼 두 값이 같은지로 인증·허용이 열리는 자리에서
 * 서로 다른 두 값이 같다고 나오면 안 된다. 견줄 값을 `encodeLoneSurrogates`(단사)로 바꿔 보내 고쳤다.
 * 호출부별 방향: tokenMatches·hostAllowed·authorize·isAllowedRequest·isAutomaticFavicon은 모두 여는 쪽(같다고 나오면 인증·허용)이다.
 * 성질: 서로 다른 값은 다르다(열린 쪽 0). 크기는 CONN_SURROGATE_PAIRS 환경 변수로 바꾼다.
 */
const PAIRS = readEnvNumber('CONN_SURROGATE_PAIRS', 40_000);

/** 짝 없는 서로게이트, 쌍, 쌍의 절반, U+FFFD, 예약 구간(U+E000..U+E01F) 글자, 글자 */
const ALPHABET = ['\ud800', '\udbff', '\udc00', '\udfff', '😀', '\ud83d', '\ude00', '�', '', '', '', '', 'a', 'b', 'A', '0', 'd', '8'];

function valueOf(g: Gen): string {
  return g.text(ALPHABET, 1 + g.int(5));
}

/** 둘 다 같은 U+FFFD 꼴로 합쳐지는지(경계가 하는 일을 흉내): 짝 없는 서로게이트만 U+FFFD로 */
const collapse = (text: string): string => text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');

describe('짝 없는 서로게이트가 든 토큰·호스트 비교(여는 쪽)', () => {
  it('토큰: 서로 다른 두 값은 다르고 같은 값은 같다(열린 쪽 0)', () => {
    const g = new Gen(2026);
    let different = 0;
    let mergedByBoundary = 0;
    let oldMerged = 0;
    for (let i = 0; i < PAIRS; i++) {
      const a = valueOf(g);
      const b = g.chance(0.3) ? a : valueOf(g);
      const actual = tokenMatches(`Bearer ${a}`, b);
      expect(actual, JSON.stringify([a, b])).toBe(a === b);
      if (a !== b) {
        different += 1;
        // 경계에서 합쳐지면 같아지는 쌍(고치지 않았다면 열렸을 쌍)
        if (collapse(a) === collapse(b)) mergedByBoundary += 1;
        if (legacy.tokenMatches(`Bearer ${a}`, b)) oldMerged += 1;
      }
    }
    expect(different).toBeGreaterThan(PAIRS / 2);
    // 입력이 이 성질을 실제로 밟는다
    expect(mergedByBoundary).toBeGreaterThan(20);
    // 옛 구현(UTF-8로 바꾸며 U+FFFD로 합침)은 그런 쌍을 같다고 읽었다. 새 구현은 하나도 열지 않는다
    expect(oldMerged).toBeGreaterThan(0);
  });

  it('호스트: 허용 이름과 Host가 짝 없는 서로게이트만 다르면 다르다, 옛 구현과 모든 쌍에서 같다', () => {
    const g = new Gen(2027);
    let mergedByBoundary = 0;
    for (let i = 0; i < PAIRS; i++) {
      const a = valueOf(g).replace(/[:[\]\s]/g, 'x');
      const b = g.chance(0.3) ? a : valueOf(g).replace(/[:[\]\s]/g, 'x');
      const actual = hostAllowed(a, [b]);
      expect(actual, JSON.stringify([a, b])).toBe(legacy.hostAllowed(a, [b]));
      if (a.toLowerCase() !== b.toLowerCase() && collapse(a.toLowerCase()) === collapse(b.toLowerCase())) {
        mergedByBoundary += 1;
        expect(actual).toBe(false);
      }
    }
    expect(mergedByBoundary).toBeGreaterThan(20);
  });

  it('대조 장치: 단사 변환 없이 Rust에 그대로 보내면 같은 쌍이 열린 쪽으로 뒤집힌다', () => {
    const g = new Gen(2028);
    let tokenOpen = 0;
    let hostOpen = 0;
    for (let i = 0; i < PAIRS; i++) {
      const a = valueOf(g);
      const b = valueOf(g);
      if (a === b) continue;
      if (native.connTokenMatches(`Bearer ${a}`, b)) tokenOpen += 1;
      const hostA = a.replace(/[:[\]\s]/g, 'x');
      const hostB = b.replace(/[:[\]\s]/g, 'x');
      if (hostA.toLowerCase() !== hostB.toLowerCase() && native.connHostAllowed(hostA, [hostB])) hostOpen += 1;
    }
    expect(tokenOpen).toBeGreaterThan(0);
    expect(hostOpen).toBeGreaterThan(0);
  });
});

// 일부러 무거운 성질·차등 시험이다(전체 코드 포인트, 긴 패치). 기본 5초는 따로 돌려도 부하 23에서 4초대라 전체 실행 때 넘는다
describe('호스트 이름의 소문자 변환: Rust와 JS가 같다', { timeout: 120_000 }, () => {
  it('모든 코드 포인트(서로게이트 제외)와 시그마 앞뒤 문맥에서 옛 구현과 같다', () => {
    let checked = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      // 호스트 구문(공백·콜론·대괄호)은 이 시험의 대상이 아니다
      if (/[\s:[\]\u0085﻿]/.test(c)) continue;
      const expected = c.toLowerCase();
      expect(hostAllowed(c, [expected]), `U+${cp.toString(16)}`).toBe(legacy.hostAllowed(c, [expected]));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(1_000_000);
    // 끝 시그마 문맥: 앞뒤에 글자·꾸밈 글자가 오는 경우
    const contexts = ['', 'a', 'Α', '.', "'", 'ͅ', '­', '1', 'Σ'];
    for (const before of contexts) {
      for (const after of contexts) {
        const host = `${before}Σ${after}`;
        for (const allowed of [host.toLowerCase(), `${before.toLowerCase()}σ${after.toLowerCase()}`, `${before.toLowerCase()}ς${after.toLowerCase()}`]) {
          expect(hostAllowed(host, [allowed]), JSON.stringify([host, allowed])).toBe(legacy.hostAllowed(host, [allowed]));
        }
      }
    }
  });
});
