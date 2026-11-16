import { native } from '@b-studio/sandbox';
import type { SessionSnapshot } from '../studio-events';
import { StudioError } from './errors';
import { isProcessAlive } from './session-store';

/**
 * 세션을 지우고 복구하고 이어받는 판정(ADR-204, 4f B2a). 판정은 Rust `crates/bstudio-session`의 `lifecycle`이 하고, 여기는 그 결과를 `StudioError`로 바꾸는 껍데기다.
 * 옛 TS 판정은 `session-lifecycle-legacy.ts`에 차등 시험의 기준으로만 남아 있다.
 *
 * 세션의 `home`은 세션을 실제로 만든 폴더(`startSession`의 `sessionDir`) 또는 읽어 온 폴더(`readStoredSessions`의 `home`)다.
 * 저장 파일의 `workDir`·`stateDir` 글자는 믿지 않는다: 지울 폴더도, 이어받을 작업 폴더도 `home`과 같은지 먼저 본다.
 */

type SnapshotPaths = Pick<SessionSnapshot, 'workDir' | 'stateDir' | 'workspace' | 'status' | 'id'>;

function fail(result: { status: number; message: string } | null): void {
  if (result) throw new StudioError(result.status, result.message);
}

/** 지우기 전의 판정(디스크를 바꾸지 않는다). 거절하면 `StudioError` */
export function assertDeletable(root: string, home: string, snapshot: SnapshotPaths): void {
  fail(
    native.deleteSessionCheck({
      status: String(snapshot.status),
      workspace: snapshot.workspace ?? undefined,
      root,
      home,
      sessionId: snapshot.id,
      workDir: snapshot.workDir,
      stateDir: snapshot.stateDir ?? undefined,
    }),
  );
}

/**
 * 세션 폴더(`home`)를 지운다. 지우기 직전에 Rust가 다시 확인한다(루트 바로 아래의 `<프로젝트>-<id>` 폴더, 링크가 아님, 내 폴더 세션이면 사용자 폴더가 그 안이 아님).
 * 확인하지 못하면 지우지 않고 던진다. 내 폴더 세션의 사용자 폴더(`workDir`)는 지우지 않는다
 */
export async function removeSessionHome(root: string, home: string, snapshot: SnapshotPaths): Promise<void> {
  fail(await native.removeSessionHome(root, home, snapshot.id, snapshot.workspace === 'local' ? snapshot.workDir : null));
}

/** 이어받기 전의 판정: 저장 파일이 가리키는 폴더가 세션을 읽어 온 폴더여야 한다. 거절하면 409 */
export function assertResumableHome(home: string, snapshot: Pick<SessionSnapshot, 'workDir' | 'stateDir' | 'workspace'>): void {
  fail(native.resumeSessionCheck(home, snapshot.workspace ?? null, snapshot.workDir, snapshot.stateDir ?? null));
}

export interface RecoveryPlan {
  skip: boolean;
  interrupted: boolean;
  cleanupTerminal: boolean;
  sandboxIdOk: boolean;
}

/** 복구할 때 세션 하나를 어떻게 할지. 주인 프로세스가 살아 있는지는 이 프로세스가 보고 Rust에 넘긴다 */
export function planRecovery(status: string, ownerPid: number, sandboxId: string): RecoveryPlan {
  return native.recoverSessionPlan(String(status), ownerPid, process.pid, isProcessAlive(ownerPid), sandboxId);
}
