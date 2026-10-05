import type { PendingChange } from './checkpoints';
import { extractPrReviewFixTitles } from './pr-review';

/** 제목 맨 앞에 붙는 conventional commit 타입 (ADR-080). git 로그에 실제로 쓰는 이름만 받는다 */
export type CommitType = 'feat' | 'fix' | 'test' | 'docs' | 'refactor' | 'chore';

const MAX_SUBJECT_CHARS = 72;

/** Vitest·Jest, JUnit, pytest 테스트 파일 경로. 바뀐 파일이 전부 이 패턴이면 테스트 커밋으로 본다 */
const TEST_FILE = /(^|\/)(__tests__)\/.+|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)src\/test\/(java|kotlin)\/.+\.(java|kt)$|(^|\/)tests?\/.+\.py$|(^|\/)test_[^/]+\.py$|_test\.py$/i;

/** 문서 파일 경로. 바뀐 파일이 전부 이 패턴이면 문서 커밋으로 본다 */
const DOC_FILE = /(^|\/)docs\/.+\.mdx?$|(^|\/)readme(\.[a-z]+)?\.md$|(^|\/)changelog\.md$/i;

/** 요청 글에서 리팩터링을 가리키는 낱말 */
const REFACTOR_WORDS = /리팩터|리팩토링|구조\s*정리|구조\s*변경|정리한다|refactor/i;
/** 요청 글에서 잡일(의존성 올리기, 설정 변경 등)을 가리키는 낱말 */
const CHORE_WORDS = /의존성|dependency|devdependency|버전\s*올리기|업그레이드|설정\s*변경|chore/i;
/** 요청 글에서 고침을 가리키는 낱말. 이 낱말이 있어야 fix로 본다 */
const FIX_WORDS = /고치|고쳐|버그|오류|에러|안\s*(돼|되|나와|보여)|깨지|실패하|수정해|fix|bug|error/i;

/**
 * 요청 글과 바뀐 파일에서 conventional commit 타입을 고른다. 모델을 부르지 않고 경로·낱말만 본다(ADR-080).
 * 우선순위: 테스트 파일만 바뀌었으면 test, 문서 파일만이면 docs, 새 파일뿐이면 feat,
 * 그 외에는 요청 글의 낱말로 fix·refactor·chore를 찾고, 없으면 feat로 둔다.
 */
export function classifyCommit(request: string, changes: readonly PendingChange[]): CommitType {
  if (changes.length > 0 && changes.every((change) => TEST_FILE.test(change.file))) return 'test';
  if (changes.length > 0 && changes.every((change) => DOC_FILE.test(change.file))) return 'docs';
  if (changes.length > 0 && changes.every((change) => change.change === 'added')) return 'feat';
  if (FIX_WORDS.test(request)) return 'fix';
  if (REFACTOR_WORDS.test(request)) return 'refactor';
  if (CHORE_WORDS.test(request)) return 'chore';
  // 고침·정리·잡일 낱말이 없으면 새 동작을 더하거나 바꾼 것으로 본다(과제 커밋 대부분이 기능 추가다)
  return 'feat';
}

/**
 * 한 줄에서 첫 문장만 자른다. "~해 주세요. 코드에서 읽는 …" 처럼 여러 문장이 이어진 요청·요약 글이 뒷 문장까지
 * 통째로 제목 후보가 되던 문제(ADR-080 버그 리포트)를 막는다 — 마침표·물음표·느낌표 뒤에 공백과 글자가
 * 이어질 때만 문장 경계로 본다(".env.example"의 점처럼 공백 없이 바로 이어지는 점은 경계로 보지 않는다).
 * 문장 경계가 없으면(쉼표만 있거나 한 문장) 줄 전체를 그대로 돌려준다.
 */
function firstSentence(line: string): string {
  const match = /^(.+?[.!?])\s+\S/.exec(line);
  return match ? match[1]! : line;
}

/** 말투를 정리하고도 남아 있으면 "아직 부탁하는 말투"로 보는 끝맺음(해 주세요·부탁드립니다류) */
const TRAILING_REQUEST_PHRASING = /(해\s*(줘|주세요|주십시오)|부탁(?:드립니다|드려요|해요|합니다)?|주시기\s*바랍니다|바랍니다)\s*[.!?。]*$/;

/**
 * 한 줄이 "무엇이 바뀌었는지" 분명히 말하는 서술문인지 본다(요청 글·에이전트 요약 둘 다에 쓴다). 너무 짧거나,
 * 물음표로 끝나거나, 말투를 커밋 문체로 정리(toCommitMood)하고도 부탁 어미만 남으면(예: "해주세요" 그 자체)
 * 분명하지 않다고 보고 바뀐 파일에서 뽑는 대체 경로로 넘긴다.
 */
function isClearChangeSentence(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 4) return false;
  if (/[?？]\s*$/.test(trimmed)) return false;
  const converted = toCommitMood(trimmed);
  if (converted.trim().length < 2) return false;
  return !TRAILING_REQUEST_PHRASING.test(converted);
}

/** 파일 경로에서 커밋 제목에 쓸 사람이 읽는 영역 이름을 뽑는다(마지막 조각의 확장자를 떼고, 흔한 이름은 다듬는다) */
function fileAreaLabel(file: string): string {
  const name = file.split('/').pop() ?? file;
  if (/^\.env\.(example|sample)$/i.test(name)) return '환경 변수 예시';
  const base = name.replace(/\.[^./]+$/, '');
  if (/^readme$/i.test(base)) return 'README';
  if (/^changelog$/i.test(base)) return 'CHANGELOG';
  return base || name;
}

/**
 * 요청 글도 에이전트 요약도 "무엇이 바뀌었는지" 분명히 말하지 않을 때 쓰는 마지막 대체 경로(ADR-080).
 * 바뀐 파일 이름에서 영역을 뽑아 최대 2개를 묶고(그 이상은 "외 N개"), 바뀐 종류(added·modified·deleted)로
 * 서술어를 고른다. 바뀐 파일이 없으면("데이터만 바뀜" 체크포인트 등) 뭉뚱그린 문구를 쓴다.
 */
function describeChangeFromFiles(changes: readonly PendingChange[]): string {
  if (changes.length === 0) return '파일을 정리한다';
  const labels = [...new Set(changes.map((change) => fileAreaLabel(change.file)))];
  const area = labels.length > 2 ? `${labels.slice(0, 2).join('·')} 외 ${labels.length - 2}개` : labels.join('·');
  const allAdded = changes.every((change) => change.change === 'added');
  const allDeleted = changes.every((change) => change.change === 'deleted');
  const verb = allDeleted ? '지운다' : allAdded ? '더한다' : '고친다';
  return `${area}를 ${verb}`;
}

/**
 * 후보 글을 남은 글자 수에 맞춰 자른다. 단어 경계에서 끊고, 비어 있으면 "체크포인트"로 대신한다.
 * 체크포인트 제목(generateCommitSubject)뿐 아니라 PR 제목(repository.ts의 buildPullRequest, ADR-110)도
 * "가장 중요한 커밋 제목을 요약"할 때 이 함수를 그대로 재사용한다 — 단어 중간을 자르지 않는 규칙을 두 곳에서
 * 따로 구현하지 않는다(버그 리포트: PR 제목을 120자에서 그냥 slice해 단어 중간이 잘렸다).
 */
export function summarize(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) return '체크포인트';
  if (trimmed.length <= maxChars) return trimmed;
  const cut = trimmed.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.5 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * AI 리뷰 고침 요청(pr-review.ts의 buildPrReviewFixRequest)이면 지적 제목들을 모아 커밋 제목 후보를 만든다(과제 66) —
 * 이 요청의 요청 글 첫 문장은 "이 PR을 리뷰해 다음 차단·주요 지적을 찾았습니다" 같은 모든 라운드가 공유하는 문구라
 * generateCommitSubject의 평소 규칙(첫 문장 쓰기)을 그대로 적용하면 "fix: [b-studio AI 리뷰] 이 PR을 리뷰해 다음
 * 차단·주요 지적을 찾았습니다"처럼 의미 없는 제목이 된다(도그푸딩 버그 리포트). 이 요청은 항상 차단·주요 지적이
 * 있어야만 보내므로(review-round.ts) 제목 목록이 비어 있을 일은 없다.
 */
function reviewFixCandidate(request: string): string | undefined {
  const titles = extractPrReviewFixTitles(request);
  return titles ? `리뷰 지적 ${titles.length}건 반영 — ${titles.join(', ')}` : undefined;
}

/**
 * 요청 글과 바뀐 파일, (있으면) 에이전트 요약에서 체크포인트 커밋 제목을 만든다(ADR-080). "타입: 한국어 요약"
 * 형식이고 72자를 넘지 않는다. 제목 글은 이 순서로 고른다:
 *  0. AI 리뷰 고침 요청이면(reviewFixCandidate) 지적 제목들로 만든다 — 요청 글 첫 문장이 라운드마다 똑같은
 *     공통 문구라 아래 1번 규칙을 쓰면 의미 없는 제목이 된다(과제 66).
 *  1. 요청 글 첫 문장이 "무엇이 바뀌었는지" 분명하면 그것을 쓴다 — 여러 문장으로 된 요청이면 첫 문장만 쓴다
 *     (firstSentence). ".env.example 파일을 만들어 주세요. 코드에서 읽는 환경 변수…를 담되…" 같은 요청
 *     전체가 제목에 그대로 들어가던 문제가 여기서 막힌다. 커밋 제목은 사람이 실제로 무엇을 부탁했는지 그대로
 *     드러내는 편이 "AI 리뷰 지적을 고쳐 주세요" 같은 맥락(PR 리뷰 트레일러·요구사항 추적이 요청 글을 다시
 *     읽는다)을 잃지 않는다.
 *  2. 요청 글이 "해주세요"처럼 부탁 어미만 있고 알맹이가 없으면(isClearChangeSentence가 거짓), 에이전트
 *     요약 첫 문장이 분명할 때 그것으로 대신한다(사람이 "이것 좀 봐주세요"처럼 구체적으로 말하지 않았을 때
 *     에이전트가 실제로 한 일을 더 잘 말해 준다).
 *  3. 그래도 분명하지 않으면 바뀐 파일에서 뽑는다.
 *  4. 요청 글마저 비어 있으면(데이터만 바뀐 체크포인트 등) "체크포인트"로 둔다.
 * studio.yaml의 checkpoints.conventionalCommits를 껐을 때는 부르지 않고 기존 "요청: ..." 형식을 그대로 쓴다.
 */
export function generateCommitSubject(request: string, changes: readonly PendingChange[], agentSummary?: string): string {
  const type = classifyCommit(request, changes);
  const budget = MAX_SUBJECT_CHARS - type.length - 2;

  const requestFirstLine = request.split('\n')[0]!.replace(/\s+/g, ' ').trim();
  const summaryLine = agentSummary
    ?.split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  let candidate: string;
  const reviewFix = reviewFixCandidate(request);
  if (reviewFix) {
    candidate = reviewFix;
  } else if (requestFirstLine && isClearChangeSentence(firstSentence(requestFirstLine))) {
    candidate = toCommitMood(firstSentence(requestFirstLine));
  } else if (summaryLine && isClearChangeSentence(firstSentence(summaryLine))) {
    candidate = toCommitMood(firstSentence(summaryLine));
  } else if (requestFirstLine) {
    candidate = describeChangeFromFiles(changes);
  } else {
    candidate = '체크포인트';
  }

  return `${type}: ${summarize(candidate, budget)}`;
}

/** 부탁하는 말투("만들어 줘.")를 커밋 문체("만든다")로 바꾼다. 흔한 끝맺음만 바꾸고, 모르는 끝맺음은 그대로 둔다 */
const MOOD_ENDINGS: ReadonlyArray<[RegExp, string]> = [
  [/만들어\s*(줘|주세요|주십시오)$/, '만든다'],
  [/고쳐\s*(줘|주세요|주십시오)$/, '고친다'],
  [/바꿔\s*(줘|주세요|주십시오)$/, '바꾼다'],
  [/써\s*(줘|주세요|주십시오)$/, '쓴다'],
  [/넣어\s*(줘|주세요|주십시오)$/, '넣는다'],
  [/보여\s*(줘|주세요|주십시오)$/, '보여 준다'],
  [/없애\s*(줘|주세요|주십시오)$/, '없앤다'],
  [/지워\s*(줘|주세요|주십시오)$/, '지운다'],
  [/(\S+)해\s*(줘|주세요|주십시오)$/, '$1한다'],
  [/\s*(해\s*)?(줘|주세요|주십시오)$/, ''],
];

export function toCommitMood(text: string): string {
  let result = text.replace(/[.!?。]+$/, '').trim();
  for (const [pattern, replacement] of MOOD_ENDINGS) {
    if (pattern.test(result)) {
      result = result.replace(pattern, replacement).trim();
      break;
    }
  }
  return result;
}
