import { native } from '@b-studio/sandbox';

/**
 * 세션 터미널의 요청 시작·쓰기 직전·MCP 판정(ADR-211, 4f B4b). 판정은 Rust `crates/bstudio-session`의 `terminal::prompt`가 한다(순수 함수).
 * 여기는 사실을 코어에 넘기고 결정을 TS 값으로 돌려주는 껍데기다. 글 조립은 `sessions.ts`가 한다. 옛 판정은 지웠다(#1347).
 *
 * 쓰기 직전 훅과 MCP는 샌드박스 켜기와 보호 경로 고정을 기다린다. 기다림 앞의 판정은 샌드박스를 켤지 말지(일찍 거절)에만 쓰고,
 * 기다림 뒤에 그 순간의 사실로 `decidePreTool`을 다시 불러 그 답을 최종으로 한다.
 */

export interface PromptFacts {
  /** 열린 터미널 실행이 있다 */
  openRun: boolean;
  /** 그 실행이 읽기만이다 */
  runReadOnly: boolean;
  /** 이번 요청이 읽기만이다 */
  promptReadOnly: boolean;
  /** 지금 터미널의 요청을 받을 수 없다는 글이 있다 */
  busy: boolean;
  /** 요청이 `/`로 시작한다 */
  slash: boolean;
  /** 세션·사람 토큰 한도를 이미 넘었다는 글이 있다 */
  budget: boolean;
}

export type PromptDecision =
  | { kind: 'attach'; markReadOnly: boolean; readOnly: boolean }
  | { kind: 'block'; block: 'busy' | 'budget' }
  | { kind: 'nothing' }
  | { kind: 'open' };

/** `unknown`은 한도를 볼 수 없는 실행(사용량 소식이 끊겼다, ADR-213)이다. 코어는 한도에 닿은 것처럼 막는다 */
export type TerminalLimit = 'none' | 'max_turns' | 'budget' | 'unknown';

export interface PreToolFacts {
  /** 파일을 바꾸지 않는 도구다. MCP는 늘 거짓이다 */
  readTool: boolean;
  /** 세션·사람 토큰 한도를 이미 넘었다는 글이 있다 */
  budget: boolean;
  /** 도구가 속할 실행을 얻었다(거짓이면 바쁨) */
  gotRun: boolean;
  /** 실행이 읽기만이다 */
  readOnly: boolean;
  /** 실행이 한도에 닿았다 */
  limit: TerminalLimit;
  /** 카드 쓰기 범위 밖이거나 범위를 확인하지 못했다. MCP는 늘 거짓이다 */
  outOfScope: boolean;
  /** 실행이 닫혔거나 중단 신호가 올랐다. 기다림 앞에서는 거짓이다 */
  closed: boolean;
}

export type PreToolDeny = 'budget' | 'busy' | 'read_only' | 'max_turns' | 'run_budget' | 'out_of_scope' | 'closed' | 'unknown';
export type PreToolDecision = { allow: true } | { allow: false; deny: PreToolDeny };

const DENY_KINDS: readonly PreToolDeny[] = ['budget', 'busy', 'read_only', 'max_turns', 'run_budget', 'out_of_scope', 'closed', 'unknown'];

/** 요청 시작 판정: 열린 실행에 이어 붙임 → 바쁨 → `/` 명령 → 토큰 한도 → 새 실행 */
export function decidePrompt(facts: PromptFacts): PromptDecision {
  const decision = native.terminalDecidePrompt(facts);
  switch (decision.kind) {
    case 'attach':
      return { kind: 'attach', markReadOnly: decision.markReadOnly, readOnly: decision.readOnly };
    case 'block':
      // 알아보지 못한 거절 종류는 바쁨으로 읽는다(막는 쪽)
      return { kind: 'block', block: decision.block === 'budget' ? 'budget' : 'busy' };
    case 'nothing':
      return { kind: 'nothing' };
    case 'open':
      return { kind: 'open' };
    default:
      return { kind: 'block', block: 'busy' };
  }
}

/** 쓰기 직전·MCP 판정: 읽기 도구 → 토큰 한도 → 바쁨 → 닫힘 → 읽기만 → 실행 한도 → 카드 범위. 모르는 결과는 거절이다 */
export function decidePreTool(facts: PreToolFacts): PreToolDecision {
  const decision = native.terminalDecidePreTool(facts);
  if (decision.allow) return { allow: true };
  const deny = (DENY_KINDS as readonly string[]).includes(decision.deny) ? (decision.deny as PreToolDeny) : 'unknown';
  return { allow: false, deny };
}

/** 다음 요청에 켜 둔 확인 선언 변경 허용을 이 실행이 가져가는가. 사람의 요청이 연 만들기 실행만 가져간다 */
export function takesCheckChanges(openedByPrompt: boolean, readOnly: boolean, allowedNext: boolean): boolean {
  return native.terminalTakesCheckChanges(openedByPrompt, readOnly, allowedNext);
}
