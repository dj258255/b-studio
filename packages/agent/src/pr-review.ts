/**
 * PR 자동 리뷰 라운드(ADR-074).
 *
 * exportSession이 PR을 만든 뒤, 별도의 읽기 전용 리뷰어 호출로 base...head diff만 보고 구조화된 지적을 받는다.
 * 이름이 겹치지 않도록 워크플로 단계 'review'(에이전트 자체 점검)나 GitHub PR의 ReviewDecision(승인/변경 요청)과
 * 구별해 이 모듈의 타입은 모두 PrReview 접두어를 쓴다.
 *
 * 계획 호출(task-plan.ts)과 같은 모양(ModelAsk, parsePlannerReply)을 그대로 재사용한다:
 *   · 도구 없이 한 번만 묻고 JSON 하나만 받는다 — 리뷰어는 diff와 요청 문구만 보고, 파일 쓰기·명령 실행 도구가 없다
 *   · 실패해도 그때까지 쓴 토큰·시간은 오류에 남겨 둔다
 */
import { z } from 'zod';
import type { AgentUsage } from './loop';
import { parsePlannerReply, type ModelAsk } from './task-plan';

export const PR_REVIEW_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export type PrReviewSeverity = (typeof PR_REVIEW_SEVERITIES)[number];

/** 차단 사유로 보는 심각도. 스타일 지적은 이 등급으로 두지 못하게 프롬프트에서도 금지한다 */
const BLOCKING_SEVERITIES = new Set<PrReviewSeverity>(['blocker', 'major']);

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

export function hasBlockingFindings(findings: readonly PrReviewFinding[]): boolean {
  return findings.some((finding) => BLOCKING_SEVERITIES.has(finding.severity));
}

export function severityCounts(findings: readonly PrReviewFinding[]): Record<PrReviewSeverity, number> {
  const counts: Record<PrReviewSeverity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

export type PrReviewRoundOutcome = 'pass' | 'cap' | 'fix';

/**
 * 이번 라운드 뒤 무엇을 할지 정하는 순수 함수(라운드 상태 기계의 핵심).
 * pass: 차단·주요 지적이 없다 → 사람 검토 대기. cap: 지적은 남았지만 라운드 상한에 이르렀다 → 사람에게 넘긴다.
 * fix: 지적이 있고 라운드가 남았다 → 같은 세션에 고쳐 달라고 보낸다.
 */
export function nextPrReviewStep(findings: readonly PrReviewFinding[], round: number, maxRounds: number): PrReviewRoundOutcome {
  if (!hasBlockingFindings(findings)) return 'pass';
  if (round >= maxRounds) return 'cap';
  return 'fix';
}

export const PR_REVIEW_DIFF_MAX_CHARS = 60_000;

export interface TruncatedDiff {
  diff: string;
  truncated: boolean;
  /** 크기 때문에 본문을 생략한 파일. 큰 파일부터 생략한다 */
  omittedFiles: string[];
}

interface DiffFileSection {
  path: string;
  text: string;
}

/** unified diff를 'diff --git a/x b/y' 줄 기준으로 파일 구간으로 나눈다 */
function splitDiffFiles(diff: string): DiffFileSection[] {
  const lines = diff.split('\n');
  const sections: DiffFileSection[] = [];
  let current: string[] | undefined;
  let path = '';
  const flush = () => {
    if (current) sections.push({ path, text: current.join('\n') });
  };
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      current = [line];
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      path = match?.[2] ?? match?.[1] ?? line.slice('diff --git '.length);
    } else {
      (current ??= []).push(line);
    }
  }
  flush();
  return sections;
}

/**
 * diff가 상한을 넘으면 가장 큰 파일부터 본문을 생략 노트로 바꿔 상한 아래로 줄인다.
 * 작은 파일은 그대로 남겨 리뷰어가 대부분의 변경에서는 문맥을 잃지 않는다.
 * 'diff --git' 구분이 없는 입력(형식이 다르거나 비어 있음)은 통째로 잘라 노트를 붙인다.
 */
export function truncateDiff(diff: string, maxChars: number = PR_REVIEW_DIFF_MAX_CHARS): TruncatedDiff {
  if (diff.length <= maxChars) return { diff, truncated: false, omittedFiles: [] };

  if (!diff.includes('diff --git ')) {
    return {
      diff: `${diff.slice(0, maxChars)}\n\n<!-- 크기 제한(${maxChars.toLocaleString()}자)으로 diff 뒷부분을 생략했습니다 -->\n`,
      truncated: true,
      omittedFiles: [],
    };
  }

  const sections = splitDiffFiles(diff);
  const kept = sections.map((section) => section.text);
  const omitted: string[] = [];
  let total = kept.reduce((sum, text) => sum + text.length + 1, 0);
  const bySize = sections.map((section, index) => ({ index, size: section.text.length })).sort((a, b) => b.size - a.size);
  for (const { index, size } of bySize) {
    if (total <= maxChars) break;
    const path = sections[index]!.path;
    const note = `diff --git a/${path} b/${path}\n<!-- 파일이 커서 생략했습니다 (${size.toLocaleString()}자) -->`;
    total += note.length - kept[index]!.length;
    kept[index] = note;
    omitted.push(path);
  }
  return { diff: kept.join('\n'), truncated: omitted.length > 0 || diff.length > maxChars, omittedFiles: omitted };
}

/** 리뷰어에게 주는 고정 시스템 프롬프트. prompts.ts와 같은 문체(영어 지시, 사용자 언어로 답하라는 규칙은 여기선 JSON만 받으므로 없다) */
export function buildPrReviewSystemPrompt(): string {
  return `You are an independent reviewer for a pull request opened by a coding agent inside b-studio.
You see ONLY a diff between the PR's base and this session's head, plus the user's original requests — not the rest of the repository, and you have no tools to read more. Do not guess about code outside the diff.
Focus on: correctness bugs, security issues (injection, secrets, broken access checks), missing tests for new logic, and mismatches between the diff and what the user actually asked for.
Style, formatting, naming, and other nitpicks must NOT be reported as severity 'blocker' or 'major' — use 'minor' or 'nit' for those, or leave them out.
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
}: {
  diff: string;
  requests: readonly string[];
  round: number;
  omittedFiles?: readonly string[];
  /** 이 PR이 구현하는 요구사항의 압축 목록(requirement-issues.ts의 buildReviewRequirementsContext, ADR-092). 없으면(요구사항을 안 쓰거나 이 PR이 구현한 게 없으면) 빈 문자열 */
  requirementsContext?: string;
}): string {
  const requestList = requests.length > 0 ? requests.map((request, index) => `${index + 1}. ${request}`).join('\n') : '(기록 없음)';
  const omittedNote = omittedFiles.length > 0 ? `\n(크기 제한으로 다음 파일은 diff에서 생략했습니다: ${omittedFiles.join(', ')})\n` : '';
  const requirementsNote = requirementsContext?.trim() ? `\n${requirementsContext.trim()}\n` : '';
  return `Review round ${round}.

User's original requests for this session, in order:
${requestList}
${omittedNote}${requirementsNote}
Diff (base...head):
\`\`\`diff
${diff}
\`\`\``;
}

/** 코멘트마다 붙이는 숨은 표시. 라운드별로 값이 달라 같은 PR에 여러 라운드 코멘트가 쌓여도 구분된다 */
export function prReviewMarker(round: number): string {
  return `<!-- b-studio-review round=${round} -->`;
}

const SEVERITY_LABEL: Record<PrReviewSeverity, string> = { blocker: '차단', major: '주요', minor: '경미', nit: '사소' };

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 500);
}

/** PR 코멘트 본문(한국어 표 + 숨은 표시). GitHub·Gitea 코멘트 API로 그대로 올린다 */
export function buildPrReviewComment({
  round,
  maxRounds,
  findings,
  outcome,
  omittedFiles = [],
}: {
  round: number;
  maxRounds: number;
  findings: readonly PrReviewFinding[];
  outcome: PrReviewRoundOutcome;
  omittedFiles?: readonly string[];
}): string {
  const counts = severityCounts(findings);
  const summary = `차단 ${counts.blocker} · 주요 ${counts.major} · 경미 ${counts.minor} · 사소 ${counts.nit}`;
  const header = `## 🤖 AI 리뷰 — 라운드 ${round}/${maxRounds}\n\n${summary}`;
  const table =
    findings.length === 0
      ? '지적할 내용이 없습니다.'
      : [
          '| 심각도 | 위치 | 제목 | 설명 |',
          '|---|---|---|---|',
          ...findings.map((finding) => {
            const location = `${finding.file}${finding.line ? `:${finding.line}` : ''}`;
            const detail = finding.suggestion ? `${finding.detail} (제안: ${finding.suggestion})` : finding.detail;
            return `| ${SEVERITY_LABEL[finding.severity]} | \`${escapeCell(location)}\` | ${escapeCell(finding.title)} | ${escapeCell(detail)} |`;
          }),
        ].join('\n');
  const footer =
    outcome === 'pass'
      ? '차단·주요 지적이 없어 사람 검토를 기다립니다.'
      : outcome === 'cap'
        ? `라운드 상한(${maxRounds})에 도달해 남은 지적은 사람이 검토합니다.`
        : '차단·주요 지적을 고치도록 세션에 요청한 뒤 다시 리뷰합니다.';
  const omittedNote = omittedFiles.length > 0 ? `\n\n(참고: 크기 제한으로 다음 파일은 생략하고 리뷰했습니다: ${omittedFiles.join(', ')})` : '';
  return `${header}\n\n${table}\n\n${footer}${omittedNote}\n\n${prReviewMarker(round)}`;
}

/** 지적을 고쳐 달라는 후속 요청 문구. 같은 세션의 정상 요청 경로(sendMessage)로 보내 검증 게이트·체크포인트를 그대로 거치게 한다 */
export function buildPrReviewFixRequest(findings: readonly PrReviewFinding[]): string {
  const blocking = findings.filter((finding) => BLOCKING_SEVERITIES.has(finding.severity));
  const items = blocking.map((finding, index) => {
    const location = `${finding.file}${finding.line ? `:${finding.line}` : ''}`;
    const suggestion = finding.suggestion ? ` 제안: ${finding.suggestion}` : '';
    return `${index + 1}. [${SEVERITY_LABEL[finding.severity]}] \`${location}\` — ${finding.title}: ${finding.detail}${suggestion}`;
  });
  return `[b-studio AI 리뷰] 이 PR을 리뷰해 다음 차단·주요 지적을 찾았습니다. 아래 항목만 고치고, 관련 없는 다른 변경은 하지 마세요.\n\n${items.join('\n')}`;
}

/**
 * 리뷰 한 번을 끝까지 부른다(호출 → 파싱 → 검증). 부르는 방법(ask)은 바깥에서 준다 —
 * claude-code 모드는 도구 없는 로컬 CLI 한 번 호출, api 모드는 ModelClient 어댑터(계획 호출과 같은 ModelAsk).
 */
export async function requestPrReview(
  ask: ModelAsk,
  input: { diff: string; requests: readonly string[]; round: number; omittedFiles?: readonly string[]; requirementsContext?: string },
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
