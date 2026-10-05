/**
 * "기능 흐름(파이프라인)" — 설계 먼저, 구현은 따로(ADR-100).
 *
 * 범수 님의 작업 방식을 코드로 강제한다: 설계는 메인 세션이 맡고, 구현은 저렴한 코더에게, 검토는 다른 계열
 * 모델이, 마지막 확인은 다시 설계한 쪽이 한다. "완료"(구현이 끝났다)와 "성공"(다른 계열 모델 검토 + 검증
 * 재실행 통과)을 나눈다. 지켜야 하는 조건은 프롬프트로 부탁하지 않고 서버가 막는다.
 *
 * 이 파일은 파일 IO·모델 호출을 하지 않는 순수 함수만 둔다(docs.ts와 같은 경계) — 실제로 세션 작업 복사본에
 * 읽고 쓰는 일은 studio의 sessions.ts가 맡는다. 설계 문서는 `docs/NN-제목.md`(docs.ts, 범용 설계 노트)와 다른
 * 자리인 `docs/design/NN-제목.md`에 둔다 — 요구사항 id·작업 묶음·승인 상태를 사이드카 JSON으로 함께 추적해야
 * 해서(승인 전에는 구현을 막는 서버 판정의 근거), 사람이 자유 형식으로 쓰는 기존 설계 노트와 섞지 않는다.
 */
import { z } from 'zod';
import { slugifyTitle } from './docs';

// ---------------------------------------------------------------------------
// 파일 이름 · 경로
// ---------------------------------------------------------------------------

export const DESIGN_PIPELINE_DIR = 'docs/design';
const DESIGN_PIPELINE_DOC_PATTERN = /^docs\/design\/(\d{2,})-.+\.md$/;

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** 기존 설계 파이프라인 문서 경로들에서 다음 번호를 고른다(비어 있으면 1부터) */
export function nextDesignPipelineDocNumber(existingPaths: readonly string[]): number {
  const max = existingPaths.reduce((acc, filePath) => {
    const match = DESIGN_PIPELINE_DOC_PATTERN.exec(filePath);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return max + 1;
}

/** `docs/design/NN-제목.md` 경로 */
export function designPipelineDocPath(number: number, title: string): string {
  return `${DESIGN_PIPELINE_DIR}/${pad(number)}-${slugifyTitle(title)}.md`;
}

/** 설계 문서 옆에 두는 사이드카(요구사항 id·작업 묶음·승인 상태). 본문은 사람이 읽는 글이고, 이 파일만 서버가 판정에 쓴다 */
export function designPipelineSidecarPath(docPath: string): string {
  return docPath.replace(/\.md$/, '.meta.json');
}

export function isDesignPipelineDocPath(file: string): boolean {
  return DESIGN_PIPELINE_DOC_PATTERN.test(file);
}

// ---------------------------------------------------------------------------
// 작업 묶음
// ---------------------------------------------------------------------------

export const DesignBundleSchema = z.object({
  id: z.string().min(1).max(20),
  title: z.string().min(1).max(200),
  doneCondition: z.string().max(2_000),
  /** 예상 시간(분) 범위. 범인·불확실성이 커 한 점이 아니라 범위로 받는다 */
  estimateMinMinutes: z.number().int().min(0),
  estimateMaxMinutes: z.number().int().min(0),
  deliverable: z.string().max(1_000),
  /** 이 묶음이 쓸 수 있는 경로(레인 쓰기 범위와 같은 모양) */
  writableScope: z.array(z.string().min(1)).max(50),
});
export type DesignBundle = z.infer<typeof DesignBundleSchema>;

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
export function parseDesignBundlesTable(markdown: string): DesignBundle[] {
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
export function buildDesignPipelineRequestPrompt(input: { title: string; requirementIds: readonly string[]; detail?: string }): string {
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
export function buildDesignPipelineDocTemplate(number: number, title: string, requirementIds: readonly string[] = []): string {
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

export const DesignDocStatusSchema = z.enum(['draft', 'approved']);
export type DesignDocStatus = z.infer<typeof DesignDocStatusSchema>;

export const DesignDocRecordSchema = z.object({
  path: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1).max(200),
  requirementIds: z.array(z.string()).max(100),
  bundles: z.array(DesignBundleSchema).max(50),
  status: DesignDocStatusSchema,
  createdAt: z.string(),
  createdBy: z.string(),
  approvedBy: z.string().optional(),
  approvedAt: z.string().optional(),
});
export type DesignDocRecord = z.infer<typeof DesignDocRecordSchema>;

// ---------------------------------------------------------------------------
// 승인 게이트(서버 강제)
// ---------------------------------------------------------------------------

export interface DesignApprovalCheck {
  blocked: boolean;
  /** 막은 이유가 된, 승인되지 않은 설계 문서들 */
  blockingDocs: DesignDocRecord[];
}

/**
 * 요청 글에 언급된 요구사항 id가, 아직 승인되지 않은 설계 문서가 다루는 범위에 걸리는지 확인한다.
 * 그 요구사항을 다루는 설계 문서가 하나도 없으면(아직 설계를 만들지 않은 프로젝트·요청) 막지 않는다 — 옵트인.
 */
export function checkDesignApproval(requirementIdsInRequest: readonly string[], designDocs: readonly DesignDocRecord[]): DesignApprovalCheck {
  if (requirementIdsInRequest.length === 0) return { blocked: false, blockingDocs: [] };
  const mentioned = new Set(requirementIdsInRequest);
  const blockingDocs = designDocs.filter((doc) => doc.status !== 'approved' && doc.requirementIds.some((id) => mentioned.has(id)));
  return { blocked: blockingDocs.length > 0, blockingDocs };
}

export const DESIGN_APPROVAL_REQUIRED_MESSAGE = '설계 승인 전에는 구현을 시작할 수 없습니다';

// ---------------------------------------------------------------------------
// 리뷰어 독립성(검토가 구현과 같은 모델 계열이면 "성공"으로 세지 않는다)
// ---------------------------------------------------------------------------

/** 세션 백엔드·API 모델 공급자를 뭉친 계열. claude-code·anthropic api 모델은 모두 claude다 */
export type ModelFamily = 'claude' | 'openai' | 'google' | 'commandcode' | 'opencode' | 'unknown';

export type ReviewIndependence = 'independent' | 'same-family' | 'unknown';

/** 구현·검토가 같은 계열이면 'same-family'(독립성 낮음), 둘 중 하나라도 모르면 'unknown', 다르면 'independent' */
export function reviewIndependence(implementer: ModelFamily, reviewer: ModelFamily): ReviewIndependence {
  if (implementer === 'unknown' || reviewer === 'unknown') return 'unknown';
  return implementer === reviewer ? 'same-family' : 'independent';
}

export const SAME_FAMILY_REVIEW_LABEL = '같은 계열 검토(독립성 낮음)';
export const REVIEW_NOT_RUN_LABEL = '검토 못 함';

// ---------------------------------------------------------------------------
// 파이프라인 단계 판정 — "완료"(구현이 끝났다)와 "성공"(독립 검토 + 검증 재실행 통과)을 나눈다
// ---------------------------------------------------------------------------

export interface DesignPipelineReviewInput {
  /** 리뷰 호출이 실제로 돌았는지. 백엔드가 지원하지 않거나 한도에 걸려 못 돌았으면 false(침묵 통과시키지 않는다) */
  ran: boolean;
  passed: boolean;
  independence: ReviewIndependence;
  findingsCount?: number;
  reviewerLabel?: string;
}

export interface DesignPipelineVerificationInput {
  /** 마지막 변경 뒤 검증 게이트가 다시 돌았는지 */
  ran: boolean;
  ok: boolean;
  /** 그 검증에 테스트 재실행이 포함됐는지(workflow.tests가 없으면 테스트가 없는 프로젝트이므로 true로 본다) */
  testsRerun: boolean;
}

export interface DesignPipelineCoder {
  sessionId?: string;
  backend?: string;
  model?: string;
  /** 이 작업 묶음을 도는 동안 모델이 승격(에스컬레이션)됐는지. true면 "같은 코더 유지" 원칙의 예외로 보여 준다 */
  escalated: boolean;
}

export interface DesignPipelineBundleActual {
  bundle: DesignBundle;
  /** 실제로 걸린 시간(분). 아직 실행한 적이 없으면 없음 */
  actualMinutes?: number;
  coder?: DesignPipelineCoder;
}

export interface DesignPipelineInput {
  design: DesignDocRecord;
  /** 이 설계 범위의 구현 체크포인트가 있는지("완료"의 유일한 조건) */
  implementationCheckpointExists: boolean;
  review?: DesignPipelineReviewInput;
  verification?: DesignPipelineVerificationInput;
}

export interface DesignPipelineResult {
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
export function deriveDesignPipelineResult(input: DesignPipelineInput): DesignPipelineResult {
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
