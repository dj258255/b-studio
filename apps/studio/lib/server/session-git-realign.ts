import { native } from '@b-studio/sandbox';

/**
 * Git 맞추기·기억·되돌리기 조합·직접 수정 가르기(ADR-218, 4f B5d). 판정은 Rust `crates/bstudio-session`의 `git_realign`이 한다(순수 함수).
 * 여기는 사실을 코어에 넘기고 결정을 TS 값으로 돌려주는 껍데기다. Git 읽기·행동(`reset`·`checkout`·`commit`)과 알림·글 조립은 `sessions.ts`가 한다.
 * 옛 판정은 `session-git-realign-legacy.ts`에 차등 시험의 기준으로만 남아 있다. 모르는 결정은 닫는 쪽이다(되돌린다·되돌리지 못한 것으로 본다).
 */

export type RestoreReason = 'detached' | 'branch_changed' | 'foreign_commits' | 'rewound' | 'moved_during_action';

export interface RealignFacts {
  rememberedHead: string;
  rememberedBranch: string;
  head: string;
  /** 분리된 HEAD면 없다 */
  branch: string | undefined;
  /** 기억한 체크포인트가 지금 HEAD의 조상인가. 아직 읽지 않았으면 없다 */
  ancestor?: boolean;
  allowUnwind: boolean;
}

export type RealignStep = { kind: 'need_ancestor' } | { kind: 'same' } | { kind: 'unwind' } | { kind: 'restore'; reason: RestoreReason };

const REASONS: readonly RestoreReason[] = ['detached', 'branch_changed', 'foreign_commits', 'rewound', 'moved_during_action'];

/** 맞추기 판정: 같음 → (조상 읽기) → 풀기 또는 되돌리기. 알아보지 못한 결정은 되돌리는 쪽이다 */
export function decideRealign(facts: RealignFacts): RealignStep {
  const step = native.gitDecideRealign({
    rememberedHead: facts.rememberedHead,
    rememberedBranch: facts.rememberedBranch,
    head: facts.head,
    // 분리된 HEAD(브랜치 없음)·읽지 않은 조상은 키를 싣지 않는다(napi 구조체의 `Option`은 null을 받지 않는다)
    ...(facts.branch === undefined ? {} : { branch: facts.branch }),
    // 읽지 않았으면 키를 싣지 않는다(napi의 `Option<bool>`은 null을 받지 않는다)
    ...(facts.ancestor === undefined ? {} : { ancestor: facts.ancestor }),
    allowUnwind: facts.allowUnwind,
  });
  switch (step.kind) {
    case 'need_ancestor':
    case 'same':
    case 'unwind':
      return { kind: step.kind };
    case 'restore': {
      const reason = REASONS.find((candidate) => candidate === step.reason);
      return { kind: 'restore', reason: reason ?? 'rewound' };
    }
    default:
      return { kind: 'restore', reason: 'rewound' };
  }
}

/** 되돌리는 까닭을 사람이 읽을 글로 쓴다. 브랜치가 바뀌었으면 지금 브랜치를 적는다 */
export function describeRestoreReason(reason: RestoreReason, branch: string | undefined): string {
  switch (reason) {
    case 'detached':
      return 'HEAD가 브랜치가 아니라 커밋을 가리킴';
    case 'branch_changed':
      return `브랜치가 ${branch ?? ''}(으)로 바뀜`;
    case 'foreign_commits':
      return '기록에 b-studio가 만들지 않은 커밋이 있음';
    case 'moved_during_action':
      return '맞추는 동안 작업 복사본의 Git 기록이 또 바뀜';
    default:
      return '기록이 b-studio의 체크포인트보다 뒤로 되감기거나 고쳐짐';
  }
}

/** 풀거나 되돌린 뒤 **다시 읽은** 끝 상태가 기억과 같은가. 읽지 못했으면(`undefined`) 같지 않다 */
export function alignedAfterAction(remembered: { branch: string; lastCheckpoint: string }, read: { head: string; branch: string | undefined } | undefined): boolean {
  return native.gitAfterActionAligned(remembered.lastCheckpoint, remembered.branch, read !== undefined, read?.head ?? null, read?.branch ?? null);
}

export interface GitMemoryValue {
  branch: string;
  lastCheckpoint: string;
  originUrl?: string;
}

/** b-studio가 HEAD를 움직인 자리에서 기억할 값. `created`가 있으면 그 커밋(만든 것·복원 대상)이고 지금 HEAD를 다시 읽은 값이 아니다. 모르면 없다 */
export function decideRemember(read: { head: string; branch: string | undefined } | undefined, created: string | undefined): GitMemoryValue | undefined {
  if (!read) return undefined;
  const memory = native.gitDecideRemember(read.head, read.branch ?? null, created ?? null);
  return memory ? { branch: memory.branch, lastCheckpoint: memory.lastCheckpoint } : undefined;
}

export type OriginRead = { kind: 'none' } | { kind: 'url'; url: string } | { kind: 'failed' };

/** 처음 기억할 값. 머리·브랜치·원격 주소 중 모르는 것이 있으면 기억하지 않는다 */
export function decideInitialMemory(read: { head: string; branch: string | undefined } | undefined, origin: OriginRead): GitMemoryValue | undefined {
  if (!read) return undefined;
  const memory = native.gitDecideInitialMemory(read.head, read.branch ?? null, origin.kind, origin.kind === 'url' ? origin.url : null);
  if (!memory) return undefined;
  return { branch: memory.branch, lastCheckpoint: memory.lastCheckpoint, ...(memory.originUrl ? { originUrl: memory.originUrl } : {}) };
}

export type Aligned = 'same' | 'unwound' | 'restored' | 'unrestorable';

/** 되돌리기가 먼저 맞추기를 하는가(이 컴퓨터 방식이고 기억이 있을 때) */
export function revertNeedsRealign(untrustedGit: boolean, hasMemory: boolean): boolean {
  return native.gitRevertNeedsRealign(untrustedGit, hasMemory);
}

export type RevertPlan = { kind: 'fail' } | { kind: 'already_restored' } | { kind: 'discard'; protectDocs: boolean };

/** 되돌리기의 순서: 맞추기 → 문서 지키기(읽기만 요청이면 하지 않는다) → 버리기. 알아보지 못한 결정은 되돌리지 못한 것으로 읽는다 */
export function planRevert(aligned: Aligned, readOnly: boolean): RevertPlan {
  const plan = native.gitPlanRevert(aligned, readOnly);
  if (plan.kind === 'already_restored') return { kind: 'already_restored' };
  if (plan.kind === 'discard') return { kind: 'discard', protectDocs: plan.protectDocs };
  return { kind: 'fail' };
}

export type RememberAfter = 'docs_checkpoint' | 'reread' | 'keep';

/** 되돌린 뒤 무엇을 기억하는가. 알아보지 못한 결정은 건드리지 않는다 */
export function rememberAfterRevert(docsCheckpoint: boolean, untrustedGit: boolean): RememberAfter {
  const what = native.gitRememberAfterRevert(docsCheckpoint, untrustedGit);
  return what === 'docs_checkpoint' || what === 'reread' ? what : 'keep';
}

/** DB 복원 기준점: 문서를 지키기 전의 체크포인트(ADR-018·ADR-131) */
export function dbRestoreBase(beforeProtect: string, afterProtect: string | undefined): string {
  return native.gitDbRestoreBase(beforeProtect, afterProtect ?? null);
}

export type RevertTail = 'nothing' | 'host_only_report' | 'restart_services';

/** 되돌린 뒤 남은 일. 알아보지 못한 결정은 서비스를 다시 띄우는 쪽이다 */
export function revertTail(filesEmpty: boolean, databaseTouched: boolean, alsoRestartEmpty: boolean, hostOnly: boolean): RevertTail {
  const tail = native.gitRevertTail(filesEmpty, databaseTouched, alsoRestartEmpty, hostOnly);
  return tail === 'nothing' || tail === 'host_only_report' ? tail : 'restart_services';
}

export interface LocalEditsSplit {
  /** 직접 수정으로 커밋할 파일 */
  human: string[];
  /** 변경으로 남길 파일(검증 안 된 에이전트 변경) */
  agent: string[];
  /** 지금도 바뀌어 있는 남긴 에이전트 변경 기억 */
  kept: string[];
}

/** 남긴 에이전트 변경 기억의 "모든 파일" 항목. 이름을 맞출 수 없어 모든 파일과 맞는다(닫는 쪽) */
export const KEPT_UNKNOWN = '..';

/** 바뀐 파일을 직접 수정으로 커밋할 것과 변경으로 남길 것으로 가른다. 이름은 넓게 맞춘다(대소문자·유니코드·보이지 않는 문자·링크 이름·`..`) */
export function splitLocalEdits(pending: readonly string[], kept: readonly string[]): LocalEditsSplit {
  const split = native.gitSplitLocalEdits([...pending], [...kept]);
  return { human: split.human, agent: split.agent, kept: split.kept };
}

/** 남긴 에이전트 변경 기억에 파일을 더한다 */
export function mergeKept(existing: readonly string[], added: readonly string[]): string[] {
  return native.gitMergeKept([...existing], [...added]);
}

/** 저장 파일에서 읽은 남긴 에이전트 변경 기억. 없으면(옛 파일) 없다. 모양이 틀리면 지우지 않고 "모든 파일"로 읽는다(닫는 쪽) */
export function restoreKept(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [KEPT_UNKNOWN];
  const entries = value.map((entry) => (typeof entry === 'string' ? entry : KEPT_UNKNOWN));
  return entries.length > 0 ? mergeKept([], entries) : undefined;
}
