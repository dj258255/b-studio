import { native } from '@b-studio/sandbox';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { StudioEvent } from '@/lib/studio-events';
import { SessionRecord, encodeEvent } from './session-record';
import { book, ledger, loadTable } from './frozen-vectors';

/**
 * 세션 기록(ADR-203, 4f B1a): Rust `SessionRecord`를 옛 TS 구현(`emit`의 버퍼 처리와 질의)이 같은 이벤트 열에 낸 값과 견준다.
 * 옛 구현이 낸 값의 열(`push` 결과와 매 질의의 결과)은 시험마다 장부 하나의 지문으로 `session-record-vectors.json`에 고정했다. 장부는 `undefined` 속성을 빼고 적는다(`toEqual`과 같다).
 * 시드 있는 무작위 열이고, 이벤트 종류를 섞고, 상한 경계(history 4,999·5,000·5,001, logs 999·1,000·1,001)와 `run_started`의 `request`가 없거나 글자가 아닌 경우,
 * 짝 없는 서로게이트, 예약 글자(U+E000~E01F), 유한하지 않은 수, 큰 이벤트를 넣는다.
 * 의도한 차이: 이벤트는 JSON 경계를 지나므로 `undefined` 속성이 사라진다(`toEqual`은 이를 같게 본다).
 */

const as = (event: unknown): StudioEvent => event as StudioEvent;

/** 시드 있는 난수(mulberry32) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEIRD_TEXTS = [
  'plain',
  '한글 요청',
  '짝 없는 앞 서로게이트 \ud83d 뒤',
  '짝 없는 뒤 서로게이트 \ude00 앞',
  '짝 있는 😀',
  '예약 글자  끝',
  '예약 모양  과 ',
  '제어 \u0000\u0001\n\t"\\ 글자',
  '  ',
  '',
];

const TYPES = ['login', 'logs', 'Log', 'log ', 'usage2', 'USAGE', 'run_finished', 'run_started_x', 'notice', 'status', 'service', 'snapshot', 'run_finished', 'agent', 'checkpoint', 'chat', 'restored', 'boot_network', 'model'];
const TRANSIENT = ['usage', 'sandbox_link', 'files_changed', 'tests_changed', 'deploy_log', 'label'];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

/** 이벤트 하나. 종류와 안의 값이 섞인다 */
function randomEvent(random: () => number, index: number, options: { big?: boolean } = {}): StudioEvent {
  const roll = random();
  const text = pick(random, WEIRD_TEXTS);
  if (roll < 0.22) return as({ type: 'log', service: pick(random, ['web', 'api', 'db']), text: `${text} ${index}`, at: '2026-01-01T00:00:00.000Z' });
  if (roll < 0.34) return as({ type: pick(random, TRANSIENT), index, text });
  if (roll < 0.46) {
    // run_started: request가 글자, 없음, 글자가 아님, null, 객체인 경우
    const base = { type: 'run_started', runId: `r${index}`, at: '2026-01-01T00:00:00.000Z' };
    const kind = Math.floor(random() * 7);
    if (kind === 0) return as(base);
    if (kind === 1) return as({ ...base, request: 5 });
    if (kind === 2) return as({ ...base, request: null });
    if (kind === 3) return as({ ...base, request: { nested: [text, 1] } });
    if (kind === 4) return as({ ...base, request: undefined });
    return as({ ...base, request: `${text} #${index}` });
  }
  if (roll < 0.5) return as({ type: pick(random, [5, null, true, undefined, ['log'], { type: 'log' }]), index });
  if (roll < 0.55) return as({ type: 'agent', runId: 'r', event: { type: 'tokens', value: pick(random, [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0, 1.5e300]) } });
  if (roll < 0.58) return as({ type: 'agent', runId: 'r', args: { '\u0000k': 1, '\u0000nfx': 2, 'a\ud800b': text }, ...(random() < 0.5 ? { [text]: index } : {}) });
  if (options.big && roll < 0.7) return as({ type: 'agent', runId: 'r', event: { type: 'tool_result', id: `t${index}`, content: `${text}${'x'.repeat(20_000)}${text}` } });
  return as({ type: pick(random, TYPES), index, text, nested: { list: [text, index, null, true], at: '2026-01-01T00:00:00.000Z' } });
}

let cases = 0;
let comparisons = 0;

const OLD = book(loadTable(new URL('./session-record-vectors.json', import.meta.url)));

interface Pair {
  record: SessionRecord;
  now: ReturnType<typeof ledger>;
}

const PENDING: Array<[string, Pair]> = [];
afterEach(() => {
  for (const [label, pair] of PENDING.splice(0)) finish(pair, label);
});

function newPair(label: string, logs = true): Pair {
  const pair: Pair = { record: new SessionRecord({ logs }), now: ledger() };
  PENDING.push([label, pair]);
  return pair;
}

/** 이 시험이 끝났을 때: 새 구현이 장부에 적은 값의 열이 옛 구현이 적은 열(고정한 지문)과 같다 */
function finish(pair: Pair, label: string): void {
  expect(pair.now.digest(), label).toBe(OLD.get(label));
}

/** 질의 결과를 장부에 적는다(옛 구현도 같은 차례로 적었다). `full`이면 전체 기록도 적는다 */
function expectSame(pair: Pair, full: boolean): void {
  const { record, now } = pair;
  comparisons += 1;
  now.add(record.lastRequest());
  now.add(record.tail(40));
  if (!full) return;
  now.add(record.history());
  now.add(record.logs());
  now.add(record.trimmedHistory());
  const length = record.history().length;
  for (const n of [1, 7, 500, length, length + 1]) if (n > 0) now.add(record.tail(n));
}

function pushBoth(pair: Pair, event: StudioEvent): void {
  pair.now.add(pair.record.push(event));
}

afterAll(() => {
  console.log(`[session-record 벡터] 사례 ${cases}개, 비교 ${comparisons}번`);
});

describe('세션 기록 벡터: 무작위 이벤트 열', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    it(`시드 ${seed}: 매 단계의 push 결과와 질의가 옛 구현과 같다`, () => {
      cases += 1;
      const random = rng(seed * 7919);
      const pair = newPair(`seed ${seed}`);
      const length = 80 + Math.floor(random() * 320);
      for (let i = 0; i < length; i += 1) {
        pushBoth(pair, randomEvent(random, i, { big: seed % 10 === 0 }));
        expectSame(pair, i % 40 === 39 || i === length - 1);
      }
    });
  }

  it('큰 이벤트(20KB 안팎)를 섞어도 같다', () => {
    cases += 1;
    const random = rng(424242);
    const pair = newPair('big events');
    for (let i = 0; i < 400; i += 1) {
      pushBoth(pair, randomEvent(random, i, { big: true }));
      if (i % 50 === 49) expectSame(pair, true);
    }
    expectSame(pair, true);
  });
});

describe('세션 기록 벡터: 상한 경계', () => {
  const notice = (i: number): StudioEvent => as({ type: 'notice', text: `n${i}`, at: 'a' });
  const logLine = (i: number): StudioEvent => as({ type: 'log', service: 'web', text: `l${i}`, at: 'a' });

  it('history는 4,999·5,000·5,001·5,002개째에 앞에서 잘린다', () => {
    cases += 1;
    const pair = newPair('cap history');
    const { record } = pair;
    for (let i = 1; i <= 5_003; i += 1) {
      pushBoth(pair, notice(i));
      if (i >= 4_999) expectSame(pair, true);
    }
    expect(record.history()).toHaveLength(5_000);
    expect(record.history()[0]).toEqual(notice(4));
  });

  it('logs는 999·1,000·1,001·1,002개째에 앞에서 잘리고 history는 그대로다', () => {
    cases += 1;
    const pair = newPair('cap logs');
    const { record } = pair;
    pushBoth(pair, notice(0));
    for (let i = 1; i <= 1_003; i += 1) {
      pushBoth(pair, logLine(i));
      if (i >= 999) expectSame(pair, true);
    }
    expect(record.logs()).toHaveLength(1_000);
    expect(record.history()).toHaveLength(1);
  });

  it('마지막 run_started가 상한에 밀려 나가면 마지막 요청이 사라진다(첫 run_started가 아니라)', () => {
    cases += 1;
    const pair = newPair('last request pushed out');
    const { record } = pair;
    pushBoth(pair, as({ type: 'run_started', runId: 'r1', request: '첫 요청', at: 'a' }));
    for (let i = 1; i <= 4_998; i += 1) pushBoth(pair, notice(i));
    pushBoth(pair, as({ type: 'run_started', runId: 'r2', request: '둘째 요청', at: 'a' }));
    expect(record.lastRequest()).toBe('둘째 요청');
    for (let i = 0; i < 4_999; i += 1) pushBoth(pair, notice(i));
    expectSame(pair, true);
    expect(record.lastRequest()).toBe('둘째 요청');
    pushBoth(pair, notice(0));
    expectSame(pair, true);
    expect(record.lastRequest()).toBeUndefined();
  });

  it('저장용 history는 저장하지 않는 종류를 빼고 끝 2,000개다(1,999·2,000·2,001·2,002)', () => {
    cases += 1;
    const pair = newPair('trimmed boundary');
    const { record } = pair;
    const mixed = (i: number): StudioEvent => (i % 3 === 0 ? as({ type: 'status', status: 'ready' }) : as({ type: 'notice', text: `n${i}`, at: 'a' }));
    let persisted = 0;
    for (let i = 0; i < 4_000 && persisted < 2_003; i += 1) {
      pushBoth(pair, mixed(i));
      if (i % 3 !== 0) persisted += 1;
      if (persisted >= 1_999) {
        pair.now.add(record.trimmedHistory());
      }
    }
    expect(record.trimmedHistory()).toHaveLength(2_000);
    expect(record.trimmedHistory().every((event) => event.type === 'notice')).toBe(true);
  });
});

describe('세션 기록 벡터: 기록을 바꾸는 쪽(이어받기·복구)', () => {
  it('replaceHistory와 덧붙이기 뒤의 상태가 같다(상한을 걸지 않고, 걸러 내지도 않는다)', () => {
    for (const seed of [3, 11, 29]) {
      cases += 1;
      const random = rng(seed);
      const stored = Array.from({ length: 150 + seed * 5 }, (_, i) => randomEvent(random, i));
      const pair = newPair(`replace ${seed}`);
      const { record } = pair;
      record.replaceHistory(stored);
      expectSame(pair, true);
      // 이어받기: 저장한 기록 뒤에 이벤트를 덧붙인다(`[...history, event]`)
      for (let i = 0; i < 4; i += 1) {
        const event = randomEvent(random, 1000 + i);
        record.append(event);
        expectSame(pair, true);
      }
      // 이어받은 뒤에는 emit이 쌓는다
      for (let i = 0; i < 60; i += 1) pushBoth(pair, randomEvent(random, 2000 + i));
      expectSame(pair, true);
    }
  });

  it('5,000개를 넘는 기록을 올려도 자르지 않고, 다음 push에서야 앞에서 잘린다', () => {
    cases += 1;
    const pair = newPair('replace over limit');
    const { record } = pair;
    const stored = Array.from({ length: 5_050 }, (_, i) => as({ type: 'notice', text: `s${i}`, at: 'a' }));
    record.replaceHistory(stored);
    expect(record.history()).toHaveLength(5_050);
    expectSame(pair, true);
    pushBoth(pair, as({ type: 'notice', text: 'next', at: 'a' }));
    expect(record.history()).toHaveLength(5_000);
    expectSame(pair, true);
  });

  it('replaceHistory는 앞의 기록과 마지막 요청을 버린다', () => {
    cases += 1;
    const pair = newPair('replace resets');
    const { record } = pair;
    pushBoth(pair, as({ type: 'run_started', runId: 'r', request: '옛 요청', at: 'a' }));
    const only = [as({ type: 'notice', text: 'x', at: 'a' })];
    record.replaceHistory(only);
    expectSame(pair, true);
    expect(record.lastRequest()).toBeUndefined();
  });

  it('기록하지 않는 종류와 log가 들어 있는 저장 기록도 그대로 올린다(저장 쪽이 걸러 낸다)', () => {
    cases += 1;
    const stored = [as({ type: 'usage', n: 1 }), as({ type: 'log', service: 's', text: 't', at: 'a' }), as({ type: 'label', label: 'x' }), as({ type: 'notice', text: 'y', at: 'a' })];
    const pair = newPair('replace unlogged');
    const { record } = pair;
    record.replaceHistory(stored);
    expectSame(pair, true);
    expect(record.logs()).toEqual([]);
    expect(record.trimmedHistory()).toEqual([stored[2], stored[3]]);
  });
});

describe('세션 기록: 보관 세션(logs 없음)', () => {
  it('logs가 없는 기록은 로그를 쌓지 않고 되감기에서도 logs를 보내지 않는다', () => {
    cases += 1;
    const record = new SessionRecord({ logs: false });
    expect(record.hasLogs()).toBe(false);
    expect(record.push(as({ type: 'log', service: 'web', text: 'x', at: 'a' }))).toBe(false);
    expect(record.logs()).toEqual([]);
    expect(record.history()).toEqual([]);
    expect(record.push(as({ type: 'notice', text: 'y', at: 'a' }))).toBe(true);
    expect(record.history()).toHaveLength(1);
    expect(new SessionRecord({ logs: true }).hasLogs()).toBe(true);
  });

  it('보관 세션 기록의 history·요약 질의는 일반 기록과 같다', () => {
    cases += 1;
    const random = rng(77);
    const events = Array.from({ length: 120 }, (_, i) => randomEvent(random, i)).filter((event) => event.type !== 'log');
    const archived = new SessionRecord({ logs: false, history: events });
    const live = new SessionRecord({ logs: true, history: events });
    expect(archived.history()).toEqual(live.history());
    expect(archived.lastRequest()).toEqual(live.lastRequest());
    expect(archived.tail(40)).toEqual(live.tail(40));
    expect(archived.trimmedHistory()).toEqual(live.trimmedHistory());
  });
});

describe('세션 기록: 경계의 글자', () => {
  it('짝 없는 서로게이트와 예약 글자가 든 요청을 그대로 돌려준다', () => {
    for (const request of WEIRD_TEXTS) {
      cases += 1;
      const pair = newPair(`weird ${request}`);
      const { record } = pair;
      pushBoth(pair, as({ type: 'run_started', runId: 'r', request, at: 'a' }));
      expect(record.lastRequest()).toBe(request);
      expectSame(pair, true);
    }
  });

  it('유한하지 않은 수와 -0을 되돌린다', () => {
    cases += 1;
    const pair = newPair('nonfinite');
    const { record } = pair;
    const event = as({ type: 'agent', runId: 'r', event: { type: 'tokens', values: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0] } });
    pushBoth(pair, event);
    const [back] = record.history() as unknown as Array<{ event: { values: number[] } }>;
    expect(Object.is(back!.event.values[0], Number.NaN)).toBe(true);
    expect(back!.event.values[1]).toBe(Number.POSITIVE_INFINITY);
    expect(back!.event.values[2]).toBe(Number.NEGATIVE_INFINITY);
    expect(Object.is(back!.event.values[3], -0)).toBe(true);
    expect(Object.is(back!.event.values[4], 0)).toBe(true);
  });

  it('NUL로 시작하는 키(모델이 도구 인자로 보낼 수 있다)도 쌓고 그대로 돌려준다. 표시 객체와 같은 키도 던지지 않는다', () => {
    cases += 1;
    const pair = newPair('nul keys');
    const { record } = pair;
    pushBoth(pair, as({ type: 'agent', runId: 'r', args: { '\u0000a': 1, '\u0000nfx': { '\u0000': 2 } } }));
    // 표시 객체와 같은 키(NUL + nf)도 보통 키로 쌓는다. 던지면 그 도구 호출이 기록에서 빠진다(커밋 보안 검토 지적)
    pushBoth(pair, as({ type: 'tool_call', name: 'write_file', input: { '\u0000nf': 'Infinity', '\u0000\u0000nf': '-0', n: Number.NaN } }));
    pushBoth(pair, as({ type: 'run_started', runId: 'r2', request: '요청', extra: { '\u0000nf': 'NaN' } }));
    expectSame(pair, true);
    const back = record.history() as unknown as Array<{ input?: Record<string, unknown>; extra?: Record<string, unknown> }>;
    expect(Object.keys(back[1]!.input!)).toEqual(['\u0000nf', '\u0000\u0000nf', 'n']);
    expect(back[1]!.input!['\u0000nf']).toBe('Infinity');
    expect(Object.is(back[1]!.input!.n, Number.NaN)).toBe(true);
    expect(back[2]!.extra).toEqual({ '\u0000nf': 'NaN' });
    expect(record.lastRequest()).toBe('요청');
  });

  it('저장해 둔 기록에 표시 객체와 같은 키가 있어도 replaceHistory(복구·이어받기)가 던지지 않는다', () => {
    cases += 1;
    const saved = [as({ type: 'run_started', runId: 'r', request: 'x' }), as({ type: 'tool_call', name: 'edit_file', input: { '\u0000nf': '-0' } })];
    const record = new SessionRecord({ logs: false, history: saved });
    expect(record.history()).toEqual(saved);
  });

  it('__proto__ 키와 NUL 키가 함께 있어도 객체의 원형을 바꾸지 않는다', () => {
    cases += 1;
    const record = new SessionRecord({ logs: true });
    const event = JSON.parse('{"type":"tool_call","input":{"__proto__":{"polluted":1},"\\u0000k":2}}') as StudioEvent;
    record.push(event);
    const [back] = record.history() as unknown as Array<{ input: Record<string, unknown> }>;
    expect(Object.getPrototypeOf(back!.input)).toBe(Object.prototype);
    expect(Object.keys(back!.input)).toEqual(['__proto__', '\u0000k']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('JSON으로 쓸 수 없는 이벤트는 던지고 아무것도 쌓지 않는다', () => {
    cases += 1;
    const record = new SessionRecord({ logs: true });
    expect(() => record.push(as({ type: 'notice', text: 1n }))).toThrow();
    const cycle: Record<string, unknown> = { type: 'notice' };
    cycle.self = cycle;
    expect(() => record.push(as(cycle))).toThrow();
    expect(record.history()).toEqual([]);
  });

  it('JSON이 아닌 글자는 던지고 아무것도 바꾸지 않는다(replaceHistory는 하나라도 틀리면 통째로 거절)', () => {
    cases += 1;
    const inner = new native.SessionRecord(true);
    inner.push('{"type":"notice","text":"a"}');
    expect(() => inner.push('{')).toThrow();
    expect(() => inner.append('nope')).toThrow();
    expect(() => inner.replaceHistory(['{"type":"notice","text":"b"}', '{'])).toThrow();
    expect(inner.history()).toBe('[{"type":"notice","text":"a"}]');
  });

  it('type이 글자가 아니거나 없는 이벤트(객체가 아닌 값 포함)는 보통 이벤트로 history에 쌓는다', () => {
    cases += 1;
    const inner = new native.SessionRecord(true);
    for (const text of ['{"type":5}', '{"type":null}', '{}', '[]', '"log"', '5', 'null', '{"type":["log"]}']) expect(inner.push(text)).toBe(true);
    expect(JSON.parse(inner.history())).toHaveLength(8);
    expect(inner.logs()).toBe('[]');
    expect(inner.lastRunStarted()).toBeNull();
  });

  it('JSON.stringify가 쓰지 않는 꼴(이스케이프한 키, 공백, 같은 키가 두 번)도 JSON.parse처럼 type을 읽는다', () => {
    cases += 1;
    const inner = new native.SessionRecord(true);
    expect(inner.push('{ "t\\u0079pe" : "log" , "text":"x" }')).toBe(false);
    expect(JSON.parse(inner.logs())).toHaveLength(1);
    expect(inner.push('{"type":"notice","type":"usage"}')).toBe(false);
    expect(inner.push('{"type":"usage","type":"notice"}')).toBe(true);
    expect(inner.push('{"type":"run\\u005fstarted","request":"r"}')).toBe(true);
    expect(inner.lastRunStarted()).toBe('{"type":"run\\u005fstarted","request":"r"}');
  });

  it('중첩이 아주 깊은 이벤트는 던지지 않고 보통 이벤트로 쌓는다', () => {
    cases += 1;
    const inner = new native.SessionRecord(true);
    const deep = `{"type":"notice","d":${'['.repeat(3_000)}${']'.repeat(3_000)}}`;
    expect(inner.push(deep)).toBe(true);
    expect(inner.history()).toBe(`[${deep}]`);
  });
});

describe('세션 기록: 이벤트 종류별 규칙', () => {
  it('기록하지 않는 종류는 쌓지 않고 저장을 예약하지 않는다', () => {
    cases += 1;
    const record = new SessionRecord({ logs: true });
    for (const type of ['usage', 'sandbox_link', 'files_changed', 'tests_changed', 'deploy_log', 'label']) {
      expect(record.push(as({ type }))).toBe(false);
    }
    expect(record.history()).toEqual([]);
    expect(record.logs()).toEqual([]);
  });

  it('log는 logs에만 쌓고 저장을 예약하지 않는다. 그 밖의 이벤트는 history에 쌓고 예약한다', () => {
    cases += 1;
    const record = new SessionRecord({ logs: true });
    expect(record.push(as({ type: 'log', service: 's', text: 't', at: 'a' }))).toBe(false);
    expect(record.logs()).toHaveLength(1);
    expect(record.history()).toHaveLength(0);
    expect(record.push(as({ type: 'status', status: 'ready' }))).toBe(true);
    expect(record.history()).toHaveLength(1);
    expect(record.logs()).toHaveLength(1);
  });

  it('encodeEvent는 JSON.stringify와 같다(유한하지 않은 수만 표시 객체)', () => {
    cases += 1;
    const event = as({ type: 'notice', text: '짝 없는 \ud800', at: 'a', n: 1 });
    expect(encodeEvent(event)).toBe(JSON.stringify(event));
  });
});
