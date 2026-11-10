import { describe, expect, it } from 'vitest';
import { Gen, readEnvNumber } from './differential-kit';
import * as legacy from './path-policy-legacy';
import { checkToolPolicy, isProtectedPath, isWithinScope } from './policy';

/**
 * 짝 없는 서로게이트는 napi·JSON 경계에서 모두 U+FFFD가 된다(트러블슈팅 165). 쓰기 범위는 허용 목록이라, 서로 다른 짝 없는 서로게이트(또는 진짜 U+FFFD)가
 * 같은 글자로 합쳐지면 범위 밖 파일이 범위 안으로 판정된다(`isWithinScope('a\uD800/x', 'a\uDC00')`). 껍데기가 파일·쓰기 범위·보호 경로를
 * `encodeLoneSurrogates`로 바꿔 보내 막는다. 보호 경로·레인 겹침은 거부 목록이라 합쳐지면 더 막을 뿐이다.
 * 크기는 PATH_SURROGATE_PAIRS 환경 변수로 바꾼다.
 */
const ALPHABET = ['a', 'b', '/', '.', '\ud800', '\udbff', '\udc00', '\udfff', '😀', '\ud83d', '\ude00', '�', '', '', ''];
const PAIRS = readEnvNumber('PATH_SURROGATE_PAIRS', 20_000);

function pathOf(g: Gen): string {
  return g.text(ALPHABET, 1 + g.int(6));
}

describe('짝 없는 서로게이트가 든 경로의 쓰기 범위·보호 경로', () => {
  it('재현: 서로 다른 짝 없는 서로게이트·U+FFFD는 같은 범위가 아니다', () => {
    expect(legacy.isWithinScope('a\ud800/x', 'a\udc00')).toBe(false);
    expect(isWithinScope('a\ud800/x', 'a\udc00')).toBe(false);
    expect(isWithinScope('a\ud800/x', 'a�')).toBe(false);
    expect(isWithinScope('a�/x', 'a\ud800')).toBe(false);
    expect(isWithinScope('a\ud800/x', 'a\ud800')).toBe(true);
    expect(checkToolPolicy('write_file', { path: 'a\ud800/x' }, { writablePaths: ['a�'] }, undefined).decision).toBe('deny');
    expect(checkToolPolicy('write_file', { path: 'a\ud800/x' }, { writablePaths: ['a\udc00'] }, undefined).decision).toBe('deny');
    expect(checkToolPolicy('write_file', { path: 'a\ud800/x' }, { writablePaths: ['a\ud800'] }, undefined).decision).toBe('allow');
  });

  it('isWithinScope: 옛 구현이 범위 밖인데 새 구현이 범위 안인 쌍은 0이다', () => {
    const g = new Gen(3);
    let open = 0;
    let inside = 0;
    for (let i = 0; i < PAIRS; i++) {
      const file = pathOf(g);
      const scope = g.int(3) === 0 ? file.slice(0, 1 + g.int(file.length)) : pathOf(g);
      const old = legacy.isWithinScope(file, scope);
      const now = isWithinScope(file, scope);
      if (!old && now) open += 1;
      if (now) inside += 1;
      expect(now, JSON.stringify([file, scope])).toBe(old);
    }
    expect(open).toBe(0);
    expect(inside).toBeGreaterThan(0);
  });

  it('checkToolPolicy: 쓰기 범위·보호 경로가 옛 구현보다 열리지 않는다', () => {
    const g = new Gen(5);
    let allowed = 0;
    for (let i = 0; i < PAIRS; i++) {
      const file = pathOf(g);
      const policy = { writablePaths: [pathOf(g), file.slice(0, 1 + g.int(file.length))], protectedPaths: g.int(2) === 0 ? [pathOf(g)] : [] };
      const old = legacy.checkToolPolicy('write_file', { path: file }, policy, undefined);
      const now = checkToolPolicy('write_file', { path: file }, policy, undefined);
      if (now.decision === 'allow') allowed += 1;
      expect(now.decision, JSON.stringify([file, policy])).toBe(old.decision);
    }
    expect(allowed).toBeGreaterThan(0);
  });

  it('isProtectedPath(거부 목록)는 옛 구현이 보호하던 것을 모두 보호한다', () => {
    const g = new Gen(9);
    for (let i = 0; i < PAIRS; i++) {
      const file = pathOf(g);
      const rule = g.int(3) === 0 ? file.slice(0, 1 + g.int(file.length)) : pathOf(g);
      if (legacy.isProtectedPath(file, rule)) expect(isProtectedPath(file, rule), JSON.stringify([file, rule])).toBe(true);
    }
  });
});
