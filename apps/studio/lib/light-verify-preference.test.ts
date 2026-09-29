import { describe, expect, it } from 'vitest';
import { lightVerifyKey, readLightVerify, storeLightVerify } from './light-verify-preference';

/** 값이 있는 저장소 */
function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

describe('가볍게 확인 스위치 저장', () => {
  it('세션마다 따로 기억한다', () => {
    const store = storage();

    expect(readLightVerify(store, 'session-a')).toBe(false);
    storeLightVerify(store, 'session-a', true);

    expect(readLightVerify(store, 'session-a')).toBe(true);
    // 다른 세션은 꺼진 채로 시작한다
    expect(readLightVerify(store, 'session-b')).toBe(false);
    expect(store.values.get(lightVerifyKey('session-a'))).toBe('on');

    storeLightVerify(store, 'session-a', false);
    expect(readLightVerify(store, 'session-a')).toBe(false);
    expect(store.values.get(lightVerifyKey('session-a'))).toBe('off');
  });

  it('저장소를 못 써도 꺼진 것으로 보고 던지지 않는다', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };

    expect(readLightVerify(broken, 'session-a')).toBe(false);
    expect(() => storeLightVerify(broken, 'session-a', true)).not.toThrow();
    // 저장소 자체가 없을 때(서버 렌더)도 같다
    expect(readLightVerify(undefined, 'session-a')).toBe(false);
    expect(() => storeLightVerify(undefined, 'session-a', true)).not.toThrow();
    // 이상한 값이 들어 있으면 꺼진 것으로 본다
    expect(readLightVerify(storage({ [lightVerifyKey('session-a')]: 'yes' }), 'session-a')).toBe(false);
  });
});
