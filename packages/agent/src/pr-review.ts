/**
 * PR 자동 리뷰 라운드(ADR-074).
 *
 * exportSession이 PR을 만든 뒤, 별도의 읽기 전용 리뷰어 호출로 base...head diff만 보고 구조화된 지적을 받는다.
 * 이름이 겹치지 않도록 워크플로 단계 'review'(에이전트 자체 점검)나 GitHub PR의 ReviewDecision(승인/변경 요청)과
 * 구별해 이 모듈의 타입은 모두 PrReview 접두어를 쓴다.
 *
 * 순수 판정과 글 만들기(차단 판정, 라운드 판정, diff 자르기, 프롬프트·코멘트 본문)는 Rust(crates/bstudio-guard/src/pr_review.rs,
 * ADR-191 3단계)가 하고, 이 파일은 같은 이름·시그니처의 껍데기다. 모델 호출·응답 스키마(zod)·응답 해석·시스템 프롬프트는 여기 남는다.
 *
 * 계획 호출(task-plan.ts)과 같은 모양(ModelAsk, parsePlannerReply)을 그대로 재사용한다:
 *   · 도구 없이 한 번만 묻고 JSON 하나만 받는다 — 리뷰어는 diff와 요청 문구만 보고, 파일 쓰기·명령 실행 도구가 없다
 *   · 실패해도 그때까지 쓴 토큰·시간은 오류에 남겨 둔다
 */
import { encodeNative, native } from '@b-studio/sandbox';
import { z } from 'zod';
import type { AgentUsage } from './loop';
import { AGENT_LANGUAGE_INSTRUCTION } from './prompts';
import { parsePlannerReply, type ModelAsk } from './task-plan';

export const PR_REVIEW_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export type PrReviewSeverity = (typeof PR_REVIEW_SEVERITIES)[number];

/** 한 라운드에서 받을 수 있는 지적 수 상한. 프롬프트가 지키게 하고, 응답이 이를 넘으면 형식 오류로 본다 */
export const MAX_PR_REVIEW_FINDINGS = 40;

export const PrReviewFindingSchema = z.object({
  severity: z.enum(PR_REVIEW_SEVERITIES),
  file: z.string().min(1).max(300),
  line: z.number().int().min(1).max(1_000_000).optional(),
  title: z.string().min(1).max(160),
  detail: z.string().min(1).max(2_000),
  suggestion: z.string().min(1).max(2_000).optional(),
});
export type PrReviewFinding = z.infer<typeof PrReviewFindingSchema>;

const PrReviewReplySchema = z.object({
  findings: z.array(PrReviewFindingSchema).max(MAX_PR_REVIEW_FINDINGS),
});

export class PrReviewError extends Error {
  /** 리뷰 호출이 실패해도 그때까지 쓴 토큰과 시간은 남긴다(계획 호출의 TaskPlanError와 같은 규칙) */
  usage?: AgentUsage;
  durationMs?: number;
  constructor(message: string) {
    super(message);
    this.name = 'PrReviewError';
  }
}

/** 모델 응답에서 findings 배열을 꺼내 검증한다. 형식이 틀리면(코드 펜스 안 JSON이 아니거나 스키마 불일치) PrReviewError를 던진다 */
export function parsePrReviewReply(text: string): PrReviewFinding[] {
  let raw: unknown;
  try {
    raw = parsePlannerReply(text);
  } catch (error) {
    throw new PrReviewError(error instanceof Error ? error.message : String(error));
  }
  const parsed = PrReviewReplySchema.safeParse(raw);
  if (!parsed.success) {
    throw new PrReviewError(`리뷰 응답 형식이 올바르지 않습니다: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return parsed.data.findings;
}

/** Rust로 넘길 심각도 목록. 문자열이 아닌 값은 어느 등급도 아니다(빈 글자) */
function severitiesOf(findings: readonly Pick<PrReviewFinding, 'severity'>[]): string[] {
  return findings.map((finding) => (typeof finding.severity === 'string' ? finding.severity : ''));
}

/** 지적 하나가 차단 사유인지(차단·주요). 스타일 지적은 이 등급으로 두지 못하게 프롬프트에서도 금지한다. 사람이 라운드 화면에서 지적을 오탐으로 닫을 때(과제 67-b)도 이 기준으로 "막는 지적"을 고른다 */
export function isBlockingFinding(finding: Pick<PrReviewFinding, 'severity'>): boolean {
  return typeof finding.severity === 'string' && native.isBlockingSeverity(finding.severity);
}

export function hasBlockingFindings(findings: readonly PrReviewFinding[]): boolean {
  return native.hasBlockingFindings(severitiesOf(findings));
}

export function severityCounts(findings: readonly PrReviewFinding[]): Record<PrReviewSeverity, number> {
  const [blocker = 0, major = 0, minor = 0, nit = 0] = native.prReviewSeverityCounts(severitiesOf(findings));
  return { blocker, major, minor, nit };
}

export type PrReviewRoundOutcome = 'pass' | 'cap' | 'fix';

/**
 * 이번 라운드 뒤 무엇을 할지 정하는 순수 함수(라운드 상태 기계의 핵심).
 * pass: 차단·주요 지적이 없다 → 사람 검토 대기. cap: 지적은 남았지만 라운드 상한에 이르렀다 → 사람에게 넘긴다.
 * fix: 지적이 있고 라운드가 남았다 → 같은 세션에 고쳐 달라고 보낸다.
 */
export function nextPrReviewStep(findings: readonly PrReviewFinding[], round: number, maxRounds: number): PrReviewRoundOutcome {
  return native.nextPrReviewStep(severitiesOf(findings), round, maxRounds) as PrReviewRoundOutcome;
}

export const PR_REVIEW_DIFF_MAX_CHARS = 60_000;

export interface TruncatedDiff {
  diff: string;
  truncated: boolean;
  /** 크기 때문에 본문을 생략한 파일. 큰 파일부터 생략한다 */
  omittedFiles: string[];
}

/**
 * diff가 상한을 넘으면 가장 큰 파일부터 본문을 생략 노트로 바꿔 상한 아래로 줄인다.
 * 작은 파일은 그대로 남겨 리뷰어가 대부분의 변경에서는 문맥을 잃지 않는다.
 * 'diff --git' 구분이 없는 입력(형식이 다르거나 비어 있음)은 통째로 잘라 노트를 붙인다.
 */
export function truncateDiff(diff: string, maxChars: number = PR_REVIEW_DIFF_MAX_CHARS): TruncatedDiff {
  return JSON.parse(native.truncateDiff(diff, maxChars)) as TruncatedDiff;
}

/** diff에 실제로 들어 있는 파일 경로들. 바깥 참고 파일을 뽑을 때(과제 67-a) 이미 diff에 있는 파일은 또 넣지 않으려고 쓴다 */
export function diffFilePaths(diff: string): string[] {
  return native.diffFilePaths(diff);
}

/**
 * diff의 추가된 줄에서 "이 PR이 가리키지만 diff에는 없는" 파일 이름 후보를 뽑는다(과제 67-a) — 상대 경로 import(JS/TS),
 * Java/Kotlin·Python의 import문이 가리키는 마지막 이름, 파스칼 케이스 식별자(클래스 이름 관례)를 모은다.
 * 실제로 그 이름의 파일을 찾아 읽는 것은 호출하는 쪽(sessions.ts)이 한다. 지운 줄은 보지 않는다
 */
export function extractDiffReferencedNames(diff: string): string[] {
  return native.extractDiffReferencedNames(diff);
}

export const PR_REVIEW_EXTERNAL_CONTEXT_MAX_CHARS = 8_000;
export const PR_REVIEW_EXTERNAL_CONTEXT_MAX_FILES = 5;

export interface ExternalFileExcerpt {
  path: string;
  excerpt: string;
}

/**
 * diff 밖 파일의 짧은 미리보기를 리뷰어 프롬프트에 붙일 섹션으로 만든다(과제 67-a). 상한을 넘으면 앞에서부터 채우고 자른다
 * (파일 개수는 호출하는 쪽이 PR_REVIEW_EXTERNAL_CONTEXT_MAX_FILES로 이미 제한한다).
 */
export function buildPrReviewExternalContext(files: readonly ExternalFileExcerpt[], maxChars: number = PR_REVIEW_EXTERNAL_CONTEXT_MAX_CHARS): string {
  return native.buildPrReviewExternalContext(
    files.map((file) => file.path),
    files.map((file) => file.excerpt),
    maxChars,
  );
}

/** 리뷰어에게 주는 고정 시스템 프롬프트. prompts.ts와 같은 문체(영어 지시, 사용자 언어로 답하라는 규칙은 여기선 JSON만 받으므로 없다) —
 * 단, "title"·"detail"·"suggestion"의 언어 지침(한국어)만은 buildSystemPrompt(과제 #309)와 같은 문구를 그대로 가져와 모델 계열이
 * 바뀌어도(1라운드 claude-code, 2라운드 api 등) 라운드마다 다른 언어로 답하지 않게 한다(도그푸딩 버그: 1라운드는 한국어, 2라운드는 영어) */
export function buildPrReviewSystemPrompt(): string {
  return `You are an independent reviewer for a pull request opened by a coding agent inside b-studio.
You see ONLY a diff between the PR's base and this session's head, plus the user's original requests — not the rest of the repository, and you have no tools to read more. Do not guess about code outside the diff.
If a "diff 밖 참고 파일" section is included, it has short excerpts of files the diff references (imports/classes) — use it to avoid flagging things that outside code already handles, but still don't assume anything not shown.
If an "이미 사람이 확인한 지적" section is included, a human already reviewed those exact findings — do not repeat them unless you have new evidence from this round's diff that they are still wrong.
Focus on: correctness bugs, security issues (injection, secrets, broken access checks), missing tests for new logic, and mismatches between the diff and what the user actually asked for.
Style, formatting, naming, and other nitpicks must NOT be reported as severity 'blocker' or 'major' — use 'minor' or 'nit' for those, or leave them out.
Write "title", "detail", and "suggestion" in Korean, regardless of what language you would otherwise reply in: ${AGENT_LANGUAGE_INSTRUCTION}
Reply with ONLY a JSON object, no prose before or after: {"findings":[{"severity":"blocker"|"major"|"minor"|"nit","file":"path/as/shown/in/diff","line":123,"title":"short title","detail":"what is wrong and why it matters","suggestion":"optional concrete fix"}]}
"line" and "suggestion" are optional. If there is nothing worth flagging, reply {"findings":[]} — do not invent findings just to have something to say.`;
}

/** 리뷰어에게 주는 요청별 사용자 메시지: 라운드 번호, 원래 요청들, (잘렸으면) 생략 안내, diff */
export function buildPrReviewUserPrompt({
  diff,
  requests,
  round,
  omittedFiles = [],
  requirementsContext,
  externalContext,
  resolvedContext,
}: {
  diff: string;
  requests: readonly string[];
  round: number;
  omittedFiles?: readonly string[];
  /** 이 PR이 구현하는 요구사항의 압축 목록(requirement-issues.ts의 buildReviewRequirementsContext, ADR-092). 없으면(요구사항을 안 쓰거나 이 PR이 구현한 게 없으면) 빈 문자열 */
  requirementsContext?: string;
  /** diff가 가리키지만 보여주지 않는 바깥 파일의 짧은 미리보기(buildPrReviewExternalContext, 과제 67-a). 없으면 빈 문자열 */
  externalContext?: string;
  /** 이전 라운드에서 사람이 오탐으로 닫은 지적(buildPrReviewResolvedContext, 과제 67-b). 없으면 빈 문자열 */
  resolvedContext?: string;
}): string {
  return native.buildPrReviewUserPrompt(encodeNative({ diff, requests, round, omittedFiles, requirementsContext, externalContext, resolvedContext }));
}

/** 코멘트마다 붙이는 숨은 표시. 라운드별로 값이 달라 같은 PR에 여러 라운드 코멘트가 쌓여도 구분된다 */
export function prReviewMarker(round: number): string {
  return native.prReviewMarker(round);
}

/**
 * 이 라운드가 본 커밋 범위(diff의 끝 커밋은 항상 있다 — 다음에 새 커밋이 쌓이면 이 값이 다음 리뷰의 시작점이
 * 된다). since는 이미 열린 PR에 새 커밋이 쌓여 그 범위만 다시 본 라운드에만 있다 — 세션 시작부터 보는 첫
 * 리뷰는 전체를 보는 게 당연해 따로 표시하지 않는다
 */
export interface PrReviewCommitRange {
  since?: string;
  head: string;
}

/** PR 코멘트 본문(한국어 표 + 숨은 표시). GitHub·Gitea 코멘트 API로 그대로 올린다 */
export function buildPrReviewComment({
  round,
  maxRounds,
  findings,
  outcome,
  omittedFiles = [],
  commitRange,
}: {
  round: number;
  maxRounds: number;
  findings: readonly PrReviewFinding[];
  outcome: PrReviewRoundOutcome;
  omittedFiles?: readonly string[];
  /** 이 라운드가 본 커밋 범위. since가 있을 때만(새 커밋이 쌓여 그 범위만 다시 본 라운드) 코멘트에 적는다 */
  commitRange?: PrReviewCommitRange;
}): string {
  return native.buildPrReviewComment(encodeNative({ round, maxRounds, findings, outcome, omittedFiles, commitRange }));
}

export interface PrReviewResolvedFinding {
  severity: PrReviewSeverity;
  file: string;
  line?: number;
  title: string;
  /** 사람이 오탐으로 닫으며 남긴 이유(resolveReviewFinding, 과제 67-b) */
  reason: string;
}

/**
 * 이전 라운드에서 사람이 오탐으로 닫은 지적들을 리뷰어 문맥에 "이미 확인했다"고 알리는 섹션으로 만든다(과제 67-b) —
 * 실제 PostgreSQL에서 새 글 id를 확인했는데도 같은 지적이 라운드마다 되풀이되던 문제를 막는다. 새 근거 없이
 * 되풀이하지 말라고 buildPrReviewSystemPrompt가 못박는다.
 */
export function buildPrReviewResolvedContext(resolved: readonly PrReviewResolvedFinding[]): string {
  return native.buildPrReviewResolvedContext(encodeNative(resolved));
}

/** 사람이 지적 하나를 오탐으로 닫을 때 PR에 답글처럼 남기는 코멘트(과제 67-b). 라운드 코멘트와 같은 댓글 API(postComment)로 올린다 */
export function buildReviewResolutionComment(finding: PrReviewFinding, reason: string): string {
  return native.buildReviewResolutionComment(encodeNative({ finding, reason }));
}

/** 고침 요청 글의 맨 앞에 붙는 표시. extractPrReviewFixTitles가 이 표시로 AI 리뷰 고침 요청(보통 사용자 요청과 다름)을 알아본다 */
export const PR_REVIEW_FIX_MARKER: string = native.prReviewFixMarker();

/** 지적을 고쳐 달라는 후속 요청 문구. 같은 세션의 정상 요청 경로(sendMessage)로 보내 검증 게이트·체크포인트를 그대로 거치게 한다.
 * 지적 제목은 **굵게** 감싸 둔다 — extractPrReviewFixTitles(아래)가 이 표시로 커밋 제목에 쓸 지적 제목들을 다시 뽑는다(과제 66) */
export function buildPrReviewFixRequest(findings: readonly PrReviewFinding[]): string {
  return native.buildPrReviewFixRequest(encodeNative(findings));
}

/**
 * buildPrReviewFixRequest가 만든 고침 요청 글에서 지적 제목들만 뽑는다(commit-message.ts의 generateCommitSubject가 과제 66을 고치는 데 쓴다) —
 * 요청 글 첫 문장이 "이 PR을 리뷰해 ... 찾았습니다" 같은 공통 문구라 그대로 커밋 제목에 쓰면 의미가 없던 버그를 고친다.
 * 이 표시로 시작하지 않으면(보통의 사용자 요청) undefined를 돌려줘 generateCommitSubject가 평소 경로를 그대로 쓰게 한다.
 */
export function extractPrReviewFixTitles(request: string): string[] | undefined {
  return native.extractPrReviewFixTitles(request) ?? undefined;
}

/**
 * 리뷰 한 번을 끝까지 부른다(호출 → 파싱 → 검증). 부르는 방법(ask)은 바깥에서 준다 —
 * claude-code 모드는 도구 없는 로컬 CLI 한 번 호출, api 모드는 ModelClient 어댑터(계획 호출과 같은 ModelAsk).
 */
export async function requestPrReview(
  ask: ModelAsk,
  input: {
    diff: string;
    requests: readonly string[];
    round: number;
    omittedFiles?: readonly string[];
    requirementsContext?: string;
    externalContext?: string;
    resolvedContext?: string;
  },
  signal?: AbortSignal,
): Promise<{ findings: PrReviewFinding[]; usage: AgentUsage; durationMs: number }> {
  const started = performance.now();
  const answer = await ask({ system: buildPrReviewSystemPrompt(), user: buildPrReviewUserPrompt(input) }, signal);
  const durationMs = Math.round(performance.now() - started);
  const { text, usage } = answer;
  try {
    return { findings: parsePrReviewReply(text), usage, durationMs };
  } catch (error) {
    if (error instanceof PrReviewError) {
      error.usage = usage;
      error.durationMs = durationMs;
    }
    throw error;
  }
}
