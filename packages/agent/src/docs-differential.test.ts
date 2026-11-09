import { describe, expect, it } from 'vitest';
import { Gen, outcome, perturb, readEnvList, readEnvNumber, sameOutcome, type Outcome } from './differential-kit';
import * as current from './docs';

/**
 * "문서" 탭의 순수 함수(docs.ts)를 Rust로 옮기면서(ADR-191 3단계 3k) 옛 TS 구현을 아래 `legacy`에 그대로 두고, 같은 무작위 입력을
 * 옛 구현과 새 껍데기에 넣어 결과를 JSON 글자(키 순서·NaN·-0 포함)로 견준다. `legacy`는 옮기기 전 docs.ts의 본문이다(`export`와 파일 머리 설명만 뗐다).
 * 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * 의도한 차이(입력에서 비켜 간다): 짝 없는 서로게이트는 napi 경계에서 U+FFFD가 된다(옛 결과도 같게 맞춘다), 색인 정렬의 `localeCompare`는
 * ASCII와 한글 음절만 ICU와 같다(그 밖의 글자는 벡터 시험이 다룬다), 색인 요약의 path·title·paragraph가 글자가 아니면 새 구현은 던진다(입력에서 뺀다).
 *
 * 크기는 환경 변수로 바꾼다: DOCS_DIFF_SEEDS(쉼표 목록), DOCS_DIFF_ITERATIONS, DOCS_DIFF_REPORT=1(분포 출력)
 */

// 옛 구현은 템플릿 글자를 그대로 두려고 들여쓰지 않는다(들여쓰면 템플릿 문자열이 달라진다)
const legacy = (() => {
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
function slugifyTitle(title: string): string {
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
function nextDesignDocNumber(existingPaths: readonly string[]): number {
  const max = existingPaths.reduce((acc, path) => {
    const match = DESIGN_DOC_PATTERN.exec(path);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return max + 1;
}

/** 기존 문서 경로들에서 다음 ADR 번호를 고른다(비어 있으면 1부터) */
function nextAdrNumber(existingPaths: readonly string[]): number {
  const max = existingPaths.reduce((acc, path) => {
    const match = ADR_PATTERN.exec(path);
    return match ? Math.max(acc, Number(match[1])) : acc;
  }, 0);
  return max + 1;
}

/** `docs/NN-제목.md` 경로 */
function designDocFilePath(number: number, title: string): string {
  return `docs/${pad(number)}-${slugifyTitle(title)}.md`;
}

/** `docs/adr/ADR-NNN-제목.md` 경로. ADR 번호는 관례상 세 자리 이상(001, 010, 100)을 쓴다 */
function adrFilePath(number: number, title: string): string {
  const padded = number < 100 ? `0${pad(number)}` : `${number}`;
  return `docs/adr/ADR-${padded}-${slugifyTitle(title)}.md`;
}

const TROUBLESHOOTING_LOG_PATH = 'docs/TROUBLESHOOTING-LOG.md';
const ROADMAP_TRADEOFFS_PATH = 'docs/ROADMAP-TRADEOFFS.md';
const DOCS_README_PATH = 'docs/README.md';

// ---------------------------------------------------------------------------
// 새 문서 템플릿
// ---------------------------------------------------------------------------

type DocTemplateKind = 'design' | 'adr' | 'troubleshooting' | 'roadmap' | 'verification' | 'experiment' | 'roadmap-plan';

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
function buildDesignDocTemplate(number: number, title: string): string {
  return `# ${pad(number)}. ${title}

${title}에 관한 설계 문서입니다.

${buildDecisionDocBody()}`;
}

/** "ADR" 템플릿(`docs/adr/ADR-NNN-제목.md`). 헤더 불릿(상태·날짜·관련) 뒤에 설계 문서와 같은 절을 둔다 */
function buildAdrTemplate(number: number, title: string, { date = new Date(), related = [] }: { date?: Date; related?: readonly string[] } = {}): string {
  const padded = number < 100 ? `0${pad(number)}` : `${number}`;
  const relatedLine = related.length > 0 ? related.join(', ') : '(관련 문서·이슈를 적습니다)';
  return `# ADR-${padded}. ${title}

- 상태: 제안 (Proposed)
- 날짜: ${todayIso(date)}
- 관련: ${relatedLine}

${buildDecisionDocBody()}`;
}

/** 트러블슈팅 항목 하나(TROUBLESHOOTING-LOG.md에 이어 붙일 조각) */
function buildTroubleshootingEntry(title: string, { symptom = '', cause = '', fix = '' }: { symptom?: string; cause?: string; fix?: string } = {}): string {
  return `### ${title}

- 증상: ${symptom || '(무엇이 어떻게 잘못됐는지 적습니다)'}
- 원인: ${cause || '(원인을 적습니다)'}
- 해결: ${fix || '(해결 방법이나 지금 상태를 적습니다)'}
`;
}

/** TROUBLESHOOTING-LOG.md에 항목을 이어 붙인다. 파일이 아직 없으면(undefined) 제목을 먼저 만든다 */
function appendTroubleshootingEntry(existing: string | undefined, entry: string): string {
  const base = existing?.trim() ? existing.trimEnd() : '# 트러블슈팅 기록\n\n이 문서는 지금 무엇이 열려 있고, 닫은 것은 어떻게 닫았는지를 한 곳에 모읍니다.';
  return `${base}\n\n${entry.trim()}\n`;
}

/** 로드맵·트레이드오프 후보 하나(ROADMAP-TRADEOFFS.md에 이어 붙일 조각) */
function buildRoadmapTradeoffEntry(title: string, { option = '', tradeoff = '' }: { option?: string; tradeoff?: string } = {}): string {
  return `### ${title}

- 후보: ${option || '(검토 중인 선택지를 적습니다)'}
- 트레이드오프: ${tradeoff || '(얻는 것과 잃는 것을 적습니다)'}
`;
}

/** ROADMAP-TRADEOFFS.md에 항목을 이어 붙인다. 파일이 아직 없으면(undefined) 제목을 먼저 만든다 */
function appendRoadmapTradeoffEntry(existing: string | undefined, entry: string): string {
  const base = existing?.trim() ? existing.trimEnd() : '# 트레이드오프 후보 로드맵\n\n이 문서는 검토 중인 선택지와 그 트레이드오프를 모읍니다.';
  return `${base}\n\n${entry.trim()}\n`;
}

const VERIFICATION_LOG_PATH = 'docs/VERIFICATION-LOG.md';
const EXPERIMENT_LOG_PATH = 'docs/EXPERIMENT-LOG.md';

/**
 * 검증 기록 항목 하나(VERIFICATION-LOG.md에 이어 붙일 조각). "성능이 좋아졌다" 같은 측정 없는 문장 대신
 * 가설·조건·관측값·예상과 다른 점·배제한 원인·다음 확인 여섯 칸을 강제한다(실패도 범위를 적어 기록으로 남긴다).
 */
function buildVerificationEntry(
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
function appendVerificationEntry(existing: string | undefined, entry: string): string {
  const base = existing?.trim()
    ? existing.trimEnd()
    : '# 검증 기록\n\n이 문서는 "구현되어 있음"과 "실제로 측정해 확인함"을 구분합니다. 가설·조건·관측값을 남겨 다음에 같은 조건으로 다시 잴 수 있게 합니다.';
  return `${base}\n\n${entry.trim()}\n`;
}

/** 실험 기록 항목 하나(EXPERIMENT-LOG.md에 이어 붙일 조각). 가설·방법·결과·결론 네 칸만 둔다(자세한 조건·지표는 docs/experiments/ 보고서를 따로 쓴다) */
function buildExperimentEntry(
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
function appendExperimentEntry(existing: string | undefined, entry: string): string {
  const base = existing?.trim() ? existing.trimEnd() : '# 실험 기록\n\n이 문서는 검증할 가설과 그 결과를 날짜 순으로 모읍니다. 틀린 가설도 결과로 남깁니다.';
  return `${base}\n\n${entry.trim()}\n`;
}

// ---------------------------------------------------------------------------
// ROADMAP.md: 단계(POC/MVP/Beta/v1)·마일스톤·현재 위치는 손으로 쓰고, "진행 현황" 구간만
// 요구사항 상태에서 자동으로 다시 만든다(ADR-098, 색인 재생성과 같은 관리되는 구간 방식).
// ---------------------------------------------------------------------------

const ROADMAP_PATH = 'docs/ROADMAP.md';
const ROADMAP_STATUS_START = '<!-- b-studio:roadmap-status -->';
const ROADMAP_STATUS_END = '<!-- /b-studio:roadmap-status -->';

/** "ROADMAP" 템플릿(`docs/ROADMAP.md`). 단계·마일스톤·현재 위치는 손으로 채우고, 진행 현황은 "ROADMAP 갱신"이 자동으로 메운다 */
function buildRoadmapTemplate(): string {
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
interface RoadmapStatusSummary {
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
function regenerateRoadmapStatus(existing: string | undefined, summary: RoadmapStatusSummary): string {
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

const DOCS_INDEX_START = '<!-- b-studio:docs-index -->';
const DOCS_INDEX_END = '<!-- /b-studio:docs-index -->';

interface DocSummary {
  /** 프로젝트 루트 기준 경로(docs/02-결제도메인-핵심개념.md 같은) */
  path: string;
  /** 첫 H1(# 제목) 텍스트. 없으면 파일 이름에서 뽑는다 */
  title: string;
  /** 제목 바로 뒤 첫 문단(여러 줄이면 공백으로 이어 붙인다). 없으면 빈 문자열 */
  paragraph: string;
}

/** 마크다운에서 첫 H1과 그 뒤 첫 문단을 뽑는다. H1이 없으면 title은 빈 문자열이다(호출하는 쪽이 파일 이름으로 메운다) */
function extractDocSummary(markdown: string): { title: string; paragraph: string } {
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
function buildDocSummary(path: string, markdown: string): DocSummary {
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
function regenerateDocsReadme(existing: string | undefined, docs: readonly DocSummary[]): string {
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

return { slugifyTitle, nextDesignDocNumber, nextAdrNumber, designDocFilePath, adrFilePath, buildDesignDocTemplate, buildAdrTemplate, buildTroubleshootingEntry, appendTroubleshootingEntry, buildRoadmapTradeoffEntry, appendRoadmapTradeoffEntry, buildVerificationEntry, appendVerificationEntry, buildExperimentEntry, appendExperimentEntry, buildRoadmapTemplate, regenerateRoadmapStatus, extractDocSummary, buildDocSummary, regenerateDocsReadme };
})();

const SEEDS = readEnvList('DOCS_DIFF_SEEDS', [1, 7, 42, 2026]);
const ITERATIONS = readEnvNumber('DOCS_DIFF_ITERATIONS', 3000);
const REPORT = process.env['DOCS_DIFF_REPORT'] === '1';

// ---------------------------------------------------------------------------
// 입력 생성
// ---------------------------------------------------------------------------

const TITLE_ATOMS = [
  'a', 'B', 'z', '0', '9', '결제', '한글', 'x-y', ' ', ' ', ' ', '\t', '\n', '\r', ' ', ' ', ' ', '﻿', '　', '​', '\u0085', ' ', ' ',
  '/', '\\', ':', '*', '?', '"', '<', '>', '|', '-', '--', '---', '.', '..', '...', '../', '..\\', '/etc', 'C:', '\u0000', '∕', '／', '‮', '😀', 'é', 'é', 'ß', '#', '%2e', '~',
];

function genTitle(g: Gen): string {
  const roll = g.int(20);
  if (roll === 0) return '';
  if (roll === 1) return g.text(TITLE_ATOMS, 400 + g.int(400)); // 매우 긴 제목
  if (roll === 2) return g.pick(['..', '.', '...', '/', '\\', '../..', '-', '--', ' ', '  ', '\t', ' ', '﻿', ' - ', '- -', '/-/', '"-"']);
  return g.text(TITLE_ATOMS, 1 + g.int(12));
}

const NUMBERS = [0, 1, 2, 5, 9, 10, 11, 98, 99, 100, 101, 999, 1000, 12345, -1, -10, 1.5, 9.99, 99.5, 0.1, NaN, Infinity, -Infinity, -0, 2 ** 53, 1e21, 1e-7, 123456789012345680000];

function genNumber(g: Gen): number {
  return g.chance(0.7) ? g.pick(NUMBERS) : g.int(1500);
}

const PATH_PREFIXES = ['docs/', 'docs/', 'docs/', './docs/', 'docs//', 'Docs/', 'DOCS/', '/docs/', 'docs/adr/ADR-', 'docs/adr/ADR-', 'docs/adr/adr-', 'docs/adr/ADR_', 'docs/adr/', 'docs/adr/ADR-', './docs/adr/ADR-', 'docs/ADR-', 'x/docs/', 'docs\\', ''];
const DIGIT_RUNS = ['', '0', '1', '00', '01', '09', '10', '99', '100', '007', '0099', '999', '1000', '12345', '２３', '٣٤', '9'.repeat(310), '0'.repeat(310) + '5', '1'.repeat(20)];
const NAME_REST = ['-a.md', '-.md', '-x.md', '-x.md.md', '-x.MD', '-x.md ', '-x.md\n', '-a\nb.md', '-a b.md', '-a\rb.md', '-a/b.md', '-.md.md', '-md', '-x.mdx', 'x.md', '-.md ', '-한글.md', '-a.md\r', '--.md', '-..md', '- .md', '_a.md'];

function genPath(g: Gen): string {
  if (g.chance(0.12)) return g.pick(['', 'README.md', 'docs/README.md', 'docs/TROUBLESHOOTING-LOG.md', 'docs/ROADMAP-TRADEOFFS.md', 'docs/ROADMAP.md', 'docs/VERIFICATION-LOG.md', 'docs/notes.md', 'docs/a/b.md', 'docs/TROUBLESHOOTING-LOG.md ', 'docs/troubleshooting-log.md', 'docs/guide/한글-문서.md', 'docs/zz.md', 'docs/Zz.md', 'docs/_x.md', 'docs/a-b.md', 'docs/a b.md', 'docs/a.b.md', 'docs/.hidden.md', 'docs/1-x.md', 'docs/Ab.md', 'docs/ab.md']);
  // 맞는 꼴에서 한 군데만 바꾼 입력을 절반쯤 섞는다(전부 무작위면 번호 계산이 거의 늘 1이다)
  const prefix = g.chance(0.5) || !g.chance(0.5) ? g.pick(['docs/', 'docs/adr/ADR-']) : g.pick(PATH_PREFIXES);
  const digits = g.chance(0.6) ? String(g.int(1500)).padStart(g.pick([2, 3, 3, 4]), '0') : g.pick(DIGIT_RUNS);
  const rest = g.chance(0.6) ? '-제목.md' : g.pick(NAME_REST);
  return prefix + digits + rest;
}

function genPathList(g: Gen): string[] {
  return g.list(0, 10, () => genPath(g));
}

const PARAGRAPH_ATOMS = ['a', '설명', '문장 하나', 'x', ' ', '  ', '`code`', '한 줄', '(괄호)', 'R1', 'A.', '가'];

function genParagraph(g: Gen): string {
  const roll = g.int(10);
  if (roll === 0) return '';
  if (roll === 1) return g.pick([' ', '(요약 없음)', '|', 'a | b', ' ']);
  return g.text(PARAGRAPH_ATOMS, 1 + g.int(5));
}

const DOC_TITLES = ['제목', 'Title', '', ' ', '결제 도메인', 'a|b', '[x]', 'x'];

function genDocSummaries(g: Gen, withExotic: boolean): current.DocSummary[] {
  return g.list(0, 9, () => {
    const path = g.chance(0.85) ? genPath(g) : g.pick(['docs/README.md', 'docs/z.md', 'docs/Z.md', 'docs/a b.md', 'docs/한글.md', 'docs/가나.md', 'docs/A.md']);
    // 한글 음절·ASCII 밖의 글자(Han, 악센트)는 정렬 근사의 의도한 차이라 벡터 시험이 따로 다룬다
    const safePath = withExotic ? path : path.replace(/[^\u0000-\u007f가-힣]/g, 'x');
    return { path: safePath, title: g.pick(DOC_TITLES), paragraph: genParagraph(g) };
  });
}

const START = current.DOCS_INDEX_START;
const END = current.DOCS_INDEX_END;
const R_START = current.ROADMAP_STATUS_START;
const R_END = current.ROADMAP_STATUS_END;

function genManagedText(g: Gen, start: string, end: string): string | undefined {
  const roll = g.int(16);
  if (roll === 0) return undefined;
  if (roll === 1) return '';
  if (roll === 2) return g.pick([' ', '\n\n', ' ', '﻿', ' ']);
  const body = () => g.text(['글', 'text', '\n', ' ', '\n\n', '```\n', '- a\n', '| a |\n', '한글', '\r\n'], 1 + g.int(5));
  const old = () => `${start}\n${g.pick(['| 문서 | 확인할 내용 |', 'old', ''])}\n${end}`;
  switch (g.int(12)) {
    case 0: return body(); // 마커 없음
    case 1: return `${body()}${start}${body()}`; // 시작만
    case 2: return `${body()}${end}${body()}`; // 끝만
    case 3: return `${body()}${end}${body()}${start}${body()}`; // 순서 뒤집힘
    case 4: return `${body()}${old()}${body()}${old()}${body()}`; // 두 쌍
    case 5: return `${body()}${start}${body()}${start}${body()}${end}${body()}`; // 시작 둘
    case 6: return `${body()}${start}${body()}${end}${body()}${end}${body()}`; // 끝 둘
    case 7: return `\`\`\`\n${old()}\n\`\`\`\n${body()}${old()}${body()}`; // 코드 블록 안의 구간이 먼저
    case 8: return `${start}${end}`; // 붙어 있음
    case 9: return `${end}${start}`;
    case 10: return `${body()}${start}${end}${body()}   \n\n`;
    default: return `${body()}${old()}${body()}`;
  }
}

const STATUS_KEYS = ['미착수', '작업 중', '검증됨', '재확인 필요', '실패', '10', '2', '1', '-1', '1.5', '', ' ', 'a|b', '__proto__', 'constructor', '한글', '01'];

function genSummary(g: Gen): current.RoadmapStatusSummary {
  const byStatus: Record<string, number> = {};
  const n = g.int(7);
  for (let i = 0; i < n; i++) byStatus[g.pick(STATUS_KEYS)] = g.chance(0.85) ? g.int(30) : g.pick([NaN, Infinity, -0, 1.5, 1e21, -3, 0]);
  const progress = () => ({ total: g.chance(0.9) ? g.int(30) : g.pick([NaN, Infinity, -0, 0.5, 1e21]), done: g.chance(0.9) ? g.int(30) : g.pick([NaN, -0, 2.5, 1e-7]) });
  return { byStatus, must: progress(), should: progress() };
}

const MD_LINES = [
  '# 제목', '#  제목  ', '#제목', '# ', '#  ', '#   ', '#  abc', '# a b', '# 제목 ', '#﻿제목', '# 제목 # 끝', '## 소제목', '###### h6', '####### h7', '#', '# #', '#\t탭 제목\t',
  '', '', '  ', '\t', '본문 한 줄', '본문 둘째 줄', '  들여쓴 본문  ', '- 항목', '-항목', '-\t탭', '1. 번호', '12) 번호', '1.번호', '1.', '١. 아랍', '| 표 |', '|', '<!-- 주석 -->', '<!--', '<!-', '> 인용',
  '```', 'a\rb', 'a b', '#\r', '# 제목\r', ' ', '＃ 전각', '- ', '1. ', '#######', '#\u0085x', '\u0085',
];

function genMarkdown(g: Gen): string {
  const lines = g.list(0, 9, () => g.pick(MD_LINES));
  const sep = g.pick(['\n', '\n', '\n', '\r\n', '\n\n', '\r\n\r\n', '\r']);
  let out = lines.join(sep);
  if (g.chance(0.15)) out += '\n';
  if (g.chance(0.05)) out = '﻿' + out;
  return out;
}

const ENTRY_TEXT = ['', '', '증상', ' ', '  \n', '(괄호)', '한글 값', 'a\nb', ' ', '0'];

function genEntryOptions(g: Gen, keys: readonly string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of keys) if (g.chance(0.7)) out[key] = g.chance(0.1) ? undefined : g.pick(ENTRY_TEXT);
  return out;
}

const EXISTING = [undefined, '', ' ', '\n\n', '# 기록\n\n내용', '# 기록\n\n내용\n\n\n', '﻿# x \n', ' x ', 'x', '### 앞 항목\n\n- a: b\n'];

// ---------------------------------------------------------------------------
// 견주기
// ---------------------------------------------------------------------------

interface Tally {
  runs: number;
  differ: number;
  empty: number;
  valued: number;
  threw: number;
  first: string[];
}

const newTally = (): Tally => ({ runs: 0, differ: 0, empty: 0, valued: 0, threw: 0, first: [] });

function compare(tally: Tally, label: string, input: unknown, legacyOutcome: Outcome, currentOutcome: Outcome): void {
  tally.runs++;
  if (legacyOutcome.threw) tally.threw++;
  else if (legacyOutcome.value === '' || legacyOutcome.value === 1 /* 번호 계산: 어느 경로도 맞지 않아 1 */ || (typeof legacyOutcome.value === 'object' && legacyOutcome.value !== null && (legacyOutcome.value as { title?: string }).title === '')) tally.empty++; // 요약은 제목을 못 찾은 것이 빈 결과
  else tally.valued++;
  if (!sameOutcome(legacyOutcome, currentOutcome)) {
    tally.differ++;
    if (tally.first.length < 3) tally.first.push(`${label}\n입력: ${JSON.stringify(input)}\n옛: ${JSON.stringify(legacyOutcome)}\n새: ${JSON.stringify(currentOutcome)}`);
  }
}

interface Case {
  name: string;
  /** 결과가 "빈 값"인 비율이 이 이상이어야 입력이 한쪽으로 쏠리지 않은 것이다(0이면 확인하지 않는다) */
  minEmpty?: number;
  run: (g: Gen, tally: Tally) => void;
}

const cases: Case[] = [
  {
    name: 'slugifyTitle',
    run: (g, t) => {
      const title = genTitle(g);
      compare(t, 'slugifyTitle', title, outcome(() => legacy.slugifyTitle(title)), outcome(() => current.slugifyTitle(title)));
    },
  },
  {
    name: 'nextDesignDocNumber',
    minEmpty: 0.02,
    run: (g, t) => {
      const list = genPathList(g);
      compare(t, 'nextDesignDocNumber', list, outcome(() => legacy.nextDesignDocNumber(list)), outcome(() => current.nextDesignDocNumber(list)));
    },
  },
  {
    name: 'nextAdrNumber',
    minEmpty: 0.02,
    run: (g, t) => {
      const list = genPathList(g);
      compare(t, 'nextAdrNumber', list, outcome(() => legacy.nextAdrNumber(list)), outcome(() => current.nextAdrNumber(list)));
    },
  },
  {
    name: 'designDocFilePath/adrFilePath',
    run: (g, t) => {
      const n = genNumber(g);
      const title = genTitle(g);
      compare(t, 'designDocFilePath', { n, title }, outcome(() => legacy.designDocFilePath(n, title)), outcome(() => current.designDocFilePath(n, title)));
      compare(t, 'adrFilePath', { n, title }, outcome(() => legacy.adrFilePath(n, title)), outcome(() => current.adrFilePath(n, title)));
    },
  },
  {
    name: 'buildDesignDocTemplate/buildAdrTemplate',
    run: (g, t) => {
      const n = genNumber(g);
      const title = genTitle(g);
      const related = g.chance(0.5) ? undefined : g.list(0, 3, () => g.pick(['#1', 'ADR-001', '', 'a, b', '한글']));
      const date = g.pick([undefined, new Date(Date.UTC(2026, 10, 10, 23, 59, 59)), new Date(0), new Date(NaN), new Date(Date.UTC(10000, 0, 1)), new Date(Date.UTC(-5, 0, 1)), new Date(Date.UTC(2026, 11, 31, 23, 59, 59, 999))]);
      const options = g.chance(0.2) ? undefined : { ...(date ? { date } : {}), ...(related ? { related } : {}) };
      compare(t, 'buildDesignDocTemplate', { n, title }, outcome(() => legacy.buildDesignDocTemplate(n, title)), outcome(() => current.buildDesignDocTemplate(n, title)));
      // 날짜가 없으면 지금 시각이라 두 호출 사이에 자정이 넘으면 달라질 수 있다 — 날짜를 넘긴 호출만 견준다
      if (date) compare(t, 'buildAdrTemplate', { n, title, options }, outcome(() => legacy.buildAdrTemplate(n, title, options)), outcome(() => current.buildAdrTemplate(n, title, options)));
      else compare(t, 'buildAdrTemplate', { n, title, related }, outcome(() => legacy.buildAdrTemplate(n, title, { related, date: new Date(86400000) })), outcome(() => current.buildAdrTemplate(n, title, { related, date: new Date(86400000) })));
    },
  },
  {
    name: '기록 항목 넷(build·append)',
    run: (g, t) => {
      const title = genTitle(g);
      const trouble = genEntryOptions(g, ['symptom', 'cause', 'fix']);
      const road = genEntryOptions(g, ['option', 'tradeoff']);
      const verify = genEntryOptions(g, ['hypothesis', 'condition', 'observation', 'deviation', 'excludedCauses', 'nextCheck']);
      const experiment = genEntryOptions(g, ['hypothesis', 'method', 'result', 'conclusion']);
      const useOptions = g.chance(0.85);
      const o = <T,>(value: T): T | undefined => (useOptions ? value : undefined);
      compare(t, 'buildTroubleshootingEntry', { title, trouble }, outcome(() => legacy.buildTroubleshootingEntry(title, o(trouble))), outcome(() => current.buildTroubleshootingEntry(title, o(trouble))));
      compare(t, 'buildRoadmapTradeoffEntry', { title, road }, outcome(() => legacy.buildRoadmapTradeoffEntry(title, o(road))), outcome(() => current.buildRoadmapTradeoffEntry(title, o(road))));
      compare(t, 'buildVerificationEntry', { title, verify }, outcome(() => legacy.buildVerificationEntry(title, o(verify))), outcome(() => current.buildVerificationEntry(title, o(verify))));
      compare(t, 'buildExperimentEntry', { title, experiment }, outcome(() => legacy.buildExperimentEntry(title, o(experiment))), outcome(() => current.buildExperimentEntry(title, o(experiment))));
      const existing = g.pick(EXISTING);
      const entry = g.chance(0.5) ? legacy.buildExperimentEntry(title, experiment) : g.pick(ENTRY_TEXT);
      compare(t, 'appendTroubleshootingEntry', { existing, entry }, outcome(() => legacy.appendTroubleshootingEntry(existing, entry)), outcome(() => current.appendTroubleshootingEntry(existing, entry)));
      compare(t, 'appendRoadmapTradeoffEntry', { existing, entry }, outcome(() => legacy.appendRoadmapTradeoffEntry(existing, entry)), outcome(() => current.appendRoadmapTradeoffEntry(existing, entry)));
      compare(t, 'appendVerificationEntry', { existing, entry }, outcome(() => legacy.appendVerificationEntry(existing, entry)), outcome(() => current.appendVerificationEntry(existing, entry)));
      compare(t, 'appendExperimentEntry', { existing, entry }, outcome(() => legacy.appendExperimentEntry(existing, entry)), outcome(() => current.appendExperimentEntry(existing, entry)));
    },
  },
  {
    name: 'buildRoadmapTemplate',
    run: (_g, t) => {
      compare(t, 'buildRoadmapTemplate', null, outcome(() => legacy.buildRoadmapTemplate()), outcome(() => current.buildRoadmapTemplate()));
    },
  },
  {
    name: 'regenerateRoadmapStatus',
    run: (g, t) => {
      const existing = genManagedText(g, R_START, R_END);
      const summary = genSummary(g);
      compare(t, 'regenerateRoadmapStatus', { existing, summary }, outcome(() => legacy.regenerateRoadmapStatus(existing, summary)), outcome(() => current.regenerateRoadmapStatus(existing, summary)));
    },
  },
  {
    name: 'extractDocSummary/buildDocSummary',
    minEmpty: 0.05,
    run: (g, t) => {
      const markdown = genMarkdown(g);
      const path = genPath(g);
      compare(t, 'extractDocSummary', markdown, outcome(() => legacy.extractDocSummary(markdown)), outcome(() => current.extractDocSummary(markdown)));
      compare(t, 'buildDocSummary', { path, markdown }, outcome(() => legacy.buildDocSummary(path, markdown)), outcome(() => current.buildDocSummary(path, markdown)));
    },
  },
  {
    name: 'regenerateDocsReadme',
    run: (g, t) => {
      const existing = genManagedText(g, START, END);
      const docs = genDocSummaries(g, false);
      compare(t, 'regenerateDocsReadme', { existing, docs }, outcome(() => legacy.regenerateDocsReadme(existing, docs)), outcome(() => current.regenerateDocsReadme(existing, docs)));
    },
  },
];

describe('차등 시험: 옛 TS 구현과 Rust 껍데기는 같은 입력에 같은 글자를 낸다', () => {
  for (const { name, run, minEmpty } of cases) {
    it(name, () => {
      const total = newTally();
      for (const seed of SEEDS) {
        const g = new Gen(seed * 1000 + name.length);
        const tally = newTally();
        for (let n = 0; n < ITERATIONS; n++) run(g, tally);
        for (const key of ['runs', 'differ', 'empty', 'valued', 'threw'] as const) total[key] += tally[key];
        total.first.push(...tally.first);
        if (REPORT) console.log(`[차등] ${name} 시드 ${seed}: 비교 ${tally.runs}, 다름 ${tally.differ}, 빈 결과 ${tally.empty}, 값 ${tally.valued}, 던짐 ${tally.threw}`);
      }
      expect(total.first.join('\n---\n')).toBe('');
      expect(total.differ).toBe(0);
      expect(total.runs).toBeGreaterThan(0);
      expect(total.valued).toBeGreaterThan(total.runs * 0.2); // 입력이 비어 있지 않다
      if (minEmpty) expect(total.empty).toBeGreaterThan(total.runs * minEmpty);
    });
  }

  it('경로 안전: 옛·새 slug와 경로는 폴더 밖을 가리키는 꼴(구분자·상위 폴더)을 절대 내지 않는다', () => {
    let checked = 0;
    let withNul = 0;
    for (const seed of SEEDS) {
      const g = new Gen(seed + 77);
      for (let n = 0; n < ITERATIONS; n++) {
        const title = genTitle(g);
        const number = genNumber(g);
        const slug = current.slugifyTitle(title);
        const paths = [current.designDocFilePath(number, title), current.adrFilePath(number, title)];
        // slug에는 구분자(/ \)·공백 종류가 없고, 앞 글자가 `-`일 수 없다
        expect(slug).not.toMatch(/[\\/\s]/);
        expect(slug.startsWith('-')).toBe(false);
        expect(slug.length).toBeGreaterThan(0);
        for (const path of paths) {
          // 경로는 늘 정해진 폴더 아래의 `NN-`·`ADR-NNN-`으로 시작하는 한 파일 이름이다
          expect(path).toMatch(/^docs\/(?:adr\/ADR-)?[^/\\]+\.md$/);
          expect(path.split('/').includes('..')).toBe(false);
          expect(path.startsWith('/')).toBe(false);
          expect(path).not.toContain('\\');
        }
        if (slug.includes('\u0000')) withNul++; // 옛 구현도 NUL을 지우지 않는다(같다). 파일 시스템 호출이 NUL을 거절한다
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
    if (REPORT) console.log(`[경로 안전] 검사 ${checked}, NUL을 품은 slug ${withNul}(옛 구현과 같다)`);
  });

  it('대조 장치: 결과 한 글자만 달라도 잡는다', () => {
    const g = new Gen(9);
    const tally = newTally();
    for (let n = 0; n < 200; n++) {
      const title = genTitle(g);
      const number = genNumber(g);
      const list = genPathList(g);
      const existing = genManagedText(g, START, END);
      const docs = genDocSummaries(g, false);
      const expected: Outcome[] = [
        outcome(() => legacy.slugifyTitle(title)),
        outcome(() => legacy.adrFilePath(number, title)),
        outcome(() => legacy.nextDesignDocNumber(list)),
        outcome(() => legacy.regenerateDocsReadme(existing, docs)),
      ];
      for (const o of expected) {
        if (o.threw) continue;
        compare(tally, 'tamper', title, o, { threw: false, value: perturb(o.value) });
      }
    }
    expect(tally.differ).toBeGreaterThan(300);
  });

  it('대조 장치: 옛 구현을 한 군데만 바꿔도(경계 ±1·글자 클래스 넓히기) 잡는다', () => {
    // 옛 slug에서 `/`를 지우지 않게 넓힌 구현·옛 번호 계산에서 두 자리 하한을 한 자리로 바꾼 구현을 새 구현과 견주면 차이가 나와야 한다
    const widenedSlug = (title: string): string =>
      title
        .trim()
        .replace(/[\\:*?"<>|]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+|-+$/g, '') || '제목-없음';
    const looseDesign = (paths: readonly string[]): number =>
      paths.reduce((acc, path) => {
        const match = /^docs\/(\d{1,})-.+\.md$/.exec(path);
        return match ? Math.max(acc, Number(match[1])) : acc;
      }, 0) + 1;
    const g = new Gen(11);
    let slugDiffer = 0;
    let numberDiffer = 0;
    for (let n = 0; n < 2000; n++) {
      const title = genTitle(g);
      if (widenedSlug(title) !== current.slugifyTitle(title)) slugDiffer++;
      const list = genPathList(g);
      if (looseDesign(list) !== current.nextDesignDocNumber(list)) numberDiffer++;
    }
    expect(slugDiffer).toBeGreaterThan(50);
    expect(numberDiffer).toBeGreaterThan(20);
  });
});
