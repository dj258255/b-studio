import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PendingChange } from './checkpoints';
import { classifyCommit, generateCommitSubject, summarize, toCommitMood } from './commit-message';

/**
 * commit-message를 Rust로 옮기면서(ADR-191 3g) 옛 TS 구현을 아래 `legacy`에 그대로 두고, 같은 무작위 입력을 옛 구현과 새 껍데기에 넣어
 * 결과를 JSON.stringify 글자로 견준다. `legacy`는 옮기기 전 `commit-message.ts`의 본문이다(`export`만 뗐다). 옛 구현이 쓰던
 * `extractPrReviewFixTitles`(pr-review)와 `extractRequirementIds`(test-discovery)도 그때 모양 그대로 안에 둔다. 지우지 않는다 — 이 시험이 기준으로 삼는다.
 *
 * 견줄 때 두 쪽 결과의 짝 없는 서로게이트를 U+FFFD로 바꾼다(`toWellFormed`): Rust 경계는 서로게이트 쌍을 가르는 자르기를 U+FFFD로 돌려주고
 * JS는 짝 없는 절반을 남긴다(의도한 차이). 입력에는 서로게이트를 쌍으로만 넣는다.
 *
 * 크기는 환경 변수로 바꾼다: COMMIT_MESSAGE_DIFF_SEEDS(쉼표 목록), COMMIT_MESSAGE_DIFF_ITERATIONS, COMMIT_MESSAGE_DIFF_REPORT=1(분포 출력), COMMIT_MESSAGE_DIFF_REPORT_FILE(출력 파일)
 */
const legacy = (() => {

type PendingChange = { file: string; change: 'added' | 'modified' | 'deleted' };
type PrReviewSeverity = 'blocker' | 'major' | 'minor' | 'nit';
interface PrReviewFinding { severity: PrReviewSeverity; file: string; line?: number; title: string; detail: string; suggestion?: string }
const BLOCKING_SEVERITIES = new Set<PrReviewSeverity>(['blocker', 'major']);
const SEVERITY_LABEL: Record<PrReviewSeverity, string> = { blocker: '차단', major: '주요', minor: '경미', nit: '사소' };
/** test-discovery.ts(옛 구현)의 요구사항 id 찾기 */
const REQUIREMENT_ID_PATTERN = /\bR\d+(?:\.\d+)?\b/g;
function extractRequirementIds(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(REQUIREMENT_ID_PATTERN)) found.add(match[0]);
  return [...found];
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



/** 제목 맨 앞에 붙는 conventional commit 타입 (ADR-080). git 로그에 실제로 쓰는 이름만 받는다 */
type CommitType = 'feat' | 'fix' | 'test' | 'docs' | 'refactor' | 'chore';

const MAX_SUBJECT_CHARS = 72;

/** Vitest·Jest, JUnit, pytest 테스트 파일 경로. 바뀐 파일이 전부 이 패턴이면 테스트 커밋으로 본다 */
const TEST_FILE = /(^|\/)(__tests__)\/.+|\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)src\/test\/(java|kotlin)\/.+\.(java|kt)$|(^|\/)tests?\/.+\.py$|(^|\/)test_[^/]+\.py$|_test\.py$/i;

/** 문서 파일 경로. 바뀐 파일이 전부 이 패턴이면 문서 커밋으로 본다 */
const DOC_FILE = /(^|\/)docs\/.+\.mdx?$|(^|\/)readme(\.[a-z]+)?\.md$|(^|\/)changelog\.md$/i;

/** 요청 글에서 리팩터링을 가리키는 낱말 */
const REFACTOR_WORDS = /리팩터|리팩토링|구조\s*정리|구조\s*변경|정리한다|옮기|옮겨|옮긴|refactor/i;
/** 요청 글에서 잡일(의존성 올리기, 설정 변경 등)을 가리키는 낱말 */
const CHORE_WORDS = /의존성|dependency|devdependency|버전\s*올리기|업그레이드|설정\s*변경|chore/i;
/** 요청 글에서 고침을 가리키는 낱말. 이 낱말이 있어야 fix로 본다 */
const FIX_WORDS = /고치|고쳐|버그|오류|에러|안\s*(돼|되|나와|보여)|깨지|실패하|수정해|fix|bug|error/i;
/** 요청 글 첫 문장에서 새로 만들기를 가리키는 낱말. 첫 문장이 이 낱말을 쓰면 본문에 FIX_WORDS가 있어도 feat로 본다 */
const FEAT_WORDS = /만들|만든|추가|더해|더하|구현|새로|add|implement|create/i;

/**
 * 요청 글과 바뀐 파일에서 conventional commit 타입을 고른다. 모델을 부르지 않고 경로·낱말만 본다(ADR-080).
 * 우선순위: 테스트 파일만 바뀌었으면 test, 문서 파일만이면 docs, 새 파일뿐이면 feat,
 * 그 외에는 요청 첫 문장에서 고침(fix)·새로 만들기(feat) 낱말을 먼저 찾고, 없으면 요청 글 전체의 낱말로
 * fix·refactor·chore를 찾고, 그래도 없으면 feat로 둔다.
 */
function classifyCommit(request: string, changes: readonly PendingChange[]): CommitType {
  if (changes.length > 0 && changes.every((change) => TEST_FILE.test(change.file))) return 'test';
  if (changes.length > 0 && changes.every((change) => DOC_FILE.test(change.file))) return 'docs';
  if (changes.length > 0 && changes.every((change) => change.change === 'added')) return 'feat';
  // 요청의 의도는 첫 문장이 말한다. 본문의 "조회 실패 시 오류 문구를 보여 준다" 같은 동작 설명이 FIX_WORDS에
  // 걸려 새 화면을 만든 커밋이 fix가 되던 문제(도그푸딩 버그 리포트)를 막으려고, 첫 문장을 먼저 본다
  const intent = firstSentence(request.split('\n')[0]!.replace(/\s+/g, ' ').trim());
  if (FIX_WORDS.test(intent)) return 'fix';
  if (FEAT_WORDS.test(intent)) return 'feat';
  if (REFACTOR_WORDS.test(intent)) return 'refactor';
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
 *
 * "최대 턴 수"는 플랫폼이 턴 상한에서 쓰는 종료 안내다(recheckGateOnMaxTurns의 "최대 턴 수(N)를 넘었습니다").
 * 그때 게이트가 통과하면 이 안내가 완료 요약 자리에 오고 체크포인트도 남으므로, 걸러 두지 않으면 안내가 제목이 된다
 * (실측: 세션 5b640fd3, 체크포인트 516fe67 — "fix: 최대 턴 수(40)를 넘었습니다").
 */
const SITUATIONAL_WORDS =
  /(앞|이전|지난|직전|방금)\s*(실행|시도|요청|작업)|네트워크|연결이?\s*끊|세션이?\s*끊|턴\s*상한|최대\s*턴\s*수|토큰\s*상한|되돌려지|롤백되|rate\s*limit|레이트\s*리밋|타임아웃|timeout/i;

/**
 * "지금 무엇이 바뀌었는지"가 아니라 그걸 알아내기까지의 경과(검토해 보니 어땠는지, 이미 돼 있었는지, 더 할 게
 * 없는지)를 서술하는 문장을 가리키는 낱말(실측: 세션 5b640fd3, 체크포인트 15ba740 — 요약 첫 줄이 "검토 결과,
 * 이전 턴에서 복구된 9개 파일(R21 구현)은 이미 완성되어 있었습니다 — 추가로 만들 것이 없어 검증만"이 되어,
 * 그대로 제목이 됐다. 바뀐 파일을 말하지 않는 경과 보고라 요구사항 id·공통 모듈(requirementModuleCandidate)
 * 같은 대체 경로로 넘겨야 한다). SITUATIONAL_WORDS(앞 실행·인프라 문제)와 달리 이쪽은 에이전트가 스스로
 * "확인했다"는 과정을 보고하는 말투다.
 */
/**
 * 지금 상태를 설명하는 문장의 끝(없습니다·않습니다·있습니다·입니다 등). 요청 첫 문장이 "…확인하지 않아서, 잰
 * 시간이 … 보장이 없습니다."처럼 문제를 설명하면 바뀐 내용이 아니라 현상이다(도그푸딩 버그 리포트: 제목이 그
 * 문제 설명 그대로 나갔다). 완료 요약의 "…확장했습니다"처럼 과거형으로 한 일을 말하는 끝은 걸리지 않는다.
 */
const STATE_DESCRIPTION_ENDING = /(없|않|있|죽)습니다$|(입|아닙|됩|깨집|나옵|보입|걸립|실패합|멈춥|막힙|끊깁)니다$|(없어|않아|있어|안\s*돼|안\s*나와|안\s*보여)요$/;

// "마무리 확인 결과를 보고합니다"처럼 보고하겠다는 말도 경과 보고다(도그푸딩 버그 리포트: 제목이 이 문장 그대로 나갔다)
/**
 * 요청 글 첫 문장이 과거형 서술로 끝나면(…다시 돌렸습니다, …만들었습니다) 사람이 이미 한 일이나 앞 상황을 알려 주는
 * 맥락이지, 이번 실행이 바꿀 내용이 아니다(도그푸딩 버그 리포트: "MediaMTX를 재시작해 새 설정으로 다시 돌렸습니다(제가
 * 대신 했습니다)."가 그대로 제목이 됐다). 완료 요약의 과거형은 에이전트가 한 일이라 요청 글에만 적용한다.
 * 끝의 괄호 꼬리("(제가 대신 했습니다)")는 떼고 본다.
 */
const REQUEST_NARRATION_ENDING = /(었|았|였|했|렸|웠|겼|졌|줬|봤|뒀)습니다$/;

function isRequestNarration(sentence: string): boolean {
  const body = sentence.replace(/[.!?。]+$/, '').trim().replace(/\s*\([^()]*\)$/, '').trim();
  return REQUEST_NARRATION_ENDING.test(body);
}

const PROGRESS_REPORT_WORDS = /검토\s*결과|확인\s*결과|확인해\s*보니|돌아보니|살펴보니|이미\s*.{0,25}있었|추가로\s*(만들|할|고칠)\s*것(이|가)?\s*없|보고(합니다|드립니다|드려요)|결과를\s*(알려|보고)|완료\s*요약/;

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
  const mood = toCommitMoodDetailed(trimmed);
  const converted = mood.text.trim();
  // 동사 규칙 없이 부탁 어미만 지웠는데 끝이 서술(…다)·명사형(…함·…기)이 아니면 동사 조각이 남은 것이다.
  // 규칙을 끝없이 늘리는 대신 다음 대체 경로(요약·바뀐 파일)로 넘긴다(트러블슈팅 78의 배운 점)
  if (mood.generic && !/(다|함|기)$/.test(converted)) return false;
  if (converted.length < 2) return false;
  if (BARE_ID_OR_PRONOUN_FRAGMENT.test(converted)) return false;
  if (STATE_DESCRIPTION_ENDING.test(converted)) return false;
  if (DANGLING_OBJECT_PARTICLE.test(converted)) return false;
  return !TRAILING_REQUEST_PHRASING.test(converted);
}

interface CommitSubjectOptions {
  /** 요청 글이 에이전트의 질문에 대한 답이다. 답의 첫 문장은 제목으로 쓰지 않는다 */
  requestIsAnswer?: boolean;
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
  return `[${requirementIdLabel(ids)}] ${module} 모듈을 ${describeVerb(changes)}`;
}

/**
 * 제목에 넣을 요구사항 id 묶음. 시나리오 id(R1.2)는 부모 요구사항(R1)으로 접고 중복을 없앤 뒤 번호순으로 늘어놓고,
 * 셋 이상 이어지는 번호는 범위(R1~R3)로 줄인다(도그푸딩 버그 리포트: "[R1, R3, R1.2, R2.1, R2.2, R3.1, R3.2, R3.3]"처럼
 * 요청 글에 나온 id를 그대로 나열해 제목이 길고 읽기 어려웠다)
 */
function requirementIdLabel(ids: readonly string[]): string {
  const numbers = [...new Set(ids.map((id) => Number(/^R(\d+)/.exec(id)?.[1])).filter((n) => Number.isFinite(n)))].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < numbers.length; ) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j]! + 1) j += 1;
    if (j - i >= 2) parts.push(`R${numbers[i]}~R${numbers[j]}`);
    else for (let k = i; k <= j; k += 1) parts.push(`R${numbers[k]}`);
    i = j + 1;
  }
  return parts.join(', ');
}

/**
 * 후보 글을 남은 글자 수에 맞춰 자른다. 단어 경계에서 끊고, 비어 있으면 "체크포인트"로 대신한다.
 * 체크포인트 제목(generateCommitSubject)뿐 아니라 PR 제목(repository.ts의 buildPullRequest, ADR-110)도
 * "가장 중요한 커밋 제목을 요약"할 때 이 함수를 그대로 재사용한다 — 단어 중간을 자르지 않는 규칙을 두 곳에서
 * 따로 구현하지 않는다(버그 리포트: PR 제목을 120자에서 그냥 slice해 단어 중간이 잘렸다).
 */
function summarize(text: string, maxChars: number): string {
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

/** 요약 본문이 시작되는 머리글: "## 요약", "## 완료 요약", "## Summary", "## 변경 내용" */
const SUMMARY_HEADING = /^#{1,6}\s*(완료\s*)?(요약|summary|변경\s*(내용|사항)|한\s*일)\s*$/i;
const HANGUL = /[가-힣]/;

/**
 * 에이전트 요약에서 제목 후보로 쓸 한 줄을 고른다. "범위: R22만 합니다"처럼 범위를 적은 줄이 있으면 그 줄(접두사는
 * 뗀다)을 요약 첫 줄보다 우선한다 — 완료 요약은 보통 인사말이나 전체 맥락으로 시작해 첫 줄이 "무엇이 바뀌었는지"를
 * 바로 말하지 않을 수 있지만, "범위:" 줄은 에이전트가 스스로 적은 작업 범위라 더 분명하다.
 *
 * 줄의 꼴이 아니라 자리와 언어로 거르는 규칙 둘(실측: 세션 5b640fd3, 체크포인트 62866d6 — 요약이 "Everything is consistent
 * and complete. All changes verified: …"로 시작하고 실제 내용은 그 아래 "## 요약" 절에 있었는데 첫 줄이 제목이 됐다):
 *  - "## 요약" 같은 머리글이 있으면 그 앞은 마무리 인사·경과 보고로 보고 머리글 뒤의 줄만 본다.
 *  - 요청 글이 한국어인데(preferHangul) 한글이 하나도 없는 줄은 건너뛴다. 영어로 된 경과 문장은 한국어 낱말 규칙
 *    (PROGRESS_REPORT_WORDS 등)에 걸리지 않아 "분명한 서술문"으로 통과한다.
 */
function summaryTitleLine(agentSummary: string | undefined, preferHangul = false): string | undefined {
  if (!agentSummary) return undefined;
  const all = agentSummary.split('\n').map((line) => line.trim());
  const heading = all.findIndex((line) => SUMMARY_HEADING.test(line));
  // 마크다운 머리글("## 완료")·굵은 글씨만 있는 줄("**고친 내용**", 뒤에 괄호로 파일만 나열한 "**레이아웃 수정** (a.tsx, b.css)")은
  // 절 제목이라 무엇이 바뀌었는지 말하지 않는다. 나머지 줄은 목록 기호·굵은 글씨·코드 표시를 걷어 내고 본다
  // (도그푸딩 버그 리포트: 요약 첫 줄이 "## 완료"였다)
  const lines = (heading >= 0 ? all.slice(heading + 1) : all)
    .filter((line) => line.length > 0 && !/^#{1,6}\s/.test(line) && !/^\*\*[^*]+\*\*\s*(\([^()]*\))?\s*[:：]?$/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/\*\*/g, '').replace(/`/g, '').trim())
    // "찾은 결함: …"·"원인: …"처럼 문제를 설명하는 줄은 무엇이 바뀌었는지가 아니다
    .filter((line) => line.length > 0 && !/^(찾은\s*)?(결함|원인|문제|현상|참고|배경|결론|요약|현재\s*상태)\s*[:：]/.test(line))
    .filter((line) => !preferHangul || HANGUL.test(line));
  const scope = lines.find((line) => /^(범위|scope)\s*[:：]/i.test(line));
  return scope ? scope.replace(/^(범위|scope)\s*[:：]\s*/i, '').trim() : lines[0];
}

/** 절 제목 한 줄: "**로그인 UX**", "**레이아웃 수정** (a.tsx, b.css)", "**방송 제목 표시**:" */
const SECTION_LABEL = /^\*\*([^*]+)\*\*\s*(\([^()]*\))?\s*[:：]?$/;
/** 바뀐 영역이 아니라 보고서의 칸 이름인 절 제목("고친 내용", "검증 방법", "남은 한계" 등) */
const REPORT_SECTION_LABEL = /^(고친|바꾼|수정한|변경한)?\s*(내용|사항|파일|것)$|요약|범위|검증|확인|테스트|결과|한계|남은|다음|결정|주의|배경|원인|참고|summary|verification|notes?$/i;

/**
 * 에이전트 요약이 바뀐 영역마다 굵은 글씨 절 제목을 달았으면 그 제목들을 묶어 제목 후보로 쓴다
 * ("레이아웃/시각 수정, 로그인 UX, 방송 제목 표시"). 요약 첫 줄도 요구사항 id도 쓸 수 없을 때, 파일 이름을 나열하는
 * 마지막 경로보다 무엇이 바뀌었는지를 더 잘 말한다(실측: 세션 5b640fd3, 체크포인트 62866d6 — 파일 이름으로는
 * "globals·page 외 5개를 고친다"가 된다). 절 제목이 둘 이상이고 예산 안에 들어갈 때만 쓴다. 하나뿐이면 그것이 바뀐 영역인지
 * 보고서의 칸 이름인지 가르기 어렵다.
 */
function sectionLabelsCandidate(agentSummary: string | undefined, budget: number, preferHangul: boolean): string | undefined {
  if (!agentSummary) return undefined;
  const labels = agentSummary
    .split('\n')
    .map((line) => SECTION_LABEL.exec(line.trim().replace(/^[-*]\s+/, ''))?.[1]?.trim())
    .filter((label): label is string => label !== undefined && label.length > 0 && !REPORT_SECTION_LABEL.test(label))
    .filter((label) => !preferHangul || HANGUL.test(label));
  const unique = [...new Set(labels)];
  if (unique.length < 2) return undefined;
  const joined = unique.join(', ');
  return joined.length <= budget ? joined : undefined;
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
 *     (summaryTitleLine — "범위:" 줄이 있으면 그것, 없으면 첫 줄. "## 요약" 머리글이 있으면 그 뒤만 보고, 요청이 한국어면
 *     한글이 없는 줄은 건너뛴다)이 분명할 때 그것으로 대신한다. 모델을 새로
 *     부르지 않고 이미 있는 완료 요약만 읽으므로 비용이 들지 않는다.
 *  3. 그래도 분명하지 않으면, 요청 글에 요구사항 id(R22 등)가 있고 바뀐 파일에서 공통 모듈 이름을 찾을 수 있으면
 *     "[R22] shorts 모듈을 고친다"처럼 만든다(requirementModuleCandidate) — 파일 이름만 나열하는 4번보다
 *     요구사항 추적에 쓸모 있는 제목이 된다.
 *  4. 그래도 안 되면 에이전트 요약의 절 제목들을 묶어 쓰고(sectionLabelsCandidate, 둘 이상이고 예산 안일 때), 그것도 없으면
 *     바뀐 파일 이름에서 뽑는다(describeChangeFromFiles).
 *  5. 요청 글마저 비어 있으면(데이터만 바뀐 체크포인트 등) "체크포인트"로 둔다.
 * studio.yaml의 checkpoints.conventionalCommits를 껐을 때는 부르지 않고 기존 "요청: ..." 형식을 그대로 쓴다.
 *
 * 요청 글이 에이전트의 질문에 대한 답이면(options.requestIsAnswer) 1번을 건너뛴다. 답의 첫 문장은 선택지를 고르는 말이지
 * 바뀐 내용이 아니다(실측: 세션 5b640fd3, 체크포인트 74d86ca — 답 "세 번째로 갑니다. sampleParams 키는 …"의 첫 문장이
 * 제목 "test: 세 번째로 갑니다"가 됐다). 문장 꼴로는 "…로 갑니다"와 "…를 더합니다"를 가를 수 없어, 어떤 문장인지가 아니라
 * 어떤 요청인지(질문이 걸려 있을 때 온 글)로 가른다.
 */
function generateCommitSubject(request: string, changes: readonly PendingChange[], agentSummary?: string, options: CommitSubjectOptions = {}): string {
  const type = classifyCommit(request, changes);
  const budget = MAX_SUBJECT_CHARS - type.length - 2;

  const requestFirstLine = request.split('\n')[0]!.replace(/\s+/g, ' ').trim();
  const summaryLine = summaryTitleLine(agentSummary, HANGUL.test(request));

  let candidate: string;
  const reviewFix = reviewFixCandidate(request);
  if (reviewFix) {
    candidate = reviewFix;
  } else if (!options.requestIsAnswer && requestFirstLine && !isRequestNarration(firstSentence(requestFirstLine)) && isClearChangeSentence(firstSentence(requestFirstLine))) {
    candidate = toCommitMood(firstSentence(requestFirstLine));
  } else if (summaryLine && isClearChangeSentence(firstSentence(summaryLine)) && shortenPaths(toCommitMood(firstSentence(summaryLine))).length <= budget) {
    // 요약 줄은 예산 안에 들어갈 때만 쓴다. 잘린 요약은 동사가 사라져 바뀐 파일로 만든 제목보다 못하다(도그푸딩 버그 리포트)
    candidate = toCommitMood(firstSentence(summaryLine));
  } else if (requestFirstLine) {
    candidate = requirementModuleCandidate(request, changes) ?? sectionLabelsCandidate(agentSummary, budget, HANGUL.test(request)) ?? describeChangeFromFiles(changes);
  } else {
    candidate = '체크포인트';
  }

  return `${type}: ${summarize(candidate.length > budget ? shortenPaths(candidate) : candidate, budget)}`;
}

/**
 * 폴더가 두 단계 이상인 파일 경로를 마지막 이름만 남긴다. 제목이 예산을 넘을 때만 쓴다(도그푸딩 버그 리포트:
 * "…넣은 commerce/src/test/resources/mockito-extensions/org.mockito.plugins.MockMaker 파일을 지워 주세요."가
 * 72자에서 잘려 경로 한가운데서 끝나고 동사 "지운다"가 사라졌다). "apps/web"처럼 짧은 경로는 그대로 둔다.
 */
function shortenPaths(text: string): string {
  return text.replace(/(?:[\w.@-]+\/){2,}([\w.@-]+)/g, '$1');
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
  [/옮겨\s*(줘|주세요|주십시오)$/, '옮긴다'],
  [/나눠\s*(줘|주세요|주십시오)$/, '나눈다'],
  [/붙여\s*(줘|주세요|주십시오)$/, '붙인다'],
  [/맞춰\s*(줘|주세요|주십시오)$/, '맞춘다'],
  [/줄여\s*(줘|주세요|주십시오)$/, '줄인다'],
  [/늘려\s*(줘|주세요|주십시오)$/, '늘린다'],
  [/올려\s*(줘|주세요|주십시오)$/, '올린다'],
  [/남겨\s*(줘|주세요|주십시오)$/, '남긴다'],
  [/돌려\s*(줘|주세요|주십시오)$/, '돌린다'],
  [/적어\s*(줘|주세요|주십시오)$/, '적는다'],
  [/막아\s*(줘|주세요|주십시오)$/, '막는다'],
  [/(\S+)해\s*(줘|주세요|주십시오)$/, '$1한다'],
  // "재생되게 해 주세요"처럼 "~게 해 주세요"는 동사구라 띄어쓰기를 지키고 "~게 한다"로 바꾼다(아래 명사 규칙이 "되게한다"로 붙였다)
  [/게\s+해\s*(줘|주세요|주십시오)$/, '게 한다'],
  // "로그인 기능 추가 해 주세요"처럼 명사 뒤에 띄어 쓴 "해 주세요". 목적격·보조사로 끝나면("R25를 해 주세요") 동사가 아니라
  // 제외한다("이걸·그걸"의 걸은 "것을"의 준말이라 함께 뺀다). 이·가·도·로·에는 명사 끝 글자(추가·정도·경로 등)와 겹쳐 넣지 않았다
  [/([^\s을를은는걸])\s+해\s*(줘|주세요|주십시오)$/, '$1한다'],
  [/\s*(해\s*)?(줘|주세요|주십시오)$/, ''],
];

function toCommitMood(text: string): string {
  return toCommitMoodDetailed(text).text;
}

/** 마지막 대체 규칙(부탁 어미만 지움)의 패턴. 이 규칙만 맞았으면 동사를 바꾸지 못한 것이다 */
const GENERIC_MOOD_ENDING = MOOD_ENDINGS[MOOD_ENDINGS.length - 1]![0];

/**
 * toCommitMood와 같지만, 구체적인 동사 규칙 없이 마지막 대체 규칙(부탁 어미만 지움)만 맞았는지도 돌려준다.
 * "…실제 경로로 재 주세요"처럼 규칙에 없는 동사는 "…실제 경로로 재"처럼 동사 조각만 남는다(도그푸딩 버그 리포트).
 */
function toCommitMoodDetailed(text: string): { text: string; generic: boolean } {
  let result = text.replace(/[.!?。]+$/, '').trim();
  let generic = false;
  // "옮겨 주세요(R32)"처럼 끝에 괄호 꼬리(요구사항 id 등)가 붙으면 어미 규칙이 끝($)을 못 찾는다(도그푸딩 버그 리포트).
  // 꼬리를 떼고 어미를 바꾼 뒤 다시 붙인다
  const tail = /\s*(\([^()]*\))$/.exec(result);
  if (tail) result = result.slice(0, tail.index).trim();
  for (const [pattern, replacement] of MOOD_ENDINGS) {
    if (pattern.test(result)) {
      generic = pattern === GENERIC_MOOD_ENDING;
      result = result.replace(pattern, replacement).trim();
      break;
    }
  }
  return { text: tail ? `${result}${tail[1]}` : result, generic };
}

  return { classifyCommit, generateCommitSubject, summarize, toCommitMood, buildPrReviewFixRequest };
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

/** 옛 단위 시험(commit-message.test.ts)에 나온 글과 같은 모양의 말뭉치 */
const CORPUS: string[] = ["\"## 요약\" 머리글이 있으면 그 앞의 줄은 보지 않고, 뒤에 절 제목이 둘 이상이면 그것들을 묶는다", "\"~게 해 주세요\"는 띄어쓰기를 지켜 \"~게 한다\"로 바꾼다(도그푸딩 버그 리포트: \"재생되게한다\")", "\"타입: 요약\" 형식으로 만들고 72자를 넘지 않는다", "\"확인해 보니\"·\"추가로 …것이 없어\"처럼 다른 경과 보고 말투도 제목 후보에서 뺀다", "## 완료\n\n**찾은 결함**: `write_master()`가 바깥 스코프 값을 먼저 치환합니다.\n\n**고친 내용**\n- 회차마다 산출물을 확인하고 마스터 재생목록을 만들었습니다.", "## 요약", "**R24 측정 완료 (실제 경로):**\n\n- 업로드 완료부터 READY까지 실제 경로 측정 스크립트를 더했습니다.", "**결론: MediaMTX가 샌드박스에서 죽어 실제 송출 검증을 끝까지 돌리지 못했습니다.**\n\n- MediaMTX 설정의 훅 이름을 runOnReady로 고쳤습니다.", "**레이아웃/시각 수정** (`apps/web/app/live/[id]/page.tsx`, `apps/web/app/globals.css`)", "**로그인 UX** (`apps/web/lib/liveLogin.ts` 신규)", "**방송 제목 표시**", "- **검증 방법**: 브라우저 스크린샷 도구가 없어 요소 높이를 계산했습니다.", "- 빈 입력 시 서버 호출 전에 안내합니다.", "- 숏폼 피드용 `.shorts-scroller`(72vh 내부 스크롤)·`.shorts-frame`(세로 9:16, 폭 300px 고정) 재사용을 그만두고, 라이브 전용 `.live-page`/`.live-frame`/`.live-video`/`.live-empty`/`.live-title`을 새로 만들었습니다.", "- 화면 상단에 표시합니다.", ".env.example", ".env.example 파일을 만들어 주세요. 코드에서 읽는 환경 변수(NEXT_PUBLIC_API_BASE_URL, DATABASE_URL)를 모두 담되 실제 값 대신 예시 값을 넣고, 실제 비밀 값이 든 .env는 커밋하지 마세요.", ".github/workflows/ci.yml", ".live-empty", ".live-frame", ".live-page", ".live-title", ".live-video", ".shorts-frame", ".shorts-scroller", "AI 리뷰", "AI 리뷰 고침 요청(buildPrReviewFixRequest)이면 요청 글의 공통 문구 대신 지적 제목들로 제목을 만든다(과제 66 버그 리포트)", "AI 리뷰 지적을 고쳐 주세요", "Add a memo field to orders", "Add a memo field to orders.", "Can you fix it?", "Everything", "Everything is consistent and complete. All changes verified: tests pass (62/62 web), both services restarted and healthy.", "MediaMTX Control API로 송출 상태를 읽도록 바꿨습니다.", "MediaMTX 실제 송출이 실패합니다. 원인을 알려 드리니 고쳐 주세요.", "MediaMTX를 재시작해 새 설정으로 다시 돌렸습니다(제가 대신 했습니다). 결과와 근거입니다. 이어서 고쳐 주세요.", "R1.2", "R24(60초 영상 업로드 완료부터 READY까지 60초 이내)를 실제 경로로 재 주세요. 지금까지는 FFmpeg 변환 시간만 쟀습니다.", "R25를 해 주세요", "R25를 해 주세요.", "R26의 백엔드 부분을 해 주세요.", "R26의 웹 화면을 만들어 주세요.\n- 조회 실패 시 오류 문구와 재시도 버튼을 보여 준다.", "README 정리", "README.md", "README를 써 줘", "README를 쓴다", "README에 설계 결정과 환경 변수 예시 절을 추가했습니다.\n\n세부 설명은 아래에.", "[R1~R3]", "[R3] 주문 취소 API", "added", "api/SeedRunner.java", "api/build.gradle", "api/src/main/java/CancelOrder.java", "api/src/main/java/Order.java", "api/src/test", "api/src/test/java/OrderTest.java", "api/tests/test_orders.py", "apps/commerce/src/order/api.ts", "apps/commerce/src/shorts/__tests__/r21.test.ts", "apps/commerce/src/shorts/__tests__/r22.test.ts", "apps/commerce/src/shorts/feed.ts", "apps/commerce/src/shorts/link.ts", "apps/commerce/src/shorts/migrations/V74__add_shorts_state.sql", "apps/commerce/src/shorts/state-machine.ts", "apps/web/app/globals.css", "apps/web/app/live/[id]/page.tsx", "apps/web/components/LiveViewer.tsx", "apps/web/components/ShortsFeed.tsx", "apps/web/lib/api.ts", "apps/web/lib/api.ts에 재시도를 넣어 주세요", "apps/web/lib/liveLogin.ts", "apps/web/lib/liveOrder.test.ts", "apps/web/next.config.ts", "blocker", "change", "chore", "classifyCommit", "commerce/build.gradle", "commerce/src/test/java/com/beomsu/becommerce/live/LiveOrderHoldReconciliationSandboxTest.java", "commerce/src/test/java/com/beomsu/becommerce/live/LiveOrderHoldReconciliationTest.java", "commerce/src/test/resources/mockito-extensions/org.mockito.plugins.MockMaker", "deleted", "docs", "docs/performance/shorts-transcode.md", "docs/requirements.md", "docs: README에 설계 결정과 환경 변수 예시 절을 추가했습니다", "feat", "feat: ", "feat: .env.example 파일을 만든다", "feat: MediaMTX Control API로 송출 상태를 읽도록 바꿨습니다", "feat: MediaMTX 설정의 훅 이름을 runOnReady로 고쳤습니다", "feat: R25를", "feat: R25를한다", "feat: R26의 백엔드 부분을", "feat: [R21] shorts 모듈을 고친다", "feat: [R22] shorts 모듈을 고친다", "feat: apps/web/lib/api.ts에 재시도를 넣는다", "feat: globals·LiveViewer 외 1개를 고친다", "feat: shorts 모듈을 R25(숏폼↔상품 다중 연결)까지 확장했습니다", "feat: 라이브 화면의 로그인 안내 문구를 고쳤습니다", "feat: 레이아웃/시각 수정, 로그인 UX, 방송 제목 표시", "feat: 로그인 기능 추가한다", "feat: 메모 필드 추가", "feat: 숏폼 피드 API에 커서 기반 페이지네이션과 다음 영상 미리 불러오기 힌트를 더했습니다", "feat: 업로드 완료부터 READY까지 실제 경로 측정 스크립트를 더했습니다", "feat: 연결 상품 조회를 피드 응답에 넣었습니다", "feat: 이걸", "feat: 주문 API를 정의한다", "feat: 주문에 메모 필드 추가", "feat: 체크포인트", "feat: 환경 변수 예시를 더한다", "fix", "fix: 리뷰 지적 2건 반영 — 시드 id 시퀀스 검증, 마이그레이션 테스트", "fix: 회차마다 산출물을 확인하고 마스터 재생목록을 만들었습니다", "generateCommitSubject", "major", "media/mediamtx.yml", "media/src/main/java/MediaMtxPathPoller.java", "media/src/main/java/Shorts.java", "media/src/test/java/com/beomsu/becommerce/live/LiveBroadcastServiceTest.java", "media/src/test/java/com/beomsu/becommerce/live/LiveBroadcastTest.java", "modified", "pass", "pytest 추가", "refactor", "refactor: 숏폼 코드를 저장소 최상위 media/로 옮긴다(R32)", "shorts", "shorts 모듈을 R25(숏폼↔상품 다중 연결)까지 확장했습니다.\n\n세부 설명은 아래에.", "test", "test: 바로 주문 시나리오(R11.2) 테스트를 더했습니다", "test: 세 번째로 갑니다", "toCommitMood", "tools/run-bench.sh", "tools/run-bench.sh가 산출물을 확인하지 않아서, 잰 시간이 맞다는 보장이 없습니다. 고쳐 주세요.", "tools/run-shorts-upload-to-ready-bench.sh", "vitest", "web/app/dashboard/page.tsx", "web/app/login/page.tsx", "web/app/orders/page.test.tsx", "web/app/orders/page.tsx", "web/app/pay/page.tsx", "write_master()", "검토 결과", "검토 결과, 이전 턴에서 복구된 9개 파일(R21 구현)은 이미 완성되어 있었습니다 — 추가로 만들 것이 없어 검증만 했습니다.", "결정을 ADR로 남겨 주세요(R32)", "결정을 ADR로 남긴다(R32)", "결정하실 사항은 없습니다.", "결제 화면에 버그가 있어요. 새로 고침하면 사라집니다.", "고쳤습니다.", "규칙에 없는 동사(\"…재 주세요\")는 부탁 어미만 떼어 동사 조각을 남기지 않고 다음 대체 경로로 넘긴다(도그푸딩 버그 리포트)", "긴 요청은 단어 경계에서 잘라 72자를 넘기지 않는다", "긴 파일 경로 때문에 72자를 넘으면 경로를 파일 이름으로 줄여 동사까지 남긴다(도그푸딩 버그 리포트: 경로 한가운데서 잘림)", "끝에 괄호 꼬리가 붙은 요청(\"…옮겨 주세요(R32)\")도 어미를 바꾸고, 옮기기는 refactor로 본다(도그푸딩 버그 리포트)", "넘었습니다", "네트워크", "네트워크 끊김처럼 다른 상황 설명 낱말도 제목 후보에서 뺀다", "네트워크가 끊겨서 다시 시도합니다.", "대시보드 로딩 버그를 고쳐 주세요", "대시보드 로딩 버그를 고쳐 주세요. 재현 방법은 콘솔을 열고 새로고침하면 됩니다.", "대시보드 로딩 버그를 고친다", "대시보드가 로딩에서 멈추는 버그를 고쳐 줘", "동사가 살아 있는 요청(\"주문 API를 정의해 주세요\")은 그대로 커밋 문체로 바꿔 쓴다", "되돌려", "라이브 방송 R1~R3의 시나리오 테스트를 채워 주세요. 요구사항 화면에 R1.2, R2.1, R2.2, R3.1, R3.2, R3.3이 \"테스트 없음\"으로 나옵니다.", "로그인 기능 추가 해 주세요", "로그인 기능 추가한다", "마무리 확인 결과를 보고합니다.\n\n**진단**: 이전 실행이 이미 올바르게 분석·수정해 두었습니다.", "마이그레이션 테스트", "머리글이 없어도 요청이 한국어면 한글이 없는 줄은 건너뛰고 다음 줄을 쓴다", "메모 필드 추가", "메모 필드 추가\n\n상세 설명은 여기", "명사 뒤에 띄어 쓴 \"해 주세요\"는 \"…한다\"로 바꾸고, 조사로 끝나면 동사로 보지 않는다", "바뀐 파일이 섞여 있으면(테스트+일반) test·docs·feat 전용 규칙에 걸리지 않는다", "바뀐 파일이 전부 문서 파일이면 docs로 본다", "바뀐 파일이 전부 새 파일이면 feat로 본다", "바뀐 파일이 전부 테스트 파일이면 test로 본다", "바로 주문 시나리오(R11.2) 테스트를 더했습니다.\n\n자세한 내용…", "방송 시청 화면(/live/[id])을 직접 열어 보니 고칠 곳이 있습니다. 1280x720 창 기준으로 봤습니다.", "보고합니다", "보장이 없습니다", "부탁 어미를 뗀 뒤 \"R26의 백엔드 부분을\"처럼 목적격 조사로 끝나는 명사구만 남아도 요청 글을 제목으로 쓰지 않는다(도그푸딩 버그 리포트)", "부탁 어미를 뗀 뒤 \"이걸\"처럼 짧은 대명사+조사만 남아도 요청 글을 제목으로 쓰지 않는다", "부탁하는 말투를 커밋 문체로 바꾸고, 모르는 끝맺음은 그대로 둔다", "빈 요청은 \"체크포인트\"로 대신한다", "상황 설명 첫 문장이고 에이전트 요약도 없으면 요청의 요구사항 id와 바뀐 파일의 공통 모듈로 제목을 만든다", "세 번째로", "세 번째로 갑니다. sampleParams 키는 지원됩니다. R11.2 테스트만 더해 주세요.", "숏폼 코드를 저장소 최상위 media/로 옮겨 주세요(R32). 결정: media/는 Gradle 하위 프로젝트입니다.", "숏폼 피드 API에 커서 기반 페이지네이션과 다음 영상 미리 불러오기 힌트를 더했습니다.", "숏폼 피드에서 변환된 영상이 실제로 재생되게 한다(R26 재생)", "숏폼 피드에서 변환된 영상이 실제로 재생되게 해 주세요(R26 재생)", "시드 id 시퀀스 검증", "실패합니다", "앞 실행", "앞 실행이 네트워크 오류로 끊겨, 그 실행이 고친 apps/web/next.config.ts를 보관본에서 되살려 두었습니다. 이어서 마무리해 주세요.", "앞 실행이 턴 상한에 걸려 변경이 모두 되돌려졌습니다. R21 작업을 이어서 해 주세요.", "앞 실행이 턴 상한에 걸려 변경이 모두 되돌려졌습니다. 범위를 줄여 다시 해 주세요. 이번에는 R22만 합니다.", "앞서 샌드박스 문제를 우회하려고 넣은 commerce/src/test/resources/mockito-extensions/org.mockito.plugins.MockMaker 파일을 지워 주세요.", "앞서 샌드박스 문제를 우회하려고 넣은 org.mockito.plugins.MockMaker 파일을 지운다", "앞의 수정(0a6f7f0)을 올린 뒤 PR #470의 CI를 다시 돌렸습니다. 이번에는 허용 목록에 넣지 말고 CI에서 실제로 돌게 고쳐 주세요. 이 두 테스트는 R23의 유일한 실제 변환 검증입니다.", "업로드와 변환을 나눈다", "업로드와 변환을 나눠 주세요", "여러 문장으로 된 요청은 첫 문장만 쓰고, 뒷 문장이 제목에 그대로 끌려오지 않는다(도그푸딩 버그 리포트)", "여러 줄 요청은 첫 줄만 쓴다", "연결 상품 조회를 피드 응답에 넣었습니다.", "완료 요약 첫 줄이 \"검토 결과…이미 완성되어 있었습니다\"처럼 경과 보고면(\"범위:\" 줄도 없으면) 제목 후보에서 빼고 요구사항 id와 공통 모듈로 제목을 만든다(실측: 세션 5b640fd3, 체크포인트 15ba740)", "완료 요약의 과거형 서술(\"…확장했습니다\")은 상태 설명으로 보지 않는다", "요구사항 id 대체 제목은 시나리오 id를 부모로 접고 이어지는 번호를 범위로 줄인다(도그푸딩 버그 리포트: \"[R1, R3, R1.2, R2.1, …]\")", "요구사항 문서", "요약 줄이 72자 예산을 넘으면 잘라 쓰지 않고 바뀐 파일로 제목을 만든다", "요약 첫 줄의 \"결론:\"·\"현재 상태:\" 머리말 줄은 건너뛴다(도그푸딩 버그 리포트: \"fix: 결론: MediaMTX가 …\")", "요약 첫 줄이 \"마무리 확인 결과를 보고합니다.\" 같은 경과 보고면 제목으로 쓰지 않는다(도그푸딩 버그 리포트)", "요약의 마무리 인사를 제목으로 쓰지 않는다(도그푸딩 마찰 184: \"feat: Everything is consistent and complete\")", "요약이 영어 한 줄뿐이면 바뀐 파일로 만든다. 요청이 영어면 영어 요약 줄을 그대로 쓴다", "요청 글도 요약도 분명하지 않으면 바뀐 파일에서 제목을 뽑는다", "요청 글이 부탁 어미뿐이라 알맹이가 없으면(해주세요) 에이전트 요약 첫 문장으로 대신한다", "요청 글이 분명하면(알맹이가 있으면) 에이전트 요약보다 요청 글을 우선한다(AI 리뷰 고침 요청처럼 사람이 부탁한 맥락을 유지한다)", "요청 글이 에이전트의 질문에 대한 답이면 첫 문장을 제목으로 쓰지 않고 요약·요구사항 id·바뀐 파일로 넘어간다(도그푸딩 마찰 178: \"test: 세 번째로 갑니다\")", "요청 첫 문장이 \"…실패합니다\" 같은 현상 설명이면 제목으로 쓰지 않는다(도그푸딩 버그 리포트)", "요청 첫 문장이 \"앞 실행이 …\"처럼 상황 설명이면 제목 후보에서 빼고 에이전트 요약의 \"범위:\" 줄을 쓴다(실측: 세션 5b640fd3, 체크포인트 57cced6)", "요청 첫 문장이 문제를 설명하면(\"…보장이 없습니다.\") 제목으로 쓰지 않고, 요약의 머리글·문제 설명 줄도 건너뛴다(도그푸딩 버그 리포트)", "요청 첫 문장이 사람이 이미 한 일의 과거형 서술이면 제목으로 쓰지 않는다(도그푸딩 버그 리포트: \"…다시 돌렸습니다(제가 대신 했습니다)\")", "요청이 \"R25를 해 주세요.\"처럼 부탁 어미를 떼고 나면 요구사항 id+조사 조각만 남으면 에이전트 요약으로 대신한다(도그푸딩 버그 리포트: 제목이 \"feat: R25를\"이 됐다)", "의존성 버전 올리기", "이 PR을 리뷰해", "이걸 해 주세요", "이걸한다", "이어서 진행할까요?", "작업을 마쳤습니다.\n범위: shorts 숏폼 상태 머신과 V74 마이그레이션, R22 테스트를 추가했습니다.", "절 제목이 보고서의 칸 이름뿐이거나 하나뿐이면 묶지 않고 바뀐 파일로 만든다", "제목에 부탁하는 말투(\"해 주세요\")를 남기지 않는다", "제목이 예산 안이면 짧은 경로는 그대로 둔다", "주문 API를 정의해 주세요", "주문 목록 API와 주문 목록 화면을 만든다", "주문 목록 API와 주문 목록 화면을 만들어 줘.", "주문 목록 화면에 필터와 정렬, 페이지네이션과 검색창을 추가하고 모바일 화면 크기에서도 잘 보이도록 반응형으로 손보고 접근성도 함께 개선해 주세요", "주문 목록을 봐 주세요.\n- 두 번째 페이지가 안 나와요", "주문 서비스 구조 정리(리팩터링)", "주문 서비스 테스트 추가", "주문 취소 API 추가", "주문 취소 기능을 추가한다", "주문 취소 기능을 추가해 줘", "주문에 메모 필드 추가", "찾은 결함", "첫 문장이 고침을 말하면 그대로 fix로 보고, 첫 문장에 단서가 없으면 본문의 고침 낱말로 fix를 고른다", "첫 문장이 새로 만들기를 말하면, 본문이 오류 상태 화면을 설명해도 fix가 아니라 feat로 본다(도그푸딩 버그 리포트: \"fix: R26의 웹 화면을 만든다\")", "최대 턴 수(40)를 넘었습니다", "추가로", "코드에서 읽는", "턴 상한", "턴 상한에서 게이트를 통과해 남긴 체크포인트는 플랫폼의 종료 안내를 제목으로 쓰지 않는다(실측: 세션 5b640fd3, 체크포인트 516fe67)", "턴 수", "테스트 힙을 줄여 주세요.", "테스트 힙을 줄인다", "테스트·문서·새 파일이 아니면 요청 글의 낱말로 fix·refactor·chore를 고르고, 없으면 feat로 둔다", "프런트 테스트", "해 주세요", "해주세요", "확인해 보니", "확인해 보니 이미 구현이 끝나 있었고, 추가로 고칠 것이 없어 검증만 진행했습니다.", "회차마다", "회차마다 지우기 전에 세 재생목록과 세그먼트가 있는지, 길이 합이 원본과 맞는지, 썸네일이 비어 있지 않은지, 마스터 재생목록이 있는지 확인했습니다.", "흔한 \"~어/아 주세요\" 동사도 커밋 문체로 바꾼다"];

const SPACES = [' ', ' ', ' ', ' ', '  ', '\t', ' ', '　', '﻿', ' ', '\r', '\u0085', ' '];
const FRAGMENTS = [
  '로그인 기능', '결제 화면', 'R22', 'R1.2', 'R3', 'R4', 'R5', 'R2.1', 'R25', 'R007', 'R0', 'R99999999999999999999', 'R26의 백엔드 부분', 'src/app/page.tsx', 'apps/web/lib/api.ts',
  'commerce/src/test/resources/mockito-extensions/org.mockito.plugins.MockMaker 파일', '.env.example 파일', 'a.b.c/d/e.f', '버그', '오류', '에러', '리팩터링', '리팩토링', '구조 정리',
  '구조  변경', '의존성', '업그레이드', '설정 변경', '버전 올리기', '옮기', '추가', '구현', '새로', '만들', '만든', '더해', 'add', 'fix', 'error', 'refactor', 'create', 'implement', 'chore',
  'Dependency', 'DEVDEPENDENCY', 'FIX', 'Refactor', '앞 실행이', '지난 요청', '직전 작업', '네트워크', '연결이 끊', '연결 끊', '세션이 끊', '턴 상한', '최대 턴 수(40)', '토큰 상한', '타임아웃',
  'Timeout', 'rate limit', 'Rate  Limit', '레이트 리밋', '되돌려지', '롤백되', '검토 결과', '확인 결과', '확인해 보니', '돌아보니', '살펴보니', '이미 완성되어 있었습니다', '이미 ',
  '있었', '추가로 만들 것이 없어', '추가로 할 것이 없', '보고합니다', '보고드립니다', '결과를 알려', '완료 요약', '이것', '그걸', '화면', '데이터', '안 돼', '안 나와', '깨지', '실패하', '수정해',
  '고치', '고쳐', '\u{1F600}', '\u{1F9D1}‍\u{1F4BB}', 'ſ', 'K', 'ſrc', 'Kotlin', 'İ', 'ı', 'ß', 'ﬁx', 'ǅ', 'bug', 'ERROR', '한글', '가', '힣', 'abc/def/ghi.ts', 'a/b/c/d/e.kt',
];
const ENDINGS = [
  '만들어 주세요.', '만들어 줘', '고쳐 주세요', '바꿔 줘', '써 주세요', '넣어 줘', '보여 줘', '없애 줘', '지워 줘', '옮겨 줘(R32)', '옮겨 주세요 (R32)', '나눠 줘', '붙여 줘', '맞춰 줘', '줄여 줘',
  '늘려 줘', '올려 줘', '남겨 줘', '돌려 줘', '적어 줘', '막아 줘', '추가 해 주세요', '재생되게 해 주세요', '재 주세요', '구현해 주세요', '해 주세요', '해주세요', '주세요', '부탁드립니다',
  '부탁합니다', '부탁', '주시기 바랍니다', '바랍니다', '합니다.', '했습니다.', '했습니다(제가 대신 했습니다).', '없습니다.', '입니다', '됩니다', '않습니다', '있습니다', '죽습니다', '안 돼요',
  '있어요', '없어요', '?', '？', '.', '!', '를', '을', '이걸 해 주세요', 'R25를 해 주세요', '이 해 주세요', '해줘', '줘', '다', '함', '기', '했다', '한다', '(R1)', '。',
];
const BULLETS = ['- ', '* ', '', '', '  - ', '1. '];

function fragment(rng: Rng): string {
  return pick(rng, FRAGMENTS);
}
function join(rng: Rng, parts: string[]): string {
  return parts.reduce((acc, part, i) => (i === 0 ? part : acc + pick(rng, SPACES) + part), '');
}
function sentence(rng: Rng): string {
  const n = int(rng, 1, 4);
  const parts = Array.from({ length: n }, () => fragment(rng));
  return join(rng, parts) + (chance(rng, 0.85) ? pick(rng, SPACES) : '') + pick(rng, ENDINGS);
}
function mutate(rng: Rng, s: string): string {
  const kind = int(rng, 0, 5);
  if (kind === 0) return s.replace(/ /, pick(rng, SPACES));
  if (kind === 1) return s + pick(rng, ENDINGS);
  if (kind === 2) return fragment(rng) + pick(rng, SPACES) + s;
  if (kind === 3) return s.replace(/\n/g, pick(rng, ['\r\n', '\n\n', ' ', '\r']));
  if (kind === 4) return s.slice(0, Math.max(0, int(rng, 0, s.length)));
  return s.toUpperCase();
}
function fromCorpus(rng: Rng): string {
  const s = pick(rng, CORPUS);
  return chance(rng, 0.3) ? mutate(rng, s) : s;
}

function request(rng: Rng): string {
  const kind = int(rng, 0, 12);
  if (kind <= 3) return sentence(rng);
  if (kind === 4) return `${sentence(rng)}${pick(rng, ['. ', '.\n', '! ', '? ', '。 ', '. '])}${sentence(rng)}`;
  if (kind === 5) return fromCorpus(rng);
  if (kind === 6) return `${sentence(rng)}\n${pick(rng, BULLETS)}${sentence(rng)}`;
  if (kind === 7) return legacy.buildPrReviewFixRequest(reviewFindings(rng));
  if (kind === 8) return pick(rng, ['', ' ', '\n', '  \n  x', '해주세요', '해 주세요.', ' ', 'R25를 해 주세요.', '이걸 해 주세요', '[b-studio AI 리뷰] x', '[b-studio AI 리뷰] **a** **b**']);
  if (kind === 9) return mutate(rng, sentence(rng));
  if (kind === 10) return `${sentence(rng)}. ${fragment(rng)}.${pick(rng, SPACES)}${sentence(rng)}`;
  return join(rng, [fragment(rng), fragment(rng), pick(rng, ENDINGS)]);
}

function reviewFindings(rng: Rng) {
  return Array.from({ length: int(rng, 0, 4) }, () => ({
    severity: pick(rng, ['blocker', 'major', 'minor', 'nit'] as const),
    file: pick(rng, ['a.ts', 'src/b.ts']),
    ...(chance(rng, 0.5) ? { line: int(rng, 1, 99) } : {}),
    title: pick(rng, ['널 처리 누락', '**굵은** 제목', ' 공백 제목 ', fragment(rng), 'x', '']),
    detail: 'd',
    ...(chance(rng, 0.3) ? { suggestion: 's' } : {}),
  }));
}

const SUMMARY_LINES = ['## 요약', '## 완료 요약', '## Summary', '# 변경 내용', '## 변경 사항', '##한 일', '## 완료', '#### 요약  ', '### 한 일', '##', '# summary'];
const LABELS = ['고친 내용', '레이아웃/시각 수정', '로그인 UX', '방송 제목 표시', '검증 방법', '검증', '남은 한계', '요약', 'summary', 'Notes', 'Layout', '결과', '파일', '내용', '고친 것', '바뀐 것', '한 일', '주문 흐름', '결제 화면', '다음 단계', 'x'];
function summaryLine(rng: Rng): string {
  const kind = int(rng, 0, 15);
  if (kind === 0) return pick(rng, SUMMARY_LINES);
  if (kind === 1) return `**${pick(rng, LABELS)}**`;
  if (kind === 2) return `**${pick(rng, LABELS)}** (a.tsx, b.css)`;
  if (kind === 3) return `**${pick(rng, LABELS)}**${pick(rng, [':', '：', ': ', ' :'])}`;
  if (kind === 4) return `${pick(rng, BULLETS)}**${pick(rng, LABELS)}**${pick(rng, ['', ' (x)', ':'])}`;
  if (kind === 5) return `${pick(rng, ['범위', 'Scope', 'scope', 'SCOPE', '범위 ', 'ſcope'])}${pick(rng, [':', '：', ': ', ' : '])}${sentence(rng)}`;
  if (kind === 6) return `${pick(rng, ['찾은 결함', '결함', '원인', '문제', '현상', '참고', '배경', '결론', '요약', '현재 상태', '찾은결함'])}${pick(rng, [':', '：'])} ${sentence(rng)}`;
  if (kind === 7) return pick(rng, ['Everything is consistent and complete.', 'All changes verified: tests pass', 'Added the login form.', 'Fix the bug in checkout', '']);
  if (kind === 8) return `${pick(rng, BULLETS)}${pick(rng, ['`', '**', ''])}${sentence(rng)}`;
  if (kind === 9) return fromCorpus(rng);
  return sentence(rng);
}
function agentSummary(rng: Rng): string | undefined {
  const kind = int(rng, 0, 9);
  if (kind === 0) return undefined;
  if (kind === 1) return '';
  const lines = Array.from({ length: int(rng, 1, 7) }, () => summaryLine(rng));
  return lines.join(pick(rng, ['\n', '\n', '\n\n', '\r\n']));
}

const SEGMENTS = ['src', 'main', 'test', 'tests', '__tests__', 'spec', 'java', 'kotlin', 'com', 'app', 'apps', 'lib', 'packages', 'web', 'api', 'components', 'pages', 'shorts', 'orders', 'commerce', 'billing', 'SRC', 'Tests', 'Kotlin', 'ſrc', 'Kotlin', 'docs', 'migrations', 'migration', 'resources', 'x', '한글', '', 'node_modules', 'Main'];
const NAMES = ['a.ts', 'page.tsx', 'Order.java', 'OrderTest.java', 'order.test.ts', 'a.spec.js', 'b.test.mjs', 'c.TEST.CJS', 'x.test.tsx', 'test_orders.py', 'orders_test.py', 'README.md', 'readme.md', 'Readme.rst.md', 'CHANGELOG.md', 'changelog.md', 'guide.md', 'guide.mdx', 'requirements.md', '.env.example', '.env.sample', '.ENV.EXAMPLE', 'Dockerfile', 'noext', '.hidden', 'a.b.c', 'MockMaker', 'org.mockito.plugins.MockMaker', 'x.', '', 'build.gradle', 'T.kt', 'FooTest.kt', 'readme.Koo.md', 'ſpec.ts', 'a.test.ſx', 'README.MD'];
function filePath(rng: Rng): string {
  const depth = int(rng, 0, 5);
  const segs = Array.from({ length: depth }, () => pick(rng, SEGMENTS));
  if (chance(rng, 0.25)) {
    // 테스트·문서 규칙을 정확히 겨눈 경로
    const special = pick(rng, [
      ['src', 'test', 'java'], ['src', 'test', 'kotlin'], ['SRC', 'TEST', 'JAVA'], ['__tests__'], ['tests'], ['test'], ['docs'], ['Docs'], ['x', 'docs'], ['src', 'test', 'scala'], ['ſrc', 'test', 'java'],
    ]);
    segs.push(...special, ...(chance(rng, 0.5) ? [pick(rng, SEGMENTS)] : []));
  }
  return [...segs, pick(rng, NAMES)].join(chance(rng, 0.03) ? '\\' : '/');
}
function changes(rng: Rng): PendingChange[] {
  const n = chance(rng, 0.08) ? 0 : int(rng, 1, 6);
  const mode = int(rng, 0, 9);
  const base = Array.from({ length: n }, (): PendingChange => ({ file: filePath(rng), change: pick(rng, ['added', 'modified', 'deleted'] as const) }));
  if (mode === 0) return base.map((c) => ({ ...c, change: 'added' as const }));
  if (mode === 1) return base.map((c) => ({ ...c, change: 'deleted' as const }));
  if (mode === 2) return base.map((c) => ({ file: `${pick(rng, ['a', 'b'])}/${pick(rng, ['tests', '__tests__'])}/${pick(rng, ['x.test.ts', 'y.py', 'z.spec.js'])}`, change: c.change }));
  if (mode === 3) return base.map((c) => ({ file: `${pick(rng, ['docs', 'doc'])}/${pick(rng, ['a.md', 'b.mdx', 'README.md'])}`, change: c.change }));
  if (mode === 4) {
    // 같은 모듈 폴더가 절반 안팎(올림 경계)
    const module = pick(rng, ['shorts', 'orders', 'billing']);
    return base.map((c, i) => ({ file: i % 2 === 0 ? `commerce/${module}/${pick(rng, NAMES)}` : filePath(rng), change: c.change }));
  }
  return base;
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
}
const tallies = new Map<string, Tally>();
function tally(name: string): Tally {
  let t = tallies.get(name);
  if (!t) tallies.set(name, (t = { compared: 0, different: 0, distribution: new Map(), examples: [] }));
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
    if (t.examples.length < 3) t.examples.push(`${JSON.stringify(input).slice(0, 400)}\n  옛: ${left.slice(0, 200)}\n  새: ${right.slice(0, 200)}`);
  }
}

function subjectBucket(result: string): string {
  if (result.includes('리뷰 지적')) return '리뷰 고침';
  if (result.includes('체크포인트')) return '체크포인트';
  if (result.includes('모듈을')) return '요구사항+모듈';
  if (/(를|을) (고친다|더한다|지운다)/.test(result)) return '파일 이름';
  return '요청·요약 문장·절 제목';
}

const SEEDS = (process.env.COMMIT_MESSAGE_DIFF_SEEDS ?? '1,7,42,2026').split(',').map(Number);
const ITERATIONS = Number(process.env.COMMIT_MESSAGE_DIFF_ITERATIONS ?? 4000);
const REPORT = process.env.COMMIT_MESSAGE_DIFF_REPORT === '1';
/** 분포 출력. 환경 변수 COMMIT_MESSAGE_DIFF_REPORT_FILE이 있으면 그 파일에 덧붙인다(vitest가 통과한 시험의 출력을 숨긴다) */
function report(line: string): void {
  const file = process.env.COMMIT_MESSAGE_DIFF_REPORT_FILE;
  if (file) appendFileSync(file, `${line}\n`);
  else console.log(line);
}

function runSeed(seed: number): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < ITERATIONS; i++) {
    const req = request(rng);
    const cs = changes(rng);
    const summary = agentSummary(rng);
    const options = chance(rng, 0.15) ? { requestIsAnswer: true } : chance(rng, 0.2) ? { requestIsAnswer: false } : undefined;

    compare('classifyCommit', { req, cs }, () => legacy.classifyCommit(req, cs), () => classifyCommit(req, cs), (r) => r);
    compare('generateCommitSubject', { req, cs, summary, options }, () => legacy.generateCommitSubject(req, cs, summary, options), () => generateCommitSubject(req, cs, summary, options), subjectBucket);
    // 같은 입력으로 요약 없이, 요청 글이 한 줄일 때도(요약 경로·요청 경로를 따로 겨눈다)
    const oneLine = req.split('\n')[0]!;
    compare('generateCommitSubject(한 줄)', { oneLine, cs }, () => legacy.generateCommitSubject(oneLine, cs), () => generateCommitSubject(oneLine, cs), subjectBucket);
    const blank = pick(rng, ['', '해 주세요', '해주세요.', '앞 실행이 턴 상한에 걸려 되돌려졌습니다.', '이걸 해 주세요', 'R25를 해 주세요.', fragment(rng)]);
    compare('generateCommitSubject(요약 경로)', { blank, cs, summary }, () => legacy.generateCommitSubject(blank, cs, summary), () => generateCommitSubject(blank, cs, summary), subjectBucket);

    // summarize: 상한 경계, 공백 위치가 절반인 경계
    const textIn = chance(rng, 0.5) ? sentence(rng) + ' ' + sentence(rng) : fromCorpus(rng);
    const trimmed = textIn.trim();
    const space = trimmed.lastIndexOf(' ');
    const maxChars = pick(rng, [
      trimmed.length, trimmed.length - 1, trimmed.length + 1, Math.floor(trimmed.length / 2), int(rng, 0, 80), 72, 120, 66, 68,
      2 * Math.max(space, 0), 2 * Math.max(space, 0) + 1, 2 * Math.max(space, 0) - 1, 2 * Math.max(space, 0) + 2,
      NaN, -1, 0.5, 7.5, Infinity, -Infinity, 1,
    ]);
    compare('summarize', { textIn, maxChars }, () => legacy.summarize(textIn, maxChars), () => summarize(textIn, maxChars), (r) => (r === 'ok:"체크포인트"' ? '체크포인트' : r.length - 5 < trimmed.length ? '잘림' : '그대로'));
    compare('toCommitMood', req, () => legacy.toCommitMood(req), () => toCommitMood(req), (r) => (r === `ok:${JSON.stringify(req.replace(/[.!?。]+$/, '').trim())}` ? '그대로' : '바뀜'));
  }
}

describe('commit-message 차등 시험(옛 TS와 Rust 껍데기)', () => {
  for (const seed of SEEDS) {
    it(`시드 ${seed}: ${ITERATIONS}회 × 함수 4개(제목은 세 경로)가 옛 TS와 같다`, () => {
      runSeed(seed);
    }, 600_000);
  }

  it('모든 함수에서 다른 결과가 0이다', () => {
    if (REPORT) {
      for (const [name, t] of tallies) report(`${name}: 비교 ${t.compared}, 다름 ${t.different}, 분포 ${JSON.stringify(Object.fromEntries(t.distribution))}`);
    }
    const bad = [...tallies].filter(([, t]) => t.different > 0).map(([name, t]) => `${name}: ${t.different}건\n${t.examples.join('\n')}`);
    expect(bad).toEqual([]);
    expect(tallies.size).toBe(6);
  });

  it('결과 분포가 한쪽으로 쏠리지 않았다(함수마다 두 갈래 이상, 제목은 여러 경로)', () => {
    const lopsided = [...tallies].filter(([, t]) => t.compared >= 1000 && t.distribution.size < 2).map(([name]) => name);
    expect(lopsided).toEqual([]);
    expect(tally('classifyCommit').distribution.size).toBe(6);
    for (const name of ['generateCommitSubject', 'generateCommitSubject(요약 경로)']) expect(tally(name).distribution.size).toBeGreaterThanOrEqual(4);
  });

  it('대조 장치: 새 결과의 한 글자만 바꿔도 차이로 잡힌다', () => {
    const t = tally('대조');
    const base = legacy.generateCommitSubject('로그인 기능을 만들어 주세요.', [{ file: 'a.ts', change: 'added' }]);
    compare('대조', base, () => base, () => base.replace('기능', '기눙'), () => '글');
    compare('대조', base, () => base, () => `${base} `, () => '글');
    compare('대조', base, () => base, () => base, () => '글');
    expect(t.different).toBe(2);
    tallies.delete('대조');
  });
});
