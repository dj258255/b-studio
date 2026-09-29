import { describe, expect, it } from 'vitest';
import type { AgentItem } from './server/agents-overview';
import {
  attentionNotices,
  diffAttention,
  NOTIFY_STORAGE_KEY,
  readNotifyEnabled,
  shouldNotify,
  titleWithCount,
  writeNotifyEnabled,
} from './attention-notify';

function item(over: Partial<AgentItem> & { id: string }): AgentItem {
  return {
    kind: 'session',
    title: `요청 ${over.id}`,
    projectName: 'orders',
    href: `/sessions/${over.id}`,
    state: 'idle',
    lastActivityAt: '2026-09-29T00:00:00.000Z',
    ...over,
  };
}

describe('diffAttention', () => {
  it('처음 불러올 때(prev 없음)는 알리지 않는다', () => {
    expect(diffAttention(undefined, [item({ id: 'a', attention: 'error' })])).toEqual([]);
  });

  it('새로 개입이 필요해진 항목만 돌려준다', () => {
    const next = [item({ id: 'a', attention: 'error' }), item({ id: 'b' })];
    expect(diffAttention([], next)).toEqual([next[0]]);
    // 개입 필요 없던 항목이 개입 필요가 되면 새 항목이다
    expect(diffAttention([item({ id: 'a' })], [item({ id: 'a', attention: 'error' })])).toHaveLength(1);
  });

  it('같은 항목이 같은 사유로 계속 있으면 다시 알리지 않는다', () => {
    const prev = [item({ id: 'a', attention: 'gate_failed' })];
    const next = [item({ id: 'a', attention: 'gate_failed' })];
    expect(diffAttention(prev, next)).toEqual([]);
  });

  it('사유가 바뀌면 새 항목으로 본다', () => {
    const prev = [item({ id: 'a', attention: 'error' })];
    const next = [item({ id: 'a', attention: 'gate_failed' })];
    expect(diffAttention(prev, next)).toHaveLength(1);
  });

  it('사라진 항목은 알리지 않는다', () => {
    expect(diffAttention([item({ id: 'a', attention: 'error' })], [])).toEqual([]);
  });
});

describe('titleWithCount', () => {
  it('0이면 원래 제목, 1 이상이면 앞에 (N)을 붙인다', () => {
    expect(titleWithCount('b-studio', 0)).toBe('b-studio');
    expect(titleWithCount('b-studio', 3)).toBe('(3) b-studio');
  });
});

describe('attentionNotices', () => {
  it('3개 이하면 항목마다 "{제목} — {사유}"로 알린다', () => {
    const items = [item({ id: 'a', attention: 'gate_failed' }), item({ id: 'b', attention: 'approval' })];
    expect(attentionNotices(items)).toEqual([
      { title: '요청 a — 검증 실패', href: '/sessions/a' },
      { title: '요청 b — 계획 승인을 기다립니다', href: '/sessions/b' },
    ]);
  });

  it('3개까지는 그대로, 4개부터는 하나로 묶는다', () => {
    const three = ['a', 'b', 'c'].map((id) => item({ id, attention: 'error' }));
    expect(attentionNotices(three)).toHaveLength(3);

    const four = ['a', 'b', 'c', 'd'].map((id) => item({ id, attention: 'error' }));
    expect(attentionNotices(four)).toEqual([{ title: '개입 필요 4건', href: '/agents' }]);
  });

  it('빈 목록이면 알리지 않는다', () => {
    expect(attentionNotices([])).toEqual([]);
  });
});

describe('알림 설정 저장', () => {
  it('저장한 값을 다시 읽는다', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
    expect(readNotifyEnabled(storage)).toBe(false);
    writeNotifyEnabled(storage, true);
    expect(store.get(NOTIFY_STORAGE_KEY)).toBe('1');
    expect(readNotifyEnabled(storage)).toBe(true);
    writeNotifyEnabled(storage, false);
    expect(readNotifyEnabled(storage)).toBe(false);
  });

  it('localStorage가 실패해도(차단·사생활 모드) 예외를 내지 않는다', () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readNotifyEnabled(blocked)).toBe(false);
    expect(() => writeNotifyEnabled(blocked, true)).not.toThrow();
    expect(readNotifyEnabled(undefined)).toBe(false);
  });
});

describe('shouldNotify', () => {
  it('켜짐·지원·숨은 탭·권한 허용일 때만 띄운다', () => {
    expect(shouldNotify({ enabled: true, supported: true, visible: false, permission: 'granted' })).toBe(true);
  });

  it('탭이 보이거나, 껐거나, 권한이 없거나, 미지원이면 띄우지 않는다', () => {
    expect(shouldNotify({ enabled: true, supported: true, visible: true, permission: 'granted' })).toBe(false);
    expect(shouldNotify({ enabled: false, supported: true, visible: false, permission: 'granted' })).toBe(false);
    expect(shouldNotify({ enabled: true, supported: true, visible: false, permission: 'default' })).toBe(false);
    expect(shouldNotify({ enabled: true, supported: true, visible: false, permission: 'denied' })).toBe(false);
    // Notification 미지원 환경
    expect(shouldNotify({ enabled: true, supported: false, visible: false, permission: 'denied' })).toBe(false);
  });
});
