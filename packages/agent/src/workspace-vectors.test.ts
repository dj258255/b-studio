import { readFileSync } from 'node:fs';
import nodePath from 'node:path';
import { encodeLoneSurrogates, native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import * as legacy from './workspace-legacy';
import { isSecretFile } from './workspace';

/**
 * workspace.ts의 막는 검사 벡터 시험(ADR-191 3단계 3w). 기대값은 옮기기 전 TS가 낸 값이다(`workspace-vectors.json`, JSON 글자).
 * 막는 검사라 거의 같은 거부 입력을 함께 밟았다.
 *  - 숨긴 이름: `.git`·`.GIT`·`.git.`·`.git `·`.gi\u200Bt`·전각·켈빈 기호·결합 악센트, 생성물 폴더의 접두·덧붙임·대소문자(`node_modulesx`·`xnode_modules`·`BUILD`·`builds`)
 *  - `.env` 계열: `.envx`·`.env_local`·`x.env`·`.env\u200B`처럼 닮았지만 다른 이름, 줄 끝 글자
 *  - 예시 파일 예외(허용 목록이라 좁게): `.env.example`은 열고 `.env.example.`·`.env.examples`·`.env.exam\u200Bple`·`.env.\uFF45xample`·`.env.example.x`·`.env..example`·켈빈 기호는 막는다
 *  - 안쪽 판정: 루트·밖·`..`로 시작하는 이름(`..x`)·접두만 같은 형제(`proj2`)·대소문자·보이지 않는 문자·Windows 드라이브·UNC
 *  - 들어온 경로: 절대 경로(`/x`, `C:/x`는 POSIX에서 상대), NUL, POSIX의 역슬래시
 * 옛 TS(`workspace-legacy.ts`)로 기대값을 돌려 보려면 WORKSPACE_VECTORS_IMPL=legacy: 의도한 차이만 실패해야 한다.
 */
type Vector = [fn: string, args: unknown[], expected: string];
const VECTORS = JSON.parse(readFileSync(new URL('./workspace-vectors.json', import.meta.url), 'utf8')) as Vector[];
const USE_LEGACY = process.env.WORKSPACE_VECTORS_IMPL === 'legacy';

function run(fn: string, args: unknown[]): unknown {
  const text = args[0] as string;
  switch (fn) {
    case 'isDenied':
      return USE_LEGACY ? legacy.isDenied(text) : native.workspaceIsDenied(text);
    case 'isSecretFile':
      return USE_LEGACY ? legacy.isSecretFile(text) : isSecretFile(text);
    case 'isInsidePosix':
      return USE_LEGACY ? legacy.isInside(text, args[1] as string, nodePath.posix) : native.workspaceIsInside(encodeLoneSurrogates(nodePath.posix.relative(text, args[1] as string)), false);
    case 'isInsideWin':
      return USE_LEGACY ? legacy.isInside(text, args[1] as string, nodePath.win32) : native.workspaceIsInside(encodeLoneSurrogates(nodePath.win32.relative(text, args[1] as string)), true);
    case 'resolveProblem':
      return USE_LEGACY ? legacy.resolveInputProblem(text, nodePath.posix) : native.workspaceInputProblem(text, false, false);
    case 'resolveProblemWin':
      return USE_LEGACY ? legacy.resolveInputProblem(text, nodePath.win32) : native.workspaceInputProblem(text, true, false);
    case 'externalProblem':
      return USE_LEGACY ? legacy.externalInputProblem(text, nodePath.posix) : native.workspaceInputProblem(text, false, true);
    case 'externalProblemWin':
      return USE_LEGACY ? legacy.externalInputProblem(text, nodePath.win32) : native.workspaceInputProblem(text, true, true);
    default:
      throw new Error(`알 수 없는 벡터 함수: ${fn}`);
  }
}

/** 의도한 차이: `.env.` 뒤에 줄 끝 글자가 오는 이름. 옛 구현은 `.`이 줄 끝 글자를 못 맞춰 통과(거짓)시켰고 새 구현은 막는다(참) */
const intended = (fn: string, args: unknown[], expected: string): boolean => {
  if (fn !== 'isDenied' && fn !== 'isSecretFile') return false;
  if (expected !== 'false') return false;
  return typeof args[0] === 'string' && /(^|\/)\.env\.[^/]*[\n\r\u2028\u2029]/.test(args[0]);
};

describe('workspace 막는 검사 벡터(옛 TS가 낸 값)', () => {
  it(`${VECTORS.length}개 벡터가 모두 같다(의도한 차이는 새 값으로 기대한다)`, () => {
    const bad: string[] = [];
    for (const [fn, args, oldExpected] of VECTORS) {
      const expected = intended(fn, args, oldExpected) ? 'true' : oldExpected;
      const actual = JSON.stringify(run(fn, args));
      if (actual !== expected) bad.push(`${fn} ${JSON.stringify(args)}\n  기대 ${expected}\n  실제 ${actual}`);
    }
    // 옛 TS(WORKSPACE_VECTORS_IMPL=legacy)에서는 의도한 차이 INTENDED_COUNT개만 실패한다
    if (USE_LEGACY) expect(bad.length).toBe(INTENDED_COUNT);
    else expect(bad.slice(0, 10)).toEqual([]);
    expect(VECTORS.length).toBeGreaterThan(800);
  });

  it('벡터가 모든 갈래를 밟는다: 막음·통과, 안쪽·바깥, 입력 문제 0·1·2', () => {
    const seen = new Map<string, Set<string>>();
    for (const [fn, , expected] of VECTORS) seen.set(fn, (seen.get(fn) ?? new Set()).add(expected));
    for (const fn of ['isDenied', 'isSecretFile', 'isInsidePosix', 'isInsideWin']) expect([...seen.get(fn)!].sort(), fn).toEqual(['false', 'true']);
    expect([...seen.get('resolveProblem')!].sort()).toEqual(['0', '1', '2']);
    expect([...seen.get('externalProblem')!].sort()).toEqual(['0', '1']);
  });

  it('숨긴 이름은 접어 넓게 막고, 예시 파일 예외는 글자 그대로만 연다(같은 이름 쌍)', () => {
    for (const name of ['.ENV', '.env.', '.env\u0301'.slice(0, 4), '.gi\u200Bt', 'Node_Modules', '.env.local', '.env.example.', '.env.examples', '.env.exam\u200Bple', '.env.\uFF45xample', '.env.example.x', '.env..example', '.env.\u212Aexample']) {
      expect(native.workspaceIsDenied(name), name).toBe(true);
    }
    for (const name of ['.env.example', '.ENV.EXAMPLE', '.env.local.example', '.env.production.dist', '.envx', '.env_local', 'env', 'builds', 'node_modulesx', '.gitx']) {
      expect(native.workspaceIsDenied(name), name).toBe(false);
    }
  });

  it('안쪽 판정은 상대 경로의 첫 조각만 본다: `..`로 시작하는 이름은 안쪽, 접두만 같은 형제는 바깥', () => {
    expect(native.workspaceIsInside('..x/a', false)).toBe(true);
    expect(native.workspaceIsInside('..', false)).toBe(false);
    expect(native.workspaceIsInside('../x', false)).toBe(false);
    expect(native.workspaceIsInside('..\\x', false)).toBe(true);
    expect(native.workspaceIsInside('..\\x', true)).toBe(false);
    expect(native.workspaceIsInside('D:\\x', true)).toBe(false);
    // 짝 없는 서로게이트가 든 상대 경로도 접두 판정은 같다(단사 변환을 거친 글자)
    expect(native.workspaceIsInside(encodeLoneSurrogates('a\ud800b'), false)).toBe(true);
    expect(native.workspaceIsInside(encodeLoneSurrogates('..\ud800'), false)).toBe(true);
    expect(native.workspaceIsInside(encodeLoneSurrogates('../\ud800'), false)).toBe(false);
  });
});

describe('의도한 차이(옛 TS에 돌리면 실패한다, 더 막는 쪽)', () => {
  it('`.env.` 뒤에 줄 끝 글자가 오는 이름은 옛 구현이 통과시켰고 새 구현은 막는다', () => {
    for (const name of ['.env.\n', '.env.\r', '.env.\u2028', '.env.\u2029', '.env.local\n', '.env.a\nb', '.env.example\n', '.env.\nexample']) {
      expect(legacy.isDenied(name), name).toBe(false);
      expect(run('isDenied', [name]), name).toBe(true);
      expect(run('isSecretFile', [name]), name).toBe(true);
    }
    // 줄 끝 글자가 `.env` 바로 뒤나 앞이면 `.env.`로 시작하지 않으므로 옛 구현과 같다(다른 이름이다)
    for (const name of ['.env\n', '\n.env', '.env\r.local']) expect(run('isDenied', [name]), name).toBe(legacy.isDenied(name));
  });
});

const INTENDED_COUNT = VECTORS.filter(([fn, args, expected]) => intended(fn, args, expected)).length;
