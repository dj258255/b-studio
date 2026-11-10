import { encodeLoneSurrogates, native } from '@b-studio/sandbox';
import { describe, expect, it } from 'vitest';
import { Gen, readEnvNumber } from './differential-kit';
import { createMismatchLog, httpOriginError, serviceName, serviceOrAddonName } from './tools';
import { mentionsDeletedFile } from './verify';
import { legacyCreateMismatchLog, legacyMentionsDeletedFile, legacyServiceName, legacyServiceOrAddonName } from './verify-tools-legacy';

/**
 * 짝 없는 서로게이트는 napi·JSON 경계에서 모두 U+FFFD가 된다(트러블슈팅 165·166). 열린 쪽으로 이어지는 같음·포함 비교(서비스 이름 허용 목록, origin 같음,
 * 어긋남 기록의 같은 기록 찾기, 지운 파일 이름 포함)는 껍데기가 두 글자를 `encodeLoneSurrogates`(단사)로 바꿔 보내 비교한다.
 * 성질: 옛 구현(JS `===`·`includes`)이 "아니다"인데 새 구현이 "이다"인 쌍(열린 쪽)은 0이다. 크기는 TOOLS_SURROGATE_PAIRS 환경 변수로 바꾼다.
 */
const PAIRS = readEnvNumber('TOOLS_SURROGATE_PAIRS', 30_000);
const ALPHABET = ['a', 'b', '/', '\ud800', '\udbff', '\udc00', '\udfff', '😀', '\ud83d', '\ude00', '�', '', '', ''];

describe('짝 없는 서로게이트가 든 이름의 같음·포함 비교', () => {
  it('재현: 인코딩 없이 보내면 서로 다른 짝 없는 서로게이트가 같은 이름이 된다', () => {
    expect(native.toolServiceAllowed('\ud800', ['\udc00'])).toBe(true);
    expect(native.toolServiceAllowed('\ud800', ['�'])).toBe(true);
    expect(native.toolSameOrigin('http://a\ud800', 'http://a\udc00')).toBe(true);
  });

  it('서비스 이름: 서로 다른 짝 없는 서로게이트·U+FFFD는 다른 이름이다', () => {
    const project = { managed: [['a\ud800', {}], ['b�', {}]], composeServices: ['a\ud800', 'b�', 'c\udc00'] } as never;
    for (const [name, allowed] of [['a\ud800', true], ['a\udc00', false], ['a�', false], ['b�', true], ['b\ud800', false], ['c\udc00', false], ['c\ud800', false]] as const) {
      const viaManaged = (() => {
        try {
          serviceName({ project } as never, { service: name });
          return true;
        } catch {
          return false;
        }
      })();
      expect(viaManaged, name).toBe(allowed);
    }
    expect(() => serviceOrAddonName({ project } as never, { service: 'c\ud800' })).toThrow('Unknown service');
    expect(serviceOrAddonName({ project } as never, { service: 'c\udc00' })).toBe('c\udc00');
    expect(() => serviceOrAddonName({ project } as never, { service: 'c�' })).toThrow('Unknown service');
  });

  it('서비스 이름: 옛 구현이 거부한 이름을 새 구현이 허용한 쌍은 0이다', () => {
    const g = new Gen(31);
    let opened = 0;
    let allowed = 0;
    for (let i = 0; i < PAIRS; i++) {
      const managed = g.list(1, 2, () => g.text(ALPHABET, 1 + g.int(3)));
      const compose = g.chance(0.5) ? [...managed, g.text(ALPHABET, 1 + g.int(3))] : undefined;
      const asked = g.chance(0.4) ? g.pick(managed) : g.text(ALPHABET, 1 + g.int(3));
      const project = { managed: managed.map((name) => [name, {}] as const), ...(compose ? { composeServices: compose } : {}) };
      for (const [now, old] of [[serviceName, legacyServiceName], [serviceOrAddonName, legacyServiceOrAddonName]] as const) {
        const oldAllowed = (() => {
          try {
            old({ project }, { service: asked });
            return true;
          } catch {
            return false;
          }
        })();
        const newAllowed = (() => {
          try {
            now({ project } as never, { service: asked });
            return true;
          } catch {
            return false;
          }
        })();
        if (!oldAllowed && newAllowed) opened += 1;
        if (newAllowed) allowed += 1;
        expect(newAllowed).toBe(oldAllowed);
      }
    }
    expect(opened).toBe(0);
    expect(allowed).toBeGreaterThan(0);
  });

  it('origin 비교의 글자: 껍데기가 쓰는 단사 인코딩으로 보내면 서로 다른 짝 없는 서로게이트가 다르다', () => {
    // URL 해석을 거친 origin에는 짝 없는 서로게이트가 들지 않는다. 그래도 판정은 글자 그대로 견주고 껍데기는 encodeLoneSurrogates를 거친다
    const same = (a: string, b: string) => native.toolSameOrigin(encodeLoneSurrogates(a), encodeLoneSurrogates(b));
    expect(same('http://a\ud800', 'http://a\ud800')).toBe(true);
    expect(same('http://a\ud800', 'http://a\udc00')).toBe(false);
    expect(same('http://a\ud800', 'http://a�')).toBe(false);
    expect(httpOriginError(new URL('/x', 'http://a.test'), 'http://a.test')).toBeUndefined();
  });

  it('어긋남 기록: 서로 다른 짝 없는 서로게이트는 다른 기록이다', () => {
    const m = (requestValue: string) => ({ requestValue, checkValue: 'c', followed: 'request' as const, note: 'n' });
    for (const log of [createMismatchLog(), legacyCreateMismatchLog()]) {
      expect(log.add(m('a\ud800'))).toBe(true);
      expect(log.add(m('a\udc00'))).toBe(true);
      expect(log.add(m('a�'))).toBe(true);
      expect(log.add(m('a\ud800'))).toBe(false);
    }
  });

  it('지운 파일 이름: 옛 구현이 없다는 쌍을 새 구현이 있다고 하지 않는다', () => {
    expect(legacyMentionsDeletedFile(['\udc00: No such file'], ['\ud800'])).toBe(false);
    expect(mentionsDeletedFile(['\udc00: No such file'], ['\ud800'])).toBe(false);
    expect(mentionsDeletedFile(['�: No such file'], ['\ud800'])).toBe(false);
    expect(mentionsDeletedFile(['\ud800: No such file'], ['a/\ud800'])).toBe(true);
    const g = new Gen(32);
    let opened = 0;
    let closed = 0;
    let found = 0;
    for (let i = 0; i < PAIRS; i++) {
      const deleted = [g.text(ALPHABET, 1 + g.int(3))];
      const line = `${g.text(ALPHABET, g.int(3))}${deleted[0]!.split('/').pop()}${g.text(ALPHABET, g.int(3))} ${g.pick(['No such file', 'x'])}`;
      const lines = [g.chance(0.5) ? line : `${g.text(ALPHABET, 4)} No such file`];
      const old = legacyMentionsDeletedFile(lines, deleted);
      const now = mentionsDeletedFile(lines, deleted);
      if (!old && now) opened += 1;
      if (old && !now) closed += 1;
      if (now) found += 1;
    }
    console.info(`지운 파일 서로게이트: 참 ${found}, 열린 쪽 ${opened}, 닫는 쪽 ${closed}`);
    expect(opened).toBe(0);
    expect(found).toBeGreaterThan(0);
  });
});
