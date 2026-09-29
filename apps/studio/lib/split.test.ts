import { describe, expect, it } from 'vitest';
import type { FleetView } from './fleet-types';
import type { ChatItem } from './session-view';
import {
  broadcastTarget,
  defaultFocusId,
  effectiveLayoutMode,
  fleetForIds,
  formatElapsed,
  initialSplitLayout,
  lastOutcomeStatus,
  MAX_SPLIT,
  nextSplitIds,
  paneDisplay,
  paneState,
  parseSplitIds,
  readStoredSplitIds,
  splitKeyAction,
  splitLayoutReducer,
  SPLIT_STORAGE_KEY,
  splitGridClass,
  splitHref,
  splitLayout,
  splitLines,
  storeSplitIds,
} from './split';

describe('parseSplitIds', () => {
  it('쉼표로 나누고 빈 값·중복을 빼고 상한까지만 쓴다', () => {
    expect(parseSplitIds('a,b,c')).toEqual(['a', 'b', 'c']);
    expect(parseSplitIds(' a , b ,, a ')).toEqual(['a', 'b']);
    expect(parseSplitIds('a,b,c,d,e,f')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseSplitIds(undefined)).toEqual([]);
    expect(parseSplitIds('')).toEqual([]);
    expect(parseSplitIds(['a,b', 'c'])).toEqual(['a', 'b']);
  });
});

describe('splitLayout / splitGridClass', () => {
  it('2개면 좌우, 3~4개면 2×2이고, 좁은 화면에서는 한 열로 쌓는다', () => {
    expect(splitLayout(1)).toEqual({ columns: 1, rows: 1 });
    expect(splitLayout(2)).toEqual({ columns: 2, rows: 1 });
    expect(splitLayout(3)).toEqual({ columns: 2, rows: 2 });
    expect(splitLayout(4)).toEqual({ columns: 2, rows: 2 });

    expect(splitGridClass(2)).toContain('min-[900px]:grid-cols-2');
    expect(splitGridClass(2)).not.toContain('min-[900px]:grid-rows-2');
    expect(splitGridClass(4)).toContain('min-[900px]:grid-rows-2');
    expect(splitGridClass(1)).toContain('grid-cols-1');
  });
});

describe('splitHref / nextSplitIds', () => {
  it('주소를 만들고, 상한을 넘으면 먼저 담긴 것부터 버린다', () => {
    expect(splitHref([])).toBe('/split');
    expect(splitHref(['a', 'b'])).toBe('/split?ids=a,b');
    expect(nextSplitIds([], 'a')).toEqual(['a']);
    expect(nextSplitIds(['a', 'b'], 'a')).toEqual(['b', 'a']);
    expect(nextSplitIds(['a', 'b', 'c', 'd'], 'e')).toEqual(['b', 'c', 'd', 'e']);
    expect(nextSplitIds(['a', 'b', 'c'], 'd')).toHaveLength(MAX_SPLIT);
  });
});

describe('paneState', () => {
  it('준비 중·작업 중·검증 통과·실패·중지를 가른다', () => {
    expect(paneState({ status: 'starting', running: false })).toEqual({ tone: 'wait', label: '준비 중', attention: false });
    expect(paneState({ status: 'ready', running: true })).toEqual({ tone: 'wait', label: '작업 중', attention: false });
    expect(paneState({ status: 'ready', running: false })).toEqual({ tone: 'pass', label: '검증 통과', attention: false });
    expect(paneState({ status: 'failed', running: false })).toEqual({ tone: 'fail', label: '실패', attention: true });
    expect(paneState({ status: 'stopped', running: false }).label).toBe('중지');
  });

  it('되묻는 중이거나 지난 실행이 실패·오류면 강조(attention)한다', () => {
    const question = { runId: 'r1', question: '어떻게 할까요?', options: ['a'], allowOther: true };
    expect(paneState({ status: 'ready', running: false, pendingQuestion: question })).toEqual({ tone: 'wait', label: '답을 기다림', attention: true });
    expect(paneState({ status: 'ready', running: false }, 'failed')).toEqual({ tone: 'fail', label: '실패', attention: true });
    expect(paneState({ status: 'ready', running: false }, 'error')).toMatchObject({ tone: 'fail', attention: true });
    expect(paneState({ status: 'ready', running: false }, 'done').attention).toBe(false);
    // 실행 중이면 되묻기·지난 결과보다 우선한다
    expect(paneState({ status: 'ready', running: true, pendingQuestion: question }).label).toBe('작업 중');
  });
});

describe('lastOutcomeStatus', () => {
  it('가장 최근에 끝난 실행 결과를 찾는다', () => {
    const chat: ChatItem[] = [
      { kind: 'outcome', runId: 'r1', status: 'done', summary: '완료' },
      { kind: 'reply', runId: 'r2', text: '중간 답' },
      { kind: 'outcome', runId: 'r2', status: 'failed', summary: '실패' },
    ];
    expect(lastOutcomeStatus(chat)).toBe('failed');
    expect(lastOutcomeStatus([])).toBeUndefined();
  });
});

describe('broadcastTarget', () => {
  it('준비됐고 실행 중이 아니면 요청, 실행 중이면 지시, 그 밖은 건너뛴다', () => {
    expect(broadcastTarget({ status: 'ready', running: false })).toBe('request');
    expect(broadcastTarget({ status: 'ready', running: true })).toBe('steer');
    expect(broadcastTarget({ status: 'starting', running: false })).toBe('skip');
    expect(broadcastTarget({ status: 'failed', running: false })).toBe('skip');
    expect(broadcastTarget({ status: 'stopped', running: false })).toBe('skip');
  });
});

describe('defaultFocusId', () => {
  it('강조가 필요한 칸을 먼저 고르고, 없으면 첫 칸을 고른다', () => {
    expect(defaultFocusId([{ id: 'a', attention: false }, { id: 'b', attention: true }])).toBe('b');
    expect(defaultFocusId([{ id: 'a', attention: false }, { id: 'b', attention: false }])).toBe('a');
    expect(defaultFocusId([])).toBeUndefined();
  });
});

describe('splitKeyAction', () => {
  it('⌘/Ctrl+1~4는 입력 중에도 그 칸을 집중하고, 범위를 넘으면 무시한다', () => {
    expect(splitKeyAction({ key: '2', metaKey: true, ctrlKey: false }, { typing: true, paneCount: 4 })).toEqual({ type: 'focus', index: 1 });
    expect(splitKeyAction({ key: '3', metaKey: false, ctrlKey: true }, { typing: false, paneCount: 4 })).toEqual({ type: 'focus', index: 2 });
    expect(splitKeyAction({ key: '4', metaKey: true, ctrlKey: false }, { typing: false, paneCount: 2 })).toBeUndefined();
  });

  it('Esc는 집중을 나가되, 입력 중이면 무시한다(다른 키는 입력을 가로채지 않는다)', () => {
    expect(splitKeyAction({ key: 'Escape', metaKey: false, ctrlKey: false }, { typing: false, paneCount: 2 })).toEqual({ type: 'exitFocus' });
    expect(splitKeyAction({ key: 'Escape', metaKey: false, ctrlKey: false }, { typing: true, paneCount: 2 })).toBeUndefined();
    expect(splitKeyAction({ key: 'a', metaKey: false, ctrlKey: false }, { typing: false, paneCount: 2 })).toBeUndefined();
  });
});

describe('splitLayoutReducer / effectiveLayoutMode / paneDisplay', () => {
  it('집중·나가기를 반영하고 focusId를 기억한다', () => {
    const initial = initialSplitLayout();
    expect(initial).toEqual({ mode: 'grid' });
    const focused = splitLayoutReducer(initial, { type: 'focus', id: 'b' });
    expect(focused).toEqual({ mode: 'focus', focusId: 'b' });
    expect(splitLayoutReducer(focused, { type: 'exitFocus' })).toEqual({ mode: 'grid', focusId: 'b' });
  });

  it('좁은 화면은 그리드 모드여도 집중 화면을 쓴다', () => {
    expect(effectiveLayoutMode('grid', false)).toBe('grid');
    expect(effectiveLayoutMode('grid', true)).toBe('focus');
    expect(effectiveLayoutMode('focus', false)).toBe('focus');
  });

  it('집중 화면에서는 고른 칸만 크게, 나머지는 숨긴다', () => {
    expect(paneDisplay('grid', 'a', undefined)).toBe('grid');
    expect(paneDisplay('focus', 'a', 'a')).toBe('big');
    expect(paneDisplay('focus', 'a', 'b')).toBe('hidden');
  });
});

describe('fleetForIds', () => {
  const fleet: FleetView = {
    id: 'f1',
    owner: 'me',
    projectId: 'p1',
    projectName: 'orders',
    request: '주문 목록',
    allowBreaking: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    members: [
      { sessionId: 'a', backend: 'api', label: '모델 A', provider: 'router', status: 'done' },
      { sessionId: 'b', backend: 'api', label: '모델 B', provider: 'router', status: 'running' },
    ],
  };

  it('칸의 세션이 모두 한 Fleet의 멤버일 때만 그 Fleet을 찾는다', () => {
    expect(fleetForIds([fleet], ['a', 'b'])).toBe(fleet);
    expect(fleetForIds([fleet], ['a', 'c'])).toBeUndefined();
    expect(fleetForIds([fleet], ['a'])).toBeUndefined();
  });
});

describe('formatElapsed', () => {
  it('초·분·시간으로 적는다', () => {
    expect(formatElapsed(0)).toBe('0초');
    expect(formatElapsed(12_400)).toBe('12초');
    expect(formatElapsed(65_000)).toBe('1분 5초');
    expect(formatElapsed(3_720_000)).toBe('1시간 2분');
    expect(formatElapsed(-5)).toBe('0초');
  });
});

describe('splitLines', () => {
  const request: ChatItem = { kind: 'request', runId: 'r1', text: '주문 목록 만들어줘' };
  const reply: ChatItem = { kind: 'reply', runId: 'r1', text: '만들었습니다' };
  const tools: ChatItem = {
    kind: 'tools',
    runId: 'r1',
    calls: [
      { name: 'read_file', summary: '읽기 api/src/Order.java', ok: true, output: '아주 긴 파일 내용'.repeat(100) },
      { name: 'edit_file', summary: '수정 api/src/Order.java', ok: false, output: '실패 본문' },
    ],
  };
  const gate: ChatItem = {
    kind: 'gate',
    runId: 'r1',
    files: ['api/src/Order.java'],
    report: { ok: true, sync: { elapsedMs: 1 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [] },
  };
  const outcome: ChatItem = { kind: 'outcome', runId: 'r1', status: 'done', summary: '완료했습니다', turns: 2 };

  it('요청·답·게이트·실행 끝을 줄로 만들고, 도구는 호출 한 줄만 남긴다', () => {
    const lines = splitLines([request, tools, gate, reply, outcome]);
    expect(lines.map((line) => line.kind)).toEqual(['request', 'tool', 'tool', 'gate', 'reply', 'outcome']);
    expect(lines[1]).toMatchObject({ text: '완료 읽기 api/src/Order.java', tone: 'pass' });
    expect(lines[2]).toMatchObject({ text: '실패 수정 api/src/Order.java', tone: 'fail' });
    expect(lines[3]).toMatchObject({ text: '검증 게이트 통과', tone: 'pass' });
    // 도구 결과 본문은 넣지 않는다
    expect(lines.some((line) => line.text.includes('아주 긴 파일 내용'))).toBe(false);
    expect(lines.some((line) => line.text.includes('실패 본문'))).toBe(false);
  });

  it('되묻기로 끝난 실행은 취소가 아니라 답을 기다리는 줄로 보인다', () => {
    const asked: ChatItem = { kind: 'outcome', runId: 'r2', status: 'awaiting_input', summary: '어떤 형태로 만들까요?', turns: 1 };
    expect(splitLines([asked])).toMatchObject([{ kind: 'outcome', text: '답을 기다립니다 · 어떤 형태로 만들까요?', tone: 'wait' }]);
  });

  it('파일을 바꾸지 않은 실행은 "답만 했습니다"로 보인다 (대화 화면과 같은 규칙)', () => {
    const answered: ChatItem = { kind: 'outcome', runId: 'r3', status: 'done', summary: '이 함수는 이렇게 동작합니다', turns: 1 };
    expect(splitLines([answered])).toMatchObject([
      { kind: 'outcome', text: '답만 했습니다(바꾼 파일 없음), 1턴 · 이 함수는 이렇게 동작합니다', tone: 'pass' },
    ]);

    // 게이트를 돌았다면(파일을 바꿨다면) 지금처럼 완료로 보인다
    const withGate = splitLines([{ ...gate, runId: 'r3' }, answered]);
    expect(withGate.at(-1)!.text).toContain('완료, 1턴');
  });

  it('긴 줄은 줄이고, 최근 것만 남긴다', () => {
    const long: ChatItem = { kind: 'reply', runId: 'r1', text: 'x'.repeat(2_000) };
    expect(splitLines([long])[0]!.text.endsWith('…')).toBe(true);

    const many: ChatItem[] = Array.from({ length: 120 }, (_, index) => ({ kind: 'reply', runId: 'r1', text: `줄 ${index}` }));
    expect(splitLines(many)).toHaveLength(80);
    expect(splitLines(many).at(-1)!.text).toBe('줄 119');
  });
});

describe('localStorage', () => {
  it('저장소를 못 읽어도 빈 목록으로 동작하고, 저장 실패는 무시한다', () => {
    const broken = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
    };
    expect(readStoredSplitIds(broken)).toEqual([]);
    expect(() => storeSplitIds(broken, ['a'])).not.toThrow();
    expect(readStoredSplitIds(undefined)).toEqual([]);

    const store = new Map<string, string>();
    const fake = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    storeSplitIds(fake, ['a', 'b']);
    expect(store.get(SPLIT_STORAGE_KEY)).toBe('a,b');
    expect(readStoredSplitIds(fake)).toEqual(['a', 'b']);
  });
});
