import { describe, expect, it } from 'vitest';
import { Gen, readEnvNumber } from './differential-kit';
import * as legacy from './path-policy-legacy';
import { checkToolPolicy, isProtectedPath, isWithinScope } from './policy';

/**
 * 짝 없는 서로게이트는 napi·JSON 경계에서 모두 U+FFFD가 된다(트러블슈팅 165). 쓰기 범위는 허용 목록이라, 서로 다른 짝 없는 서로게이트(또는 진짜 U+FFFD)가
 * 같은 글자로 합쳐지면 범위 밖 파일이 범위 안으로 판정된다(`isWithinScope('a\uD800/x', 'a\uDC00')`).
 * 쓰기 범위는 껍데기가 파일과 범위를 `encodeLoneSurrogates`(단사)로 바꿔 보내 막는다. 보호 경로·레인 겹침은 거부 목록이라 파일 시스템이 실제로 쓰는
 * 이름(짝 없는 서로게이트 → U+FFFD)으로 견준다. 옛 구현보다 넓게 맞출 뿐 좁아지지 않는다(커밋 보안 검토 지적: 보호 경로까지 단사로 바꾸면 `a\uFFFD` 보호 아래에
 * 실제로 써질 `a\uD800/x`를 놓친다).
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

  it('재현: 보호 경로는 파일 시스템이 쓰는 이름으로 견준다(짝 없는 서로게이트 → U+FFFD)', () => {
    for (const rule of ['a\ufffd', 'a\udc00', 'a\ud800']) {
      expect(checkToolPolicy('write_file', { path: 'a\ud800/x' }, { protectedPaths: [rule] }, undefined).decision, rule).toBe('deny');
    }
    expect(checkToolPolicy('write_file', { path: 'a\ud800/x' }, { protectedPaths: ['b'] }, undefined).decision).toBe('allow');
    // 쓰기 범위와 보호 경로가 함께 있어도 각자의 규칙으로 견준다
    expect(checkToolPolicy('write_file', { path: 'a\ud800/x' }, { writablePaths: ['a\ud800'], protectedPaths: ['a\ufffd'] }, undefined).decision).toBe('deny');
    expect(checkToolPolicy('write_file', { path: 'a\ud800/x' }, { writablePaths: ['a\ufffd'], protectedPaths: ['b'] }, undefined).decision).toBe('deny');
  });

  it('checkToolPolicy: 쓰기 범위는 옛 구현과 같고, 보호 경로는 옛 구현과 파일 시스템 꼴이 막던 것을 모두 막는다', () => {
    const g = new Gen(5);
    const fsForm = (text: string) => text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
    let allowed = 0;
    let widened = 0;
    for (let i = 0; i < PAIRS; i++) {
      const file = pathOf(g);
      const writablePaths = [pathOf(g), file.slice(0, 1 + g.int(file.length))];
      const protectedPaths = g.int(2) === 0 ? [g.int(2) === 0 ? pathOf(g) : file.slice(0, 1 + g.int(file.length))] : [];
      const label = JSON.stringify([file, writablePaths, protectedPaths]);
      const scopeOnly = checkToolPolicy('write_file', { path: file }, { writablePaths }, undefined).decision;
      expect(scopeOnly, label).toBe(legacy.checkToolPolicy('write_file', { path: file }, { writablePaths }, undefined).decision);
      const now = checkToolPolicy('write_file', { path: file }, { writablePaths, protectedPaths }, undefined).decision;
      const old = legacy.checkToolPolicy('write_file', { path: file }, { writablePaths, protectedPaths }, undefined).decision;
      const fsProtected = protectedPaths.some((rule) => legacy.isProtectedPath(fsForm(file), fsForm(rule)));
      if (old === 'deny' || fsProtected) expect(now, label).toBe('deny');
      if (now === 'deny' && old === 'allow') {
        widened += 1;
        expect(fsProtected, label).toBe(true);
      }
      if (now === 'allow') allowed += 1;
    }
    expect(allowed).toBeGreaterThan(0);
    expect(widened).toBeGreaterThan(0);
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
