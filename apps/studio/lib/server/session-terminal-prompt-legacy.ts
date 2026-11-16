/**
 * 옛 터미널 요청 시작·쓰기 직전·MCP 판정(ADR-211 이전)의 판정. 새 코드(`session-terminal-prompt.ts`, Rust `bstudio-session`의 `terminal::prompt`)와 견주는 차등 시험의 기준으로만 남아 있다.
 * 4g에서 지운다. 옛 `sessions.ts`의 `terminalPromptSubmitted`·`terminalToolDecision`·`runTerminalTool`이 정하던 분기 순서를 그대로 옮겼다(부수 효과는 뺐다).
 * 옛 코드의 모습 그대로의 결함도 함께 옮겼다:
 * - 쓰기 직전·MCP는 샌드박스 켜기(`terminalVerification`)를 기다리기 앞에서만 읽기만·한도·카드 범위를 봤고, 기다림 뒤에는 닫힘(중단 신호)만 봤다
 * - 확인 선언 변경 허용은 요청 훅 없이 도구 호출이 연 실행도 가져갔다
 */
import type { PreToolFacts, PromptFacts } from './session-terminal-prompt';

export type LegacyPromptDecision = 'attach' | 'block_busy' | 'nothing' | 'block_budget' | 'open';

/** `terminalPromptSubmitted`: 열린 실행에 이어 붙임 → 바쁨 → `/` 명령 → 토큰 한도 → 새 실행 */
export function legacyPrompt(facts: PromptFacts): { decision: LegacyPromptDecision; markReadOnly: boolean; readOnly: boolean } {
  if (facts.openRun) return { decision: 'attach', markReadOnly: facts.promptReadOnly, readOnly: facts.runReadOnly || facts.promptReadOnly };
  const none = { markReadOnly: false, readOnly: false };
  if (facts.busy) return { decision: 'block_busy', ...none };
  if (facts.slash) return { decision: 'nothing', ...none };
  if (facts.budget) return { decision: 'block_budget', ...none };
  return { decision: 'open', ...none };
}

export type LegacyDeny = 'budget' | 'busy' | 'read_only' | 'max_turns' | 'run_budget' | 'out_of_scope' | 'closed';
export type LegacyPreTool = { allow: true } | { allow: false; deny: LegacyDeny };

/** 기다리기 앞의 판정(`terminalToolDecision`·`runTerminalTool`의 앞부분): 읽기 도구 → 토큰 한도 → 바쁨 → 읽기만 → 실행 한도 → 카드 범위 */
export function legacyPreToolBefore(facts: PreToolFacts): LegacyPreTool {
  if (facts.readTool) return { allow: true };
  if (facts.budget) return { allow: false, deny: 'budget' };
  if (!facts.gotRun) return { allow: false, deny: 'busy' };
  if (facts.readOnly) return { allow: false, deny: 'read_only' };
  if (facts.limit === 'max_turns') return { allow: false, deny: 'max_turns' };
  if (facts.limit === 'budget') return { allow: false, deny: 'run_budget' };
  if (facts.outOfScope) return { allow: false, deny: 'out_of_scope' };
  return { allow: true };
}

/** 기다림 뒤의 판정: 중단 신호가 올랐거나 실행이 닫혔을 때만 거절한다 */
export function legacyPreToolAfter(facts: PreToolFacts): LegacyPreTool {
  return facts.closed ? { allow: false, deny: 'closed' } : { allow: true };
}

/** 옛 `beginTerminalRun`: 읽기만이 아니면 켜 둔 허용을 열린 이유와 무관하게 가져갔다 */
export function legacyTakesCheckChanges(_openedByPrompt: boolean, readOnly: boolean, allowedNext: boolean): boolean {
  return !readOnly && allowedNext;
}
