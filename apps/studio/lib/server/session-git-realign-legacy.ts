/**
 * 옛 Git 맞추기·기억·되돌리기 조합 판정(B5d 앞의 `sessions.ts`의 `realignGit`·`rememberGit`·`initialGitMemory`·`revertRunDetailed`·`commitLocalEdits`에서 판정만 그대로 떼어 둔 것).
 * 차등 시험(`session-git-realign.test.ts`)의 기준이다. 4g에서 지운다. 운영 코드는 부르지 않는다.
 */

export interface LegacyRemembered {
  branch: string;
  lastCheckpoint: string;
}

export interface LegacyState {
  head: string;
  branch: string | undefined;
}

export type LegacyRealign = { kind: 'same' } | { kind: 'unwind' } | { kind: 'restore'; which: string };

/** `realignGit`의 판정 부분. `ancestor`는 조상 읽기의 결과(옛 코드는 같은 브랜치일 때만 읽었다) */
export function legacyRealign(remembered: LegacyRemembered, state: LegacyState, ancestor: boolean, allowUnwind: boolean): LegacyRealign {
  if (state.head === remembered.lastCheckpoint && state.branch === remembered.branch) return { kind: 'same' };
  const sameBranch = state.branch === remembered.branch;
  const aheadOnSameBranch = sameBranch && ancestor;
  if (allowUnwind && aheadOnSameBranch) return { kind: 'unwind' };
  const which = !sameBranch
    ? state.branch === undefined
      ? 'HEAD가 브랜치가 아니라 커밋을 가리킴'
      : `브랜치가 ${state.branch}(으)로 바뀜`
    : aheadOnSameBranch
      ? '기록에 b-studio가 만들지 않은 커밋이 있음'
      : '기록이 b-studio의 체크포인트보다 뒤로 되감기거나 고쳐짐';
  return { kind: 'restore', which };
}

/** `rememberGit`의 판정 부분 */
export function legacyRemember(state: LegacyState, created: string | undefined): LegacyRemembered | undefined {
  if (!state.head || !state.branch) return undefined;
  return { branch: state.branch, lastCheckpoint: created ?? state.head };
}

/** `initialGitMemory`의 판정 부분. 원격 주소를 읽지 못하면(`undefined`) 원격 없음으로 기억했다 */
export function legacyInitialMemory(state: LegacyState, originUrl: string | undefined): (LegacyRemembered & { originUrl?: string }) | undefined {
  if (!state.head || !state.branch) return undefined;
  return { branch: state.branch, lastCheckpoint: state.head, ...(originUrl ? { originUrl } : {}) };
}

export type LegacyAligned = 'same' | 'unwound' | 'restored' | 'unrestorable';

/** `revertRunDetailed`의 순서 판정: 맞추기 결과 → 문서 지키기·버리기 */
export function legacyRevertPlan(aligned: LegacyAligned): { kind: 'fail' } | { kind: 'already_restored' } | { kind: 'discard'; protectDocs: boolean } {
  if (aligned === 'unrestorable') return { kind: 'fail' };
  if (aligned === 'restored') return { kind: 'already_restored' };
  return { kind: 'discard', protectDocs: true };
}

/** 되돌린 뒤 기억(옛 코드: 문서 체크포인트가 있으면 그것, 없고 컨테이너 방식이면 다시 읽기, 이 컴퓨터 방식이면 그대로) */
export function legacyRememberAfterRevert(docsCheckpoint: boolean, untrustedGit: boolean): 'docs_checkpoint' | 'reread' | 'keep' {
  if (docsCheckpoint) return 'docs_checkpoint';
  return untrustedGit ? 'keep' : 'reread';
}

/** 되돌린 뒤 남은 일(옛 코드의 조기 반환과 `hostOnly` 갈래) */
export function legacyRevertTail(filesEmpty: boolean, databaseTouched: boolean, alsoRestartEmpty: boolean, hostOnly: boolean): 'nothing' | 'host_only_report' | 'restart_services' {
  if (filesEmpty && !databaseTouched && alsoRestartEmpty) return 'nothing';
  return hostOnly ? 'host_only_report' : 'restart_services';
}

/** `commitLocalEdits`의 가르기: 바뀐 파일 전부를 직접 수정으로 커밋했다 */
export function legacySplitLocalEdits(pending: readonly string[]): { human: string[]; agent: string[] } {
  return { human: [...pending], agent: [] };
}
