import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildPrReviewComment,
  buildPrReviewExternalContext,
  buildPrReviewFixRequest,
  buildPrReviewResolvedContext,
  buildPrReviewUserPrompt,
  buildReviewResolutionComment,
  diffFilePaths,
  extractDiffReferencedNames,
  extractPrReviewFixTitles,
  hasBlockingFindings,
  isBlockingFinding,
  nextPrReviewStep,
  prReviewMarker,
  severityCounts,
  truncateDiff,
} from './pr-review';

/**
 * pr-review의 순수 판정·글 만들기를 Rust로 옮기면서(ADR-191 3g) 옛 TS 구현을 아래 `legacy`에 그대로 두고, 같은 무작위 입력을 옛 구현과
 * 새 껍데기에 넣어 결과를 JSON.stringify 글자(키 순서 포함)로 견준다. `legacy`는 옮기기 전 `pr-review.ts`의 해당 함수들이다
 * (`export`만 뗐고, 쉼표로 묶는 `toLocaleString()`만 로케일을 'en-US'로 고정했다). 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * 견줄 때 두 쪽 결과의 짝 없는 서로게이트를 U+FFFD로 바꾼다(`toWellFormed`): Rust 경계는 서로게이트 쌍을 가르는 자르기를 U+FFFD로
 * 돌려주고 JS는 짝 없는 절반을 남긴다(의도한 차이). 입력에는 서로게이트를 쌍으로만 넣는다.
 *
 * 크기는 환경 변수로 바꾼다: PR_REVIEW_DIFF_SEEDS(쉼표 목록), PR_REVIEW_DIFF_ITERATIONS, PR_REVIEW_DIFF_REPORT=1(분포 출력), PR_REVIEW_DIFF_REPORT_FILE(출력 파일)
 */
const legacy = (() => {
type PrReviewSeverity = 'blocker' | 'major' | 'minor' | 'nit';
interface PrReviewFinding {
  severity: PrReviewSeverity;
  file: string;
  line?: number;
  title: string;
  detail: string;
  suggestion?: string;
}

/** 차단 사유로 보는 심각도 */
const BLOCKING_SEVERITIES = new Set<PrReviewSeverity>(['blocker', 'major']);

/** 지적 하나가 차단 사유인지(차단·주요). 사람이 라운드 화면에서 지적을 오탐으로 닫을 때(과제 67-b)도 이 기준으로 "막는 지적"을 고른다 */
function isBlockingFinding(finding: Pick<PrReviewFinding, 'severity'>): boolean {
  return BLOCKING_SEVERITIES.has(finding.severity);
}

function hasBlockingFindings(findings: readonly PrReviewFinding[]): boolean {
  return findings.some(isBlockingFinding);
}

function severityCounts(findings: readonly PrReviewFinding[]): Record<PrReviewSeverity, number> {
  const counts: Record<PrReviewSeverity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

type PrReviewRoundOutcome = 'pass' | 'cap' | 'fix';

/**
 * 이번 라운드 뒤 무엇을 할지 정하는 순수 함수(라운드 상태 기계의 핵심).
 * pass: 차단·주요 지적이 없다 → 사람 검토 대기. cap: 지적은 남았지만 라운드 상한에 이르렀다 → 사람에게 넘긴다.
 * fix: 지적이 있고 라운드가 남았다 → 같은 세션에 고쳐 달라고 보낸다.
 */
function nextPrReviewStep(findings: readonly PrReviewFinding[], round: number, maxRounds: number): PrReviewRoundOutcome {
  if (!hasBlockingFindings(findings)) return 'pass';
  if (round >= maxRounds) return 'cap';
  return 'fix';
}

const PR_REVIEW_DIFF_MAX_CHARS = 60_000;

interface TruncatedDiff {
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
function truncateDiff(diff: string, maxChars: number = PR_REVIEW_DIFF_MAX_CHARS): TruncatedDiff {
  if (diff.length <= maxChars) return { diff, truncated: false, omittedFiles: [] };

  if (!diff.includes('diff --git ')) {
    return {
      diff: `${diff.slice(0, maxChars)}\n\n<!-- 크기 제한(${maxChars.toLocaleString('en-US')}자)으로 diff 뒷부분을 생략했습니다 -->\n`,
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
    const note = `diff --git a/${path} b/${path}\n<!-- 파일이 커서 생략했습니다 (${size.toLocaleString('en-US')}자) -->`;
    total += note.length - kept[index]!.length;
    kept[index] = note;
    omitted.push(path);
  }
  return { diff: kept.join('\n'), truncated: omitted.length > 0 || diff.length > maxChars, omittedFiles: omitted };
}

/** diff에 실제로 들어 있는 파일 경로들(diffFileSections의 path만). 바깥 참고 파일을 뽑을 때(과제 67-a) 이미 diff에 있는 파일은 또 넣지 않으려고 쓴다 */
function diffFilePaths(diff: string): string[] {
  return splitDiffFiles(diff).map((section) => section.path);
}

/** 전부 대문자인 식별자(SQL, API, URL 등 흔한 약어)는 클래스 이름 후보에서 뺀다 */
function looksLikeAcronym(identifier: string): boolean {
  return identifier === identifier.toUpperCase();
}

/**
 * diff의 추가된 줄에서 "이 PR이 가리키지만 diff에는 없는" 파일 이름 후보를 뽑는다(과제 67-a) — 상대 경로 import(JS/TS),
 * Java/Kotlin·Python의 import문이 가리키는 마지막 이름, 파스칼 케이스 식별자(클래스 이름 관례)를 모은다.
 * 실제로 그 이름의 파일을 찾아 읽는 것은 호출하는 쪽(sessions.ts, 작업 복사본에 접근할 수 있는 곳)이 한다 — 이 함수는
 * diff 텍스트만 보는 순수 함수라 세션·파일시스템 없이 vitest로 검증한다. 지운 줄은 보지 않는다(이제 없는 코드라 찾을 필요가 없다)
 */
function extractDiffReferencedNames(diff: string): string[] {
  const names = new Set<string>();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const body = line.slice(1);

    const relativeImport = /\bfrom\s+['"](\.[^'"]+)['"]/.exec(body) ?? /\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/.exec(body);
    if (relativeImport) {
      const base = relativeImport[1]!.split('/').pop()!.replace(/\.(tsx?|jsx?)$/, '');
      if (base) names.add(base);
    }

    const pythonImport = /^\s*from\s+[\w.]+\s+import\s+(\w+)/.exec(body);
    const dottedImport = pythonImport ?? /^\s*import\s+(?:static\s+)?([\w.]+)\s*;?\s*$/.exec(body);
    if (dottedImport) {
      const last = dottedImport[1]!.includes('.') ? dottedImport[1]!.split('.').pop()! : dottedImport[1]!;
      if (last && last !== '*') names.add(last);
    }

    for (const match of body.matchAll(/\b[A-Z][a-zA-Z0-9]{2,40}\b/g)) {
      if (!looksLikeAcronym(match[0])) names.add(match[0]);
    }
  }
  return [...names];
}

const PR_REVIEW_EXTERNAL_CONTEXT_MAX_CHARS = 8_000;
const PR_REVIEW_EXTERNAL_CONTEXT_MAX_FILES = 5;

interface ExternalFileExcerpt {
  path: string;
  excerpt: string;
}

/**
 * diff 밖 파일의 짧은 미리보기를 리뷰어 프롬프트에 붙일 섹션으로 만든다(과제 67-a) — 실제 PostgreSQL 시퀀스를
 * 복원하는 SeedLoader처럼, diff가 가리키기만 하고 보여주지 않는 코드 때문에 오탐이 나던 문제를 줄인다.
 * 상한을 넘으면 앞에서부터 채우고 자른다(파일 개수는 호출하는 쪽이 PR_REVIEW_EXTERNAL_CONTEXT_MAX_FILES로 이미 제한한다).
 */
function buildPrReviewExternalContext(files: readonly ExternalFileExcerpt[], maxChars: number = PR_REVIEW_EXTERNAL_CONTEXT_MAX_CHARS): string {
  if (files.length === 0) return '';
  const header = '[diff 밖 참고 파일 — diff가 가리키지만 보여주지 않은 코드입니다. 이미 저장소에 있으니 "없다"고 단정하지 마세요]';
  let used = header.length;
  const blocks: string[] = [header];
  for (const file of files) {
    const block = `--- ${file.path} ---\n${file.excerpt}`;
    if (used + block.length + 1 > maxChars) break;
    blocks.push(block);
    used += block.length + 1;
  }
  return blocks.join('\n\n');
}


/** 리뷰어에게 주는 요청별 사용자 메시지: 라운드 번호, 원래 요청들, (잘렸으면) 생략 안내, diff */
function buildPrReviewUserPrompt({
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
  const requestList = requests.length > 0 ? requests.map((request, index) => `${index + 1}. ${request}`).join('\n') : '(기록 없음)';
  const omittedNote = omittedFiles.length > 0 ? `\n(크기 제한으로 다음 파일은 diff에서 생략했습니다: ${omittedFiles.join(', ')})\n` : '';
  const requirementsNote = requirementsContext?.trim() ? `\n${requirementsContext.trim()}\n` : '';
  const externalNote = externalContext?.trim() ? `\n${externalContext.trim()}\n` : '';
  const resolvedNote = resolvedContext?.trim() ? `\n${resolvedContext.trim()}\n` : '';
  return `Review round ${round}.

User's original requests for this session, in order:
${requestList}
${omittedNote}${requirementsNote}${resolvedNote}
Diff (base...head):
\`\`\`diff
${diff}
\`\`\`
${externalNote}`;
}

/** 코멘트마다 붙이는 숨은 표시. 라운드별로 값이 달라 같은 PR에 여러 라운드 코멘트가 쌓여도 구분된다 */
function prReviewMarker(round: number): string {
  return `<!-- b-studio-review round=${round} -->`;
}

const SEVERITY_LABEL: Record<PrReviewSeverity, string> = { blocker: '차단', major: '주요', minor: '경미', nit: '사소' };

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 500);
}

/**
 * 이 라운드가 본 커밋 범위(diff의 끝 커밋은 항상 있다 — 다음에 새 커밋이 쌓이면 이 값이 다음 리뷰의 시작점이
 * 된다). since는 이미 열린 PR에 새 커밋이 쌓여 그 범위만 다시 본 라운드에만 있다 — 세션 시작부터 보는 첫
 * 리뷰는 전체를 보는 게 당연해 따로 표시하지 않는다
 */
interface PrReviewCommitRange {
  since?: string;
  head: string;
}

/** PR 코멘트 본문(한국어 표 + 숨은 표시). GitHub·Gitea 코멘트 API로 그대로 올린다 */
function buildPrReviewComment({
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
  const counts = severityCounts(findings);
  const summary = `차단 ${counts.blocker} · 주요 ${counts.major} · 경미 ${counts.minor} · 사소 ${counts.nit}`;
  const rangeNote = commitRange?.since ? `\n\n커밋 범위: \`${commitRange.since.slice(0, 7)}\`..\`${commitRange.head.slice(0, 7)}\`` : '';
  const header = `## 🤖 AI 리뷰 — 라운드 ${round}/${maxRounds}${rangeNote}\n\n${summary}`;
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

interface PrReviewResolvedFinding {
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
function buildPrReviewResolvedContext(resolved: readonly PrReviewResolvedFinding[]): string {
  if (resolved.length === 0) return '';
  const lines = resolved.map((finding) => {
    const location = `${finding.file}${finding.line ? `:${finding.line}` : ''}`;
    return `- [${SEVERITY_LABEL[finding.severity]}] \`${location}\` — ${finding.title}: 사람이 오탐으로 닫았습니다(${finding.reason})`;
  });
  return `[이미 사람이 확인한 지적 — 새 근거 없이 되풀이하지 마세요]\n${lines.join('\n')}`;
}

/** 사람이 지적 하나를 오탐으로 닫을 때 PR에 답글처럼 남기는 코멘트(과제 67-b). 라운드 코멘트와 같은 댓글 API(postComment)로 올린다 */
function buildReviewResolutionComment(finding: PrReviewFinding, reason: string): string {
  const location = `${finding.file}${finding.line ? `:${finding.line}` : ''}`;
  return `## 🙋 사람이 리뷰 지적을 확인했습니다\n\n> [${SEVERITY_LABEL[finding.severity]}] \`${location}\` — ${finding.title}\n\n오탐으로 닫습니다: ${reason}`;
}

/** 고침 요청 글의 맨 앞에 붙는 표시. extractPrReviewFixTitles가 이 표시로 AI 리뷰 고침 요청(보통 사용자 요청과 다름)을 알아본다 */
const PR_REVIEW_FIX_MARKER = '[b-studio AI 리뷰]';

/** 지적을 고쳐 달라는 후속 요청 문구. 같은 세션의 정상 요청 경로(sendMessage)로 보내 검증 게이트·체크포인트를 그대로 거치게 한다.
 * 지적 제목은 **굵게** 감싸 둔다 — extractPrReviewFixTitles(아래)가 이 표시로 커밋 제목에 쓸 지적 제목들을 다시 뽑는다(과제 66) */
function buildPrReviewFixRequest(findings: readonly PrReviewFinding[]): string {
  const blocking = findings.filter((finding) => BLOCKING_SEVERITIES.has(finding.severity));
  const items = blocking.map((finding, index) => {
    const location = `${finding.file}${finding.line ? `:${finding.line}` : ''}`;
    const suggestion = finding.suggestion ? ` 제안: ${finding.suggestion}` : '';
    return `${index + 1}. [${SEVERITY_LABEL[finding.severity]}] \`${location}\` — **${finding.title}**: ${finding.detail}${suggestion}`;
  });
  return `${PR_REVIEW_FIX_MARKER} 이 PR을 리뷰해 다음 차단·주요 지적을 찾았습니다. 아래 항목만 고치고, 관련 없는 다른 변경은 하지 마세요.\n\n${items.join('\n')}`;
}

/**
 * buildPrReviewFixRequest가 만든 고침 요청 글에서 지적 제목들만 뽑는다(commit-message.ts의 generateCommitSubject가 과제 66을 고치는 데 쓴다) —
 * 요청 글 첫 문장이 "이 PR을 리뷰해 ... 찾았습니다" 같은 공통 문구라 그대로 커밋 제목에 쓰면 의미가 없던 버그를 고친다.
 * 이 표시로 시작하지 않으면(보통의 사용자 요청) undefined를 돌려줘 generateCommitSubject가 평소 경로를 그대로 쓰게 한다.
 */
function extractPrReviewFixTitles(request: string): string[] | undefined {
  if (!request.startsWith(PR_REVIEW_FIX_MARKER)) return undefined;
  const titles = [...request.matchAll(/\*\*(.+?)\*\*/g)].map((match) => match[1]!.trim()).filter(Boolean);
  return titles.length > 0 ? titles : undefined;
}


  return {
    isBlockingFinding,
    hasBlockingFindings,
    severityCounts,
    nextPrReviewStep,
    truncateDiff,
    diffFilePaths,
    extractDiffReferencedNames,
    buildPrReviewExternalContext,
    buildPrReviewUserPrompt,
    prReviewMarker,
    buildPrReviewComment,
    buildPrReviewResolvedContext,
    buildReviewResolutionComment,
    buildPrReviewFixRequest,
    extractPrReviewFixTitles,
    PR_REVIEW_DIFF_MAX_CHARS,
    PR_REVIEW_EXTERNAL_CONTEXT_MAX_CHARS,
  };
})();

// ── 무작위 입력
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;
const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
const chance = (rng: Rng, p: number): boolean => rng() < p;

const ODD = ['\u{1F600}', '\u{1F9D1}‍\u{1F4BB}', '﻿', ' ', ' ', ' ', '　', '\u0085', '한글', '가', '\r', '\t', '|', '\\', '`', '*', '**', '_', '#', '<', '>', '&', 'é', '́'];
const SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
const WORDS = ['alpha', 'Beta', 'OrderService', 'SeedLoader', 'HTTP', 'URL', 'SQL', 'ApiClient', 'Ab', 'A1B2', 'My_Class', 'userId', 'JSON', 'PostgreSQL', 'shorts', 'index', 'main', 'util', 'R22', 'R1.2'];

function text(rng: Rng, max = 6): string {
  const parts: string[] = [];
  for (let i = 0, n = int(rng, 0, max); i < n; i++) parts.push(chance(rng, 0.25) ? pick(rng, ODD) : pick(rng, WORDS));
  return parts.join(pick(rng, [' ', ' ', ' ', '', '-', '/', '.', '\n', '\r\n', '  ']));
}

/** 길이가 경계(500·160·2000 등) 근처인 글: 서로게이트 쌍이 끊는 자리에 오는 것을 막지 않는다(쌍이 가려지면 U+FFFD로 같게 견준다) */
function longText(rng: Rng): string {
  const base = text(rng, 4);
  const unit = pick(rng, ['x', '가', '\u{1F600}', '|', 'ab\n', ' ', ' ']);
  const target = pick(rng, [498, 499, 500, 501, 502, 7, 6, 8, int(rng, 0, 700)]);
  return (base + unit.repeat(Math.ceil(target / unit.length))).slice(0, target + int(rng, 0, 3)).replace(/[\uD800-\uDBFF]$/, '');
}

interface Finding {
  severity: string;
  file: string;
  line?: number;
  title: string;
  detail: string;
  suggestion?: string;
}

function finding(rng: Rng, allowUnknown: boolean): Finding {
  const f: Finding = {
    severity: allowUnknown && chance(rng, 0.03) ? pick(rng, ['urgent', '', 'Blocker']) : pick(rng, SEVERITIES),
    file: chance(rng, 0.2) ? longText(rng) : pick(rng, ['a.ts', 'apps/studio/lib/server/sessions.ts', 'src/main/java/Foo.java', text(rng, 3) || 'f']),
    title: chance(rng, 0.2) ? longText(rng) || 't' : text(rng, 4) || 't',
    detail: chance(rng, 0.25) ? longText(rng) || 'd' : text(rng, 8) || 'd',
  };
  const lineKind = int(rng, 0, 5);
  if (lineKind === 1) f.line = int(rng, 1, 5000);
  else if (lineKind === 2) f.line = 0;
  else if (lineKind === 3) f.line = pick(rng, [1.5, 1e21, 1e-7, -3, 123456789012]);
  else if (lineKind === 4) f.line = int(rng, 1, 9);
  if (chance(rng, 0.45)) f.suggestion = chance(rng, 0.2) ? longText(rng) || 's' : text(rng, 6) || 's';
  else if (chance(rng, 0.05)) f.suggestion = '';
  return f;
}

function findings(rng: Rng, allowUnknown = true): Finding[] {
  const n = chance(rng, 0.2) ? 0 : int(rng, 1, 7);
  return Array.from({ length: n }, () => finding(rng, allowUnknown));
}

const IMPORT_LINES = [
  "import { a } from './foo/bar.ts';",
  'import x from "../baz.tsx";',
  "const a = require('./q.js')",
  "const b = require( './r' )",
  "import y from './dir/'",
  "import z from '.'",
  "import w from './a.test.ts'",
  "import v from './x.d.ts.jsx'",
  "export * from './idx'",
  "import q from 'pkg'",
  'from pkg.mod import Name',
  'from . import thing',
  'from a.b import c, d',
  '  from deep.mod import Inner',
  'import os',
  'import static org.junit.Assert.*;',
  'import static org.junit.Assert.assertEquals;',
  'import java.util.List;',
  'import java.util.*;',
  'import a.b.c.D',
  'import static',
  'import  Foo  ;',
  'import com.example.OrderService',
  '\timport\tcom.x.Y;',
  'class SeedLoader extends BaseLoader {',
  'const url = new URL(HTTP_BASE)',
  'let AbcdefghijklmnopqrstuvwxyzAbcdefghijklmnopqrstuvwxyz = 1',
  'Abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrs xxxxx',
  'new MyClass(OrderService.of(Customer))',
  '+++ not a header',
  '',
  'return PostgreSQL.connect(SQL)',
];

function bodyLine(rng: Rng): string {
  const kind = int(rng, 0, 9);
  if (kind <= 3) return `+${pick(rng, IMPORT_LINES)}`;
  if (kind === 4) return `+${text(rng, 6)}`;
  if (kind === 5) return `-${pick(rng, IMPORT_LINES)}`;
  if (kind === 6) return ` ${text(rng, 4)}`;
  if (kind === 7) return pick(rng, ['+++ b/x.ts', '--- a/x.ts', '@@ -1,2 +3,4 @@', 'index abc..def 100644', 'Binary files a/x.png and b/x.png differ', '\\ No newline at end of file', '+', '++x', '+\r', '+  ', '+ x']);
  if (kind === 8) return `+${pick(rng, WORDS)}${'x'.repeat(int(rng, 0, 90))}`;
  return `+${pick(rng, IMPORT_LINES)} ${pick(rng, WORDS)}`;
}

const PATHS = ['a.ts', 'src/app/page.tsx', 'apps/studio/lib/server/sessions.ts', 'x y/z.ts', 'dir/한글.ts', 'a b/c', 'weird b/name b/inner.ts', '😀.ts', 'a.txt', 'résumé.md'];

function headerLine(rng: Rng): string {
  const kind = int(rng, 0, 20);
  const p = pick(rng, PATHS);
  const q = chance(rng, 0.2) ? pick(rng, PATHS) : p;
  if (kind === 0) return `diff --git a/${p}`;
  if (kind === 1) return `diff --git a/${p} b/`;
  if (kind === 2) return `diff --git a/${p} b/${q}\r`;
  if (kind === 3) return `diff --git a/${p} b/${q} z`;
  if (kind === 4) return `diff --git ${p} ${q}`;
  if (kind === 5) return 'diff --git ';
  if (kind === 6) return `diff --git a/ b/${q}`;
  if (kind === 7) return `diff --git a/${p} b/${q} b/${p}`;
  if (kind === 8) return ` diff --git a/${p} b/${q}`;
  return `diff --git a/${p} b/${q}`;
}

function fileDiff(rng: Rng): string {
  const lines = [headerLine(rng)];
  if (chance(rng, 0.6)) lines.push('index abc..def 100644', `--- a/${pick(rng, PATHS)}`, `+++ b/${pick(rng, PATHS)}`);
  else if (chance(rng, 0.3)) lines.push('similarity index 90%', 'rename from old.ts', 'rename to new.ts');
  else if (chance(rng, 0.2)) lines.push('Binary files a/x.png and b/x.png differ');
  if (chance(rng, 0.8)) lines.push('@@ -1,3 +1,4 @@');
  for (let i = 0, n = int(rng, 0, chance(rng, 0.15) ? 60 : 8); i < n; i++) lines.push(bodyLine(rng));
  return lines.join(chance(rng, 0.03) ? '\r\n' : '\n');
}

function diffText(rng: Rng): string {
  const kind = int(rng, 0, 11);
  if (kind === 0) return '';
  if (kind === 1) return text(rng, 10); // diff --git 없음
  if (kind === 2) return `x diff --git a/y b/y\n${bodyLine(rng)}`; // 줄 중간에만 있다
  const parts: string[] = [];
  if (chance(rng, 0.25)) parts.push(text(rng, 3)); // 첫 머리 줄 앞의 글
  for (let i = 0, n = int(rng, 1, 6); i < n; i++) parts.push(fileDiff(rng));
  const joined = parts.join('\n');
  return chance(rng, 0.2) ? `${joined}\n` : joined;
}

function boundaryMax(rng: Rng, length: number): number {
  const kind = int(rng, 0, 12);
  if (kind === 0) return legacy.PR_REVIEW_DIFF_MAX_CHARS;
  if (kind <= 2) return length;
  if (kind === 3) return length - 1;
  if (kind === 4) return length + 1;
  if (kind === 5) return Math.max(0, length - 2);
  if (kind === 6) return Math.floor(length / 2);
  if (kind === 7) return int(rng, 0, 40);
  if (kind === 8) return Math.floor(length * rng() * 1.2);
  if (kind === 9) return pick(rng, [0, 1, 2, 1000, 1234567, -1, -5, Infinity]);
  return Math.max(0, Math.floor(length * (0.3 + rng() * 0.7)));
}

// ── 견주기
/** `String.prototype.toWellFormed`(짝 없는 서로게이트를 U+FFFD로) */
const toWellFormed = (text: string): string => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
const wellFormed = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => (typeof item === 'string' ? toWellFormed(item) : item));
function outcome(run: () => unknown): string {
  try {
    return `ok:${wellFormed(run())}`;
  } catch {
    return 'throws';
  }
}

interface Tally {
  compared: number;
  different: number;
  distribution: Map<string, number>;
  examples: string[];
  passFlips: number;
}
const tallies = new Map<string, Tally>();
function tally(name: string): Tally {
  let t = tallies.get(name);
  if (!t) tallies.set(name, (t = { compared: 0, different: 0, distribution: new Map(), examples: [], passFlips: 0 }));
  return t;
}
function compare(name: string, input: unknown, a: () => unknown, b: () => unknown, bucket: (result: string) => string): void {
  const t = tally(name);
  const left = outcome(a);
  const right = outcome(b);
  t.compared += 1;
  const key = bucket(left);
  t.distribution.set(key, (t.distribution.get(key) ?? 0) + 1);
  if (left !== right) {
    t.different += 1;
    if (t.examples.length < 3) t.examples.push(`${JSON.stringify(input).slice(0, 300)}\n  옛: ${left.slice(0, 200)}\n  새: ${right.slice(0, 200)}`);
  }
}

const SEEDS = (process.env.PR_REVIEW_DIFF_SEEDS ?? '1,7,42,2026').split(',').map(Number);
const ITERATIONS = Number(process.env.PR_REVIEW_DIFF_ITERATIONS ?? 4000);
const REPORT = process.env.PR_REVIEW_DIFF_REPORT === '1';
/** 분포 출력. 환경 변수 PR_REVIEW_DIFF_REPORT_FILE이 있으면 그 파일에 덧붙인다(vitest가 통과한 시험의 출력을 숨긴다) */
function report(line: string): void {
  const file = process.env.PR_REVIEW_DIFF_REPORT_FILE;
  if (file) appendFileSync(file, `${line}\n`);
  else console.log(line);
}

function runSeed(seed: number): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < ITERATIONS; i++) {
    // 심각도 판정
    const fs = findings(rng, false);
    compare('isBlockingFinding', fs[0], () => (fs[0] ? legacy.isBlockingFinding(fs[0] as never) : null), () => (fs[0] ? isBlockingFinding(fs[0] as never) : null), (r) => r);
    compare('hasBlockingFindings', fs, () => legacy.hasBlockingFindings(fs as never), () => hasBlockingFindings(fs as never), (r) => r);
    compare('severityCounts', fs, () => legacy.severityCounts(fs as never), () => severityCounts(fs as never), (r) => (r.includes('"blocker":0,"major":0,"minor":0,"nit":0') ? '모두 0' : '값 있음'));

    // 라운드 판정(경계: round == maxRounds, 차단 있음/없음)
    const maxRounds = int(rng, 0, 5);
    const round = pick(rng, [maxRounds, maxRounds - 1, maxRounds + 1, int(rng, 0, 6), 1.5, NaN, Infinity]);
    const maxR = chance(rng, 0.05) ? pick(rng, [NaN, 2.5, Infinity, -1]) : maxRounds;
    const old = outcome(() => legacy.nextPrReviewStep(fs as never, round, maxR));
    compare('nextPrReviewStep', { fs, round, maxR }, () => legacy.nextPrReviewStep(fs as never, round, maxR), () => nextPrReviewStep(fs as never, round, maxR), (r) => r);
    if (old !== 'ok:"pass"' && outcome(() => nextPrReviewStep(fs as never, round, maxR)) === 'ok:"pass"') tally('nextPrReviewStep').passFlips += 1;

    // diff
    const diff = diffText(rng);
    const max = boundaryMax(rng, diff.length);
    compare('truncateDiff', { diff, max }, () => legacy.truncateDiff(diff, max), () => truncateDiff(diff, max), (r) => (r.includes('"truncated":false') ? '안 자름' : r.includes('"omittedFiles":[]') ? '통째로 자름' : '파일 생략'));
    compare('diffFilePaths', diff, () => legacy.diffFilePaths(diff), () => diffFilePaths(diff), (r) => (r === 'ok:[""]' || r === 'ok:[]' ? '빈 경로' : '경로 있음'));
    compare('extractDiffReferencedNames', diff, () => legacy.extractDiffReferencedNames(diff), () => extractDiffReferencedNames(diff), (r) => (r === 'ok:[]' ? '빈 결과' : '이름 있음'));

    // 바깥 파일 미리보기
    const files = Array.from({ length: int(rng, 0, 6) }, () => ({ path: text(rng, 3) || 'p', excerpt: chance(rng, 0.2) ? longText(rng) : text(rng, 10) }));
    const header = legacy.buildPrReviewExternalContext(files.slice(0, 1), 1e9).split('\n\n')[0]!;
    let used = header.length;
    const marks = [used];
    for (const f of files) {
      used += `--- ${f.path} ---\n${f.excerpt}`.length + 1;
      marks.push(used);
    }
    const mark = pick(rng, marks);
    const extMax = pick(rng, [mark, mark - 1, mark + 1, mark - 2, header.length, header.length - 1, 0, legacy.PR_REVIEW_EXTERNAL_CONTEXT_MAX_CHARS, int(rng, 0, 400), NaN, -1]);
    compare('buildPrReviewExternalContext', { files, extMax }, () => legacy.buildPrReviewExternalContext(files, extMax), () => buildPrReviewExternalContext(files, extMax), (r) => (r === 'ok:""' ? '빈 결과' : r.includes('--- ') ? '파일 있음' : '머리만'));

    // 프롬프트
    const promptInput = {
      diff: chance(rng, 0.5) ? diff : text(rng, 6),
      requests: Array.from({ length: int(rng, 0, 4) }, () => text(rng, 6)),
      round: pick(rng, [1, 2, 3, 0, 1.5, NaN, 1e21, -0, 123456789.125]),
      ...(chance(rng, 0.7) ? { omittedFiles: Array.from({ length: int(rng, 0, 3) }, () => text(rng, 2)) } : {}),
      requirementsContext: chance(rng, 0.4) ? pick(rng, ['', '  ', '\n', text(rng, 5), `  ${text(rng, 5)}\n `, '﻿ x  ']) : undefined,
      externalContext: chance(rng, 0.4) ? pick(rng, ['', ' \t ', text(rng, 5), `\n${text(rng, 5)}\n`]) : undefined,
      resolvedContext: chance(rng, 0.4) ? pick(rng, ['', '　', text(rng, 5)]) : undefined,
    };
    compare('buildPrReviewUserPrompt', promptInput, () => legacy.buildPrReviewUserPrompt(promptInput), () => buildPrReviewUserPrompt(promptInput), (r) => (r.includes('기록 없음') ? '요청 없음' : '요청 있음'));
    compare('prReviewMarker', promptInput.round, () => legacy.prReviewMarker(promptInput.round), () => prReviewMarker(promptInput.round), () => '글');

    // 코멘트
    const cf = findings(rng);
    const commitRange = pick(rng, [
      undefined,
      { head: 'abcdef1234567890' },
      { since: '1234567890abcdef', head: 'abcdef1234567890' },
      { since: '', head: 'abc' },
      { since: 'abc', head: '' },
      { since: '\u{1F600}'.repeat(5), head: '\u{1F600}'.repeat(5) },
      { since: 'a'.repeat(int(rng, 0, 12)), head: 'b'.repeat(int(rng, 0, 12)) },
    ]);
    const commentInput = {
      round: pick(rng, [1, 2, 3, 1.5, NaN, Infinity]),
      maxRounds: pick(rng, [1, 3, 5, 2.5, 0]),
      findings: cf,
      outcome: pick(rng, ['pass', 'cap', 'fix'] as const),
      ...(chance(rng, 0.6) ? { omittedFiles: Array.from({ length: int(rng, 0, 3) }, () => text(rng, 2)) } : {}),
      ...(commitRange ? { commitRange } : {}),
    };
    compare('buildPrReviewComment', commentInput, () => legacy.buildPrReviewComment(commentInput as never), () => buildPrReviewComment(commentInput as never), (r) => (r.includes('지적할 내용이 없습니다') ? '지적 없음' : r.includes('커밋 범위') ? '표+범위' : '표'));

    // 닫은 지적·확인 코멘트·고침 요청
    const resolved = findings(rng).map((f) => ({ severity: f.severity, file: f.file, ...(f.line !== undefined ? { line: f.line } : {}), title: f.title, reason: text(rng, 5) }));
    compare('buildPrReviewResolvedContext', resolved, () => legacy.buildPrReviewResolvedContext(resolved as never), () => buildPrReviewResolvedContext(resolved as never), (r) => (r === 'ok:""' ? '빈 결과' : '목록'));
    const one = finding(rng, true);
    const reason = text(rng, 6);
    compare('buildReviewResolutionComment', { one, reason }, () => legacy.buildReviewResolutionComment(one as never, reason), () => buildReviewResolutionComment(one as never, reason), () => '글');
    const fixFindings = findings(rng);
    compare('buildPrReviewFixRequest', fixFindings, () => legacy.buildPrReviewFixRequest(fixFindings as never), () => buildPrReviewFixRequest(fixFindings as never), (r) => (r.includes('1. [') ? '항목 있음' : '항목 없음'));

    // 고침 요청에서 제목 뽑기: 실제 만든 글, 표시만 있는 글, 표시 없는 글, 별표가 섞인 글
    const request = pick(rng, [
      legacy.buildPrReviewFixRequest(fixFindings as never),
      `[b-studio AI 리뷰] ${text(rng, 8)}`,
      `[b-studio AI 리뷰] **${text(rng, 3)}** x **${text(rng, 2)}**`,
      `x [b-studio AI 리뷰] **a**`,
      `[b-studio AI 리뷰]\n**a**\n**b** ** c**\r**d**`,
      `[b-studio AI 리뷰] ****`,
      `[b-studio AI 리뷰] ***a***  ** **  ** t **`,
      `[b-studio AI 리뷰] **a**b**c**d**`,
      text(rng, 6),
      '',
    ]);
    compare('extractPrReviewFixTitles', request, () => legacy.extractPrReviewFixTitles(request), () => extractPrReviewFixTitles(request), (r) => (r === 'ok:undefined' || r === 'ok:' ? '없음' : '제목 있음'));
  }
}

describe('pr-review 차등 시험(옛 TS와 Rust 껍데기)', () => {
  for (const seed of SEEDS) {
    it(`시드 ${seed}: ${ITERATIONS}회 × 함수 15개가 옛 TS와 같다`, () => {
      runSeed(seed);
    }, 600_000);
  }

  it('모든 함수에서 다른 결과가 0이고, pass로 뒤집힌 판정이 0이다', () => {
    if (REPORT) {
      for (const [name, t] of tallies) {
        report(`${name}: 비교 ${t.compared}, 다름 ${t.different}, 분포 ${JSON.stringify(Object.fromEntries(t.distribution))}`);
      }
      report(`nextPrReviewStep에서 옛 fix·cap이 새 pass로 뒤집힌 수: ${tally('nextPrReviewStep').passFlips}`);
    }
    const bad = [...tallies].filter(([, t]) => t.different > 0).map(([name, t]) => `${name}: ${t.different}건\n${t.examples.join('\n')}`);
    expect(bad).toEqual([]);
    expect(tally('nextPrReviewStep').passFlips).toBe(0);
    expect(tallies.size).toBe(15);
  });

  it('결과 분포가 한쪽으로 쏠리지 않았다(함수마다 두 갈래 이상)', () => {
    const lopsided = [...tallies].filter(([name, t]) => !['prReviewMarker', 'buildReviewResolutionComment'].includes(name) && t.compared >= 1000 && t.distribution.size < 2).map(([name]) => name);
    expect(lopsided).toEqual([]);
  });

  it('대조 장치: 새 결과의 한 글자·키 순서만 바꿔도 차이로 잡힌다', () => {
    const base = legacy.truncateDiff('diff --git a/a b/a\n+x\ndiff --git a/b b/b\n+y\n', 30);
    const t = tally('대조');
    const wrongChar = { ...base, diff: base.diff.replace('a/a', 'a/b') };
    const wrongOrder = { omittedFiles: base.omittedFiles, truncated: base.truncated, diff: base.diff };
    const wrongNum = { ...base, truncated: !base.truncated };
    for (const alt of [wrongChar, wrongOrder, wrongNum]) {
      compare('대조', base, () => base, () => alt, () => '글');
    }
    expect(t.different).toBe(3);
    tallies.delete('대조');
  });
});
