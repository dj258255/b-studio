import { readFileSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentUsage } from '@b-studio/agent';
import { addTokens, periodKey, totalTokens, type UsageWindow } from '@/lib/usage';

/**
 * 사람별 모델 토큰 사용량. 세션 파일은 세션 하나만 담으므로, 사람 단위 합계는 서버 파일 한 곳에 모은다.
 * 요청을 처리하는 동안 여러 번 쓰므로 무효화 기록(auth-state)과 같은 방식으로 다룬다:
 * 파일이 바뀌었을 때만 다시 읽고, 쓰기는 임시 파일을 옮겨 바꾸며 차례로 한다
 */
const FILE = 'tokens.json';
/** 남겨 두는 기간 수. 지난 기간은 한도 판정에 쓰지 않지만 운영자가 확인할 수 있게 얼마간 둔다 */
const KEEP_PERIODS = 40;

export interface UsageRecord {
  version: 1;
  /** 기간 이름(2026-09-12 또는 2026-09) → 사람 → 사용량 */
  periods: Record<string, Record<string, AgentUsage>>;
}

const EMPTY: UsageRecord = { version: 1, periods: {} };

interface Cache {
  file: string;
  mtimeMs: number;
  size: number;
  value: UsageRecord;
}

const globalState = globalThis as typeof globalThis & { __bStudioUsage?: Cache; __bStudioUsageWrites?: Promise<unknown> };

export function usageStateDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.B_STUDIO_USAGE_DIR ?? path.join(homedir(), '.cache/b-studio/usage'));
}

/** 파일이 바뀌었을 때만 다시 읽는다. 파일이 없으면 쓴 사람이 없다. 읽을 수 없으면 던져, 한도가 조용히 사라지지 않게 한다 */
export function readUsage(dir = usageStateDir()): UsageRecord {
  const file = path.join(/*turbopackIgnore: true*/ dir, FILE);
  let stat;
  try {
    stat = statSync(/*turbopackIgnore: true*/ file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw new Error(`${file}을(를) 읽지 못했습니다: ${(error as Error).message}`);
  }
  const cached = globalState.__bStudioUsage;
  if (cached && cached.file === file && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;
  const value = parseUsage(readFileSync(/*turbopackIgnore: true*/ file, 'utf8'), file);
  globalState.__bStudioUsage = { file, mtimeMs: stat.mtimeMs, size: stat.size, value };
  return value;
}

function parseUsage(text: string, file: string): UsageRecord {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${file}을(를) 읽지 못했습니다: JSON이 아닙니다`);
  }
  const periods = (data as { periods?: unknown } | null)?.periods;
  if (periods === null || typeof periods !== 'object' || Array.isArray(periods)) {
    throw new Error(`${file}을(를) 읽지 못했습니다: periods가 객체여야 합니다`);
  }
  return { version: 1, periods: periods as UsageRecord['periods'] };
}

/** 이 기간에 그 사람이 쓴 양 */
export function userUsage(user: string, window: UsageWindow, at = new Date(), dir = usageStateDir()): AgentUsage | undefined {
  return readUsage(dir).periods[periodKey(window, at)]?.[user];
}

/** 이 기간에 그 사람이 쓴 토큰 수 */
export function userTokens(user: string, window: UsageWindow, at = new Date(), dir = usageStateDir()): number {
  return totalTokens(userUsage(user, window, at, dir));
}

/** 쓴 만큼 더하고 더한 뒤의 합계를 돌려준다. 데모 모드처럼 토큰을 쓰지 않는 실행은 부르지 않는다 */
export function addUserUsage(user: string, usage: AgentUsage, window: UsageWindow, at = new Date(), dir = usageStateDir()): Promise<AgentUsage> {
  const key = periodKey(window, at);
  const run = async (): Promise<AgentUsage> => {
    const current = readUsage(dir);
    const periods: UsageRecord['periods'] = { ...current.periods };
    const people = { ...(periods[key] ?? {}) };
    const total = addTokens(people[user], usage);
    people[user] = total;
    periods[key] = people;
    // 오래된 기간은 이름 순(날짜 순)으로 정리한다
    const kept = Object.keys(periods)
      .sort()
      .slice(-KEEP_PERIODS);
    const trimmed: UsageRecord['periods'] = {};
    for (const name of kept) trimmed[name] = periods[name]!;

    await mkdir(/*turbopackIgnore: true*/ dir, { recursive: true, mode: 0o700 });
    const file = path.join(/*turbopackIgnore: true*/ dir, FILE);
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(/*turbopackIgnore: true*/ temp, JSON.stringify({ version: 1, periods: trimmed }, null, 2), { mode: 0o600 });
    await rename(/*turbopackIgnore: true*/ temp, file);
    return total;
  };
  const result = (globalState.__bStudioUsageWrites ?? Promise.resolve()).then(run, run);
  globalState.__bStudioUsageWrites = result.catch(() => undefined);
  return result;
}
