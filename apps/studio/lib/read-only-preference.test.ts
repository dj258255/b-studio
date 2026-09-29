import { describe, expect, it } from 'vitest';
import { readOnlyKey, readReadOnly, storeReadOnly } from './read-only-preference';

/** 값이 있는 저장소 */
function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    values,
  };
}

describe('읽기만 스위치 저장', () => {
  it('세션마다 따로 기억한다', () => {
    const store = storage();

    expect(readReadOnly(store, 'session-a')).toBe(false);
    storeReadOnly(store, 'session-a', true);

    expect(readReadOnly(store, 'session-a')).toBe(true);
    // 다른 세션은 꺼진 채로 시작한다
    expect(readReadOnly(store, 'session-b')).toBe(false);
    expect(store.values.get(readOnlyKey('session-a'))).toBe('on');

    storeReadOnly(store, 'session-a', false);
    expect(readReadOnly(store, 'session-a')).toBe(false);
    expect(store.values.get(readOnlyKey('session-a'))).toBe('off');
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

    expect(readReadOnly(broken, 'session-a')).toBe(false);
    expect(() => storeReadOnly(broken, 'session-a', true)).not.toThrow();
    // 저장소 자체가 없을 때(서버 렌더)도 같다
    expect(readReadOnly(undefined, 'session-a')).toBe(false);
    expect(() => storeReadOnly(undefined, 'session-a', true)).not.toThrow();
    // 이상한 값이 들어 있으면 꺼진 것으로 본다
    expect(readReadOnly(storage({ [readOnlyKey('session-a')]: 'yes' }), 'session-a')).toBe(false);
  });
});
