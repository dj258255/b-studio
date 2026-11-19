import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Checkpoint } from '@b-studio/agent';
import type { StudioEvent } from '../studio-events';
import { sessionFile, stateDirOf, trimHistory, type PersistedSession } from './session-store';

/**
 * 옛 세션 저장 구현(B1b 앞의 `session-store.ts`의 `writeSession`·`writeSessionSync`·`readSessions`·`closeUnfinished`와 `sessions.ts`의 `toPersisted`의 객체 조립)을 그대로 떼어 둔 것이다.
 * 새 구현(Rust `crates/bstudio-session`의 `Persister`·`read_sessions`·`close_unfinished`)과 견주는 차등 시험의 기준으로만 쓴다. 4g에서 옛 TS를 지울 때 함께 지운다.
 * 제품 코드는 이 파일을 쓰지 않는다.
 */

/** 옛 `toPersisted`의 객체 조립. `history`는 옛 `session.record.trimmedHistory()`(= `trimHistory(전체 기록)`)다. 키 순서가 파일의 순서다 */
export function legacyToPersisted(body: Omit<PersistedSession, 'history'>, fullHistory: readonly StudioEvent[]): PersistedSession {
  return {
    version: 1,
    savedAt: body.savedAt,
    owner: body.owner,
    snapshot: body.snapshot,
    history: trimHistory(fullHistory),
    conversation: body.conversation,
    demoIndex: body.demoIndex,
    claudeCode: body.claudeCode,
    codex: body.codex,
    commandCode: body.commandCode,
    openCode: body.openCode,
    gemini: body.gemini,
    sourceDirtyFiles: body.sourceDirtyFiles,
    ...(body.agentLedger ? { agentLedger: body.agentLedger } : {}),
    ...(body.terminalConversation ? { terminalConversation: body.terminalConversation } : {}),
    sandbox: body.sandbox,
    previewToken: body.previewToken,
    git: body.git,
  };
}

/** 서버가 멈춰 끝나지 못한 요청과 되돌리기를 닫는다. 그대로 두면 다시 그린 화면이 "처리 중"에 멈춘다 */
export function legacyCloseUnfinished(history: readonly StudioEvent[], reason: string): StudioEvent[] {
  const openRuns = new Set<string>();
  let openRestore: Checkpoint | undefined;
  let openRemoteSync = false;
  let openBackupRestore: string | undefined;
  let openDeploy: Extract<StudioEvent, { type: 'deploy_started' }> | undefined;
  for (const event of history) {
    if (event.type === 'deploy_started') openDeploy = event;
    else if (event.type === 'deploy_finished' || event.type === 'deploy_failed') openDeploy = undefined;
    if (event.type === 'run_started') openRuns.add(event.runId);
    else if (event.type === 'run_finished') openRuns.delete(event.runId);
    else if (event.type === 'restore_started') openRestore = event.checkpoint;
    else if (event.type === 'restored' || event.type === 'restore_failed') openRestore = undefined;
    else if (event.type === 'backup_restore_started') openBackupRestore = event.backupId;
    else if (event.type === 'backup_restored' || event.type === 'backup_restore_failed') openBackupRestore = undefined;
    else if (event.type === 'remote_sync_started') openRemoteSync = true;
    else if (event.type === 'remote_synced' || event.type === 'remote_sync_failed') openRemoteSync = false;
  }
  return [
    ...history,
    ...[...openRuns].map((runId): StudioEvent => ({ type: 'run_finished', runId, status: 'error', summary: reason })),
    ...(openRestore ? [{ type: 'restore_failed', checkpoint: openRestore, error: reason } satisfies StudioEvent] : []),
    ...(openBackupRestore ? [{ type: 'backup_restore_failed', backupId: openBackupRestore, error: reason } satisfies StudioEvent] : []),
    ...(openRemoteSync ? [{ type: 'remote_sync_failed', error: reason } satisfies StudioEvent] : []),
    ...(openDeploy ? [{ type: 'deploy_failed', action: openDeploy.action, target: openDeploy.target, error: reason } satisfies StudioEvent] : []),
  ];
}

/** 쓰는 도중 서버가 멈춰도 이전 파일이 남도록 임시 파일에 쓴 뒤 이름을 바꾼다 */
export async function legacyWriteSession(data: PersistedSession): Promise<void> {
  const file = sessionFile(stateDirOf(data.snapshot));
  await mkdir(path.dirname(file), { recursive: true });
  // 임시 파일 이름은 호출마다 달라야 한다. 같으면 같은 세션 파일에 동시에 쓰는 두 저장이 서로의 임시 파일을 지우고 rename이 ENOENT로 깨진다
  const temp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temp, JSON.stringify(data));
  await rename(temp, file);
}

/**
 * 종료 신호 처리처럼 기다릴 수 없는 곳에서 쓴다.
 * 진행 중일 수 있는 비동기 쓰기와 같은 임시 파일을 동시에 쓰지 않도록 이름을 달리한다
 */
export function legacyWriteSessionSync(data: PersistedSession): void {
  const file = sessionFile(stateDirOf(data.snapshot));
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.exit.tmp`;
  writeFileSync(temp, JSON.stringify(data));
  renameSync(temp, file);
}

/** 세션 폴더들에서 저장된 세션을 읽는다. 읽을 수 없거나 형식이 다른 파일은 건너뛴다 */
export async function legacyReadSessions(root: string): Promise<PersistedSession[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const sessions: PersistedSession[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const data = await readFile(sessionFile(path.join(root, entry.name)), 'utf8')
      .then((text) => JSON.parse(text) as PersistedSession)
      .catch(() => undefined);
    if (data?.version === 1 && data.snapshot?.id && data.snapshot.workDir && data.sandbox?.id && Number.isInteger(data.owner?.pid)) {
      sessions.push(data);
    }
  }
  return sessions;
}

