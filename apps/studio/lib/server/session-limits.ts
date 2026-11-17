import type { AgentUsage } from '@b-studio/agent';
import { native } from '@b-studio/sandbox';
import { hasTokens, parseUsageWindow, parseUserTokenLimit, totalTokens, type UsageWindow } from '@/lib/usage';
import { addUserUsageSync, userTokens } from './usage-state';

/**
 * 토큰 한도 판정(ADR-209, 4f B3c). 판정은 Rust `bstudio-session`의 `limits` 함수 하나(`native.judgeTokenLimit`)가 하고, 요청 시작·대화 실행 중·터미널 실행 중이
 * 모두 여기를 거쳐 그 함수를 부른다. 옛 TS 판정 셋은 `session-limits-legacy.ts`에 차등 시험의 기준으로만 남아 있다.
 *
 * 사람 몫 = 파일의 사람 합계 − 이 실행이 저장을 마친 몫 + 이 실행 누적. 이 실행의 원장(`RunLedger`)은 쓰기가 성공했을 때만 저장을 마친 몫을 늘린다.
 * 요청 시작은 실행이 없으므로 원장이 없다(누적 0, 저장 0).
 */

/** 사람 한도 설정. 한도를 정하지 않았거나 누가 보냈는지 모르면 없다. 설정이 잘못됐으면 던진다(오타가 조용히 "한도 없음"이 되지 않게) */
export interface UserLimitSetting {
  limit: number;
  window: UsageWindow;
}

export function userLimitSetting(by: string | undefined): UserLimitSetting | undefined {
  if (!by) return undefined;
  const limit = parseUserTokenLimit(process.env.B_STUDIO_USER_TOKEN_LIMIT);
  if (limit === undefined) return undefined;
  return { limit, window: parseUsageWindow(process.env.B_STUDIO_USER_TOKEN_WINDOW) };
}

/** 한 실행이 사람 몫에 더한 양(토큰 수). `accum`은 더하려 한 양, `saved`는 그중 파일에 쓰기가 끝난 양이다 */
export interface RunLedger {
  accum: number;
  saved: number;
}

export function newLedger(): RunLedger {
  return { accum: 0, saved: 0 };
}

/**
 * 사람 몫에 delta를 더한다(늘어난 것이 없으면 건너뛴다). 더하려 한 양은 먼저 원장의 누적에 넣고, 파일에 쓰기가 **성공한 뒤에만** 저장을 마친 몫에 넣는다.
 * 쓰지 못해도(잠금 시간 초과·읽을 수 없는 파일·쓰기 오류) 실행은 계속한다. 그 양은 누적에만 있어 한도 판정이 센다
 */
export function chargeUserUsage(by: string, delta: AgentUsage, window: UsageWindow, ledger?: RunLedger): boolean {
  if (!hasTokens(delta)) return true;
  const tokens = totalTokens(delta);
  if (ledger) ledger.accum += tokens;
  try {
    addUserUsageSync(by, delta, window);
    if (ledger) ledger.saved += tokens;
    return true;
  } catch (error) {
    console.error('[b-studio] 사람별 토큰 사용량을 기록하지 못했습니다', error);
    return false;
  }
}

/**
 * 앞서 쓰지 못한 몫(`chargeUserUsage`가 거짓을 돌려줬다)을 다시 쓴다(ADR-213, U1). 그 몫은 이미 그때 원장의 누적에 들어 있으므로 누적은 다시 늘리지 않고,
 * 쓰기가 성공했을 때만 저장을 마친 몫을 늘린다. 또 쓰지 못하면 거짓이다(부른 쪽이 계속 들고 있는다)
 */
export function retryUserUsage(by: string, delta: AgentUsage, window: UsageWindow, ledger?: RunLedger): boolean {
  if (!hasTokens(delta)) return true;
  try {
    addUserUsageSync(by, delta, window);
    if (ledger) ledger.saved += totalTokens(delta);
    return true;
  } catch (error) {
    console.error('[b-studio] 사람별 토큰 사용량을 다시 기록하지 못했습니다', error);
    return false;
  }
}

export interface LimitFacts {
  /** 세션 합계(이 실행을 반영한 값) */
  sessionTokens: number;
  sessionLimit?: number;
  /** 요청을 보낸(또는 세션 주인인) 사람 */
  by?: string;
  /** 이 실행의 원장. 요청 시작이면 없다 */
  ledger?: RunLedger;
}

/**
 * 한도 판정. 세션 한도가 먼저이고(그때는 파일을 읽지 않는다), 사람 한도는 파일의 사람 합계를 읽어 본다.
 * 사람별 사용량 파일을 읽을 수 없으면 던진다 — 한도가 조용히 꺼지지 않게 한다. 실행 중에는 `judgeRunLimits`가 이 오류를 멈춤으로 바꾼다
 */
export function judgeLimits(facts: LimitFacts, at = new Date()): 'ok' | 'session' | 'user' {
  const { sessionTokens, sessionLimit } = facts;
  if (native.judgeTokenLimit(sessionTokens, sessionLimit, undefined, 0, 0, 0) === 'session') return 'session';
  const setting = userLimitSetting(facts.by);
  if (!setting || !facts.by) return 'ok';
  const fileTotal = userTokens(facts.by, setting.window, at);
  return native.judgeTokenLimit(sessionTokens, sessionLimit, setting.limit, fileTotal, facts.ledger?.saved ?? 0, facts.ledger?.accum ?? 0);
}

export type RunLimitVerdict = 'ok' | 'session' | 'user' | 'usage_unreadable';

/**
 * 실행 중의 판정. 사용량 파일을 읽을 수 없어 판정하지 못하면 `usage_unreadable`이다: 러너로 던지지 않고(던지면 실행이 이상하게 끝난다),
 * 한도가 있는데 확인하지 못했으므로 계속하지 않고 멈추는 쪽으로 처리한다
 */
export function judgeRunLimits(facts: LimitFacts): RunLimitVerdict {
  try {
    return judgeLimits(facts);
  } catch (error) {
    console.error('[b-studio] 사람별 토큰 한도를 판정하지 못했습니다', error);
    return 'usage_unreadable';
  }
}
