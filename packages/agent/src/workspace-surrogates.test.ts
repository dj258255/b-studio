import nodePath from 'node:path';
import { encodeLoneSurrogates, native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { Gen, readEnvNumber } from './differential-kit';
import * as legacy from './workspace-legacy';

/**
 * 짝 없는 서로게이트가 든 경로의 막는 검사(ADR-191 3w). napi 경계에서 짝 없는 서로게이트는 U+FFFD가 되고(트러블슈팅 165) 파일 시스템도 그렇게 읽는다.
 *  - 거부 목록(`isDenied`·`isSecretFile`): 파일 시스템 꼴(U+FFFD)로 본다. 옛 구현이 막던 것은 모두 막고, 파일 시스템 꼴이 막힐 이름도 막아야 한다
 *  - 허용 목록(`isInside`): 같음·포함을 읽는 판정이라 `encodeLoneSurrogates`(단사)한 글자를 보낸다. 서로 다른 짝 없는 서로게이트가 같은 글자가 되어 범위 밖이 안으로 읽히면 안 된다
 * 크기는 WORKSPACE_SURROGATE_PAIRS 환경 변수로 바꾼다.
 */
const PAIRS: Array<[string, string]> = [['/a\ud800', '/a\udc00/x'], ['/a\ud800', '/a�/x'], ['/a�', '/a\ud800/x']];
const ALPHABET = ['a', '.', 'e', 'n', 'v', '/', '..', '\ud800', '\udbff', '\udc00', '\udfff', '😀', '\ud83d', '\ude00', '�', '', ''];
const COUNT = readEnvNumber('WORKSPACE_SURROGATE_PAIRS', 20_000);
const fsForm = (text: string) => text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');

describe('짝 없는 서로게이트가 든 경로의 막는 검사', () => {
  it('재현: 숨긴 이름 안의 짝 없는 서로게이트는 파일 시스템 꼴로 막는다', () => {
    expect(native.workspaceIsDenied('.env.\ud800')).toBe(true);
    expect(native.workspaceIsDenied('.env.a\udc00')).toBe(true);
    expect(native.workspaceIsSecretFile('a/.env.\ud800')).toBe(true);
    expect(native.workspaceIsDenied('.env.example\ud800')).toBe(true);
    expect(native.workspaceIsDenied('.envx\ud800')).toBe(false);
  });

  it('거부 목록: 옛 구현이 막은 것과 파일 시스템 꼴이 막는 것은 모두 막는다(막는 쪽이 줄지 않는다)', () => {
    const g = new Gen(11);
    let denied = 0;
    for (let i = 0; i < COUNT; i++) {
      const name = g.pick(['', '', '.env', '.env.', '.git', 'build', 'a/.env.']) + g.text(ALPHABET, g.int(7));
      const now = native.workspaceIsDenied(name);
      if (legacy.isDenied(name) || legacy.isDenied(fsForm(name))) expect(now, JSON.stringify(name)).toBe(true);
      const now2 = native.workspaceIsSecretFile(name);
      if (legacy.isSecretFile(name) || legacy.isSecretFile(fsForm(name))) expect(now2, JSON.stringify(name)).toBe(true);
      if (now) denied += 1;
    }
    expect(denied).toBeGreaterThan(0);
  });

  it('허용 목록: 안쪽 판정은 단사로 바꾼 상대 경로로 옛 구현과 같다(범위 밖이 안으로 읽히지 않는다)', () => {
    const g = new Gen(12);
    let inside = 0;
    let outside = 0;
    for (let i = 0; i < COUNT; i++) {
      const root = `/${g.text(ALPHABET, 1 + g.int(4))}`;
      const target = g.int(3) === 0 ? `${root}/${g.text(ALPHABET, g.int(4))}` : `/${g.text(ALPHABET, 1 + g.int(4))}`;
      const old = legacy.isInside(root, target);
      const now = native.workspaceIsInside(encodeLoneSurrogates(nodePath.posix.relative(root, target)), false);
      if (!old && now) throw new Error(`열린 쪽 뒤집힘: ${JSON.stringify([root, target])}`);
      expect(now, JSON.stringify([root, target])).toBe(old);
      if (now) inside += 1;
      else outside += 1;
    }
    expect(inside).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
  });

  it('허용 목록: 서로 다른 짝 없는 서로게이트·U+FFFD가 든 형제 폴더는 바깥이다', () => {
    for (const [root, target] of PAIRS) {
      expect(legacy.isInside(root, target), JSON.stringify([root, target])).toBe(false);
      expect(native.workspaceIsInside(encodeLoneSurrogates(nodePath.posix.relative(root, target)), false), JSON.stringify([root, target])).toBe(false);
    }
    expect(native.workspaceIsInside(encodeLoneSurrogates(nodePath.posix.relative('/a\ud800', '/a\ud800/x')), false)).toBe(true);
  });
});
