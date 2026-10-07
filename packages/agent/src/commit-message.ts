import type { PendingChange } from './checkpoints';
import { extractPrReviewFixTitles } from './pr-review';
import { extractRequirementIds } from './test-discovery';

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
 * 앞 실행·네트워크 등 "지금 무엇이 바뀌었는지"가 아니라 그 바깥 상황(앞 실행의 결과, 인프라 문제)을 설명하는
 * 문장을 가리키는 낱말(실측: 세션 5b640fd3, 체크포인트 57cced6 — 제목이 "앞 실행이 턴 상한에 걸려 변경이 모두
 * 되돌려졌습니다"가 되어 실제로 바뀐 commerce shorts 모듈을 전혀 말하지 않았다). 이런 문장은 뒤에 진짜 요청이
 * 이어져도 첫 문장만 보는 firstSentence 때문에 그대로 제목이 되므로, isClearChangeSentence에서 걸러
 * 에이전트 요약·요구사항 id·바뀐 파일 같은 대체 경로로 넘긴다.
 */
const SITUATIONAL_WORDS =
  /(앞|이전|지난|직전|방금)\s*(실행|시도|요청|작업)|네트워크|연결이?\s*끊|세션이?\s*끊|턴\s*상한|토큰\s*상한|되돌려지|롤백되|rate\s*limit|레이트\s*리밋|타임아웃|timeout/i;

/**
 * "지금 무엇이 바뀌었는지"가 아니라 그걸 알아내기까지의 경과(검토해 보니 어땠는지, 이미 돼 있었는지, 더 할 게
 * 없는지)를 서술하는 문장을 가리키는 낱말(실측: 세션 5b640fd3, 체크포인트 15ba740 — 요약 첫 줄이 "검토 결과,
 * 이전 턴에서 복구된 9개 파일(R21 구현)은 이미 완성되어 있었습니다 — 추가로 만들 것이 없어 검증만"이 되어,
 * 그대로 제목이 됐다. 바뀐 파일을 말하지 않는 경과 보고라 요구사항 id·공통 모듈(requirementModuleCandidate)
 * 같은 대체 경로로 넘겨야 한다). SITUATIONAL_WORDS(앞 실행·인프라 문제)와 달리 이쪽은 에이전트가 스스로
 * "확인했다"는 과정을 보고하는 말투다.
 */
const PROGRESS_REPORT_WORDS = /검토\s*결과|확인해\s*보니|돌아보니|살펴보니|이미\s*.{0,25}있었|추가로\s*(만들|할|고칠)\s*것(이|가)?\s*없/;

/**
 * toCommitMood가 부탁 어미("해 주세요" 등)를 통째로 떼어 낸 뒤 남는 것이, 요구사항 id(R25)나 짧은 대명사에
 * 조사만 붙은 조각일 때를 가리킨다(실측: 도그푸딩 — 요청 "R25를 해 주세요."의 제목이 "feat: R25를"이 됐다.
 * MOOD_ENDINGS의 마지막 대체 경로(`\s*(해\s*)?(줘|주세요|주십시오)$` → '')가 "를 해 주세요"를 통째로 지워
 * "R25를"만 남기는데, 이건 "무엇이 바뀌었는지"를 말하지 않는 요청 글 조각일 뿐이다). isClearChangeSentence가
 * toCommitMood로 바꾸고 나서야 이 조각을 보므로, TRAILING_REQUEST_PHRASING(바꾸기 전 어미 검사)만으로는
 * 잡히지 않는다 — 그래서 변환 결과 자체를 다시 검사해야 한다.
 */
const BARE_ID_OR_PRONOUN_FRAGMENT = /^(R\d+(?:\.\d+)?|이것|그것|저것|이거|그거|저거|이걸|그걸|저걸|이|그|저)(은|는|이|가|을|를|도|만|에|에서|로|으로)?$/;

/**
 * 부탁 어미를 뗀 결과가 목적격 조사(을/를)로 끝나면 동사가 빠진 명사구 조각이다(도그푸딩 버그 리포트: "R26의
 * 백엔드 부분을 해 주세요."가 "feat: R26의 백엔드 부분을"이 됐다). BARE_ID_OR_PRONOUN_FRAGMENT는 id·대명사 하나만
 * 남는 경우만 잡아서, 앞에 수식어가 붙은 긴 조각은 그대로 제목이 됐다. "마을"·"가을"처럼 을로 끝나는 명사가
 * 제목 끝에 올 수는 있지만, 그때는 에이전트 요약으로 넘어갈 뿐 잘못된 제목이 되지는 않는다.
 */
const DANGLING_OBJECT_PARTICLE = /\S(을|를)$/;

/**
 * 한 줄이 "무엇이 바뀌었는지" 분명히 말하는 서술문인지 본다(요청 글·에이전트 요약 둘 다에 쓴다). 너무 짧거나,
 * 물음표로 끝나거나, 앞 실행·인프라 같은 상황 설명이거나(SITUATIONAL_WORDS), 경과를 보고하는 말투거나
 * (PROGRESS_REPORT_WORDS), 말투를 커밋 문체로 정리(toCommitMood)하고도 부탁 어미만 남거나(예: "해주세요"
 * 그 자체) 요구사항 id·대명사에 조사만 남으면(예: "R25를", "이걸", BARE_ID_OR_PRONOUN_FRAGMENT), 목적격 조사로 끝나는 명사구만
 * 남으면(예: "R26의 백엔드 부분을", DANGLING_OBJECT_PARTICLE) 분명하지 않다고 보고 다음 대체 경로로 넘긴다.
 */
function isClearChangeSentence(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 4) return false;
  if (/[?？]\s*$/.test(trimmed)) return false;
  if (SITUATIONAL_WORDS.test(trimmed)) return false;
  if (PROGRESS_REPORT_WORDS.test(trimmed)) return false;
  const converted = toCommitMood(trimmed).trim();
  if (converted.length < 2) return false;
  if (BARE_ID_OR_PRONOUN_FRAGMENT.test(converted)) return false;
  if (DANGLING_OBJECT_PARTICLE.test(converted)) return false;
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

/** 바뀐 파일이 전부 added면 "더한다", 전부 deleted면 "지운다", 섞여 있으면 "고친다" */
function describeVerb(changes: readonly PendingChange[]): string {
  const allAdded = changes.every((change) => change.change === 'added');
  const allDeleted = changes.every((change) => change.change === 'deleted');
  return allDeleted ? '지운다' : allAdded ? '더한다' : '고친다';
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
  return `${area}를 ${describeVerb(changes)}`;
}

/** 모듈 이름으로 쓸모없는, 언어·빌드 도구가 강제하는 흔한 폴더 이름(src, main, test 등) */
const GENERIC_PATH_SEGMENTS =
  /^(src|main|test|tests|__tests__|spec|specs|java|kotlin|scala|com|org|io|net|app|apps|lib|libs|pkg|packages|internal|migrations?|resources|scripts|dist|build|out|public|assets|config|node_modules|web|api|server|client|components|pages)$/i;

/**
 * 바뀐 파일 경로에서 공통 모듈 이름을 뽑는다(요구사항 id + 모듈 이름 제목을 만들 때 쓴다). 파일마다 폴더 조각 중
 * 언어·빌드 도구가 강제하는 흔한 이름(GENERIC_PATH_SEGMENTS)을 걸러내고 남은 것 중 파일에 가장 가까운(가장
 * 안쪽) 조각 하나를 그 파일의 모듈로 본다 — "commerce/shorts/__tests__/r22.test.ts"는 __tests__까지 걸러
 * "shorts"가 남는다. 이 모듈이 바뀐 파일 절반 이상에서 같으면 공통 모듈로 본다. 가장 바깥 조각(commerce 같은
 * 영역 전체)이 아니라 가장 안쪽 조각을 쓰는 이유는 "무엇이 바뀌었는지"에는 shorts처럼 더 구체적인 이름이 낫기
 * 때문이다. 공통 모듈이 없으면 undefined — 이 경로로는 모듈을 못 찾는다는 뜻이다.
 */
function commonModuleLabel(changes: readonly PendingChange[]): string | undefined {
  const perFile = changes
    .map((change) => {
      const segments = change.file.split('/').slice(0, -1).filter((segment) => segment && !GENERIC_PATH_SEGMENTS.test(segment));
      return segments.at(-1);
    })
    .filter((segment): segment is string => Boolean(segment));
  if (perFile.length === 0) return undefined;

  const counts = new Map<string, number>();
  for (const segment of perFile) counts.set(segment, (counts.get(segment) ?? 0) + 1);
  let best: [string, number] | undefined;
  for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
  return best && best[1] >= Math.ceil(changes.length / 2) ? best[0] : undefined;
}

/**
 * 요청 글에서 요구사항 id(R22 등)를 찾고, 바뀐 파일에서 공통 모듈 이름을 찾아 "[R22] shorts 모듈을 고친다"
 * 같은 제목 후보를 만든다. 요청 글도 에이전트 요약도 분명하지 않을 때(generateCommitSubject의 3번 대체 경로)
 * describeChangeFromFiles보다 먼저 쓴다 — 요구사항 id가 있으면 파일 이름을 나열하는 것보다 더 사람이 읽을 만한
 * 제목이 된다. 요구사항 id가 없거나 공통 모듈을 못 찾으면 undefined.
 */
function requirementModuleCandidate(request: string, changes: readonly PendingChange[]): string | undefined {
  const ids = extractRequirementIds(request);
  if (ids.length === 0) return undefined;
  const module = commonModuleLabel(changes);
  if (!module) return undefined;
  return `[${ids.join(', ')}] ${module} 모듈을 ${describeVerb(changes)}`;
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
 * 에이전트 요약에서 제목 후보로 쓸 한 줄을 고른다. "범위: R22만 합니다"처럼 범위를 적은 줄이 있으면 그 줄(접두사는
 * 뗀다)을 요약 첫 줄보다 우선한다 — 완료 요약은 보통 인사말이나 전체 맥락으로 시작해 첫 줄이 "무엇이 바뀌었는지"를
 * 바로 말하지 않을 수 있지만, "범위:" 줄은 에이전트가 스스로 적은 작업 범위라 더 분명하다.
 */
function summaryTitleLine(agentSummary: string | undefined): string | undefined {
  if (!agentSummary) return undefined;
  const lines = agentSummary
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const scope = lines.find((line) => /^(범위|scope)\s*[:：]/i.test(line));
  return scope ? scope.replace(/^(범위|scope)\s*[:：]\s*/i, '').trim() : lines[0];
}

/**
 * 요청 글과 바뀐 파일, (있으면) 에이전트 요약에서 체크포인트 커밋 제목을 만든다(ADR-080). "타입: 한국어 요약"
 * 형식이고 72자를 넘지 않는다. 제목은 "무엇이 요청됐는지"가 아니라 "무엇이 바뀌었는지"를 말해야 하므로, 이 순서로
 * 고른다:
 *  0. AI 리뷰 고침 요청이면(reviewFixCandidate) 지적 제목들로 만든다 — 요청 글 첫 문장이 라운드마다 똑같은
 *     공통 문구라 아래 1번 규칙을 쓰면 의미 없는 제목이 된다(과제 66).
 *  1. 요청 글 첫 문장이 "무엇이 바뀌었는지" 분명하면 그것을 쓴다 — 여러 문장으로 된 요청이면 첫 문장만 쓴다
 *     (firstSentence). ".env.example 파일을 만들어 주세요. 코드에서 읽는 환경 변수…를 담되…" 같은 요청
 *     전체가 제목에 그대로 들어가던 문제가 여기서 막힌다. 커밋 제목은 사람이 실제로 무엇을 부탁했는지 그대로
 *     드러내는 편이 "AI 리뷰 지적을 고쳐 주세요" 같은 맥락(PR 리뷰 트레일러·요구사항 추적이 요청 글을 다시
 *     읽는다)을 잃지 않는다. 단, 첫 문장이 "앞 실행이 턴 상한에 걸려…"처럼 지금 바뀐 것이 아니라 그 바깥
 *     상황을 설명하면(SITUATIONAL_WORDS) isClearChangeSentence가 거짓이 되어 다음 단계로 넘어간다(실측:
 *     세션 5b640fd3, 체크포인트 57cced6 — 제목이 상황 설명 그대로 나가 실제로 바뀐 shorts 모듈을 말하지 않았다).
 *  2. 요청 글이 "해주세요"처럼 부탁 어미만 있거나 위 상황 설명이라 알맹이가 없으면, 에이전트 요약에서 고른 줄
 *     (summaryTitleLine — "범위:" 줄이 있으면 그것, 없으면 첫 줄)이 분명할 때 그것으로 대신한다. 모델을 새로
 *     부르지 않고 이미 있는 완료 요약만 읽으므로 비용이 들지 않는다.
 *  3. 그래도 분명하지 않으면, 요청 글에 요구사항 id(R22 등)가 있고 바뀐 파일에서 공통 모듈 이름을 찾을 수 있으면
 *     "[R22] shorts 모듈을 고친다"처럼 만든다(requirementModuleCandidate) — 파일 이름만 나열하는 4번보다
 *     요구사항 추적에 쓸모 있는 제목이 된다.
 *  4. 그래도 안 되면 바뀐 파일 이름에서 뽑는다(describeChangeFromFiles).
 *  5. 요청 글마저 비어 있으면(데이터만 바뀐 체크포인트 등) "체크포인트"로 둔다.
 * studio.yaml의 checkpoints.conventionalCommits를 껐을 때는 부르지 않고 기존 "요청: ..." 형식을 그대로 쓴다.
 */
export function generateCommitSubject(request: string, changes: readonly PendingChange[], agentSummary?: string): string {
  const type = classifyCommit(request, changes);
  const budget = MAX_SUBJECT_CHARS - type.length - 2;

  const requestFirstLine = request.split('\n')[0]!.replace(/\s+/g, ' ').trim();
  const summaryLine = summaryTitleLine(agentSummary);

  let candidate: string;
  const reviewFix = reviewFixCandidate(request);
  if (reviewFix) {
    candidate = reviewFix;
  } else if (requestFirstLine && isClearChangeSentence(firstSentence(requestFirstLine))) {
    candidate = toCommitMood(firstSentence(requestFirstLine));
  } else if (summaryLine && isClearChangeSentence(firstSentence(summaryLine))) {
    candidate = toCommitMood(firstSentence(summaryLine));
  } else if (requestFirstLine) {
    candidate = requirementModuleCandidate(request, changes) ?? describeChangeFromFiles(changes);
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
