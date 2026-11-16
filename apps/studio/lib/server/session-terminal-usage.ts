import { native } from '@b-studio/sandbox';

/**
 * 세션 터미널의 사용량 귀속·정체 판정(ADR-213, 4f B4d). 판정은 Rust `crates/bstudio-session`의 `terminal::usage`가 한다(순수 함수).
 * 여기는 사실을 코어에 넘기고 결정을 TS 값으로 돌려주는 껍데기다. 기억(Set)·저장·알림·글 조립은 `sessions.ts`가 한다.
 * 옛 판정은 `session-terminal-usage-legacy.ts`에 차등 시험의 기준으로만 남아 있다.
 *
 * 막는 검사다. 덜 세는 쪽이 여는 쪽이므로, 코어가 알아보지 못한 결정은 센다(귀속 없이 세션 합계와 한도에 더한다).
 */

export interface UsageFacts {
  /** 요청 번호가 있다 */
  hasRequestId: boolean;
  /** 한도 계산용으로 이 번호를 이미 셌다 */
  counted: boolean;
  /** 실행 귀속용으로 이 번호를 이미 붙였다 */
  attached: boolean;
  /** 열린 터미널 실행이 있다 */
  openRun: boolean;
  /** 요청 시각이 열린 실행의 시작 이후다 */
  inOpenWindow: boolean;
  /** 요청 시각이 열린 실행의 시작보다 EARLY_USAGE_MS 안에 앞선다 */
  inEarlySlack: boolean;
  /** 열린 실행을 요청 훅이 아니라 도구 호출이 열었다 */
  openedByTool: boolean;
  /** 요청 시각이 가장 최근에 닫힌 실행의 시작과 끝 사이다 */
  inClosedRun: boolean;
  /** 요청 시각이 그 실행의 끝보다 뒤이고 LATE_USAGE_MS 안이다 */
  inClosedLate: boolean;
}

export type UsageTarget = 'none' | 'open' | 'closed';

export interface UsageStep {
  /** 세션 합계·에이전트 내역·사용량 화면·사람 몫에 더한다 */
  count: boolean;
  target: UsageTarget;
  /** 열린 실행의 합계와 턴(모델 호출 수)에 센다 */
  countTurn: boolean;
  /** 더한 뒤 한도를 본다 */
  checkLimits: boolean;
}

const TARGETS = new Set<string>(['none', 'open', 'closed']);

/** 요청 하나를 어떻게 처리할지. 알아보지 못한 결정은 붙이지 않고 센다 */
export function decideUsage(facts: UsageFacts): UsageStep {
  const step = native.terminalDecideUsage(facts);
  if (!TARGETS.has(step.target)) return { count: true, target: 'none', countTurn: false, checkLimits: true };
  return { count: step.count, target: step.target as UsageTarget, countTurn: step.countTurn, checkLimits: step.checkLimits };
}

/** 도구 호출이 연 실행에 붙이는 열린 시각 앞의 시간(ms) */
export const EARLY_USAGE_MS = native.terminalEarlyUsageMs();
/** 실행이 닫힌 뒤 늦게 닿는 텔레메트리를 그 실행의 몫으로 보는 시간(ms) */
export const LATE_USAGE_MS = native.terminalLateUsageMs();

export interface StallFacts {
  openRun: boolean;
  notified: boolean;
  /** 마지막 활동 뒤 흐른 시간(ms). 시계가 거꾸로 갔으면 음수다 */
  idleMs: number;
  stallMs: number;
}

export type StallStep = 'stop' | 'nothing' | 'notify';

/** 정체 감시 한 회차. 알리기만 하는 판정이라 알아보지 못한 결정은 알린다 */
export function decideStall(facts: StallFacts): StallStep {
  const step = native.terminalDecideStall(facts);
  return step === 'stop' || step === 'nothing' ? step : 'notify';
}

/** 정체 감시 주기(ms): 정체 시간의 1/4, 최소 1초 */
export function stallIntervalMs(stallMs: number): number {
  return native.terminalStallIntervalMs(stallMs);
}

export interface SilenceFacts {
  cliSendsUsage: boolean;
  /** 이 실행이 열린 뒤 사용량 소식을 한 번이라도 받았다 */
  telemetrySeen: boolean;
  /** 이 실행이 열린 뒤 온 쓰기 도구 훅의 수 */
  writeHooks: number;
  /** 이 실행이 열린 지 흐른 시간(ms) */
  elapsedMs: number;
  /** 이 세션이 앞서 끊김으로 판정됐고 그 뒤 사용량 소식을 받지 못했다 */
  silentBefore: boolean;
}

/** 사용량 소식이 끊겨 한도를 볼 수 없는가. 알아보지 못한 결정은 끊긴 것이다(막는 쪽) */
export function decideSilence(facts: SilenceFacts): 'fine' | 'silent' {
  return native.terminalDecideSilence(facts) === 'fine' ? 'fine' : 'silent';
}
