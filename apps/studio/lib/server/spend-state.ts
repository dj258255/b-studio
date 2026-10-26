/**
 * 날마다 CLI·모델별로 쓴 토큰과 비용(#925). 터미널 작업대의 사용량 화면이 "오늘·최근 7일"을 보인다.
 *
 * 세션 합계에 더한 터미널 사용량(텔레메트리 요청 하나)마다 하나씩 더한다. 기록 화면용이라 한도 판정에는 쓰지 않고,
 * 파일을 읽지 못하거나 쓰지 못해도 실행을 막지 않는다. 요청마다 파일을 쓰지 않게 메모리에 모아 잠시 뒤 한 번에 쓴다.
 *
 * 비용은 두 가지를 가른다.
 *  - CLI가 알린 비용(Claude Code의 cost_usd): 그 모델 줄의 호출 전부에 실려 왔을 때만 그대로 쓴다.
 *  - 단가 표로 낸 추정(Codex처럼 비용을 알리지 않는 CLI): 단가(B_STUDIO_TOKEN_PRICES_JSON 등)가 있을 때만 내고 추정이라고 표시한다.
 *    단가가 없으면 비용을 지어내지 않고 "단가 없음"으로 둔다. 그런 줄이 하나라도 있으면 합계 비용도 내지 않는다.
 */
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentUsage } from '@b-studio/agent';
import { estimateCostUsd, matchTokenPrices } from '../token-types';
import type { TokenPricing } from './token-report';
import { usageStateDir } from './usage-state';

const FILE = 'spend.json';
/** 남겨 두는 날 수 */
const KEEP_DAYS = 35;
/** "최근 7일"의 날 수(오늘 포함) */
const WEEK_DAYS = 7;
/** 모아 두었다가 파일에 쓰기까지 기다리는 시간 */
const FLUSH_MS = 2_000;

export interface SpendEntry {
  usage: AgentUsage;
  calls: number;
  /** CLI가 알린 비용의 합. 하나도 받지 않았으면 없다 */
  cliCostUsd?: number;
  /** 비용이 실려 온 호출 수 */
  cliCostCalls?: number;
}

export interface SpendRecord {
  version: 1;
  /** 날(YYYY-MM-DD, 이 컴퓨터 시각) → CLI → 모델 → 합계 */
  days: Record<string, Record<string, Record<string, SpendEntry>>>;
}

export interface SpendInput {
  /** 모델 요청 시각(밀리초) */
  at: number;
  backend: string;
  model: string;
  usage: AgentUsage;
  costUsd?: number;
}

export interface SpendRow {
  backend: string;
  model: string;
  tokens: number;
  usage: AgentUsage;
  calls: number;
  costUsd?: number;
  /** 비용이 단가 표로 낸 추정이다 */
  estimated: boolean;
}

export interface SpendTotals {
  tokens: number;
  /** 비용의 합. 단가가 없어 모르는 줄이 하나라도 있으면 없다 */
  costUsd?: number;
  /** 합에 추정이 섞였다 */
  estimated: boolean;
  /** 단가가 없어 비용을 모르는 줄이 있다 */
  missingPrice: boolean;
  /** 토큰이 많은 줄부터 */
  rows: SpendRow[];
}

export interface SpendSummary {
  today: SpendTotals;
  week: SpendTotals;
  /** 단가 표를 읽지 못한 까닭 */
  priceError?: string;
}

const EMPTY: SpendRecord = { version: 1, days: {} };

function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function plus(base: AgentUsage, usage: AgentUsage): AgentUsage {
  return {
    inputTokens: base.inputTokens + usage.inputTokens,
    outputTokens: base.outputTokens + usage.outputTokens,
    cacheReadTokens: base.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + usage.cacheWriteTokens,
  };
}

function tokensOf(usage: AgentUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** 이 컴퓨터 시각의 날 이름 */
export function dayKey(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/** 요청 하나를 더한 새 기록. 오래된 날은 지운다 */
export function addSpend(record: SpendRecord, input: SpendInput): SpendRecord {
  const key = dayKey(new Date(input.at));
  const day = { ...(record.days[key] ?? {}) };
  const models = { ...(day[input.backend] ?? {}) };
  const before = models[input.model];
  const entry: SpendEntry = { usage: plus(before?.usage ?? emptyUsage(), input.usage), calls: (before?.calls ?? 0) + 1 };
  if (before?.cliCostUsd !== undefined || input.costUsd !== undefined) {
    entry.cliCostUsd = (before?.cliCostUsd ?? 0) + (input.costUsd ?? 0);
    entry.cliCostCalls = (before?.cliCostCalls ?? 0) + (input.costUsd !== undefined ? 1 : 0);
  }
  models[input.model] = entry;
  day[input.backend] = models;
  const days: SpendRecord['days'] = { ...record.days, [key]: day };
  const kept: SpendRecord['days'] = {};
  for (const name of Object.keys(days).sort().slice(-KEEP_DAYS)) kept[name] = days[name]!;
  return { version: 1, days: kept };
}

function rowOf(backend: string, model: string, entry: SpendEntry, pricing: TokenPricing): SpendRow {
  const row: SpendRow = { backend, model, tokens: tokensOf(entry.usage), usage: entry.usage, calls: entry.calls, estimated: false };
  if (entry.cliCostUsd !== undefined && entry.cliCostCalls === entry.calls) return { ...row, costUsd: entry.cliCostUsd };
  const prices = pricing.error ? undefined : ((pricing.byModel ? matchTokenPrices(pricing.byModel, model) : undefined) ?? pricing.single);
  if (prices) return { ...row, costUsd: estimateCostUsd(entry.usage, prices), estimated: true };
  // 일부 호출에만 비용이 실려 왔다: 아는 만큼만 적고 추정으로 둔다
  if (entry.cliCostUsd !== undefined) return { ...row, costUsd: entry.cliCostUsd, estimated: true };
  return row;
}

function totalsOf(record: SpendRecord, keys: readonly string[], pricing: TokenPricing): SpendTotals {
  const merged = new Map<string, { backend: string; model: string; entry: SpendEntry }>();
  for (const key of keys) {
    for (const [backend, models] of Object.entries(record.days[key] ?? {})) {
      for (const [model, entry] of Object.entries(models)) {
        const id = `${backend}\0${model}`;
        const before = merged.get(id)?.entry;
        const next: SpendEntry = { usage: plus(before?.usage ?? emptyUsage(), entry.usage), calls: (before?.calls ?? 0) + entry.calls };
        if (before?.cliCostUsd !== undefined || entry.cliCostUsd !== undefined) {
          next.cliCostUsd = (before?.cliCostUsd ?? 0) + (entry.cliCostUsd ?? 0);
          next.cliCostCalls = (before?.cliCostCalls ?? 0) + (entry.cliCostCalls ?? 0);
        }
        merged.set(id, { backend, model, entry: next });
      }
    }
  }
  const rows = [...merged.values()].map(({ backend, model, entry }) => rowOf(backend, model, entry, pricing)).filter((row) => row.tokens > 0);
  rows.sort((a, b) => b.tokens - a.tokens || a.backend.localeCompare(b.backend) || a.model.localeCompare(b.model));
  const known = rows.filter((row) => row.costUsd !== undefined);
  const totals: SpendTotals = {
    tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    estimated: known.some((row) => row.estimated),
    missingPrice: rows.some((row) => row.costUsd === undefined),
    rows,
  };
  // 단가가 없는 줄이 하나라도 있으면 합계 비용은 내지 않는다. 일부만 더한 합계는 실제보다 싸 보인다(토큰 보고서와 같은 규칙)
  if (known.length && !totals.missingPrice) totals.costUsd = known.reduce((sum, row) => sum + row.costUsd!, 0);
  return totals;
}

/** 오늘과 최근 7일(오늘 포함) */
export function summarizeSpend(record: SpendRecord, now: number, pricing: TokenPricing): SpendSummary {
  const week: string[] = [];
  for (let back = 0; back < WEEK_DAYS; back++) {
    const date = new Date(now);
    date.setDate(date.getDate() - back);
    week.push(dayKey(date));
  }
  return { today: totalsOf(record, week.slice(0, 1), pricing), week: totalsOf(record, week, pricing), ...(pricing.error ? { priceError: pricing.error } : {}) };
}

function parseRecord(text: string): SpendRecord {
  try {
    const days = (JSON.parse(text) as { days?: unknown } | null)?.days;
    if (days && typeof days === 'object' && !Array.isArray(days)) return { version: 1, days: days as SpendRecord['days'] };
  } catch {
    // 깨진 파일: 비운 채 시작한다
  }
  return EMPTY;
}

export interface SpendStore {
  note(input: SpendInput): void;
  read(): SpendRecord;
  /** 모아 둔 것을 지금 쓴다 */
  flush(): Promise<void>;
}

/** 폴더 하나의 기록. 처음 읽을 때 파일에서 되살리고, 더한 것은 flushMs 뒤 한 번에 쓴다 */
export function createSpendStore(dir: string, options: { flushMs?: number } = {}): SpendStore {
  const file = path.join(dir, FILE);
  let record: SpendRecord | undefined;
  let timer: NodeJS.Timeout | undefined;
  let writing: Promise<void> = Promise.resolve();
  const load = (): SpendRecord => {
    if (record) return record;
    try {
      record = parseRecord(readFileSync(file, 'utf8'));
    } catch {
      record = EMPTY;
    }
    return record;
  };
  const write = async (): Promise<void> => {
    timer = undefined;
    const snapshot = load();
    const run = async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, JSON.stringify(snapshot), { mode: 0o600 });
      await rename(temp, file);
    };
    writing = writing.then(run, run).catch((error: unknown) => {
      console.error('[b-studio] 날마다의 토큰 기록을 쓰지 못했습니다', error);
    });
    await writing;
  };
  return {
    note(input) {
      record = addSpend(load(), input);
      if (timer) return;
      timer = setTimeout(() => void write(), options.flushMs ?? FLUSH_MS);
      timer.unref?.();
    },
    read: load,
    async flush() {
      if (timer) clearTimeout(timer);
      await write();
    },
  };
}

const GLOBAL_KEY = Symbol.for('b-studio.spend-state');

/** 스튜디오 프로세스에 하나(사람별 토큰 기록과 같은 폴더) */
export function spendStore(): SpendStore {
  const holder = globalThis as unknown as Record<symbol, SpendStore | undefined>;
  holder[GLOBAL_KEY] ??= createSpendStore(usageStateDir());
  return holder[GLOBAL_KEY];
}
