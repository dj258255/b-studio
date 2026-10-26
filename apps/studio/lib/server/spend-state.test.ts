import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addSpend, createSpendStore, dayKey, summarizeSpend, type SpendRecord } from './spend-state';

const usage = (input: number, output = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 });
const at = (iso: string) => new Date(iso).getTime();
const EMPTY: SpendRecord = { version: 1, days: {} };

describe('addSpend', () => {
  it('날마다 CLI·모델별로 토큰·호출 수·CLI가 알린 비용을 더한다', () => {
    let record = addSpend(EMPTY, { at: at('2026-10-26T09:00:00'), backend: 'claude-code', model: 'claude-opus-5-5', usage: usage(100, 10), costUsd: 0.5 });
    record = addSpend(record, { at: at('2026-10-26T10:00:00'), backend: 'claude-code', model: 'claude-opus-5-5', usage: usage(50), costUsd: 0.25 });
    record = addSpend(record, { at: at('2026-10-26T10:00:00'), backend: 'codex', model: 'gpt-5.5', usage: usage(70) });
    const day = record.days['2026-10-26']!;
    expect(day['claude-code']!['claude-opus-5-5']).toEqual({ usage: usage(150, 10), calls: 2, cliCostUsd: 0.75, cliCostCalls: 2 });
    expect(day.codex!['gpt-5.5']).toEqual({ usage: usage(70), calls: 1 });
    expect(EMPTY.days).toEqual({});
  });

  it('35일보다 오래된 날은 지운다', () => {
    let record = EMPTY;
    for (let day = 1; day <= 40; day++) record = addSpend(record, { at: new Date(2026, 8, day, 12).getTime(), backend: 'codex', model: 'm', usage: usage(1) });
    const days = Object.keys(record.days).sort();
    expect(days).toHaveLength(35);
    expect(days[0]).toBe(dayKey(new Date(2026, 8, 6, 12)));
  });
});

describe('summarizeSpend', () => {
  const record = [
    { at: at('2026-10-26T09:00:00'), backend: 'claude-code', model: 'claude-opus-5-5', usage: usage(1_000_000), costUsd: 3 },
    { at: at('2026-10-26T11:00:00'), backend: 'codex', model: 'gpt-5.5', usage: usage(2_000_000) },
    { at: at('2026-10-22T11:00:00'), backend: 'codex', model: 'gpt-5.5', usage: usage(1_000_000) },
    { at: at('2026-10-10T11:00:00'), backend: 'codex', model: 'gpt-5.5', usage: usage(9_000_000) },
  ].reduce(addSpend, EMPTY);
  const now = at('2026-10-26T12:00:00');

  it('오늘과 최근 7일을 모으고 토큰이 많은 줄부터 보인다. CLI가 알린 비용은 추정이 아니다', () => {
    const summary = summarizeSpend(record, now, { byModel: { 'gpt-5.5': { inputPerM: 1, outputPerM: 0, cacheReadPerM: 0, cacheWritePerM: 0 } } });
    expect(summary.today.tokens).toBe(3_000_000);
    expect(summary.today.rows.map((row) => [row.backend, row.tokens, row.costUsd, row.estimated])).toEqual([
      ['codex', 2_000_000, 2, true],
      ['claude-code', 1_000_000, 3, false],
    ]);
    expect(summary.today.costUsd).toBe(5);
    expect(summary.today.estimated).toBe(true);
    expect(summary.week.tokens).toBe(4_000_000);
    expect(summary.week.costUsd).toBe(6);
  });

  it('단가가 없으면 비용을 지어내지 않고 단가 없음으로 둔다. 그런 줄이 있으면 합계 비용도 내지 않는다', () => {
    const summary = summarizeSpend(record, now, {});
    const codex = summary.today.rows.find((row) => row.backend === 'codex')!;
    const claude = summary.today.rows.find((row) => row.backend === 'claude-code')!;
    expect(codex.costUsd).toBeUndefined();
    expect(claude.costUsd).toBe(3);
    expect(summary.today.missingPrice).toBe(true);
    expect(summary.today.costUsd).toBeUndefined();
  });

  it('기록이 없으면 0이다', () => {
    const summary = summarizeSpend(EMPTY, now, {});
    expect(summary.today).toEqual({ tokens: 0, estimated: false, missingPrice: false, rows: [] });
  });
});

describe('createSpendStore', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('더한 것을 모아 파일에 쓰고, 새 저장소가 파일에서 되살린다', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'spend-'));
    const store = createSpendStore(dir, { flushMs: 0 });
    store.note({ at: at('2026-10-26T09:00:00'), backend: 'codex', model: 'gpt-5.5', usage: usage(5) });
    await store.flush();
    const saved = JSON.parse(await readFile(path.join(dir, 'spend.json'), 'utf8')) as SpendRecord;
    expect(saved.days['2026-10-26']!.codex!['gpt-5.5']!.calls).toBe(1);
    expect(createSpendStore(dir).read().days['2026-10-26']!.codex!['gpt-5.5']!.usage.inputTokens).toBe(5);
  });

  it('깨진 파일은 비운 채 시작한다(기록 화면용이라 실행을 막지 않는다)', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'spend-'));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, 'spend.json'), '{oops');
    expect(createSpendStore(dir).read()).toEqual(EMPTY);
  });
});
