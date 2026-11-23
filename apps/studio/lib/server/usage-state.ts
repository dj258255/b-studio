import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentUsage } from '@b-studio/agent';
import { native } from '@b-studio/sandbox';
import { periodKey, totalTokens, type UsageWindow } from '@/lib/usage';

/**
 * 사람별 모델 토큰 사용량(`tokens.json`). 세션 파일은 세션 하나만 담으므로, 사람 단위 합계는 서버 파일 한 곳에 모은다.
 * **파일의 주인은 Rust 하나다**(ADR-209, 4f B3c: `crates/bstudio-session`의 `usage`). 읽기(바뀌었을 때만)·더하기(프로세스 안 차례 + 프로세스 사이 파일 잠금,
 * 임시 파일·rename)·오래된 기간 정리(40개)를 그쪽이 하고, 여기는 기간 이름(`periodKey`)을 정해 부르는 껍데기다. 옛 TS 구현은 #1347에서 지웠다.
 * 차등 시험의 기준으로만 남아 있다. 읽을 수 없으면 던져 한도가 조용히 사라지지 않게 한다. 잠금을 얻지 못하면 쓰지 않고 던진다
 */

export interface UsageRecord {
  version: 1;
  /** 기간 이름(2026-09-12 또는 2026-09) → 사람 → 사용량 */
  periods: Record<string, Record<string, AgentUsage>>;
}

export function usageStateDir(): string {
  return path.resolve(process.env.B_STUDIO_USAGE_DIR ?? path.join(homedir(), '.cache/b-studio/usage'));
}

/** 파일이 없으면 쓴 사람이 없다. 읽을 수 없으면 던진다 */
export function readUsage(dir = usageStateDir()): UsageRecord {
  return JSON.parse(native.usageReadJson(dir)) as UsageRecord;
}

/** 이 기간에 그 사람이 쓴 양 */
export function userUsage(user: string, window: UsageWindow, at = new Date(), dir = usageStateDir()): AgentUsage | undefined {
  return native.usageUserUsage(dir, periodKey(window, at), user) ?? undefined;
}

/** 이 기간에 그 사람이 쓴 토큰 수 */
export function userTokens(user: string, window: UsageWindow, at = new Date(), dir = usageStateDir()): number {
  return totalTokens(userUsage(user, window, at, dir));
}

/**
 * 쓴 만큼 더하고 더한 뒤의 합계를 돌려준다. 돌아왔다는 것은 파일에 쓰였다는 뜻이다(이 스레드에서 끝난다 — 저장이 끝난 몫을 늘리는 쪽이 사이에 낀 판정 없이 이어서 센다).
 * 잠금을 얻지 못했거나 파일을 읽을 수 없거나 쓰지 못하면 던진다. 데모 모드처럼 토큰을 쓰지 않는 실행은 부르지 않는다
 */
export function addUserUsageSync(user: string, usage: AgentUsage, window: UsageWindow, at = new Date(), dir = usageStateDir()): AgentUsage {
  return native.usageAdd(dir, periodKey(window, at), user, usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens);
}

/** `addUserUsageSync`의 Promise 판(옛 호출 모양) */
export async function addUserUsage(user: string, usage: AgentUsage, window: UsageWindow, at = new Date(), dir = usageStateDir()): Promise<AgentUsage> {
  return addUserUsageSync(user, usage, window, at, dir);
}
