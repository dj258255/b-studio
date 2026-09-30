import type { PendingChange } from './checkpoints';

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

/**
 * 요청 글과 바뀐 파일에서 conventional commit 타입을 고른다. 모델을 부르지 않고 경로·낱말만 본다(ADR-080).
 * 우선순위: 테스트 파일만 바뀌었으면 test, 문서 파일만이면 docs, 새 파일뿐이면 feat,
 * 그 외에는 요청 글의 낱말로 refactor·chore를 찾고 없으면 fix로 둔다(수정·삭제가 섞인 변경은 대개 고침이라서다).
 */
export function classifyCommit(request: string, changes: readonly PendingChange[]): CommitType {
  if (changes.length > 0 && changes.every((change) => TEST_FILE.test(change.file))) return 'test';
  if (changes.length > 0 && changes.every((change) => DOC_FILE.test(change.file))) return 'docs';
  if (changes.length > 0 && changes.every((change) => change.change === 'added')) return 'feat';
  if (REFACTOR_WORDS.test(request)) return 'refactor';
  if (CHORE_WORDS.test(request)) return 'chore';
  return 'fix';
}

/**
 * 요청 글과 바뀐 파일에서 체크포인트 커밋 제목을 만든다(ADR-080). "타입: 한국어 요약" 형식이고 72자를 넘지 않는다.
 * studio.yaml의 checkpoints.conventionalCommits를 껐을 때는 부르지 않고 기존 "요청: ..." 형식을 그대로 쓴다.
 */
export function generateCommitSubject(request: string, changes: readonly PendingChange[]): string {
  const type = classifyCommit(request, changes);
  const summary = summarize(request, MAX_SUBJECT_CHARS - type.length - 2);
  return `${type}: ${summary}`;
}

/** 요청 글의 첫 줄을 공백 정리하고 남은 글자 수에 맞춰 자른다. 문장 중간에서 끊기지 않게 단어 경계로 물러난다 */
function summarize(request: string, maxChars: number): string {
  const oneLine = request.split('\n')[0]!.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxChars) return oneLine || '체크포인트';
  const cut = oneLine.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.5 ? cut.slice(0, lastSpace) : cut).trim();
}
