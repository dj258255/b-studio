import { describe, expect, it, vi } from 'vitest';
import { Board } from './board';
import { noteBytes, type Note, type NoteKind } from './notes';
import { canRead, type Topology } from './topology';

const HUB = 'planner';

function note(over: Partial<Note> & { kind: NoteKind }): Note {
  return { id: 'n', body: 'body', refs: [], priority: 1, at: '2026-01-01T00:00:00.000Z', author: { lane: 'a', by: 'model' }, ...over };
}

const NOTES = {
  platform: note({ id: 'p', kind: 'failure', author: { lane: 'verifier', by: 'platform' } }),
  hub: note({ id: 'h', kind: 'contract', refs: ['a.ts'], author: { lane: HUB, by: 'model' } }),
  own: note({ id: 'o', kind: 'fact', author: { lane: 'web', by: 'model' } }),
  sameGroup: note({ id: 'g', kind: 'fact', author: { lane: 'api', by: 'model' }, group: 'backend' }),
  other: note({ id: 'x', kind: 'fact', author: { lane: 'worker', by: 'model' } }),
};

const WEB = { lane: 'web', group: 'frontend' };
const API = { lane: 'api', group: 'backend' };

describe('canRead', () => {
  const cases: ReadonlyArray<[Topology, keyof typeof NOTES, boolean]> = [
    // star: 허브·자기 것·플랫폼만. 레인끼리 직접 보지 않는다
    ['star', 'platform', true],
    ['star', 'hub', true],
    ['star', 'own', true],
    ['star', 'sameGroup', false],
    ['star', 'other', false],
    // hierarchical: 같은 그룹 + 허브 + 플랫폼
    ['hierarchical', 'platform', true],
    ['hierarchical', 'hub', true],
    ['hierarchical', 'own', true],
    ['hierarchical', 'sameGroup', false], // frontend 독자가 backend 그룹 메모를 본다 → 다른 그룹이라 false
    ['hierarchical', 'other', false],
    // mesh: 모든 레인
    ['mesh', 'platform', true],
    ['mesh', 'hub', true],
    ['mesh', 'own', true],
    ['mesh', 'sameGroup', true],
    ['mesh', 'other', true],
  ];

  it.each(cases)('%s topology에서 web 레인이 %s 메모를 읽는가 → %s', (topology, key, expected) => {
    expect(canRead(topology, WEB, NOTES[key], HUB)).toBe(expected);
  });

  it('계층 구조에서 같은 그룹 레인끼리는 읽는다', () => {
    expect(canRead('hierarchical', API, NOTES.sameGroup, HUB)).toBe(true);
  });

  it('그룹이 없는 레인은 계층 구조에서 그룹 메모를 보지 못한다', () => {
    expect(canRead('hierarchical', { lane: 'lone' }, NOTES.sameGroup, HUB)).toBe(false);
  });
});

function clock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1) + (tick += 1000));
}

function board(options: Partial<ConstructorParameters<typeof Board>[0]> = {}): Board {
  return new Board({ topology: 'mesh', hub: HUB, now: clock(), ...options });
}

const asModel = (lane: string) => ({ lane, by: 'model' as const });

describe('Board.post 검사', () => {
  it('메모 크기 상한을 넘으면 거부한다', () => {
    const b = board({ limits: { noteBytes: 4 } });
    expect(b.post({ kind: 'fact', body: '12345' }, asModel('web'))).toMatchObject({ ok: false });
    expect(b.post({ kind: 'fact', body: '1234' }, asModel('web')).ok).toBe(true);
  });

  it('레인 쓰기 한도를 넘으면 거부한다', () => {
    const b = board({ limits: { writesPerLane: 2 } });
    expect(b.post({ kind: 'fact', body: 'a' }, asModel('web')).ok).toBe(true);
    expect(b.post({ kind: 'fact', body: 'b' }, asModel('web')).ok).toBe(true);
    const third = b.post({ kind: 'fact', body: 'c' }, asModel('web'));
    expect(third).toMatchObject({ ok: false });
    expect(third.ok ? '' : third.reason).toContain('쓰기 한도');
  });

  it('실패 메모는 검증기(플랫폼)만 쓴다', () => {
    const b = board();
    const denied = b.post({ kind: 'failure', body: 'cannot find symbol' }, asModel('web'));
    expect(denied).toMatchObject({ ok: false });
    expect(denied.ok ? '' : denied.reason).toBe('실패 메모는 검증기만 씁니다');
    expect(b.post({ kind: 'failure', body: 'cannot find symbol' }, { lane: 'verifier', by: 'platform' }).ok).toBe(true);
  });

  it('빈 본문을 거부한다', () => {
    const b = board();
    expect(b.post({ kind: 'fact', body: '   ' }, asModel('web'))).toMatchObject({ ok: false, reason: '빈 메모는 쓸 수 없습니다' });
  });

  it('계약 메모는 refs가 하나 이상 필요하다', () => {
    const b = board();
    expect(b.post({ kind: 'contract', body: 'OrderResponse.memo', refs: [] }, asModel('web'))).toMatchObject({ ok: false });
    expect(b.post({ kind: 'contract', body: 'OrderResponse.memo', refs: ['api/src/Order.java'] }, asModel('web')).ok).toBe(true);
  });

  it('작성자·그룹·시각을 그대로 남긴다', () => {
    const b = board();
    const result = b.post({ kind: 'fact', body: 'api listens on 8080', group: 'backend' }, { lane: 'api', task: 'orders', by: 'model' });
    expect(result.ok && result.note).toMatchObject({ author: { lane: 'api', task: 'orders', by: 'model' }, group: 'backend' });
  });
});

describe('Board 중복·우선순위·읽기', () => {
  it('같은 (kind, body)는 새로 만들지 않고 기존 id를 돌려준다', () => {
    const b = board();
    const first = b.post({ kind: 'fact', body: 'same' }, asModel('web'));
    const second = b.post({ kind: 'fact', body: 'same' }, asModel('api'));
    expect(first.ok && second.ok && first.note.id).toBe(second.ok ? second.note.id : '');
    expect(b.snapshot()).toHaveLength(1);
    expect(b.stats().posts).toBe(1);
    // kind가 다르면 다른 메모다
    expect(b.post({ kind: 'contract', body: 'same', refs: ['a.ts'] }, asModel('web')).ok).toBe(true);
    expect(b.snapshot()).toHaveLength(2);
  });

  it('우선순위 기본값은 failure 3 > contract 2 > fact 1이고 내림차순으로 읽힌다', () => {
    const b = board();
    b.post({ kind: 'fact', body: 'fact' }, asModel('web'));
    b.post({ kind: 'contract', body: 'contract', refs: ['a.ts'] }, asModel('web'));
    b.post({ kind: 'failure', body: 'failure' }, { lane: 'verifier', by: 'platform' });

    const { notes } = b.read({ lane: 'web' });
    expect(notes.map((n) => n.kind)).toEqual(['failure', 'contract', 'fact']);
    expect(notes.map((n) => n.priority)).toEqual([3, 2, 1]);
  });

  it('우선순위가 같으면 최신순으로 읽는다', () => {
    const b = board();
    b.post({ kind: 'fact', body: 'first' }, asModel('web'));
    b.post({ kind: 'fact', body: 'second' }, asModel('web'));
    b.post({ kind: 'fact', body: 'third' }, asModel('web'));
    expect(b.read({ lane: 'web' }).notes.map((n) => n.body)).toEqual(['third', 'second', 'first']);
  });

  it('kinds로 거르고 since 이후만 읽는다', () => {
    const b = board();
    const first = b.post({ kind: 'fact', body: 'old' }, asModel('web'));
    b.post({ kind: 'contract', body: 'new', refs: ['a.ts'] }, asModel('web'));
    expect(b.read({ lane: 'web' }, { kinds: ['contract'] }).notes.map((n) => n.body)).toEqual(['new']);
    const since = first.ok ? first.note.at : '';
    expect(b.read({ lane: 'web' }, { since }).notes.map((n) => n.body)).toEqual(['new']);
  });

  it('읽기 개수 상한을 넘으면 truncated로 알린다', () => {
    const b = board({ limits: { readLimit: 1 } });
    b.post({ kind: 'fact', body: 'a' }, asModel('web'));
    b.post({ kind: 'fact', body: 'b' }, asModel('web'));
    const result = b.read({ lane: 'web' });
    expect(result.notes).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.reason).toBeTruthy();
  });

  it('레인별 읽기 바이트 예산을 넘으면 그 뒤로 빈 목록을 돌려준다', () => {
    // 본문 10바이트짜리 사실 3개, 예산 20바이트
    const b = board({ limits: { readBytesPerLane: 20 } });
    b.post({ kind: 'fact', body: 'a'.repeat(10) }, asModel('web'));
    b.post({ kind: 'fact', body: 'b'.repeat(10) }, asModel('web'));
    b.post({ kind: 'fact', body: 'c'.repeat(10) }, asModel('web'));

    const first = b.read({ lane: 'web' });
    expect(first.notes).toHaveLength(2);
    expect(first.truncated).toBe(true);
    expect(first.reason).toBeTruthy();

    const second = b.read({ lane: 'web' });
    expect(second.notes).toEqual([]);
    expect(second.truncated).toBe(true);
    expect(second.reason).toContain('예산');

    // 예산은 레인별이다. 다른 레인은 자기 예산을 처음 쓴다
    expect(b.read({ lane: 'api' }).notes).toHaveLength(2);
  });
});

describe('Board stats·onChange·snapshot', () => {
  it('쓴·거부한·읽은 수와 종류별 개수를 센다', () => {
    const b = board();
    b.post({ kind: 'fact', body: 'fact' }, asModel('web'));
    b.post({ kind: 'contract', body: 'contract', refs: ['a.ts'] }, asModel('web'));
    b.post({ kind: 'failure', body: 'nope' }, asModel('web')); // 거부
    b.post({ kind: 'fact', body: 'fact' }, asModel('web')); // 중복, posts에 안 셈
    b.read({ lane: 'web' });
    b.read({ lane: 'api' });

    const stats = b.stats();
    expect(stats.posts).toBe(2);
    expect(stats.rejected).toBe(1);
    expect(stats.reads).toBe(2);
    expect(stats.byKind).toEqual({ contract: 1, failure: 0, fact: 1 });
    // bytesRead는 게시판 전체에서 실제로 돌려준 바이트 합이다. 두 레인이 같은 두 메모를 읽었으므로 두 배
    expect(stats.bytesRead).toBe((noteBytes('fact') + noteBytes('contract')) * 2);
  });

  it('새 메모가 생기면 onChange로 스냅샷을 넘기고, 중복·거부에는 부르지 않는다', () => {
    const onChange = vi.fn();
    const b = board({ onChange });
    b.post({ kind: 'fact', body: 'a' }, asModel('web'));
    expect(onChange).toHaveBeenCalledTimes(1);
    b.post({ kind: 'fact', body: 'a' }, asModel('web')); // 중복
    b.post({ kind: 'failure', body: 'x' }, asModel('web')); // 거부
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it('스냅샷을 밖에서 고쳐도 게시판은 바뀌지 않는다', () => {
    const b = board();
    b.post({ kind: 'contract', body: 'c', refs: ['a.ts'] }, asModel('web'));
    const snap = b.snapshot();
    snap[0]!.refs.push('b.ts');
    snap[0]!.author.lane = 'evil';
    expect(b.snapshot()[0]).toMatchObject({ refs: ['a.ts'], author: { lane: 'web' } });
  });
});
