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

export type DocTemplateKind = 'design' | 'adr' | 'troubleshooting' | 'roadmap';

/** 오늘 날짜(YYYY-MM-DD). 호출하는 쪽이 넘기지 않으면 지금 시각을 쓴다(테스트는 항상 넘긴다 — 결정론적으로) */
function todayIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** "설계 문서" 템플릿(`docs/NN-제목.md`). 맥락·결정·검토한 선택지·감수한 트레이드오프 틀만 둔다 */
export function buildDesignDocTemplate(number: number, title: string): string {
  return `# ${pad(number)}. ${title}

${title}에 관한 설계 문서입니다.

## 맥락

(이 문서를 쓰게 된 배경과 풀어야 할 문제를 적습니다)

## 결정

(최종 결정과 그 이유를 적습니다)

## 검토한 선택지

| 방식 | 문제 |
| --- | --- |

## 감수한 트레이드오프

(이 결정으로 포기한 것, 아직 검증하지 못한 범위를 적습니다)
`;
}

/** "ADR" 템플릿(`docs/adr/ADR-NNN-제목.md`). 헤더 불릿(상태·날짜·관련) 뒤에 맥락/결정/검토한 선택지/감수한 트레이드오프를 둔다 */
export function buildAdrTemplate(number: number, title: string, { date = new Date(), related = [] }: { date?: Date; related?: readonly string[] } = {}): string {
  const padded = number < 100 ? `0${pad(number)}` : `${number}`;
  const relatedLine = related.length > 0 ? related.join(', ') : '(관련 문서·이슈를 적습니다)';
  return `# ADR-${padded}. ${title}

- 상태: 제안 (Proposed)
- 날짜: ${todayIso(date)}
- 관련: ${relatedLine}

## 맥락

(이 결정을 하게 된 배경과 풀어야 할 문제를 적습니다)

## 결정

(최종 결정과 그 이유를 적습니다)

## 검토한 선택지

| 방식 | 문제 |
| --- | --- |

## 감수한 트레이드오프

(이 결정으로 포기한 것, 아직 검증하지 못한 범위를 적습니다)
`;
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
