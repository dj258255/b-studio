/**
 * 결과 파일 두 개(전·후)를 견준다. 같은 세트로 잰 결과끼리만 견준다 — 세트 해시가 다르면 비교하지 않고 이유를 돌려준다.
 * 프롬프트 해시·모델이 다른 것은 바꾼 것이니 막지 않고 그대로 보여 준다(그것이 비교하려는 대상이다).
 */
import type { EvalItemResult, EvalResult } from './run-core';

export interface ItemChange {
  id: string;
  before: string;
  after: string;
}

export interface Comparison {
  comparable: boolean;
  reason?: string;
  promptChanged: boolean;
  modelChanged: boolean;
  recall: { before: number | null; after: number | null; delta: number | null };
  hits: { before: number; after: number };
  expected: number;
  falsePositives: { before: number; after: number };
  outOfScope: { before: number; after: number };
  unreadable: { before: number; after: number };
  changed: ItemChange[];
}

function label(item: EvalItemResult | undefined): string {
  if (!item) return '없음';
  if (!item.readable) return '응답 못 읽음';
  if (item.clean) return item.findings === 0 ? '오탐 없음' : `오탐 ${item.findings}`;
  return `${item.expected.filter((e) => e.hit).length}/${item.expected.length} 맞음, 범위 밖 ${item.outOfScope}`;
}

export function compareResults(before: EvalResult, after: EvalResult): Comparison {
  const base: Comparison = {
    comparable: false,
    promptChanged: before.promptHash !== after.promptHash,
    modelChanged: before.model !== after.model || before.ask !== after.ask,
    recall: { before: before.totals.recall, after: after.totals.recall, delta: null },
    hits: { before: before.totals.hits, after: after.totals.hits },
    expected: after.totals.expected,
    falsePositives: { before: before.totals.falsePositives, after: after.totals.falsePositives },
    outOfScope: { before: before.totals.outOfScope, after: after.totals.outOfScope },
    unreadable: { before: before.totals.unreadable, after: after.totals.unreadable },
    changed: [],
  };
  if (before.evalSetHash !== after.evalSetHash) {
    return { ...base, reason: `평가 세트가 다릅니다(${before.evalSetHash} → ${after.evalSetHash}). 같은 세트로 잰 결과끼리만 비교합니다` };
  }
  const afterById = new Map(after.items.map((item) => [item.id, item]));
  const changed: ItemChange[] = [];
  for (const item of before.items) {
    const b = label(item);
    const a = label(afterById.get(item.id));
    if (a !== b) changed.push({ id: item.id, before: b, after: a });
  }
  const { before: rb, after: ra } = base.recall;
  return { ...base, comparable: true, recall: { before: rb, after: ra, delta: rb !== null && ra !== null ? ra - rb : null }, changed };
}

const pct = (value: number | null) => (value === null ? '없음' : `${(value * 100).toFixed(1)}%`);
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function formatComparison(c: Comparison): string {
  if (!c.comparable) return `비교할 수 없습니다: ${c.reason}\n`;
  const lines = [
    `재현율: ${pct(c.recall.before)} → ${pct(c.recall.after)} (맞음 ${c.hits.before} → ${c.hits.after} / 기대 ${c.expected})`,
    `오탐(결함 없는 diff의 지적): ${c.falsePositives.before} → ${c.falsePositives.after} (${signed(c.falsePositives.after - c.falsePositives.before)})`,
    `범위 밖 지적: ${c.outOfScope.before} → ${c.outOfScope.after} (${signed(c.outOfScope.after - c.outOfScope.before)})`,
    `응답 못 읽음: ${c.unreadable.before} → ${c.unreadable.after} (${signed(c.unreadable.after - c.unreadable.before)})`,
    `프롬프트: ${c.promptChanged ? '바뀜' : '같음'}, 모델·호출 방식: ${c.modelChanged ? '바뀜' : '같음'}`,
  ];
  if (c.changed.length === 0) lines.push('항목별로 달라진 것: 없음');
  else {
    lines.push('항목별로 달라진 것:');
    for (const item of c.changed) lines.push(`  ${item.id}: ${item.before} → ${item.after}`);
  }
  lines.push('한 번씩 잰 값이다. 같은 설정을 반복해 흔들림을 재기 전에는 작은 차이를 개선으로 읽지 않는다.');
  return `${lines.join('\n')}\n`;
}
