import type { AgentResult, AgentUsage, GateOutcome, VerificationReport, WorkflowCheck } from '@b-studio/agent';
import { formatCheckedCoverage, formatIncompleteTrailer, formatVerificationReport, formatVerifyTrailer, formatWorkflowTrailer } from '@b-studio/agent';
import { AGENT_READ_ONLY_MARK } from '@b-studio/sandbox';
import { SPEC_FILE } from '@b-studio/spec';
import type { PreToolDeny } from './session-terminal-prompt';

/**
 * A4c-6 이전의 `sessions.ts`가 만들던 글(차등 시험의 기준값). 지금 구현은 Rust(`crates/bstudio-session/src/terminal_text.rs`)다.
 * 이 파일은 견주는 시험만 쓴다. `terminalResult`는 옛 함수가 `performance.now()`로 재던 `gateMs`를 인자로 받는다(같은 입력을 만들기 위해서다).
 */

const UNGUARDED_WRITES_NOTE = '검사 동안 다른 프로세스의 쓰기를 막지 않았습니다(이 컴퓨터 방식 터미널. 컨테이너 방식은 검사 동안 에이전트 컨테이너를 멈춥니다)';

export function checkpointBody(result: AgentResult, allowBreaking: boolean, { unguardedWrites = false }: { unguardedWrites?: boolean } = {}): string {
  const sections: string[] = [];
  if (result.report) sections.push(formatVerificationReport(result.report, { allowBreaking }));
  if (unguardedWrites) sections.push(UNGUARDED_WRITES_NOTE);
  const coverage = formatCheckedCoverage(result.checks);
  if (coverage) sections.push(coverage);
  if (result.verifyAttempts > 0) sections.push(`검증 게이트 재시도: ${result.verifyAttempts}회`);
  const summary = result.summary.trim();
  if (summary) sections.push(`에이전트 요약:\n${summary.split('\n').slice(0, 30).join('\n')}`);
  return sections.join('\n\n');
}

export function checkpointTrailers(result: AgentResult): string[] {
  if (!result.passedStages) return [];
  const trailers = [formatWorkflowTrailer(result.passedStages)];
  if (result.verify === 'light') trailers.push(formatVerifyTrailer('light'));
  if (result.incomplete === 'max_turns') trailers.push(formatIncompleteTrailer('max_turns'));
  return trailers;
}

interface LegacyRun {
  terminalUsage?: { usage: AgentUsage; usageByModel: Record<string, AgentUsage>; modelCalls: number };
}

interface LegacyVerification {
  workspace: { changedFiles(): string[] };
  gate: { report?: VerificationReport; checks: WorkflowCheck[]; passedStages: Iterable<string>; attempts: number };
}

/** `gateMs`는 옛 함수의 `Math.round(performance.now() - startedMs)`다 */
export function terminalResult(
  run: LegacyRun,
  verification: LegacyVerification,
  status: 'done' | 'failed',
  summary: string,
  outcome: GateOutcome['kind'],
  gateMs: number,
): AgentResult {
  const { workspace, gate } = verification;
  return {
    status,
    summary,
    changedFiles: workspace.changedFiles(),
    report: gate.report,
    checks: gate.checks,
    gateOutcome: outcome,
    passedStages: [...gate.passedStages] as AgentResult['passedStages'],
    verifyAttempts: gate.attempts,
    turns: 0,
    usage: run.terminalUsage?.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    metrics: {
      modelCalls: run.terminalUsage?.modelCalls ?? 0,
      maxContextTokens: 0,
      toolMs: 0,
      gateMs,
      ...(run.terminalUsage ? { usageByModel: run.terminalUsage.usageByModel } : {}),
    },
  };
}

/** 옛 TS의 글 상수(지금은 Rust가 정한다) */
export const LEGACY_TERMINAL_TEXTS = {
  runClosedDeny: '[b-studio] 요청을 닫아 도구를 쓰지 않았습니다.',
  undecidedDeny: '[b-studio] 요청을 받을 수 있는지 판정하지 못해 시작하지 않았습니다. 잠시 뒤 다시 시도하세요.',
  usageSilentDeny:
    '[b-studio] 터미널의 사용량(텔레메트리)이 오지 않아 턴·토큰 한도를 확인할 수 없어 파일을 바꾸거나 명령을 돌리는 도구를 막았습니다. CLI의 텔레메트리 설정을 확인하세요. 사용량이 다시 오면 풀립니다.',
  usageUnreadableDeny:
    '[b-studio] 터미널이 보낸 사용량 기록 일부를 읽지 못해 토큰 한도를 확인할 수 없어 파일을 바꾸거나 명령을 돌리는 도구를 막았습니다. 지금 하던 일을 정리하고 턴을 끝내세요.',
  readOnlyNote: '[b-studio] 이 요청은 읽기만입니다. 파일을 바꾸거나 명령을 돌리는 도구(Write·Edit·Bash·b-studio 도구)는 거절됩니다. Read·Glob·Grep으로 읽고 답만 하세요.',
  checkChangesNote: `[b-studio] 사용자가 이 요청에 '확인 선언 변경 허용'을 켰습니다. 이번 실행의 검증은 ${SPEC_FILE}의 지금 확인 선언(tests·pageChecks·concurrencyChecks·loadChecks·autoPageChecks·required)으로 돕니다. 사용자가 요청한 선언만 바꾸고, 바꾼 것은 검증 결과의 declared-checks 줄에 남습니다.`,
  gitMissingReason: '[b-studio] 작업 복사본의 Git 상태를 기억하지 못해 확인하지 못했습니다. 작업 복사본의 git 저장소를 확인한 뒤 다시 요청하세요',
};

const TERMINAL_READ_ONLY_DENY = `[b-studio] 읽기만 요청이라 파일을 바꾸거나 명령을 돌리는 도구를 쓰지 않았습니다. 바꾸려면 이 요청이 끝난 뒤 "${AGENT_READ_ONLY_MARK}" 없이 새로 요청하세요.`;
const TERMINAL_RUN_CLOSED_DENY = LEGACY_TERMINAL_TEXTS.runClosedDeny;
const TERMINAL_UNDECIDED_TOOL_DENY = '[b-studio] 이 도구를 쓸 수 있는지 판정하지 못해 막았습니다. 잠시 뒤 다시 시도하세요.';

export function pretoolDenyText(kind: PreToolDeny, texts: Partial<Record<PreToolDeny, string>>): string {
  if (kind === 'read_only') return TERMINAL_READ_ONLY_DENY;
  if (kind === 'closed') return TERMINAL_RUN_CLOSED_DENY;
  return texts[kind] ?? TERMINAL_UNDECIDED_TOOL_DENY;
}

export function hookMessage(summary: string): string {
  const line = summary.replace(/\n+/g, ' ');
  return line.startsWith('[b-studio]') ? line : `[b-studio] ${line}`;
}

export function doneTestsFeedback(failures: readonly { name: string; detail: string }[]): string {
  return `[b-studio 검증 게이트] 완료 조건이 통과하지 못했습니다. 고친 뒤 턴을 끝내세요.\n\n${failures.map((failure) => `- ${failure.name}\n${failure.detail}`).join('\n')}`;
}

export function terminalStallMessage(stallMs: number): string {
  const seconds = Math.round(stallMs / 1000);
  const label = seconds % 60 === 0 ? `${seconds / 60}분` : `${seconds}초`;
  return `터미널 요청이 ${label} 넘게 움직임이 없습니다. CLI가 확인을 기다리는지 터미널을 보세요`;
}

export function limitAbortMessage(kind: 'session' | 'user' | 'usage_unreadable'): string {
  if (kind === 'session') return '세션 토큰 한도에 도달했습니다';
  return kind === 'user' ? '사람별 토큰 한도에 도달했습니다' : '사람별 토큰 사용량 기록을 읽지 못했습니다';
}

export function apiErrorKind(raw: unknown): string {
  const kind = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9_.-]{1,40}$/.test(kind) ? kind : '알 수 없는 오류';
}

/** 옛 `sessions.ts`의 `clipText`(UTF-16) */
export function clipText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}… (${text.length - limit}자 줄임)` : text;
}

export function attemptsExhaustedSummary(gateAttempts: number, unsettledAttempts: number, feedback: string, maxAttempts: number): string {
  const base = `검증 재시도 상한(${maxAttempts}번)에 닿았습니다(게이트 ${gateAttempts}번, 게이트 밖 사유 ${unsettledAttempts}번)`;
  return feedback ? `${base}: ${clipText(feedback, 800)}` : base;
}

export function cliEndedReason(feedback: string): string {
  return `검증을 통과하지 못한 채 CLI가 끝났습니다.\n\n${clipText(feedback, 4000)}`;
}

export function deadlineReason(deadlineMs: number, hookSeconds: number, nowMs: number, arrivedMs: number): string {
  return `검증이 시간 상한(${Math.round(deadlineMs / 1000)}초) 안에 끝나지 않아 통과시키지 않고 실패로 닫습니다. Stop 훅은 ${hookSeconds}초에 CLI가 끊고 답을 버리므로 그보다 먼저 닫아, 상한을 넘겨 끝난 검사가 체크포인트를 남기지 않게 합니다(훅이 도착한 뒤 ${Math.round((nowMs - arrivedMs) / 1000)}초)`;
}

export function restoreBackupNote(filesLen: number, backupId: string | undefined): string {
  return filesLen > 0 ? ` 바뀐 파일 ${filesLen}개는 보관본으로 남겼습니다${backupId ? `(id: ${backupId})` : ''}.` : '';
}

export function gitRealignUnrestorableMessage(which: string, errorText: string): string {
  return `작업 복사본의 Git 기록이 b-studio가 남긴 체크포인트와 달라(${which}) 되돌리려 했지만 되돌리지 못했습니다: ${errorText}`;
}

export function gitRealignNotice(which: string, filesLen: number, backupId: string | undefined): string {
  return `[b-studio] 요청 사이에 작업 복사본의 Git 기록이 b-studio가 남긴 체크포인트와 달라져(${which}) 마지막 체크포인트로 되돌렸습니다.${restoreBackupNote(filesLen, backupId)}`;
}

export function gitRealignFailureReason(which: string, errorText: string): string {
  return `[b-studio] 작업 복사본의 Git 기록이 b-studio가 남긴 체크포인트와 달라(${which}) 마지막 체크포인트로 되돌리려 했지만 되돌리지 못했습니다: ${errorText}`;
}

export function gitRealignRestoredReason(which: string, filesLen: number, backupId: string | undefined): string {
  return `[b-studio] 작업 복사본의 Git 기록이 b-studio가 남긴 체크포인트와 달라(${which}) 마지막 체크포인트로 되돌렸습니다.${restoreBackupNote(filesLen, backupId)}`;
}

type LegacyLanded = 'yes' | 'no' | 'unknown';

/** 옛 `landedCheckpoint`의 분기: 저장이 커밋하지 않았으면 `no`, 목록을 읽지 못했으면 `unknown`(목록은 첫 체크포인트 하나) */
export function landedPlan(committed: string | undefined, listed: boolean, latest: string | undefined): { state: LegacyLanded; adopt: boolean } {
  if (committed === undefined) return { state: 'no', adopt: false };
  const head: { kind: 'empty' } | { kind: 'sha'; sha: string } | { kind: 'failed' } = !listed
    ? { kind: 'failed' }
    : latest !== undefined
      ? { kind: 'sha', sha: latest }
      : { kind: 'empty' };
  const state: LegacyLanded = head.kind === 'failed' ? 'unknown' : head.kind === 'empty' ? 'no' : head.sha === committed ? 'yes' : 'no';
  return { state, adopt: state === 'yes' && latest !== undefined };
}
