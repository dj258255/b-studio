import { describe, expect, it } from 'vitest';
import type { ChatItem } from './session-view';
import {
  formatElapsed,
  MAX_SPLIT,
  nextSplitIds,
  paneState,
  parseSplitIds,
  readStoredSplitIds,
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
  it('준비 중·작업 중·대기·오류·중지됨을 가른다', () => {
    expect(paneState({ status: 'starting', running: false })).toEqual({ tone: 'wait', label: '준비 중' });
    expect(paneState({ status: 'ready', running: true })).toEqual({ tone: 'wait', label: '작업 중' });
    expect(paneState({ status: 'ready', running: false })).toEqual({ tone: 'pass', label: '대기' });
    expect(paneState({ status: 'failed', running: false }).tone).toBe('fail');
    expect(paneState({ status: 'stopped', running: false }).label).toBe('중지됨');
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
