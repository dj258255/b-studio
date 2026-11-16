/**
 * 옛 토큰 한도 판정 셋(ADR-209 이전). 새 코드(`session-limits.ts`, Rust `bstudio-session`의 `limits`)와 견주는 차등 시험의 기준으로만 남아 있다. 4g에서 지운다.
 * 옛 `sessions.ts`의 세 자리를 그대로 옮겼다(부수 효과만 뺐다). 입력은 이미 읽은 수다:
 * - `legacyStartVerdict`: `sendMessage`의 한도 409 둘과 `terminalBudgetMessage`
 * - `legacyConversationVerdict`: `runPlan`의 `onEvent`(tokens) — 사람 몫을 `파일 합계 + 이 실행 누적`으로 봤다(결함: 파일에는 이 실행이 이미 저장한 몫이 들어 있다)
 * - `legacyTerminalVerdict`: `checkTerminalLimits` — 파일 합계만 봤다(결함: 저장이 끝나지 않은 증가분은 세지 않았다)
 */
export interface LegacyLimitFacts {
  sessionTokens: number;
  sessionLimit?: number;
  /** 사람 한도. 없으면(한도를 정하지 않았거나 누가 보냈는지 모름) 사람 몫은 보지 않는다 */
  userLimit?: number;
  /** 파일의 사람 합계 */
  fileTotal: number;
  /** 이 실행 누적(`totalTokens(event.usage)`). 대화 경로만 쓴다 */
  runTotal?: number;
}

export type LegacyVerdict = 'ok' | 'session' | 'user';

export function legacyStartVerdict(facts: LegacyLimitFacts): LegacyVerdict {
  if (facts.sessionLimit !== undefined && facts.sessionTokens >= facts.sessionLimit) return 'session';
  if (facts.userLimit !== undefined && facts.fileTotal >= facts.userLimit) return 'user';
  return 'ok';
}

export function legacyConversationVerdict(facts: LegacyLimitFacts): LegacyVerdict {
  const overSession = facts.sessionLimit !== undefined && facts.sessionTokens >= facts.sessionLimit;
  const overUser = facts.userLimit !== undefined && facts.fileTotal + (facts.runTotal ?? 0) >= facts.userLimit;
  return overSession ? 'session' : overUser ? 'user' : 'ok';
}

export function legacyTerminalVerdict(facts: LegacyLimitFacts): LegacyVerdict {
  const overSession = facts.sessionLimit !== undefined && facts.sessionTokens >= facts.sessionLimit;
  const overUser = facts.userLimit !== undefined && facts.fileTotal >= facts.userLimit;
  return overSession ? 'session' : overUser ? 'user' : 'ok';
}
