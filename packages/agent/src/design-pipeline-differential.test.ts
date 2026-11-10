import { describe, expect, it } from 'vitest';
import { Gen, outcome, perturb, readEnvList, readEnvNumber, sameOutcome, type Outcome } from './differential-kit';
import * as current from './design-pipeline';
import type { DesignBundle, DesignDocRecord, ModelFamily } from './design-pipeline';

/**
 * 설계 파이프라인의 순수 함수(design-pipeline.ts)를 Rust로 옮기면서(ADR-191 3단계 3o) 옛 TS 구현을 아래 `legacy`에 그대로 두고, 같은 무작위 입력을
 * 옛 구현과 새 껍데기에 넣어 결과를 JSON 글자(키 순서·NaN·-0 포함)로 견준다. `legacy`는 옮기기 전 design-pipeline.ts의 본문이다(`export`·zod 스키마·파일 머리 설명만 뗐고,
 * slugifyTitle은 옛 docs.ts의 TS 본문을 그대로 붙였다). 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * 의도한 차이(입력에서 비켜 간다): 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다(옛 결과도 같게 맞춘다).
 * 열린 쪽 뒤집힘: 설계 승인 확인(checkDesignApproval)에서 옛 구현은 막았는데 새 구현이 막지 않은 수(막는 기록이 하나라도 빠진 수)를 따로 센다. 0이어야 한다.
 *
 * 크기는 환경 변수로 바꾼다: DESIGN_PIPELINE_DIFF_SEEDS(쉼표 목록), DESIGN_PIPELINE_DIFF_ITERATIONS, DESIGN_PIPELINE_DIFF_REPORT=1(분포 출력)
 */

// 옛 구현은 템플릿 글자를 그대로 두려고 들여쓰지 않는다(들여쓰면 템플릿 문자열이 달라진다)
const legacy = (() => {
/** 옛 docs.ts의 slugifyTitle(3k 이전 TS 본문) */
function slugifyTitle(title: string): string {
  return title
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '') || '제목-없음';
}

const DESIGN_PIPELINE_DIR = 'docs/design';
const DESIGN_PIPELINE_DOC_PATTERN = /^docs\/design\/(\d{2,})-.+\.md$/;

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 기존 설계 파이프라인 문서 경로들에서 다음 번호를 고른다(비어 있으면 1부터) */
function nextDesignPipelineDocNumber(existingPaths: readonly string[]): number {
  const max = existingPaths.reduce((acc, filePath) => {
    const match = DESIGN_PIPELINE_DOC_PATTERN.exec(filePath);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return max + 1;
}

/** `docs/design/NN-제목.md` 경로 */
function designPipelineDocPath(number: number, title: string): string {
  return `${DESIGN_PIPELINE_DIR}/${pad(number)}-${slugifyTitle(title)}.md`;
}

/** 설계 문서 옆에 두는 사이드카(요구사항 id·작업 묶음·승인 상태). 본문은 사람이 읽는 글이고, 이 파일만 서버가 판정에 쓴다 */
function designPipelineSidecarPath(docPath: string): string {
  return docPath.replace(/\.md$/, '.meta.json');
}

function isDesignPipelineDocPath(file: string): boolean {
  return DESIGN_PIPELINE_DOC_PATTERN.test(file);
}

// ---------------------------------------------------------------------------
// 작업 묶음
// ---------------------------------------------------------------------------


const BUNDLE_TABLE_HEADER = /\|\s*묶음\s*\|\s*완료\s*조건\s*\|\s*예상\s*시간[^|]*\|\s*결과물\s*\|\s*쓰기\s*범위\s*\|/;

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** "30-60", "30~60", "45" 같은 표기에서 분 단위 [최소, 최대]를 뽑는다. 읽을 수 없으면 [0, 0] */
function parseEstimateRange(text: string): [number, number] {
  const range = /(\d+)\s*[-~]\s*(\d+)/.exec(text);
  if (range) return [Number(range[1]), Number(range[2])];
  const single = /(\d+)/.exec(text);
  if (single) return [Number(single[1]), Number(single[1])];
  return [0, 0];
}

/**
 * 설계 문서 본문의 "작업 묶음" 표(`| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |`)를 구조화된 목록으로 뽑는다.
 * 모델(또는 사람)이 자유 형식으로 쓴 본문에서 서버가 예상 vs 실제 시간을 비교하려면 이 표만은 정해진 모양을
 * 따라야 한다 — buildDesignPipelineRequestPrompt가 이 모양을 지시한다. 표를 찾지 못하면 빈 배열(차단하지 않는다).
 */
function parseDesignBundlesTable(markdown: string): DesignBundle[] {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => BUNDLE_TABLE_HEADER.test(line));
  if (headerIndex === -1) return [];

  const bundles: DesignBundle[] = [];
  // headerIndex + 1은 구분선(--- 행)이라 건너뛴다
  for (let index = headerIndex + 2; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line.startsWith('|')) break;
    const cells = splitTableRow(line);
    if (cells.length < 5) continue;
    const [bundleCell, doneCondition, estimateCell, deliverable, scopeCell] = cells as [string, string, string, string, string];
    if (/^-+$/.test(bundleCell.replaceAll(' ', ''))) continue; // 혹시 구분선이 두 번 들어와도 건너뛴다
    const idMatch = /^(B\d+)\s*(.*)$/.exec(bundleCell);
    const id = idMatch?.[1] ?? `B${bundles.length + 1}`;
    const title = (idMatch?.[2] ?? bundleCell).trim() || id;
    const [estimateMinMinutes, estimateMaxMinutes] = parseEstimateRange(estimateCell);
    const writableScope = scopeCell
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    bundles.push({ id, title, doneCondition: doneCondition.trim(), estimateMinMinutes, estimateMaxMinutes, deliverable: deliverable.trim(), writableScope });
  }
  return bundles;
}

// ---------------------------------------------------------------------------
// 요청 프롬프트 · 템플릿
// ---------------------------------------------------------------------------

/**
 * 설계 문서를 받을 때 쓰는 "조사"(읽기만) 모드 질문. 사람이 대화 입력창에 이 글을 채우고(읽기만 스위치와 함께)
 * 직접 보낸다 — 모델은 이 턴에서 파일을 바꾸지 않는다(plan-brief.ts가 계획 모델에 쓰는 것과 같은 "계획은 안내,
 * 구현은 따로"라는 경계). 답은 사람이 검토해 설계 문서로 저장한다.
 */
function buildDesignPipelineRequestPrompt(input: { title: string; requirementIds: readonly string[]; detail?: string }): string {
  const ids = input.requirementIds.length > 0 ? input.requirementIds.join(', ') : '(해당 없음)';
  const detail = input.detail?.trim() ? `\n\n${input.detail.trim()}` : '';
  return `"${input.title}" 설계 문서를 써 주세요. 대상 요구사항: ${ids}.${detail}

지금은 파일을 바꾸지 말고 읽기만 하세요. 실제 코드를 확인한 사실만 쓰고, 모르면 "불확실"이라고 적으세요.
아래 항목을 마크다운으로, 이 순서대로 답하세요:

## 대상 요구사항
(이 설계가 다루는 요구사항 id와 한 줄 설명)

## 접근
(전체 구현 방향)

## 데이터·API 계약 변경
(바뀌는 스키마·엔드포인트·타입. 없으면 "없음")

## 작업 묶음

| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |
| --- | --- | --- | --- | --- |
| B1 (묶음 제목) | (무엇이 되면 끝인지) | 30-60 | (어떤 파일·화면이 나오는지) | (쓸 경로, 쉼표로 구분) |

표 형식을 그대로 지키세요(다른 열을 추가하거나 빼지 마세요) — 플랫폼이 이 표로 예상 시간을 기록합니다.

## 위험·불확실성
(불확실한 점, 검증이 필요한 가정)

## 검증 방법
(각 작업 묶음을 어떻게 확인할지 — 게이트·테스트·화면 확인 등)`;
}

/** 모델에게 묻지 않고 빈 틀로 바로 만들 때 쓰는 기본 틀(docs.ts의 buildDesignDocTemplate과 같은 구조, 다른 자리) */
function buildDesignPipelineDocTemplate(number: number, title: string, requirementIds: readonly string[] = []): string {
  const ids = requirementIds.length > 0 ? requirementIds.join(', ') : '(대상 요구사항을 적습니다)';
  return `# ${pad(number)}. ${title}

${title}에 관한 설계 문서입니다.

## 대상 요구사항

${ids}

## 접근

(전체 구현 방향을 적습니다)

## 데이터·API 계약 변경

(바뀌는 스키마·엔드포인트·타입을 적습니다. 없으면 "없음")

## 작업 묶음

| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |
| --- | --- | --- | --- | --- |

## 위험·불확실성

(불확실한 점, 검증이 필요한 가정을 적습니다)

## 검증 방법

(각 작업 묶음을 어떻게 확인할지 적습니다)
`;
}

// ---------------------------------------------------------------------------
// 설계 문서 레코드(사이드카)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 승인 게이트(서버 강제)
// ---------------------------------------------------------------------------

interface DesignApprovalCheck {
  blocked: boolean;
  /** 막은 이유가 된, 승인되지 않은 설계 문서들 */
  blockingDocs: DesignDocRecord[];
}

/**
 * 요청 글에 언급된 요구사항 id가, 아직 승인되지 않은 설계 문서가 다루는 범위에 걸리는지 확인한다.
 * 그 요구사항을 다루는 설계 문서가 하나도 없으면(아직 설계를 만들지 않은 프로젝트·요청) 막지 않는다 — 옵트인.
 */
function checkDesignApproval(requirementIdsInRequest: readonly string[], designDocs: readonly DesignDocRecord[]): DesignApprovalCheck {
  if (requirementIdsInRequest.length === 0) return { blocked: false, blockingDocs: [] };
  const mentioned = new Set(requirementIdsInRequest);
  const blockingDocs = designDocs.filter((doc) => doc.status !== 'approved' && doc.requirementIds.some((id) => mentioned.has(id)));
  return { blocked: blockingDocs.length > 0, blockingDocs };
}

const DESIGN_APPROVAL_REQUIRED_MESSAGE = '설계 승인 전에는 구현을 시작할 수 없습니다';

// ---------------------------------------------------------------------------
// 리뷰어 독립성(검토가 구현과 같은 모델 계열이면 "성공"으로 세지 않는다)
// ---------------------------------------------------------------------------

/** 세션 백엔드·API 모델 공급자를 뭉친 계열. claude-code·anthropic api 모델은 모두 claude다 */
type ModelFamily = 'claude' | 'openai' | 'google' | 'commandcode' | 'opencode' | 'unknown';

type ReviewIndependence = 'independent' | 'same-family' | 'unknown';

/** 구현·검토가 같은 계열이면 'same-family'(독립성 낮음), 둘 중 하나라도 모르면 'unknown', 다르면 'independent' */
function reviewIndependence(implementer: ModelFamily, reviewer: ModelFamily): ReviewIndependence {
  if (implementer === 'unknown' || reviewer === 'unknown') return 'unknown';
  return implementer === reviewer ? 'same-family' : 'independent';
}

const SAME_FAMILY_REVIEW_LABEL = '같은 계열 검토(독립성 낮음)';
const REVIEW_NOT_RUN_LABEL = '검토 못 함';

// ---------------------------------------------------------------------------
// 파이프라인 단계 판정 — "완료"(구현이 끝났다)와 "성공"(독립 검토 + 검증 재실행 통과)을 나눈다
// ---------------------------------------------------------------------------

interface DesignPipelineReviewInput {
  /** 리뷰 호출이 실제로 돌았는지. 백엔드가 지원하지 않거나 한도에 걸려 못 돌았으면 false(침묵 통과시키지 않는다) */
  ran: boolean;
  passed: boolean;
  independence: ReviewIndependence;
  findingsCount?: number;
  reviewerLabel?: string;
}

interface DesignPipelineVerificationInput {
  /** 마지막 변경 뒤 검증 게이트가 다시 돌았는지 */
  ran: boolean;
  ok: boolean;
  /** 그 검증에 테스트 재실행이 포함됐는지(workflow.tests가 없으면 테스트가 없는 프로젝트이므로 true로 본다) */
  testsRerun: boolean;
}

interface DesignPipelineCoder {
  sessionId?: string;
  backend?: string;
  model?: string;
  /** 이 작업 묶음을 도는 동안 모델이 승격(에스컬레이션)됐는지. true면 "같은 코더 유지" 원칙의 예외로 보여 준다 */
  escalated: boolean;
}

interface DesignPipelineBundleActual {
  bundle: DesignBundle;
  /** 실제로 걸린 시간(분). 아직 실행한 적이 없으면 없음 */
  actualMinutes?: number;
  coder?: DesignPipelineCoder;
}

interface DesignPipelineInput {
  design: DesignDocRecord;
  /** 이 설계 범위의 구현 체크포인트가 있는지("완료"의 유일한 조건) */
  implementationCheckpointExists: boolean;
  review?: DesignPipelineReviewInput;
  verification?: DesignPipelineVerificationInput;
}

interface DesignPipelineResult {
  designApproved: boolean;
  /** 완료: 구현 체크포인트가 있다 */
  completed: boolean;
  /** 성공: 완료 + 다른 계열 모델이 검토를 통과 + 검증(테스트 재실행 포함)이 마지막 변경 뒤 통과 */
  succeeded: boolean;
  /** 성공이 아닐 때 그 이유들(사람이 읽는 문구). 성공이면 빈 배열 */
  reasons: string[];
}

/**
 * "완료"와 "성공"을 나눠 판정한다. 완료는 구현 체크포인트의 존재만 본다 — 검토·검증 전에도 "구현이 끝났다"는
 * 사실은 그대로다. 성공은 그 위에 독립 검토(다른 모델 계열이 통과)와 검증 재실행 통과를 모두 요구한다.
 * 검토를 못 돌렸거나(review.ran === false) 같은 계열이었으면 성공으로 세지 않고 이유를 남긴다(침묵 통과 금지).
 */
function deriveDesignPipelineResult(input: DesignPipelineInput): DesignPipelineResult {
  const designApproved = input.design.status === 'approved';
  const completed = input.implementationCheckpointExists;
  const reasons: string[] = [];
  if (!designApproved) reasons.push('설계가 승인되지 않았습니다');
  if (!completed) reasons.push('구현 체크포인트가 없습니다');

  const review = input.review;
  let reviewOk = false;
  if (!review || !review.ran) {
    reasons.push(REVIEW_NOT_RUN_LABEL);
  } else {
    if (!review.passed) reasons.push('검토를 통과하지 못했습니다');
    if (review.independence === 'same-family') reasons.push(SAME_FAMILY_REVIEW_LABEL);
    else if (review.independence === 'unknown') reasons.push('검토자 계열을 확인할 수 없습니다');
    reviewOk = review.passed && review.independence === 'independent';
  }

  const verification = input.verification;
  let verificationOk = false;
  if (!verification || !verification.ran) {
    reasons.push('검증을 다시 돌리지 못했습니다');
  } else {
    if (!verification.ok) reasons.push('검증이 통과하지 못했습니다');
    if (!verification.testsRerun) reasons.push('테스트를 다시 돌리지 않았습니다');
    verificationOk = verification.ok && verification.testsRerun;
  }

  const succeeded = designApproved && completed && reviewOk && verificationOk;
  return { designApproved, completed, succeeded, reasons: succeeded ? [] : reasons };
}

return {
  nextDesignPipelineDocNumber,
  designPipelineDocPath,
  designPipelineSidecarPath,
  isDesignPipelineDocPath,
  parseDesignBundlesTable,
  buildDesignPipelineRequestPrompt,
  buildDesignPipelineDocTemplate,
  checkDesignApproval,
  reviewIndependence,
  deriveDesignPipelineResult,
};
})();

const SEEDS = readEnvList('DESIGN_PIPELINE_DIFF_SEEDS', [1, 7, 42, 2026]);
const ITERATIONS = readEnvNumber('DESIGN_PIPELINE_DIFF_ITERATIONS', 3000);
const REPORT = process.env['DESIGN_PIPELINE_DIFF_REPORT'] === '1';

// ---------------------------------------------------------------------------
// 입력 생성
// ---------------------------------------------------------------------------

const TITLE_ATOMS = [
  'a', 'B', '0', '9', '결제', '한글', 'x-y', ' ', ' ', ' ', '\t', '\n', '\r', ' ', '﻿', '　', '\u0085', '/', '\\', ':', '*', '?', '"', '<', '>', '|', '-', '--', '.', '..', '../', '\u0000', '😀', 'é', '#',
];

function genTitle(g: Gen): string {
  const roll = g.int(20);
  if (roll === 0) return '';
  if (roll === 1) return g.text(TITLE_ATOMS, 300 + g.int(300));
  if (roll === 2) return g.pick(['..', '.', '/', '\\', '-', '--', ' ', '\t', ' ', '﻿', ' - ']);
  return g.text(TITLE_ATOMS, 1 + g.int(12));
}

const NUMBERS = [0, 1, 2, 5, 9, 10, 11, 98, 99, 100, 999, 12345, -1, -10, 1.5, 9.99, 0.1, NaN, Infinity, -Infinity, -0, 2 ** 53, 1e21, 1e-7];

function genNumber(g: Gen): number {
  return g.chance(0.7) ? g.pick(NUMBERS) : g.int(1500);
}

const PATH_PREFIXES = [
  'docs/design/', 'docs/design/', 'docs/design/', 'docs/design//', './docs/design/', 'Docs/design/', 'docs/Design/', 'DOCS/DESIGN/', '/docs/design/', 'x/docs/design/', 'docs/designx/', 'docs/design', 'docs/design\\',
  'docs/', 'docs/adr/ADR-', 'docs/design/design/', 'docs/designs/', 'docs/ design/', '',
];
const DIGIT_RUNS = ['', '0', '1', '00', '01', '09', '10', '99', '100', '007', '999', '12345', '２３', '٣٤', '9'.repeat(310), '0'.repeat(310) + '5', '1'.repeat(20)];
const NAME_REST = ['-a.md', '-.md', '-x.md', '-x.md.md', '-x.MD', '-x.Md', '-x.md ', '-x.md\n', '-a\nb.md', '-a b.md', '-a\rb.md', '-a b.md', '-a/b.md', '-.md.md', '-md', '-x.mdx', 'x.md', '-.md ', '-한글.md', '-a.md\r', '--.md', '-..md', '_a.md', '.md', '-x.meta.json', '-x.md.meta.json'];

function genPath(g: Gen): string {
  if (g.chance(0.1)) return g.pick(['', 'README.md', 'docs/README.md', 'docs/design/README.md', 'docs/design/01-a.meta.json', 'docs/design/1-a.md', 'docs/design/01a.md', 'docs/02-a.md', 'docs/design/01-a.md', 'docs/design/01-a.md ', ' docs/design/01-a.md', 'docs/design/001-b.md']);
  const prefix = g.chance(0.5) ? 'docs/design/' : g.pick(PATH_PREFIXES);
  const digits = g.chance(0.6) ? String(g.int(1500)).padStart(g.pick([2, 3, 3, 4]), '0') : g.pick(DIGIT_RUNS);
  const rest = g.chance(0.6) ? '-제목.md' : g.pick(NAME_REST);
  return prefix + digits + rest;
}

function genPathList(g: Gen): string[] {
  return g.list(0, 10, () => genPath(g));
}

const HEADER_CELLS = [
  '| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |',
  '| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |',
  '|묶음|완료조건|예상시간|결과물|쓰기범위|',
  '|\t묶음\t| 완료　조건 | 예상\n시간|결과물|쓰기 범위|',
  '| 묶음 | 완료 조건 | 예상 시간 | 결과물 | 쓰기 범위 |',
  '| 묶음 | 완료 조건 | 예상 시간(분, 대략) | 결과물 | 쓰기 범위 |',
  '| 묶음 | 완료 조건 | 예상 시간(분)||결과물 | 쓰기 범위 |', // `[^|]*`가 `|`를 못 먹는다
  '| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위',
  '| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |  ',
  '앞글자 | 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 | 뒷글자',
  '| 묶음 | 완료 | 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |',
  '| 묶 음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |',
  '| 묶음 | 완료 조건 | 예상시간 | 결과물 | 쓰기범위 |',
  '| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 | 비고 |',
  '| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |\r',
  '| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |​',
  '| 묶음 | 완료 조건 | 예상 시간 | 쓰기 범위 | 결과물 |',
  '|묶음|완료 조건|예상 시간(분)|결과물|쓰기 범위|묶음|완료 조건|예상 시간(분)|결과물|쓰기 범위|',
  '| ﻿묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |',
  '| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |',
];

const SEP_LINES = ['| --- | --- | --- | --- | --- |', '| --- | --- | --- | --- | --- |', '|---|---|---|---|---|', '| :-- | --: | :-: | --- | --- |', '', '| a |'];
const BUNDLE_CELLS = ['B1 로그인', 'B2', 'B10  제목', 'B3제목', 'b4 소문자', 'B 5', 'B', 'B1 x', 'B1 x\ry', 'B1 \rx', 'B1\t\t탭', '제목만', '', ' ', '---', '- - -', '-', '--', 'B1２', 'B007 영', 'B1 ', 'BB1', 'B1,B2', '묶음 B1', 'B99999999999999999999 큰 수', 'B1  nbsp', 'B1\u0085x', 'B1 한글 제목 길게 길게'];
const ESTIMATES = ['30-60', '30~60', '45', '30 - 60', '30 ~ 60분', '30–60', '30—60', '-5', '5-', '5 - x 3-4', '', ' ', '없음', '약 10분', '10분~20분', '0', '007', '9'.repeat(400), '1'.repeat(30) + '-' + '2'.repeat(30), '１２-３４', '30 - 60', '30-', '-', '30 -\n60', '30 - 60', '5~~6', '5-6-7', 'x5y', '3.5-4.5', '1,2', '1 2'];
const SCOPES = ['src/a, src/b', 'src/a', '', ' ', ',', ',,a,,', 'a, ,b', ' a ', 'a, b', 'apps/**', '"a,b"', 'a b'];
const CELL_FILL = ['통과', '화면', '', ' ', '(무엇이 되면 끝인지)', 'a b', '한글 값', 'x|y'];

function genRow(g: Gen): string {
  const roll = g.int(20);
  const bundle = g.pick(BUNDLE_CELLS);
  if (roll === 0) return '|';
  if (roll === 1) return `| ${bundle} | ${g.pick(CELL_FILL)} |`; // 칸이 모자라다
  if (roll === 2) return `${bundle} | ${g.pick(CELL_FILL)} | 10 | x | y`; // `|`로 시작하지 않아 표가 끝난다
  if (roll === 3) return '';
  const cells = [bundle, g.pick(CELL_FILL), g.pick(ESTIMATES), g.pick(CELL_FILL), g.pick(SCOPES)];
  if (roll === 4) cells.push('여분');
  if (roll === 5) return `|${cells.join('|')}`; // 끝 `|` 없음
  if (roll === 6) return `  |${cells.join('|')}|  `;
  if (roll === 7) return `|${cells.join('||')}|`;
  return `| ${cells.join(' | ')} |`;
}

function genBundlesMarkdown(g: Gen): string {
  const parts: string[] = [];
  if (g.chance(0.7)) parts.push('# 제목', '', '본문 한 줄');
  if (g.chance(0.12)) parts.push(g.pick(HEADER_CELLS), g.pick(SEP_LINES)); // 앞에 가짜 머리가 하나 더 있다
  const hasHeader = !g.chance(0.12);
  if (hasHeader) parts.push(g.pick(HEADER_CELLS));
  if (!g.chance(0.1)) parts.push(g.pick(SEP_LINES));
  const rows = g.list(0, 6, () => genRow(g));
  parts.push(...rows);
  if (g.chance(0.4)) parts.push('', '## 위험·불확실성', '| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |');
  const sep = g.pick(['\n', '\n', '\n', '\r\n', '\r\n']);
  let out = parts.join(sep);
  if (g.chance(0.1)) out += '\n';
  if (g.chance(0.05)) out = '﻿' + out;
  return out;
}

const REQ_IDS = ['R1', 'R2', 'R10', 'R-1', 'R-10', 'r-1', ' R-1', 'R-1 ', 'R1.1', 'R1.10', 'r1', 'R1 ', ' R1', '', ' ', 'R', '한글', 'R1\u0000', 'R１'];

function genIds(g: Gen, max = 4): string[] {
  return g.list(0, max, () => g.pick(REQ_IDS));
}

const STATUSES: unknown[] = ['draft', 'approved', 'approved', 'Approved', 'APPROVED', 'approved ', ' approved', 'approve', 'approvedx', 'draft', 'rejected', '', ' ', undefined, null, 1, true, ['approved'], { s: 'approved' }];

function genDoc(g: Gen, valid: boolean): DesignDocRecord {
  const status = valid ? g.pick(['draft', 'approved', 'Approved', 'approved ', 'draft']) : g.pick(STATUSES);
  const base: Record<string, unknown> = { path: 'docs/design/01-a.md', number: 1, title: 't', requirementIds: genIds(g), bundles: [], status, createdAt: 'x', createdBy: 'y' };
  if (!valid) {
    const roll = g.int(12);
    if (roll === 0) base['requirementIds'] = undefined;
    else if (roll === 1) base['requirementIds'] = null;
    else if (roll === 2) base['requirementIds'] = 'R1';
    else if (roll === 3) base['requirementIds'] = [1, 'R1', null, undefined, { a: 1 }, ['R1']];
    else if (roll === 4) base['requirementIds'] = { some: 1 };
  }
  return base as unknown as DesignDocRecord;
}

function genDocs(g: Gen): unknown[] {
  const exotic = g.chance(0.15);
  const docs: unknown[] = g.list(0, 5, () => genDoc(g, !exotic));
  if (exotic && g.chance(0.2)) docs.push(g.pick([null, undefined, 5, 'x']));
  return docs;
}

const FAMILIES: unknown[] = ['claude', 'openai', 'google', 'commandcode', 'opencode', 'unknown', 'Claude', 'claude ', 'unknown ', 'UNKNOWN', 'unknow', '', 'independent'];

function genFlag(g: Gen): boolean {
  return g.chance(0.8);
}

function genResultInput(g: Gen): current.DesignPipelineInput {
  const independence = g.pick<unknown>(['independent', 'independent', 'independent', 'independent', 'same-family', 'unknown', 'Independent', 'independent ', 'same-family ', '', undefined, 'other']);
  const review = g.chance(0.12) ? undefined : { ran: genFlag(g), passed: genFlag(g), independence, ...(g.chance(0.3) ? { findingsCount: g.int(4) } : {}) };
  const verification = g.chance(0.12) ? undefined : { ran: genFlag(g), ok: genFlag(g), testsRerun: genFlag(g) };
  const status = g.pick<unknown>(['approved', 'approved', 'approved', 'approved', 'approved', 'draft', 'Approved', 'approved ', '', undefined]);
  const input = {
    design: { ...genDoc(g, true), status },
    implementationCheckpointExists: g.chance(0.9),
    ...(review ? { review } : {}),
    ...(verification ? { verification } : {}),
  };
  return input as unknown as current.DesignPipelineInput;
}

// ---------------------------------------------------------------------------
// 견주기
// ---------------------------------------------------------------------------

interface Tally {
  runs: number;
  differ: number;
  empty: number;
  valued: number;
  threw: number;
  /** 판정 참/거짓(승인 확인은 막음, 성공 판정은 성공, 독립성은 independent) */
  truthy: number;
  /** 열린 쪽 뒤집힘: 옛 구현은 막았는데(성공시키지 않았는데) 새 구현이 풀어 준 수 */
  flippedOpen: number;
  first: string[];
}

const newTally = (): Tally => ({ runs: 0, differ: 0, empty: 0, valued: 0, threw: 0, truthy: 0, flippedOpen: 0, first: [] });

function isEmptyValue(value: unknown): boolean {
  return value === '' || (Array.isArray(value) && value.length === 0) || value === 1 /* 번호 계산: 어느 경로도 맞지 않아 1 */;
}

function compare(tally: Tally, label: string, input: unknown, legacyOutcome: Outcome, currentOutcome: Outcome): void {
  tally.runs++;
  if (legacyOutcome.threw) tally.threw++;
  else if (isEmptyValue(legacyOutcome.value)) tally.empty++;
  else tally.valued++;
  if (!sameOutcome(legacyOutcome, currentOutcome)) {
    tally.differ++;
    if (tally.first.length < 3) tally.first.push(`${label}\n입력: ${JSON.stringify(input)}\n옛: ${JSON.stringify(legacyOutcome)}\n새: ${JSON.stringify(currentOutcome)}`);
  }
}

interface Case {
  name: string;
  minEmpty?: number;
  minTruthy?: number;
  run: (g: Gen, tally: Tally) => void;
}

const cases: Case[] = [
  {
    name: 'designPipelineDocPath/designPipelineSidecarPath',
    run: (g, t) => {
      const title = genTitle(g);
      const number = genNumber(g);
      compare(t, 'designPipelineDocPath', { number, title }, outcome(() => legacy.designPipelineDocPath(number, title)), outcome(() => current.designPipelineDocPath(number, title)));
      const path = g.chance(0.5) ? genPath(g) : legacy.designPipelineDocPath(number, title);
      compare(t, 'designPipelineSidecarPath', path, outcome(() => legacy.designPipelineSidecarPath(path)), outcome(() => current.designPipelineSidecarPath(path)));
    },
  },
  {
    name: 'nextDesignPipelineDocNumber/isDesignPipelineDocPath',
    minEmpty: 0.05,
    run: (g, t) => {
      const list = genPathList(g);
      compare(t, 'nextDesignPipelineDocNumber', list, outcome(() => legacy.nextDesignPipelineDocNumber(list)), outcome(() => current.nextDesignPipelineDocNumber(list)));
      const path = genPath(g);
      const l = outcome(() => legacy.isDesignPipelineDocPath(path));
      if (!l.threw && l.value === true) t.truthy++;
      compare(t, 'isDesignPipelineDocPath', path, l, outcome(() => current.isDesignPipelineDocPath(path)));
    },
  },
  {
    name: 'parseDesignBundlesTable',
    minEmpty: 0.05,
    run: (g, t) => {
      const markdown = genBundlesMarkdown(g);
      compare(t, 'parseDesignBundlesTable', markdown, outcome(() => legacy.parseDesignBundlesTable(markdown)), outcome(() => current.parseDesignBundlesTable(markdown)));
    },
  },
  {
    name: 'buildDesignPipelineRequestPrompt/buildDesignPipelineDocTemplate',
    run: (g, t) => {
      const title = genTitle(g);
      const ids = genIds(g);
      const detail = g.pick<string | undefined>([undefined, '', ' ', '  \n ', '상세', ' 앞뒤 공백 ', '﻿', '\u0085', 'a\nb', '한글 설명']);
      const number = genNumber(g);
      compare(t, 'buildDesignPipelineRequestPrompt', { title, ids, detail }, outcome(() => legacy.buildDesignPipelineRequestPrompt({ title, requirementIds: ids, detail })), outcome(() => current.buildDesignPipelineRequestPrompt({ title, requirementIds: ids, detail })));
      compare(t, 'buildDesignPipelineDocTemplate', { number, title, ids }, outcome(() => legacy.buildDesignPipelineDocTemplate(number, title, ids)), outcome(() => current.buildDesignPipelineDocTemplate(number, title, ids)));
      if (g.chance(0.5)) compare(t, 'buildDesignPipelineDocTemplate(기본값)', { number, title }, outcome(() => legacy.buildDesignPipelineDocTemplate(number, title)), outcome(() => current.buildDesignPipelineDocTemplate(number, title)));
    },
  },
  {
    name: 'checkDesignApproval',
    minTruthy: 0.05,
    run: (g, t) => {
      const ids = genIds(g);
      const docs = genDocs(g) as DesignDocRecord[];
      const l = outcome(() => legacy.checkDesignApproval(ids, docs));
      const c = outcome(() => current.checkDesignApproval(ids, docs));
      if (!l.threw) {
        const lv = l.value as { blocked: boolean; blockingDocs: unknown[] };
        if (lv.blocked) t.truthy++;
        // 열린 쪽 뒤집힘: 옛 구현이 막은 기록이 새 결과에서 빠졌거나(막지 않거나) 던지지 않고 통과한 경우
        if (lv.blocked) {
          if (c.threw) {
            /* 던짐은 구현을 시작하지 않는다(닫힌 쪽): 뒤집힘이 아니다. 따로 differ로 센다 */
          } else {
            const cv = c.value as { blocked: boolean; blockingDocs: unknown[] };
            if (!cv.blocked || lv.blockingDocs.some((doc) => !cv.blockingDocs.includes(doc))) t.flippedOpen++;
          }
        }
      }
      compare(t, 'checkDesignApproval', { ids, docs }, l, c);
    },
  },
  {
    name: 'reviewIndependence',
    minTruthy: 0.05,
    run: (g, t) => {
      const a = g.pick(FAMILIES) as ModelFamily;
      const b = g.pick(FAMILIES) as ModelFamily;
      const l = outcome(() => legacy.reviewIndependence(a, b));
      if (!l.threw && l.value === 'independent') t.truthy++;
      compare(t, 'reviewIndependence', { a, b }, l, outcome(() => current.reviewIndependence(a, b)));
    },
  },
  {
    name: 'deriveDesignPipelineResult',
    minTruthy: 0.02,
    run: (g, t) => {
      const input = genResultInput(g);
      const l = outcome(() => legacy.deriveDesignPipelineResult(input));
      const c = outcome(() => current.deriveDesignPipelineResult(input));
      if (!l.threw) {
        const lv = l.value as { succeeded: boolean };
        if (lv.succeeded) t.truthy++;
        else if (!c.threw && (c.value as { succeeded: boolean }).succeeded) t.flippedOpen++; // 성공이 아니었던 것을 성공으로 뒤집었다
      }
      compare(t, 'deriveDesignPipelineResult', input, l, c);
    },
  },
];

describe('차등 시험: 옛 TS 구현과 Rust 껍데기는 같은 입력에 같은 글자를 낸다', () => {
  const totalFlipped = { n: 0 };
  for (const { name, run, minEmpty, minTruthy } of cases) {
    it(name, () => {
      const total = newTally();
      for (const seed of SEEDS) {
        const g = new Gen(seed * 1000 + name.length);
        const tally = newTally();
        for (let n = 0; n < ITERATIONS; n++) run(g, tally);
        for (const key of ['runs', 'differ', 'empty', 'valued', 'threw', 'truthy', 'flippedOpen'] as const) total[key] += tally[key];
        total.first.push(...tally.first);
        if (REPORT) console.log(`[차등] ${name} 시드 ${seed}: 비교 ${tally.runs}, 다름 ${tally.differ}, 빈 결과 ${tally.empty}, 값 ${tally.valued}, 던짐 ${tally.threw}, 참 ${tally.truthy}, 열린 쪽 뒤집힘 ${tally.flippedOpen}`);
      }
      totalFlipped.n += total.flippedOpen;
      expect(total.first.join('\n---\n')).toBe('');
      expect(total.differ).toBe(0);
      expect(total.flippedOpen).toBe(0);
      expect(total.runs).toBeGreaterThan(0);
      expect(total.valued).toBeGreaterThan(total.runs * 0.2); // 입력이 비어 있지 않다
      if (minEmpty) expect(total.empty).toBeGreaterThan(total.runs * minEmpty);
      if (minTruthy) expect(total.truthy).toBeGreaterThan(total.runs * minTruthy);
    }, 3_600_000);
  }

  it('대조 장치: 결과 한 글자만 달라도 잡는다', () => {
    const g = new Gen(9);
    const tally = newTally();
    for (let n = 0; n < 200; n++) {
      const title = genTitle(g);
      const number = genNumber(g);
      const list = genPathList(g);
      const markdown = genBundlesMarkdown(g);
      const input = genResultInput(g);
      const expected: Outcome[] = [
        outcome(() => legacy.designPipelineDocPath(number, title)),
        outcome(() => legacy.nextDesignPipelineDocNumber(list)),
        outcome(() => legacy.parseDesignBundlesTable(markdown)),
        outcome(() => legacy.deriveDesignPipelineResult(input)),
        outcome(() => legacy.checkDesignApproval(genIds(g), genDocs(g) as DesignDocRecord[])),
      ];
      for (const o of expected) {
        if (o.threw) continue;
        compare(tally, 'tamper', title, o, { threw: false, value: perturb(o.value) });
      }
    }
    expect(tally.differ).toBeGreaterThan(300);
  });

  it('대조 장치: 옛 구현을 한 군데만 넓혀도(승인 확인의 접두·대소문자 무시·status 넓히기, 경로 접두·대소문자) 잡는다', () => {
    const broadApproval = (
      mode: 'prefix' | 'ci' | 'status' | 'empty',
      ids: readonly string[],
      docs: readonly DesignDocRecord[],
    ): { blocked: boolean; blockingDocs: DesignDocRecord[] } => {
      if (ids.length === 0) return { blocked: false, blockingDocs: [] };
      const blockingDocs = docs.filter((doc) => {
        const approved = mode === 'status' ? String(doc.status).toLowerCase().trim() === 'approved' : doc.status === 'approved';
        if (approved) return false;
        if (mode === 'prefix') return doc.requirementIds.some((id) => ids.some((m) => id.startsWith(m)));
        if (mode === 'ci') return doc.requirementIds.some((id) => ids.some((m) => id.toLowerCase() === m.toLowerCase()));
        if (mode === 'empty') return doc.requirementIds.length === 0 || doc.requirementIds.some((id) => ids.includes(id));
        return doc.requirementIds.some((id) => ids.includes(id));
      });
      return { blocked: blockingDocs.length > 0, blockingDocs };
    };
    const g = new Gen(11);
    const differ = { prefix: 0, ci: 0, status: 0, empty: 0 };
    let pathDiffer = 0;
    for (let n = 0; n < 3000; n++) {
      const ids = genIds(g);
      const docs = g.list(0, 5, () => genDoc(g, true));
      const base = JSON.stringify(current.checkDesignApproval(ids, docs));
      for (const mode of ['prefix', 'ci', 'status', 'empty'] as const) {
        if (JSON.stringify(broadApproval(mode, ids, docs)) !== base) differ[mode]++;
      }
      const path = genPath(g);
      const loose = /^docs\/design\/(\d{1,})-.+\.md$/i.test(path);
      if (loose !== current.isDesignPipelineDocPath(path)) pathDiffer++;
    }
    expect(differ.prefix).toBeGreaterThan(20);
    expect(differ.ci).toBeGreaterThan(20);
    expect(differ.status).toBeGreaterThan(20);
    expect(differ.empty).toBeGreaterThan(20);
    expect(pathDiffer).toBeGreaterThan(20);
  });

  it('입력으로 쓴 설계 기록 객체는 껍데기가 바꾸지 않고, 막는 기록은 같은 객체로 돌려준다', () => {
    const doc = { ...genDoc(new Gen(3), true), status: 'draft', requirementIds: ['R-1'] } as DesignDocRecord;
    const before = JSON.stringify(doc);
    const result = current.checkDesignApproval(['R-1'], [doc]);
    expect(result.blockingDocs[0]).toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
