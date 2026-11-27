import type { Totals } from './score';

const pct = (value: number | null) => (value === null ? '없음' : `${(value * 100).toFixed(1)}%`);

export function formatTotals(t: Totals): string {
  const lines = [
    `재현율: ${pct(t.recall)} (맞음 ${t.hits} / 기대 ${t.expected})`,
    `결함 없는 diff: ${t.cleanItems}개 중 지적 없이 통과 ${t.cleanPassed}개, 오탐 ${t.falsePositives}건`,
    `범위 밖 지적: ${t.outOfScope}건, diff에 없는 위치를 가리킨 지적: ${t.notInDiff}건`,
    `응답 못 읽음: ${t.unreadable}개(통과로 세지 않음)`,
  ];
  for (const [tag, v] of Object.entries(t.byTag)) lines.push(`  ${tag}: ${v.hits}/${v.expected}`);
  for (const [language, v] of Object.entries(t.byLanguage)) lines.push(`  ${language}: ${v.hits}/${v.expected}`);
  return `${lines.join('\n')}\n`;
}
