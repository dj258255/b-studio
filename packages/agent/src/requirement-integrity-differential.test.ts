import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Gen, readEnvList, readEnvNumber } from './differential-kit';
import * as old from './requirement-integrity-legacy';
import * as next from './requirement-integrity';

/**
 * 요구사항 검증 기록 무결성(ADR-191 3단계 3x)의 판정을 옮기기 전의 TS(`requirement-integrity-legacy.ts`)와 지금의 Rust 껍데기에 같은 무작위 문서 쌍을 넣어 견준다.
 * 비교하는 함수: diffVerificationRecords, hasVerificationTamper, describeVerificationTamper, describeRemovedVerifications, tamperedRequirementIds, restoreVerificationRecords, reviewRequirementRecords.
 * 결과는 JSON 글자(키 순서 포함)로 견준다. 짝 없는 서로게이트가 든 문서도 넣는다: 글자 그대로 같아야 한다(U+FFFD로 바뀌면 안 된다).
 *
 * **막는 검사라 방향을 센다.** 열린 쪽 뒤집힘은 "옛 TS는 위조·조작이 있다고 했는데 새 구현은 없다고 한 것"(hasVerificationTamper·리뷰 검사의 실패 검사)과
 * "옛 TS는 사람 확인이 지워졌다고 했는데 새 구현은 아니라고 한 것"이다. 0이어야 한다.
 *
 * 크기는 환경 변수로 바꾼다: REQ_INTEGRITY_DIFF_SEEDS(쉼표 목록), REQ_INTEGRITY_DIFF_N(시드마다), REQ_INTEGRITY_DIFF_REPORT=<파일 경로>
 */
const SEEDS = readEnvList('REQ_INTEGRITY_DIFF_SEEDS', [1, 7, 42, 2026]);
const N = readEnvNumber('REQ_INTEGRITY_DIFF_N', 1500);
const REPORT = process.env.REQ_INTEGRITY_DIFF_REPORT;

const BY = ['범수', 'agent', 'a b', '', '에이전트', 'x\ud800', 'x\ud801', 'x�', 'x', 'x', 'é', 'é', 'A', 'a'];
const AT = ['2026-10-01', '2026-10-02', '2026-1-1', '20261001', '2026-10-01T00:00:00Z', '2026-10-01 '];
const SHA = ['abc1234', 'ffff', 'a b', '', 'abc1234​', 'ABC1234', 'y\ud800', 'y�'];
const NOTE = ['화면에서 확인', '', '메모 속 · 점', 'x\ud800', 'x\ud801', 'x�', '  padded  ', 'n', 'a'];

function manualLine(g: Gen): string {
  const by = g.pick(BY);
  const at = g.pick(AT);
  const sha = g.pick(SHA);
  const note = g.pick(NOTE);
  const std = `- 확인: ${by} · ${at} · 체크포인트 ${sha} · 메모 ${note}`;
  return g.weighted<string>([
    [10, std],
    [1, `-확인: ${by} · ${at} · 체크포인트 ${sha} · 메모 ${note}`],
    [1, `-\t확인:\t${by} ·　${at} · 체크포인트\t${sha} · 메모 ${note}`],
    [1, `* 확인: ${by} · ${at} · 체크포인트 ${sha} · 메모 ${note}`],
    [1, ` ${std}`],
    [1, `- 확인: ${by} · ${at} · 체크포인트 ${sha}`],
    [1, `- 확인: ${by} · ${at} · 체크포인트${sha} · 메모 ${note}`],
    [1, `- 확인: ${by} - ${at} · 체크포인트 ${sha} · 메모 ${note}`],
    [1, `${std} `],
    [1, `${std} 　`],
    [1, `- 확인: ${by} · ${at} · 체크포인트 ${sha} · 메모 ${note} · 메모 중복`],
    [1, `- 확인: ${by} · ${at} · 체크포인트 ${sha} · 메모 ${note}﻿`],
  ]);
}

const JSON_SCALARS: unknown[] = ['abc', 'a\ud800', 'a\ud801', 'a', 'a', 7, 7.0, -0, 1e21, 1e-7, 0.1, true, false, null, '', ' '];

function jsonValue(g: Gen, depth = 0): unknown {
  const roll = g.int(10);
  if (depth < 2 && roll === 0) return g.list(0, 3, () => jsonValue(g, depth + 1));
  if (depth < 2 && roll === 1) return Object.fromEntries(g.list(0, 3, () => [g.pick(['a', 'b', '1', '0', 'by', 'z']), jsonValue(g, depth + 1)] as [string, unknown]));
  return g.pick(JSON_SCALARS);
}

function manualRecord(g: Gen): unknown {
  const roll = g.int(100);
  if (roll < 55) {
    const entry: Record<string, unknown> = {};
    for (const [key, pool] of [['by', BY], ['at', AT], ['sha', SHA], ['note', NOTE]] as const) {
      if (g.chance(0.9)) entry[key] = g.chance(0.12) ? jsonValue(g) : g.pick(pool);
    }
    if (g.chance(0.1)) entry.extra = jsonValue(g);
    return entry;
  }
  if (roll < 65) return g.pick(['str', 'x\ud800', '', 'a b']);
  if (roll < 70) return g.pick([5, 0, -0, 1.5, true, false]);
  if (roll < 80) return g.pick([[], [1, 2], [null], ['a'], [{ by: 'x' }]]);
  if (roll < 85) return {};
  if (roll < 90) return null;
  return jsonValue(g);
}

function fieldValue(g: Gen): unknown {
  return g.weighted<unknown>([
    [8, g.pick(['h1', 'h2', 'abc123'])],
    [2, g.pick(['2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'])],
    [1, g.pick(['h\ud800', 'h\ud801', 'h�', 'h'])],
    [1, g.pick([1, 2, 0, -0, 1e21])],
    [1, null],
    [1, g.pick([[], [1], {}, { a: 1 }])],
    [1, g.pick([true, false, ''])],
  ]);
}

interface Slot {
  present: boolean;
  lines: string[];
  item: Record<string, unknown> | undefined;
}

const IDS = ['R1', 'R2', 'R3', 'R4', 'R5'];

function makeSlot(g: Gen, id: string): Slot {
  const item: Record<string, unknown> | undefined = g.chance(0.75) ? { id } : undefined;
  if (item) {
    if (g.chance(0.6)) item.hash = fieldValue(g);
    if (g.chance(0.5)) item.revisedAt = fieldValue(g);
    if (g.chance(0.4)) item.manualVerification = manualRecord(g);
    if (g.chance(0.05)) item.title = '제목';
    if (g.chance(0.04)) Object.defineProperty(item, '__proto__', { value: { id: 'R9' }, enumerable: true, writable: true, configurable: true });
    if (g.chance(0.03)) item['\u0000a'] = 1;
    if (g.chance(0.03)) item['1'] = 'int key';
  }
  return { present: g.chance(0.85), lines: g.list(0, g.chance(0.1) ? 2 : 1, () => manualLine(g)).slice(0, g.chance(0.5) ? 1 : 2).filter(() => g.chance(0.55)), item };
}

interface DocSpec {
  slots: Map<string, Slot>;
  loose: string[];
  after: string[];
  jsonMode: 'none' | 'wrapper' | 'array' | 'invalid' | 'two' | 'noterm' | 'tight';
  extraItems: unknown[];
  nl: string;
  rawSurrogates: boolean;
}

function makeDoc(g: Gen, base?: DocSpec): DocSpec {
  const slots = new Map<string, Slot>();
  for (const id of IDS) {
    const prior = base?.slots.get(id);
    slots.set(id, prior && g.chance(0.75) ? { present: prior.present, lines: [...prior.lines], item: prior.item ? mutateItem(g, prior.item) : prior.item } : makeSlot(g, id));
  }
  const extraItems = base && g.chance(0.7) ? [...base.extraItems] : g.list(0, 2, () => g.pick<unknown>([null, 5, 'x', [], { id: 7 }, { id: 'R7', hash: 'q', manualVerification: manualRecord(g) }, { hash: 'x' }, { id: 'R1', manualVerification: manualRecord(g) }, { id: '' }]));
  return {
    slots,
    loose: base && g.chance(0.8) ? [...base.loose] : g.list(0, 2, () => (g.chance(0.6) ? manualLine(g) : '- 메모')),
    after: base && g.chance(0.8) ? [...base.after] : g.chance(0.5) ? ['', '## 가정', '- 하나', ...g.list(0, 1, () => manualLine(g))] : [],
    jsonMode: base && g.chance(0.75) ? base.jsonMode : g.weighted<DocSpec['jsonMode']>([[10, 'wrapper'], [3, 'array'], [1, 'invalid'], [1, 'two'], [1, 'noterm'], [2, 'none'], [1, 'tight']]),
    extraItems,
    nl: base && g.chance(0.9) ? base.nl : g.pick(['\n', '\n', '\r\n']),
    rawSurrogates: base ? base.rawSurrogates : g.chance(0.4),
  };
}

function mutateItem(g: Gen, item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(item)) Object.defineProperty(out, key, { value: item[key], enumerable: true, writable: true, configurable: true });
  const roll = g.int(100);
  if (roll < 12) out.hash = fieldValue(g);
  else if (roll < 22) delete out.hash;
  else if (roll < 30) out.revisedAt = fieldValue(g);
  else if (roll < 38) delete out.revisedAt;
  else if (roll < 50) out.manualVerification = manualRecord(g);
  else if (roll < 58) delete out.manualVerification;
  else if (roll < 62) out.hash = fieldValue(g);
  return Object.fromEntries(Object.entries(out)) as Record<string, unknown>;
}

function dumpJson(g: Gen, value: unknown, raw: boolean): string {
  let text = JSON.stringify(value, null, g.chance(0.7) ? 2 : undefined);
  if (raw) text = text.replace(/\\u(d[89ab][0-9a-f]{2}|d[c-f][0-9a-f]{2})/g, (_m, hex: string) => (g.chance(0.5) ? String.fromCharCode(parseInt(hex, 16)) : `\\u${hex}`));
  if (g.chance(0.08)) text = text.replace(/\\ue005/g, '');
  return text;
}

function render(g: Gen, doc: DocSpec): string {
  const lines: string[] = ['# 요구사항', '', ...doc.loose];
  const items: unknown[] = [];
  for (const id of IDS) {
    const slot = doc.slots.get(id)!;
    if (slot.present) {
      lines.push('', `## ${id}. 제목 ${id}`, '- 종류: api · 우선순위: must', '- 인수 조건:', '  - 조건', ...slot.lines, '- 상태: 미착수');
    }
    if (slot.item) items.push(slot.item);
  }
  lines.push(...doc.after);
  items.push(...doc.extraItems);
  let text = lines.join(doc.nl);
  const wrapper = { requirements: items, assumptions: [], manualSteps: [] };
  const block = (inner: string) => `<!-- b-studio-requirements\n${inner}\n-->`;
  switch (doc.jsonMode) {
    case 'wrapper':
      text += `${doc.nl}${doc.nl}${block(dumpJson(g, wrapper, doc.rawSurrogates))}${doc.nl}`;
      break;
    case 'array':
      text += `${doc.nl}${block(dumpJson(g, items, doc.rawSurrogates))}`;
      break;
    case 'invalid':
      text += `${doc.nl}${block(`${dumpJson(g, wrapper, false)},`)}`;
      break;
    case 'two':
      text += `${doc.nl}${block(dumpJson(g, wrapper, doc.rawSurrogates))}${doc.nl}${block(dumpJson(g, { requirements: [{ id: 'R1', hash: 'second' }] }, false))}`;
      break;
    case 'noterm':
      text += `${doc.nl}<!-- b-studio-requirements\n${dumpJson(g, wrapper, false)}`;
      break;
    case 'tight':
      text += `${doc.nl}<!--b-studio-requirements${dumpJson(g, wrapper, doc.rawSurrogates)}-->`;
      break;
    default:
  }
  return text;
}

type Outcome = { ok: true; json: string } | { ok: false };

function run(fn: () => unknown): Outcome {
  try {
    return { ok: true, json: JSON.stringify(fn()) ?? 'undefined' };
  } catch {
    return { ok: false };
  }
}

interface Tally {
  compared: number;
  different: number;
  /** 옛 TS는 위조·조작이 있다고 했는데 새 구현은 없다고 했다 */
  openFlips: number;
  /** 옛 TS는 사람 확인이 지워졌다고 했는데 새 구현은 아니라고 했다 */
  openRemovedFlips: number;
  closedFlips: number;
  threwBoth: number;
  examples: string[];
  distribution: Map<string, number>;
}
const tallies = new Map<string, Tally>();
function tally(name: string): Tally {
  let t = tallies.get(name);
  if (!t) tallies.set(name, (t = { compared: 0, different: 0, openFlips: 0, openRemovedFlips: 0, closedFlips: 0, threwBoth: 0, examples: [], distribution: new Map() }));
  return t;
}

function tamperOf(diff: unknown): boolean {
  const d = diff as { forged: unknown[]; tampered: unknown[] };
  return d.forged.length > 0 || d.tampered.length > 0;
}

function compareOne(t: Tally, label: string, a: Outcome, b: Outcome, doc: () => string): boolean {
  t.compared += 1;
  if (!a.ok && !b.ok) {
    t.threwBoth += 1;
    return true;
  }
  if (a.ok && b.ok && a.json === b.json) return true;
  t.different += 1;
  if (t.examples.length < 3) t.examples.push(`${label}\n${doc()}\n옛 ${JSON.stringify(a).slice(0, 700)}\n새 ${JSON.stringify(b).slice(0, 700)}`);
  return false;
}

function bump(t: Tally, key: string): void {
  t.distribution.set(key, (t.distribution.get(key) ?? 0) + 1);
}

function runPair(seed: number, count: number, weak?: (before: string | undefined, after: string | undefined) => boolean, name = '요구사항 검증 기록'): Tally {
  const t = tally(name);
  const g = new Gen(seed);
  for (let i = 0; i < count; i++) {
    const baseSpec = makeDoc(g);
    const afterSpec = makeDoc(g, baseSpec);
    let before: string | undefined = render(g, baseSpec);
    let after: string | undefined = render(g, afterSpec);
    const roll = g.int(100);
    if (roll < 4) before = undefined;
    else if (roll < 8) after = undefined;
    else if (roll < 10) after = before;
    const doc = () => `before=${JSON.stringify(before)}\nafter=${JSON.stringify(after)}`;

    const oldDiff = run(() => old.diffVerificationRecords(before, after));
    const newDiff = run(() => next.diffVerificationRecords(before, after));
    const same = compareOne(t, 'diffVerificationRecords', oldDiff, newDiff, doc);
    if (oldDiff.ok) {
      const diff = JSON.parse(oldDiff.json) as ReturnType<typeof old.diffVerificationRecords>;
      // diff 객체를 JSON을 거쳐 만들면 짝 없는 서로게이트가 이미 이스케이프를 거쳐 되살아난다(JSON.parse는 \ud800을 짝 없는 서로게이트로 읽는다)
      bump(t, tamperOf(diff) ? '위조·조작 있음' : diff.removed.length > 0 ? '삭제만' : '변화 없음');
      compareOne(t, 'hasVerificationTamper', run(() => old.hasVerificationTamper(diff)), run(() => next.hasVerificationTamper(diff)), doc);
      compareOne(t, 'describeVerificationTamper', run(() => old.describeVerificationTamper(diff)), run(() => next.describeVerificationTamper(diff)), doc);
      compareOne(t, 'describeRemovedVerifications', run(() => old.describeRemovedVerifications(diff)), run(() => next.describeRemovedVerifications(diff)), doc);
      compareOne(t, 'tamperedRequirementIds', run(() => old.tamperedRequirementIds(diff)), run(() => next.tamperedRequirementIds(diff)), doc);
    }
    if (oldDiff.ok && newDiff.ok) {
      const [x, y] = [tamperOf(JSON.parse(oldDiff.json)), tamperOf(JSON.parse(newDiff.json))];
      if (x && !y) t.openFlips += 1;
      if (!x && y) t.closedFlips += 1;
      const [xr, yr] = [(JSON.parse(oldDiff.json) as { removed: unknown[] }).removed.length > 0, (JSON.parse(newDiff.json) as { removed: unknown[] }).removed.length > 0];
      if (xr && !yr) t.openRemovedFlips += 1;
      if (weak && x && !weak(before, after)) t.openFlips += 1;
    }
    if (!weak) {
      const oldRestore = run(() => (after === undefined ? undefined : old.restoreVerificationRecords(before, after)));
      const newRestore = run(() => (after === undefined ? undefined : next.restoreVerificationRecords(before, after)));
      compareOne(t, 'restoreVerificationRecords', oldRestore, newRestore, doc);
      const oldReview = run(() => old.reviewRequirementRecords(before, after));
      const newReview = run(() => next.reviewRequirementRecords(before, after));
      compareOne(t, 'reviewRequirementRecords', oldReview, newReview, doc);
      if (oldReview.ok && newReview.ok) {
        const failing = (json: string) => (JSON.parse(json) as Array<{ ok: boolean }>).some((check) => !check.ok);
        if (failing(oldReview.json) && !failing(newReview.json)) t.openFlips += 1;
      }
      if (oldRestore.ok && newRestore.ok && after !== undefined && same) {
        const restored = (JSON.parse(newRestore.json) as string | null) ?? after;
        // 되돌린 문서는 실행 전 문서와 견줘 위조·조작이 없어야 한다(옛 구현이 그랬는지는 따로 세어 둔다)
        const left = next.diffVerificationRecords(before, restored);
        bump(t, left.forged.length > 0 ? '되돌린 뒤에도 위조 기록 남음' : left.tampered.length > 0 ? '되돌린 뒤에도 hash·revisedAt 조작 남음' : '되돌린 뒤 깨끗함');
        if (left.forged.length > 0 && process.env.REQ_INTEGRITY_LEFT) appendFileSync(process.env.REQ_INTEGRITY_LEFT, `${doc()}\n`);
      }
    }
  }
  return t;
}

describe('요구사항 검증 기록 무결성 차등 시험', () => {
  it('옛 TS와 같은 결과를 내고, 위조·조작이나 삭제를 없다고 뒤집지 않는다', () => {
    for (const seed of SEEDS) runPair(seed, N);
    const t = tally('요구사항 검증 기록');
    expect(t.examples).toEqual([]);
    expect(t.openFlips).toBe(0);
    expect(t.openRemovedFlips).toBe(0);
    expect(t.closedFlips).toBe(0);
    expect(t.different).toBe(0);
    // 입력이 비지 않았다: 위조·삭제·변화 없음이 모두 나온다
    expect(t.distribution.get('위조·조작 있음') ?? 0).toBeGreaterThan(t.compared / 40);
    expect(t.distribution.get('삭제만') ?? 0).toBeGreaterThan(0);
    expect(t.distribution.get('변화 없음') ?? 0).toBeGreaterThan(0);
  }, 60_000);

  it('대조 장치: hash·revisedAt 조작을 보지 않는 구현은 열린 쪽 뒤집힘으로 잡힌다', () => {
    let weakOpen = 0;
    for (const seed of SEEDS) {
      const g = new Gen(seed + 99);
      for (let i = 0; i < N; i++) {
        const baseSpec = makeDoc(g);
        const before = render(g, baseSpec);
        const after = render(g, makeDoc(g, baseSpec));
        const full = old.diffVerificationRecords(before, after);
        const weak = { ...full, tampered: [] };
        if (old.hasVerificationTamper(full) && !next.hasVerificationTamper(weak)) weakOpen += 1;
      }
    }
    expect(weakOpen).toBeGreaterThan(0);
  });

  it('대조 장치: 결과 글을 한 글자 바꾼 구현은 차이로 잡힌다', () => {
    const g = new Gen(5);
    let caught = 0;
    for (let i = 0; i < 300; i++) {
      const baseSpec = makeDoc(g);
      const before = render(g, baseSpec);
      const after = render(g, makeDoc(g, baseSpec));
      const a = run(() => old.reviewRequirementRecords(before, after));
      const b = run(() => next.reviewRequirementRecords(before, after).map((check) => (check.detail === undefined ? check : { ...check, detail: `${check.detail}\u0001` })));
      if (a.ok && b.ok && a.json !== b.json) caught += 1;
    }
    expect(caught).toBeGreaterThan(0);
  });

  it('결과를 보고한다', () => {
    const lines = [...tallies].map(
      ([name, t]) =>
        `[차등] ${name}: 비교 ${t.compared}, 다름 ${t.different}, 둘 다 던짐 ${t.threwBoth}, 열린 쪽 뒤집힘(위조→없음 ${t.openFlips}, 삭제→없음 ${t.openRemovedFlips}), 닫힌 쪽 뒤집힘 ${t.closedFlips}, 분포 ${JSON.stringify(Object.fromEntries(t.distribution))}`,
    );
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
    if (REPORT) appendFileSync(REPORT, `${lines.join('\n')}\n`);
    expect(lines.length).toBeGreaterThan(0);
  });
});
