/**
 * "문서" 탭(ADR-094)이 쓰는 순수 함수: 새 문서 템플릿(설계 문서·ADR·트러블슈팅·로드맵), 다음 번호 계산,
 * `docs/README.md` 색인 재생성. 이 파일은 파일 IO를 하지 않는다 — 읽고 쓰는 일은 studio의 sessions.ts가
 * Workspace로 맡고, 여기 함수들은 문자열만 받아 문자열을 돌려준다(테스트하기 쉽고, studio 밖에서도 재사용할 수 있게).
 *
 * 범수 님의 BE-commerce 저장소(docs/README.md의 "처음 읽는 순서" 표, `docs/NN-제목.md` 번호 매긴 설계 문서,
 * `docs/adr/ADR-NNN-slug.md` 한 ADR당 한 파일, TROUBLESHOOTING-LOG.md·ROADMAP-TRADEOFFS.md) 구조를 참고했다.
 */

// ---------------------------------------------------------------------------
// 파일 이름 만들기
// ---------------------------------------------------------------------------

/** 번호를 두 자리 이상으로 0으로 채운다(01, 02 … 99, 100) */
function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * 제목을 파일 이름 조각으로 바꾼다. 한글은 그대로 두고(BE-commerce 관례), 공백·슬래시는 하이픈으로,
 * 파일 이름에 쓸 수 없는 문자만 지운다.
 */
export function slugifyTitle(title: string): string {
  return title
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '') || '제목-없음';
}

const DESIGN_DOC_PATTERN = /^docs\/(\d{2,})-.+\.md$/;
const ADR_PATTERN = /^docs\/adr\/ADR-(\d{3,})-.+\.md$/;

/** 기존 문서 경로들에서 다음 번호 매긴 설계 문서 번호를 고른다(비어 있으면 1부터) */
export function nextDesignDocNumber(existingPaths: readonly string[]): number {
  const max = existingPaths.reduce((acc, path) => {
    const match = DESIGN_DOC_PATTERN.exec(path);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return max + 1;
}

/** 기존 문서 경로들에서 다음 ADR 번호를 고른다(비어 있으면 1부터) */
export function nextAdrNumber(existingPaths: readonly string[]): number {
  const max = existingPaths.reduce((acc, path) => {
    const match = ADR_PATTERN.exec(path);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return max + 1;
}

/** `docs/NN-제목.md` 경로 */
export function designDocFilePath(number: number, title: string): string {
  return `docs/${pad(number)}-${slugifyTitle(title)}.md`;
}

/** `docs/adr/ADR-NNN-제목.md` 경로. ADR 번호는 관례상 세 자리 이상(001, 010, 100)을 쓴다 */
export function adrFilePath(number: number, title: string): string {
  const padded = number < 100 ? `0${pad(number)}` : `${number}`;
  return `docs/adr/ADR-${padded}-${slugifyTitle(title)}.md`;
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

/**
 * 설계 문서·ADR이 공유하는 본문 절. "문제 → 왜 문제라고 판단했나 → 가설 → 선택지(얻는 것·잃는 것) → 판단 기준 →
 * 결정 → 포기한 것 → 검증 → 예상과 실제" 순서로, 범수 님이 쓴 평가 기준(기술 판단의 근거·트레이드오프·검증을
 * 측정 가능하게 남긴다)을 그대로 문서 뼈대로 옮겼다. 맥락/결정/검토한 선택지/감수한 트레이드오프만 두던 예전
 * 틀보다 "왜 문제라고 봤는지"·"무엇을 포기했는지"·"예상과 실제가 어떻게 달랐는지"를 빈칸으로 남겨 채우게 한다.
 */
function buildDecisionDocBody(): string {
  return `## 문제

(무엇이 문제인지 적습니다)

## 왜 문제라고 판단했나

(관측한 사실·수치를 적습니다 — "느리다" 대신 "p95 850ms" 같이 측정 가능한 근거를 적습니다)

## 가설

(이 문제의 원인이나 해결 방향에 대한 반증 가능한 가설을 적습니다)

## 선택지

| 선택지 | 얻는 것 | 잃는 것 |
| --- | --- | --- |

## 판단 기준

(선택지 중 하나를 고를 때 무엇을 기준으로 판단했는지 적습니다)

## 결정

(최종 결정과 그 이유를 적습니다)

## 포기한 것

(이 결정으로 포기한 선택지와 그 이유, 아직 검증하지 못한 범위를 적습니다)

## 검증

(무엇을 어떤 조건에서 측정했는지, 결과가 무엇인지 적습니다)

## 예상과 실제

(결정할 때 예상한 것과 실제 결과가 어떻게 달랐는지 적습니다. 다르지 않았다면 그 사실도 적습니다)
`;
}

/** "설계 문서" 템플릿(`docs/NN-제목.md`). 문제/가설/선택지/판단 기준/결정/포기한 것/검증/예상과 실제 틀을 둔다 */
export function buildDesignDocTemplate(number: number, title: string): string {
  return `# ${pad(number)}. ${title}

${title}에 관한 설계 문서입니다.

${buildDecisionDocBody()}`;
}

/** "ADR" 템플릿(`docs/adr/ADR-NNN-제목.md`). 헤더 불릿(상태·날짜·관련) 뒤에 설계 문서와 같은 절을 둔다 */
export function buildAdrTemplate(number: number, title: string, { date = new Date(), related = [] }: { date?: Date; related?: readonly string[] } = {}): string {
  const padded = number < 100 ? `0${pad(number)}` : `${number}`;
  const relatedLine = related.length > 0 ? related.join(', ') : '(관련 문서·이슈를 적습니다)';
  return `# ADR-${padded}. ${title}

- 상태: 제안 (Proposed)
- 날짜: ${todayIso(date)}
- 관련: ${relatedLine}

${buildDecisionDocBody()}`;
}

/** 트러블슈팅 항목 하나(TROUBLESHOOTING-LOG.md에 이어 붙일 조각) */
export function buildTroubleshootingEntry(title: string, { symptom = '', cause = '', fix = '' }: { symptom?: string; cause?: string; fix?: string } = {}): string {
  return `### ${title}

- 증상: ${symptom || '(무엇이 어떻게 잘못됐는지 적습니다)'}
- 원인: ${cause || '(원인을 적습니다)'}
- 해결: ${fix || '(해결 방법이나 지금 상태를 적습니다)'}
`;
}

/** TROUBLESHOOTING-LOG.md에 항목을 이어 붙인다. 파일이 아직 없으면(undefined) 제목을 먼저 만든다 */
export function appendTroubleshootingEntry(existing: string | undefined, entry: string): string {
  const base = existing?.trim() ? existing.trimEnd() : '# 트러블슈팅 기록\n\n이 문서는 지금 무엇이 열려 있고, 닫은 것은 어떻게 닫았는지를 한 곳에 모읍니다.';
  return `${base}\n\n${entry.trim()}\n`;
}

/** 로드맵·트레이드오프 후보 하나(ROADMAP-TRADEOFFS.md에 이어 붙일 조각) */
export function buildRoadmapTradeoffEntry(title: string, { option = '', tradeoff = '' }: { option?: string; tradeoff?: string } = {}): string {
  return `### ${title}

- 후보: ${option || '(검토 중인 선택지를 적습니다)'}
- 트레이드오프: ${tradeoff || '(얻는 것과 잃는 것을 적습니다)'}
`;
}

/** ROADMAP-TRADEOFFS.md에 항목을 이어 붙인다. 파일이 아직 없으면(undefined) 제목을 먼저 만든다 */
export function appendRoadmapTradeoffEntry(existing: string | undefined, entry: string): string {
  const base = existing?.trim() ? existing.trimEnd() : '# 트레이드오프 후보 로드맵\n\n이 문서는 검토 중인 선택지와 그 트레이드오프를 모읍니다.';
  return `${base}\n\n${entry.trim()}\n`;
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
  return `### ${title}

- 가설: ${hypothesis || '(반증 가능한 한 문장을 적습니다)'}
- 조건: ${condition || '(무엇을 어떤 조건에서 측정했는지 적습니다 — 환경·반복 횟수·고정한 변수)'}
- 관측값: ${observation || '(실제로 측정한 수치를 적습니다)'}
- 예상과 다른 점: ${deviation || '(가설과 어긋난 관측이 있으면 적습니다. 없으면 "없음")'}
- 배제한 원인: ${excludedCauses || '(무엇을 확인해 배제했는지 적습니다)'}
- 다음 확인: ${nextCheck || '(남은 질문과 다음에 확인할 것을 적습니다)'}
`;
}

/** VERIFICATION-LOG.md에 항목을 이어 붙인다. 파일이 아직 없으면(undefined) 제목을 먼저 만든다 */
export function appendVerificationEntry(existing: string | undefined, entry: string): string {
  const base = existing?.trim()
    ? existing.trimEnd()
    : '# 검증 기록\n\n이 문서는 "구현되어 있음"과 "실제로 측정해 확인함"을 구분합니다. 가설·조건·관측값을 남겨 다음에 같은 조건으로 다시 잴 수 있게 합니다.';
  return `${base}\n\n${entry.trim()}\n`;
}

/** 실험 기록 항목 하나(EXPERIMENT-LOG.md에 이어 붙일 조각). 가설·방법·결과·결론 네 칸만 둔다(자세한 조건·지표는 docs/experiments/ 보고서를 따로 쓴다) */
export function buildExperimentEntry(
  title: string,
  { hypothesis = '', method = '', result = '', conclusion = '' }: { hypothesis?: string; method?: string; result?: string; conclusion?: string } = {},
): string {
  return `### ${title}

- 가설: ${hypothesis || '(반증 가능한 한 문장을 적습니다)'}
- 방법: ${method || '(무엇을 어떻게 비교했는지 적습니다 — 과제·모델·반복 횟수·고정한 변수)'}
- 결과: ${result || '(측정한 수치를 그대로 적습니다. 가설이 틀렸어도 결과로 남깁니다)'}
- 결론: ${conclusion || '(이 결과가 적용되는 범위를 한정해 적습니다)'}
`;
}

/** EXPERIMENT-LOG.md에 항목을 이어 붙인다. 파일이 아직 없으면(undefined) 제목을 먼저 만든다 */
export function appendExperimentEntry(existing: string | undefined, entry: string): string {
  const base = existing?.trim() ? existing.trimEnd() : '# 실험 기록\n\n이 문서는 검증할 가설과 그 결과를 날짜 순으로 모읍니다. 틀린 가설도 결과로 남깁니다.';
  return `${base}\n\n${entry.trim()}\n`;
}

// ---------------------------------------------------------------------------
// ROADMAP.md: 단계(POC/MVP/Beta/v1)·마일스톤·현재 위치는 손으로 쓰고, "진행 현황" 구간만
// 요구사항 상태에서 자동으로 다시 만든다(ADR-0XX, 색인 재생성과 같은 관리되는 구간 방식).
// ---------------------------------------------------------------------------

export const ROADMAP_PATH = 'docs/ROADMAP.md';
export const ROADMAP_STATUS_START = '<!-- b-studio:roadmap-status -->';
export const ROADMAP_STATUS_END = '<!-- /b-studio:roadmap-status -->';

/** "ROADMAP" 템플릿(`docs/ROADMAP.md`). 단계·마일스톤·현재 위치는 손으로 채우고, 진행 현황은 "ROADMAP 갱신"이 자동으로 메운다 */
export function buildRoadmapTemplate(): string {
  return `# 로드맵

## 단계

- [ ] POC
- [ ] MVP
- [ ] Beta
- [ ] v1

(지금 어느 단계를 밟고 있는지 체크하고, 각 단계에서 끝내야 할 것을 적습니다)

## 마일스톤

(마일스톤과 예상 날짜를 적습니다. 예상이 틀렸으면 날짜를 고치지 말고 옆에 실제 날짜와 이유를 덧붙입니다)

## 현재 위치

(지금 무엇을 끝냈고 무엇이 남았는지 적습니다)

## 진행 현황

${ROADMAP_STATUS_START}
아직 집계하지 않았습니다. "ROADMAP 갱신"을 눌러 요구사항 상태를 반영하세요.
${ROADMAP_STATUS_END}
`;
}

/** "ROADMAP 갱신"이 넘기는 집계값. 요구사항 상태별 개수와 필수(must)·권장(should) 진행도만 다룬다(마일스톤은 손으로 쓴 글이라 건드리지 않는다) */
export interface RoadmapStatusSummary {
  /** 상태 이름(미착수·작업 중·검증됨·재확인 필요·실패) → 개수. 요구사항이 하나도 없으면 빈 객체 */
  byStatus: Readonly<Record<string, number>>;
  must: { total: number; done: number };
  should: { total: number; done: number };
}

/** 진행 현황 관리 구간의 몸통(표 + 필수·권장 진행도 한 줄) */
function buildRoadmapStatusBody(summary: RoadmapStatusSummary): string {
  const entries = Object.entries(summary.byStatus);
  if (entries.length === 0) return '아직 저장된 요구사항이 없습니다. "요구사항" 탭에서 먼저 명세를 뽑아 저장하세요.';
  const rows = entries.map(([status, count]) => `| ${status} | ${count} |`);
  const table = `| 상태 | 개수 |\n| --- | --- |\n${rows.join('\n')}`;
  const progress = `필수(must) 진행: ${summary.must.done}/${summary.must.total} · 권장(should) 진행: ${summary.should.done}/${summary.should.total}`;
  return `${table}\n\n${progress}`;
}

/**
 * `docs/ROADMAP.md`의 "진행 현황" 구간만 다시 만든다(docs/README.md 색인 재생성과 같은 관리되는 구간 방식) —
 * 단계·마일스톤·현재 위치처럼 손으로 쓴 글은 그대로 둔다. 파일이 없으면(undefined) 새 ROADMAP 템플릿을 만들고
 * 그 안의 진행 현황 구간을 채운다. 관리 구간 표지가 없으면(손으로 만든 옛 ROADMAP.md) 글 끝에 새로 덧붙인다.
 */
export function regenerateRoadmapStatus(existing: string | undefined, summary: RoadmapStatusSummary): string {
  const body = buildRoadmapStatusBody(summary);
  const managed = `${ROADMAP_STATUS_START}\n${body}\n${ROADMAP_STATUS_END}`;
  const base = existing?.trim() ? existing : buildRoadmapTemplate();

  const startIndex = base.indexOf(ROADMAP_STATUS_START);
  const endIndex = base.indexOf(ROADMAP_STATUS_END);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return `${base.trimEnd()}\n\n## 진행 현황\n\n${managed}\n`;
  }
  return `${base.slice(0, startIndex)}${managed}${base.slice(endIndex + ROADMAP_STATUS_END.length)}`;
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
  const lines = markdown.split(/\r?\n/);
  let title = '';
  let titleIndex = -1;
  for (let index = 0; index < lines.length; index++) {
    const match = /^#\s+(.+?)\s*$/.exec(lines[index]!);
    if (match) {
      title = match[1]!;
      titleIndex = index;
      break;
    }
  }
  if (titleIndex === -1) return { title: '', paragraph: '' };

  const paragraphLines: string[] = [];
  for (let index = titleIndex + 1; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) {
      if (paragraphLines.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) break;
    if (/^(<!--|\||-\s|\d+[.)]\s)/.test(line)) break;
    paragraphLines.push(line);
  }
  return { title, paragraph: paragraphLines.join(' ') };
}

/** 문서 하나의 요약을 만든다(경로+내용). 제목이 없으면 파일 이름(확장자 뺀 마지막 조각)을 제목으로 쓴다 */
export function buildDocSummary(path: string, markdown: string): DocSummary {
  const { title, paragraph } = extractDocSummary(markdown);
  const fallbackTitle = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
  return { path, title: title || fallbackTitle, paragraph };
}

/** 색인 표에서 문서가 나올 순서: 설계 문서(번호순) → ADR(번호순) → 트러블슈팅·로드맵·작업 보드 → 그 밖(경로 가나다순) */
function sortKey(path: string): [number, number, string] {
  const design = DESIGN_DOC_PATTERN.exec(path);
  if (design) return [0, Number(design[1]), path];
  const adr = ADR_PATTERN.exec(path);
  if (adr) return [1, Number(adr[1]), path];
  if (path === TROUBLESHOOTING_LOG_PATH) return [2, 0, path];
  if (path === ROADMAP_TRADEOFFS_PATH) return [2, 1, path];
  return [3, 0, path];
}

function compareSortKey(a: readonly [number, number, string], b: readonly [number, number, string]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2].localeCompare(b[2]);
}

/** 색인 표 하나(관리되는 구간의 몸통). "문서 | 확인할 내용" — 역할을 세부 분류하는 것은 사람 판단이라 다루지 않는다 */
function buildIndexTable(docs: readonly DocSummary[]): string {
  if (docs.length === 0) return '아직 문서가 없습니다. "새 문서"로 설계 문서·ADR·트러블슈팅·로드맵을 만들어 보세요.';
  const sorted = [...docs].sort((a, b) => compareSortKey(sortKey(a.path), sortKey(b.path)));
  const rows = sorted.map((doc) => {
    const label = doc.path.replace(/^docs\//, '');
    const content = doc.paragraph || '(요약 없음)';
    return `| [${doc.title}](${label}) | ${content} |`;
  });
  return `| 문서 | 확인할 내용 |\n| --- | --- |\n${rows.join('\n')}`;
}

/**
 * `docs/README.md`의 색인을 다시 만든다. 관리되는 구간(DOCS_INDEX_START~END) 안만 바꾸고, 그 밖의 손으로 쓴
 * 글은 그대로 둔다. 기존 README가 없으면(undefined) 새 머리말과 관리 구간만 담은 문서를 만든다.
 * 관리 구간 표지가 기존 README에 없으면(처음 "색인 갱신"을 누른 경우) 글 끝에 구간을 새로 덧붙인다.
 */
export function regenerateDocsReadme(existing: string | undefined, docs: readonly DocSummary[]): string {
  const table = buildIndexTable(docs);
  const managed = `${DOCS_INDEX_START}\n${table}\n${DOCS_INDEX_END}`;

  if (!existing?.trim()) {
    return `# 문서\n\n${managed}\n`;
  }

  const startIndex = existing.indexOf(DOCS_INDEX_START);
  const endIndex = existing.indexOf(DOCS_INDEX_END);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    const base = existing.trimEnd();
    return `${base}\n\n${managed}\n`;
  }

  const before = existing.slice(0, startIndex);
  const after = existing.slice(endIndex + DOCS_INDEX_END.length);
  return `${before}${managed}${after}`;
}
