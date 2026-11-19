import type { AgentResult, AgentUsage, GateOutcome, WorkflowCheck } from '@b-studio/agent';
import { AGENT_READ_ONLY_MARK } from '@b-studio/sandbox';
import { decodeNative, encodeNative, native } from '@b-studio/sandbox';
import { SPEC_FILE } from '@b-studio/spec';
import type { PreToolDeny } from './session-terminal-prompt';

/**
 * 세션 조율 함수가 만드는 글(ADR-195 4f C1-6a/6b). `Session` 상태·git·파일은 `sessions.ts`가 쥐고, 글자는 Rust
 * (`crates/bstudio-session/src/terminal_text.rs`)가 만든다. 트레일러는 게이트 통과의 근거라 바이트까지 같아야 한다.
 * 옛 구현은 `session-text-legacy.ts`에 차등 시험의 기준으로만 남아 있다.
 */

export interface TerminalTexts {
  runClosedDeny: string;
  undecidedDeny: string;
  usageSilentDeny: string;
  usageUnreadableDeny: string;
  readOnlyNote: string;
  checkChangesNote: string;
  gitMissingReason: string;
}

export const TERMINAL_TEXTS: TerminalTexts = decodeNative<TerminalTexts>(native.sessionTerminalTexts(SPEC_FILE));

/** PR 리뷰어가 요청마다 무엇을 확인했는지 볼 수 있도록 검증 결과와 에이전트 요약을 커밋 본문에 남긴다 */
export function checkpointBody(result: AgentResult, allowBreaking: boolean, { unguardedWrites = false }: { unguardedWrites?: boolean } = {}): string {
  let reportJson: string | null = null;
  let reportUnserializable = false;
  if (result.report) {
    try {
      reportJson = encodeNative(result.report);
    } catch {
      reportUnserializable = true;
    }
  }
  // 옛 `formatCheckedCoverage`와 같은 모양만 넘긴다(모양이 어긋나면 그 자리에서 던진다)
  const checks = (result.checks ?? []).map((check) => ({ stage: check.stage, name: check.name, ok: check.ok, detail: check.detail }));
  return native.sessionCheckpointBody(reportJson, reportUnserializable, allowBreaking, encodeNative(checks), result.verifyAttempts, result.summary, unguardedWrites);
}

/** 체크포인트에 남길 통과 단계. 게이트 기록이 없는 실행이면 트레일러를 남기지 않는다 */
export function checkpointTrailers(result: AgentResult): string[] {
  return native.sessionCheckpointTrailers(result.passedStages ? [...result.passedStages] : null, result.verify ?? null, result.incomplete ?? null);
}

export interface TerminalResultFacts {
  status: 'done' | 'failed';
  summary: string;
  changedFiles: readonly string[];
  /** 없으면(undefined) 결과에 키를 넣지 않는다(옛 객체의 `undefined` 속성과 같다) */
  report: unknown;
  checks: readonly WorkflowCheck[];
  gateOutcome: GateOutcome['kind'];
  passedStages: readonly string[];
  verifyAttempts: number;
  usage: AgentUsage;
  modelCalls: number;
  /** 없으면(undefined) 결과에 키를 넣지 않는다 */
  usageByModel: unknown;
  gateMs: number;
}

/**
 * 게이트의 결과를 실행 결과의 꼴로 옮긴다(체크포인트 본문과 트레일러, 대화 창의 결과 카드가 이 꼴을 읽는다).
 * 키 순서는 옛 객체 리터럴과 같다.
 */
export function assembleTerminalResult(facts: TerminalResultFacts): AgentResult {
  const input: Record<string, unknown> = {
    status: facts.status,
    summary: facts.summary,
    changedFiles: [...facts.changedFiles],
    checks: facts.checks,
    gateOutcome: facts.gateOutcome,
    passedStages: [...facts.passedStages],
    verifyAttempts: facts.verifyAttempts,
    usage: facts.usage,
    modelCalls: facts.modelCalls,
    gateMs: facts.gateMs,
  };
  if (facts.report !== undefined) input.report = facts.report;
  if (facts.usageByModel !== undefined) input.usageByModel = facts.usageByModel;
  const result = decodeNative<AgentResult>(native.sessionTerminalResult(encodeNative(input)));
  // 옛 객체 리터럴은 `report` 키를 값이 undefined여도 두었다. Rust가 그 자리에 null을 채우므로 여기서 undefined로 되돌린다
  // (이미 있는 키에 대입하므로 키 순서가 그대로다. JSON.stringify는 어느 쪽도 키를 쓰지 않는다)
  if (facts.report === undefined) result.report = undefined;
  return result;
}

/** 코어가 거절한 까닭을 화면에 낼 글로 바꾼다. 글이 없으면(알아보지 못한 까닭) 막는 쪽의 일반 글이다 */
export function pretoolDenyText(kind: PreToolDeny, texts: Partial<Record<PreToolDeny, string>>): string {
  return native.sessionPretoolDenyText(kind, encodeNative(texts), AGENT_READ_ONLY_MARK);
}

/** 훅 답의 한 줄 알림. 사유 글이 이미 `[b-studio]`로 시작하면 다시 붙이지 않는다 */
export function hookMessage(summary: string): string {
  return native.sessionHookMessage(summary);
}

/** 완료 검사 실패를 게이트 실패와 같은 모양의 feedback으로 만든다 */
export function doneTestsFeedback(failures: readonly { name: string; detail: string }[]): string {
  return native.sessionDoneTestsFeedback(encodeNative(failures));
}

/** 정체 알림 문구(#B5 수정 3). 설정한 시간으로 만든다 — 60초의 배수면 N분, 아니면 N초 */
export function terminalStallMessage(stallMs: number): string {
  return native.sessionTerminalStallMessage(stallMs);
}

/** 실행 중 한도 판정이 멈추라고 했을 때 중단 신호에 싣는 글 */
export function limitAbortMessage(kind: 'session' | 'user' | 'usage_unreadable'): string {
  return native.sessionLimitAbortMessage(kind);
}

/** 훅 입력의 오류 종류(`error`)를 사유에 적을 글로 바꾼다. 모르는 것(없거나 문자열이 아니거나 낯선 글자·긴 값)은 "알 수 없는 오류"다 */
export function apiErrorKind(raw: string | undefined): string {
  return native.sessionApiErrorKind(raw ?? null);
}

/** 게이트 쪽 횟수와 게이트 밖 사유의 횟수를 합쳐 상한에 닿았을 때 쓰는 글(S12). `feedbackClipped`는 `clipText`로 자른 글이다 */
export function attemptsExhaustedSummary(gateAttempts: number, unsettledAttempts: number, feedbackClipped: string, maxAttempts: number): string {
  return native.sessionAttemptsExhaustedSummary(gateAttempts, unsettledAttempts, feedbackClipped, maxAttempts);
}

/** CLI가 끝났는데 마지막으로 돌려준 검증 결과가 있을 때 실패로 닫는 사유. `feedbackClipped`는 `clipText`로 자른 글이다 */
export function cliEndedReason(feedbackClipped: string): string {
  return native.sessionCliEndedReason(feedbackClipped);
}

/** 턴 끝 검증의 시간 상한이 지났을 때 실행을 닫는 사유 글. 초는 호출자가 `Math.round`로 센 값이다 */
export function deadlineReasonOf(deadlineSeconds: number, hookSeconds: number, elapsedSeconds: number): string {
  return native.sessionDeadlineReason(String(deadlineSeconds), String(hookSeconds), String(elapsedSeconds));
}

/** 기억한 체크포인트로 되돌리지 못했다(요청 사이 Git 검사) */
export function gitRealignUnrestorableMessage(which: string, errorText: string): string {
  return native.sessionGitRealignUnrestorableMessage(which, errorText);
}

/** 되돌렸다는 알림(요청 사이 Git 검사) */
export function gitRealignNotice(which: string, filesLen: number, backupId: string | undefined): string {
  return native.sessionGitRealignNotice(which, filesLen, backupId ?? null);
}

/** 턴 끝 Git 검사에서 되돌리지 못해 실행을 실패로 닫는 사유 */
export function gitRealignFailureReason(which: string, errorText: string): string {
  return native.sessionGitRealignFailureReason(which, errorText);
}

/** 턴 끝 Git 검사에서 되돌려 실행을 실패로 닫는 사유 */
export function gitRealignRestoredReason(which: string, filesLen: number, backupId: string | undefined): string {
  return native.sessionGitRealignRestoredReason(which, filesLen, backupId ?? null);
}

/** 저장이 남긴 체크포인트를 받아들일지. `listed`가 거짓이면 Git 목록을 읽지 못한 것이다 */
export function landedPlan(committed: string | undefined, listed: boolean, latest: string | undefined): { state: 'yes' | 'no' | 'unknown'; adopt: boolean } {
  return decodeNative(native.sessionLandedPlan(committed ?? null, listed, latest ?? null));
}
