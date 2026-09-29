/**
 * 벤치 결과(results.jsonl)의 모델 호출별 기록으로 "토큰이 어디서 나왔는지"를 조건마다 나눠 보여 준다.
 *
 *   pnpm bench:coordination:tokens <결과 폴더>...   (진입점: breakdown-cli.ts)
 *
 * 세션(레인·통합·P0)마다 대화가 따로라 고정 문맥도 세션마다 붙는다. 그래서 세션마다 나눈 뒤 더한다.
 * 호출별 기록(traces[].turns, plainTurns)이 없는 옛 결과는 건너뛰고 몇 행을 건너뛰었는지 알린다.
 */
import type { BenchRow } from './summary';
import { tokenBreakdown, type TokenBreakdown, type TurnRecord } from './turns';

export interface ConditionBreakdown {
  label: string;
  rows: number;
  successes: number;
  sessions: number;
  breakdown: TokenBreakdown;
}

export function emptyBreakdown(): TokenBreakdown {
  return { calls: 0, contextTotal: 0, output: 0, firstContext: 0, fixed: 0, outputReread: 0, toolReread: {}, toolResults: {}, clearedSaving: 0 };
}

/** 세션별 분해를 더한다. firstContext는 세션마다 다르므로 평균으로 둔다(fixed ÷ calls가 아니라 세션 평균) */
export function addBreakdown(total: TokenBreakdown, part: TokenBreakdown, sessionsBefore: number): TokenBreakdown {
  const toolReread = { ...total.toolReread };
  for (const [name, value] of Object.entries(part.toolReread)) toolReread[name] = (toolReread[name] ?? 0) + value;
  const toolResults: TokenBreakdown['toolResults'] = {};
  for (const [name, value] of Object.entries(total.toolResults)) toolResults[name] = { ...value };
  for (const [name, value] of Object.entries(part.toolResults)) {
    const entry = (toolResults[name] ??= { calls: 0, chars: 0 });
    entry.calls += value.calls;
    entry.chars += value.chars;
  }
  return {
    calls: total.calls + part.calls,
    contextTotal: total.contextTotal + part.contextTotal,
    output: total.output + part.output,
    firstContext: (total.firstContext * sessionsBefore + part.firstContext) / (sessionsBefore + 1),
    fixed: total.fixed + part.fixed,
    outputReread: total.outputReread + part.outputReread,
    toolReread,
    toolResults,
    clearedSaving: total.clearedSaving + part.clearedSaving,
  };
}

/** 한 행의 세션별 턴 기록. 레인 → 통합 → P0 순 */
export function rowSessions(row: BenchRow): TurnRecord[][] {
  const sessions: TurnRecord[][] = [];
  for (const trace of row.traces ?? []) if (trace.turns?.length) sessions.push(trace.turns);
  if (row.integrationTrace?.turns?.length) sessions.push(row.integrationTrace.turns);
  if (row.plainTurns?.length) sessions.push(row.plainTurns);
  return sessions;
}

export function conditionLabel(row: BenchRow): string {
  return row.verify === 'light' ? `${row.strategy} (light)` : row.strategy;
}

export function breakdownByCondition(rows: readonly BenchRow[]): { conditions: ConditionBreakdown[]; skipped: number } {
  const byLabel = new Map<string, ConditionBreakdown>();
  let skipped = 0;
  for (const row of rows) {
    const sessions = rowSessions(row);
    if (sessions.length === 0) {
      skipped += 1;
      continue;
    }
    const label = conditionLabel(row);
    const entry = byLabel.get(label) ?? { label, rows: 0, successes: 0, sessions: 0, breakdown: emptyBreakdown() };
    entry.rows += 1;
    if (row.success) entry.successes += 1;
    for (const turns of sessions) {
      entry.breakdown = addBreakdown(entry.breakdown, tokenBreakdown(turns), entry.sessions);
      entry.sessions += 1;
    }
    byLabel.set(label, entry);
  }
  return { conditions: [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label)), skipped };
}

const number = new Intl.NumberFormat('en-US');

function share(value: number, total: number): string {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '—';
}

export function breakdownMarkdown(conditions: readonly ConditionBreakdown[], skipped: number, topTools = 5): string {
  const lines: string[] = [];
  lines.push('| 조건 | 행(성공) | 세션 | 호출 | 문맥 합 | 고정 문맥 | 출력 재읽기 | 도구 결과 재읽기 | 비워서 줄어든 양 | 세션 첫 호출 문맥(평균) |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const { label, rows, successes, sessions, breakdown: b } of conditions) {
    const tools = Object.values(b.toolReread).reduce((sum, value) => sum + value, 0);
    lines.push(
      `| ${label} | ${rows} (${successes}) | ${sessions} | ${b.calls} | ${number.format(b.contextTotal)} | ${number.format(b.fixed)} (${share(b.fixed, b.contextTotal)}) | ${number.format(Math.round(b.outputReread))} (${share(b.outputReread, b.contextTotal)}) | ${number.format(Math.round(tools))} (${share(tools, b.contextTotal)}) | ${number.format(b.clearedSaving)} | ${number.format(Math.round(b.firstContext))} |`,
    );
  }
  lines.push('');
  lines.push(`도구별 결과 재읽기 (조건마다 상위 ${topTools}개)`);
  lines.push('');
  lines.push('| 조건 | 도구 | 호출 | 결과 글자 | 재읽기 토큰 | 문맥 합 대비 |');
  lines.push('|---|---|---|---|---|---|');
  for (const { label, breakdown: b } of conditions) {
    const ranked = Object.entries(b.toolReread).sort((x, y) => y[1] - x[1]).slice(0, topTools);
    for (const [name, value] of ranked) {
      const result = b.toolResults[name] ?? { calls: 0, chars: 0 };
      lines.push(`| ${label} | \`${name}\` | ${result.calls} | ${number.format(result.chars)} | ${number.format(value)} | ${share(value, b.contextTotal)} |`);
    }
  }
  if (skipped > 0) {
    lines.push('');
    lines.push(`호출별 기록이 없는 옛 결과 ${skipped}행은 건너뛰었습니다.`);
  }
  lines.push('');
  lines.push('고정 문맥 = 세션 첫 호출 문맥 × 호출 수. 재읽기 = 호출 뒤 늘어난 문맥 × 그 뒤 호출 수. 네 값(고정 + 출력 재읽기 + 도구 결과 재읽기 − 비워서 줄어든 양)을 더하면 문맥 합이 됩니다.');
  return lines.join('\n');
}
