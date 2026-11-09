import { encodeNative, native } from '@b-studio/sandbox';

/**
 * "문서" 탭(ADR-094)이 쓰는 순수 함수: 새 문서 템플릿(설계 문서·ADR·트러블슈팅·로드맵), 다음 번호 계산,
 * `docs/README.md` 색인 재생성. 이 파일은 파일 IO를 하지 않는다 — 읽고 쓰는 일은 studio의 sessions.ts가
 * Workspace로 맡고, 여기 함수들은 문자열만 받아 문자열을 돌려준다(테스트하기 쉽고, studio 밖에서도 재사용할 수 있게).
 * 판정은 Rust(crates/bstudio-guard/src/docs.rs, ADR-191 3단계 3k)가 하고, 이 파일은 타입·경로 상수와 같은 이름·시그니처의 껍데기다.
 * 날짜 글자(`toISOString().slice(0, 10)`, UTC)와 잘못된 Date에서 던지는 일은 껍데기에 남긴다.
 *
 * 범수 님의 BE-commerce 저장소(docs/README.md의 "처음 읽는 순서" 표, `docs/NN-제목.md` 번호 매긴 설계 문서,
 * `docs/adr/ADR-NNN-slug.md` 한 ADR당 한 파일, TROUBLESHOOTING-LOG.md·ROADMAP-TRADEOFFS.md) 구조를 참고했다.
 */

// ---------------------------------------------------------------------------
// 파일 이름 만들기
// ---------------------------------------------------------------------------

/**
 * 제목을 파일 이름 조각으로 바꾼다. 한글은 그대로 두고(BE-commerce 관례), 공백·슬래시는 하이픈으로,
 * 파일 이름에 쓸 수 없는 문자만 지운다.
 */
export function slugifyTitle(title: string): string {
  return native.docsSlugifyTitle(title);
}

/** 기존 문서 경로들에서 다음 번호 매긴 설계 문서 번호를 고른다(비어 있으면 1부터) */
export function nextDesignDocNumber(existingPaths: readonly string[]): number {
  return native.docsNextDesignDocNumber([...existingPaths]);
}

/** 기존 문서 경로들에서 다음 ADR 번호를 고른다(비어 있으면 1부터) */
export function nextAdrNumber(existingPaths: readonly string[]): number {
  return native.docsNextAdrNumber([...existingPaths]);
}

/** `docs/NN-제목.md` 경로 */
export function designDocFilePath(number: number, title: string): string {
  return native.docsDesignDocFilePath(number, title);
}

/** `docs/adr/ADR-NNN-제목.md` 경로. ADR 번호는 관례상 세 자리 이상(001, 010, 100)을 쓴다 */
export function adrFilePath(number: number, title: string): string {
  return native.docsAdrFilePath(number, title);
}

export const TROUBLESHOOTING_LOG_PATH = 'docs/TROUBLESHOOTING-LOG.md';
export const ROADMAP_TRADEOFFS_PATH = 'docs/ROADMAP-TRADEOFFS.md';
export const DOCS_README_PATH = 'docs/README.md';

// ---------------------------------------------------------------------------
// 새 문서 템플릿
// ---------------------------------------------------------------------------

export type DocTemplateKind = 'design' | 'adr' | 'troubleshooting' | 'roadmap' | 'verification' | 'experiment' | 'roadmap-plan';

/** 오늘 날짜(YYYY-MM-DD). 호출하는 쪽이 넘기지 않으면 지금 시각을 쓴다(테스트는 항상 넘긴다 — 결정론적으로) */
function todayIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** "설계 문서" 템플릿(`docs/NN-제목.md`). 문제/가설/선택지/판단 기준/결정/포기한 것/검증/예상과 실제 틀을 둔다 */
export function buildDesignDocTemplate(number: number, title: string): string {
  return native.docsBuildDesignDocTemplate(number, title);
}

/** "ADR" 템플릿(`docs/adr/ADR-NNN-제목.md`). 헤더 불릿(상태·날짜·관련) 뒤에 설계 문서와 같은 절을 둔다 */
export function buildAdrTemplate(number: number, title: string, { date = new Date(), related = [] }: { date?: Date; related?: readonly string[] } = {}): string {
  return native.docsBuildAdrTemplate(number, title, todayIso(date), [...related]);
}

/** 트러블슈팅 항목 하나(TROUBLESHOOTING-LOG.md에 이어 붙일 조각) */
export function buildTroubleshootingEntry(title: string, { symptom = '', cause = '', fix = '' }: { symptom?: string; cause?: string; fix?: string } = {}): string {
  return native.docsBuildEntry('troubleshooting', title, [symptom || '', cause || '', fix || '']);
}

/** TROUBLESHOOTING-LOG.md에 항목을 이어 붙인다. 파일이 아직 없으면(undefined) 제목을 먼저 만든다 */
export function appendTroubleshootingEntry(existing: string | undefined, entry: string): string {
  return native.docsAppendEntry('troubleshooting', existing, entry);
}

/** 로드맵·트레이드오프 후보 하나(ROADMAP-TRADEOFFS.md에 이어 붙일 조각) */
export function buildRoadmapTradeoffEntry(title: string, { option = '', tradeoff = '' }: { option?: string; tradeoff?: string } = {}): string {
  return native.docsBuildEntry('roadmap-tradeoff', title, [option || '', tradeoff || '']);
}

/** ROADMAP-TRADEOFFS.md에 항목을 이어 붙인다. 파일이 아직 없으면(undefined) 제목을 먼저 만든다 */
export function appendRoadmapTradeoffEntry(existing: string | undefined, entry: string): string {
  return native.docsAppendEntry('roadmap-tradeoff', existing, entry);
}

export const VERIFICATION_LOG_PATH = 'docs/VERIFICATION-LOG.md';
export const EXPERIMENT_LOG_PATH = 'docs/EXPERIMENT-LOG.md';

/**
 * 검증 기록 항목 하나(VERIFICATION-LOG.md에 이어 붙일 조각). "성능이 좋아졌다" 같은 측정 없는 문장 대신
 * 가설·조건·관측값·예상과 다른 점·배제한 원인·다음 확인 여섯 칸을 강제한다(실패도 범위를 적어 기록으로 남긴다).
 */
export function buildVerificationEntry(
  title: string,
  {
    hypothesis = '',
    condition = '',
    observation = '',
    deviation = '',
    excludedCauses = '',
    nextCheck = '',
  }: { hypothesis?: string; condition?: string; observation?: string; deviation?: string; excludedCauses?: string; nextCheck?: string } = {},
): string {
  return native.docsBuildEntry('verification', title, [hypothesis || '', condition || '', observation || '', deviation || '', excludedCauses || '', nextCheck || '']);
}

/** VERIFICATION-LOG.md에 항목을 이어 붙인다. 파일이 아직 없으면(undefined) 제목을 먼저 만든다 */
export function appendVerificationEntry(existing: string | undefined, entry: string): string {
  return native.docsAppendEntry('verification', existing, entry);
}

/** 실험 기록 항목 하나(EXPERIMENT-LOG.md에 이어 붙일 조각). 가설·방법·결과·결론 네 칸만 둔다(자세한 조건·지표는 docs/experiments/ 보고서를 따로 쓴다) */
export function buildExperimentEntry(
  title: string,
  { hypothesis = '', method = '', result = '', conclusion = '' }: { hypothesis?: string; method?: string; result?: string; conclusion?: string } = {},
): string {
  return native.docsBuildEntry('experiment', title, [hypothesis || '', method || '', result || '', conclusion || '']);
}

/** EXPERIMENT-LOG.md에 항목을 이어 붙인다. 파일이 아직 없으면(undefined) 제목을 먼저 만든다 */
export function appendExperimentEntry(existing: string | undefined, entry: string): string {
  return native.docsAppendEntry('experiment', existing, entry);
}

// ---------------------------------------------------------------------------
// ROADMAP.md: 단계(POC/MVP/Beta/v1)·마일스톤·현재 위치는 손으로 쓰고, "진행 현황" 구간만
// 요구사항 상태에서 자동으로 다시 만든다(ADR-098, 색인 재생성과 같은 관리되는 구간 방식).
// ---------------------------------------------------------------------------

export const ROADMAP_PATH = 'docs/ROADMAP.md';
export const ROADMAP_STATUS_START = '<!-- b-studio:roadmap-status -->';
export const ROADMAP_STATUS_END = '<!-- /b-studio:roadmap-status -->';

/** "ROADMAP" 템플릿(`docs/ROADMAP.md`). 단계·마일스톤·현재 위치는 손으로 채우고, 진행 현황은 "ROADMAP 갱신"이 자동으로 메운다 */
export function buildRoadmapTemplate(): string {
  return native.docsBuildRoadmapTemplate();
}

/** "ROADMAP 갱신"이 넘기는 집계값. 요구사항 상태별 개수와 필수(must)·권장(should) 진행도만 다룬다(마일스톤은 손으로 쓴 글이라 건드리지 않는다) */
export interface RoadmapStatusSummary {
  /** 상태 이름(미착수·작업 중·검증됨·재확인 필요·실패) → 개수. 요구사항이 하나도 없으면 빈 객체 */
  byStatus: Readonly<Record<string, number>>;
  must: { total: number; done: number };
  should: { total: number; done: number };
}

/**
 * `docs/ROADMAP.md`의 "진행 현황" 구간만 다시 만든다(docs/README.md 색인 재생성과 같은 관리되는 구간 방식) —
 * 단계·마일스톤·현재 위치처럼 손으로 쓴 글은 그대로 둔다. 파일이 없으면(undefined) 새 ROADMAP 템플릿을 만들고
 * 그 안의 진행 현황 구간을 채운다. 관리 구간 표지가 없으면(손으로 만든 옛 ROADMAP.md) 글 끝에 새로 덧붙인다.
 */
export function regenerateRoadmapStatus(existing: string | undefined, summary: RoadmapStatusSummary): string {
  // Object.entries의 순서(정수꼴 키가 앞)를 그대로 두 목록으로 넘긴다
  const entries = Object.entries(summary.byStatus);
  return native.docsRegenerateRoadmapStatus(
    existing,
    entries.map(([status]) => status),
    entries.map(([, count]) => count),
    summary.must.total,
    summary.must.done,
    summary.should.total,
    summary.should.done,
  );
}

// ---------------------------------------------------------------------------
// docs/README.md 색인 재생성
// ---------------------------------------------------------------------------

export const DOCS_INDEX_START = '<!-- b-studio:docs-index -->';
export const DOCS_INDEX_END = '<!-- /b-studio:docs-index -->';

export interface DocSummary {
  /** 프로젝트 루트 기준 경로(docs/02-결제도메인-핵심개념.md 같은) */
  path: string;
  /** 첫 H1(# 제목) 텍스트. 없으면 파일 이름에서 뽑는다 */
  title: string;
  /** 제목 바로 뒤 첫 문단(여러 줄이면 공백으로 이어 붙인다). 없으면 빈 문자열 */
  paragraph: string;
}

/** 마크다운에서 첫 H1과 그 뒤 첫 문단을 뽑는다. H1이 없으면 title은 빈 문자열이다(호출하는 쪽이 파일 이름으로 메운다) */
export function extractDocSummary(markdown: string): { title: string; paragraph: string } {
  return JSON.parse(native.docsExtractDocSummary(markdown)) as { title: string; paragraph: string };
}

/** 문서 하나의 요약을 만든다(경로+내용). 제목이 없으면 파일 이름(확장자 뺀 마지막 조각)을 제목으로 쓴다 */
export function buildDocSummary(path: string, markdown: string): DocSummary {
  return JSON.parse(native.docsBuildDocSummary(path, markdown)) as DocSummary;
}

/**
 * `docs/README.md`의 색인을 다시 만든다. 관리되는 구간(DOCS_INDEX_START~END) 안만 바꾸고, 그 밖의 손으로 쓴
 * 글은 그대로 둔다. 기존 README가 없으면(undefined) 새 머리말과 관리 구간만 담은 문서를 만든다.
 * 관리 구간 표지가 기존 README에 없으면(처음 "색인 갱신"을 누른 경우) 글 끝에 구간을 새로 덧붙인다.
 */
export function regenerateDocsReadme(existing: string | undefined, docs: readonly DocSummary[]): string {
  return native.docsRegenerateDocsReadme(existing, encodeNative(docs.map((doc) => ({ path: doc.path, title: doc.title, paragraph: doc.paragraph }))));
}
