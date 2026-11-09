import { native } from '@b-studio/sandbox';
import type { PendingChange } from './checkpoints';

/**
 * 체크포인트 커밋 제목 만들기(ADR-080). 모델을 부르지 않고 경로·낱말만 본다. 판정은 Rust(crates/bstudio-guard/src/commit_message.rs,
 * ADR-191 3단계)가 하고, 이 파일은 같은 이름·시그니처의 껍데기다. 제목을 고르는 순서와 낱말 규칙은 Rust 파일의 주석에 있다.
 */

/** 제목 맨 앞에 붙는 conventional commit 타입 (ADR-080). git 로그에 실제로 쓰는 이름만 받는다 */
export type CommitType = 'feat' | 'fix' | 'test' | 'docs' | 'refactor' | 'chore';

/** 바뀐 파일 목록을 Rust로 넘길 두 배열(같은 순서)로 나눈다 */
function splitChanges(changes: readonly PendingChange[]): [string[], string[]] {
  return [changes.map((change) => change.file), changes.map((change) => change.change)];
}

/**
 * 요청 글과 바뀐 파일에서 conventional commit 타입을 고른다. 모델을 부르지 않고 경로·낱말만 본다(ADR-080).
 * 우선순위: 테스트 파일만 바뀌었으면 test, 문서 파일만이면 docs, 새 파일뿐이면 feat,
 * 그 외에는 요청 첫 문장에서 고침(fix)·새로 만들기(feat) 낱말을 먼저 찾고, 없으면 요청 글 전체의 낱말로
 * fix·refactor·chore를 찾고, 그래도 없으면 feat로 둔다.
 */
export function classifyCommit(request: string, changes: readonly PendingChange[]): CommitType {
  const [files, kinds] = splitChanges(changes);
  return native.classifyCommit(request, files, kinds) as CommitType;
}

export interface CommitSubjectOptions {
  /** 요청 글이 에이전트의 질문에 대한 답이다. 답의 첫 문장은 제목으로 쓰지 않는다 */
  requestIsAnswer?: boolean;
}

/**
 * 후보 글을 남은 글자 수에 맞춰 자른다. 단어 경계에서 끊고, 비어 있으면 "체크포인트"로 대신한다.
 * 체크포인트 제목(generateCommitSubject)뿐 아니라 PR 제목(repository.ts의 buildPullRequest, ADR-110)도
 * "가장 중요한 커밋 제목을 요약"할 때 이 함수를 그대로 재사용한다 — 단어 중간을 자르지 않는 규칙을 두 곳에서
 * 따로 구현하지 않는다(버그 리포트: PR 제목을 120자에서 그냥 slice해 단어 중간이 잘렸다).
 */
export function summarize(text: string, maxChars: number): string {
  return native.summarizeCommitText(text, maxChars);
}

/**
 * 요청 글과 바뀐 파일, (있으면) 에이전트 요약에서 체크포인트 커밋 제목을 만든다(ADR-080). "타입: 한국어 요약"
 * 형식이고 72자를 넘지 않는다. 제목은 "무엇이 요청됐는지"가 아니라 "무엇이 바뀌었는지"를 말해야 하므로, 이 순서로 고른다:
 *  0. AI 리뷰 고침 요청이면 지적 제목들로 만든다(과제 66).
 *  1. 요청 글 첫 문장이 "무엇이 바뀌었는지" 분명하면 그것을 쓴다. 단, 앞 실행·인프라 같은 상황 설명이면 다음 단계로 넘어간다.
 *  2. 요청 글에 알맹이가 없으면 에이전트 요약에서 고른 줄이 분명할 때 그것으로 대신한다.
 *  3. 그래도 분명하지 않으면 요구사항 id(R22 등)와 바뀐 파일의 공통 모듈 이름으로 "[R22] shorts 모듈을 고친다"처럼 만든다.
 *  4. 그래도 안 되면 에이전트 요약의 절 제목들을 묶어 쓰고, 그것도 없으면 바뀐 파일 이름에서 뽑는다.
 *  5. 요청 글마저 비어 있으면(데이터만 바뀐 체크포인트 등) "체크포인트"로 둔다.
 * studio.yaml의 checkpoints.conventionalCommits를 껐을 때는 부르지 않고 기존 "요청: ..." 형식을 그대로 쓴다.
 * 요청 글이 에이전트의 질문에 대한 답이면(options.requestIsAnswer) 1번을 건너뛴다.
 */
export function generateCommitSubject(request: string, changes: readonly PendingChange[], agentSummary?: string, options: CommitSubjectOptions = {}): string {
  const [files, kinds] = splitChanges(changes);
  return native.generateCommitSubject(request, files, kinds, agentSummary, Boolean(options.requestIsAnswer));
}

/** 부탁하는 말투("만들어 줘.")를 커밋 문체("만든다")로 바꾼다. 흔한 끝맺음만 바꾸고, 모르는 끝맺음은 그대로 둔다 */
export function toCommitMood(text: string): string {
  return native.toCommitMood(text);
}
