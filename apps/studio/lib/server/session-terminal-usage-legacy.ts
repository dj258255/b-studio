/**
 * 옛 터미널 사용량 귀속·정체 판정(ADR-213 이전)의 판정. 새 코드(`session-terminal-usage.ts`, Rust `bstudio-session`의 `terminal::usage`)와 견주는 차등 시험의 기준으로만 남아 있다.
 * 4g에서 지운다. 옛 `sessions.ts`의 `countTerminalUsageOnce`·`attributeRunUsage`·`checkTerminalStall`이 정하던 분기 순서를 그대로 옮겼다(부수 효과는 뺐다).
 * 옛 코드의 모습 그대로의 결함도 함께 옮겼다:
 * - 도구 호출이 연 실행에서 열린 시각보다 앞선 요청은 붙지 않아 턴 수에 세지지 않았다(U5)
 * - 정체 감시 주기가 정체 시간과 같아 알림이 최대 두 배 늦었다(U6, 주기는 `legacyStallIntervalMs`)
 */

export interface LegacyUsageFacts {
  hasRequestId: boolean;
  counted: boolean;
  attached: boolean;
  openRun: boolean;
  /** 요청 시각 >= 열린 실행의 시작 */
  inOpenWindow: boolean;
  /** 막 닫힌 실행의 시작과 끝+5초 사이(끝 이전과 이후를 가르지 않는다) */
  inClosedWindow: boolean;
}

export interface LegacyUsageStep {
  count: boolean;
  target: 'none' | 'open' | 'closed';
  countTurn: boolean;
  checkLimits: boolean;
}

export function legacyUsage(facts: LegacyUsageFacts): LegacyUsageStep {
  const count = !facts.hasRequestId || !facts.counted;
  let target: LegacyUsageStep['target'];
  if (facts.openRun && facts.inOpenWindow) target = 'open';
  else if (facts.inClosedWindow) target = 'closed';
  else target = 'none';
  if (target !== 'none' && facts.hasRequestId && facts.attached) target = 'none';
  return { count, target, countTurn: target === 'open', checkLimits: count };
}

export interface LegacyStallFacts {
  openRun: boolean;
  notified: boolean;
  idleMs: number;
  stallMs: number;
}

export function legacyStall(facts: LegacyStallFacts): 'stop' | 'nothing' | 'notify' {
  if (!facts.openRun) return 'stop';
  if (facts.notified) return 'nothing';
  if (facts.idleMs < facts.stallMs) return 'nothing';
  return 'notify';
}

export function legacyStallIntervalMs(stallMs: number): number {
  return stallMs;
}
