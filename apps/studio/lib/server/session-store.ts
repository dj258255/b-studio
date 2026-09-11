import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Checkpoint } from '@b-studio/agent';
import type { SessionSnapshot, StudioEvent } from '../studio-events';

/** 세션 작업 복사본 안의 저장 위치. .git 아래라 에이전트 도구가 접근하지 못하고 커밋에도 들어가지 않는다 */
const FILE = path.join('.git', 'b-studio', 'session.json');
export const PERSISTED_HISTORY_LIMIT = 2_000;

/** 스튜디오 서버가 다시 시작돼도 세션을 이어서 띄울 수 있게 남기는 상태 */
export interface PersistedSession {
  version: 1;
  savedAt: string;
  /** 마지막으로 쓴 스튜디오 프로세스. 살아 있으면 다른 프로세스가 복구하지 않는다 */
  owner: { pid: number };
  snapshot: SessionSnapshot;
  history: StudioEvent[];
  /** api 모드의 모델 대화 */
  conversation: unknown[];
  demoIndex: number;
  claudeCode: { sessionId?: string; notes: string[] };
  sourceDirtyFiles: number;
  /** 정리할 때 쓰는 샌드박스 id와 제공자 이름 */
  sandbox: { id: string; provider: string };
}

export function sessionFile(workDir: string): string {
  return path.join(workDir, FILE);
}

/**
 * 화면의 대화와 체크포인트를 다시 그리는 이벤트만 남긴다.
 * 로그·사용량·서비스 상태는 샌드박스와 함께 사라지고, 세션 상태는 스냅샷이 들고 있으므로 뺀다
 */
export function trimHistory(history: readonly StudioEvent[]): StudioEvent[] {
  return history.filter((event) => !['log', 'usage', 'service', 'status', 'snapshot'].includes(event.type)).slice(-PERSISTED_HISTORY_LIMIT);
}

/** 서버가 멈춰 끝나지 못한 요청과 되돌리기를 닫는다. 그대로 두면 다시 그린 화면이 "처리 중"에 멈춘다 */
export function closeUnfinished(history: readonly StudioEvent[], reason: string): StudioEvent[] {
  const openRuns = new Set<string>();
  let openRestore: Checkpoint | undefined;
  let openRemoteSync = false;
  for (const event of history) {
    if (event.type === 'run_started') openRuns.add(event.runId);
    else if (event.type === 'run_finished') openRuns.delete(event.runId);
    else if (event.type === 'restore_started') openRestore = event.checkpoint;
    else if (event.type === 'restored' || event.type === 'restore_failed') openRestore = undefined;
    else if (event.type === 'remote_sync_started') openRemoteSync = true;
    else if (event.type === 'remote_synced' || event.type === 'remote_sync_failed') openRemoteSync = false;
  }
  return [
    ...history,
    ...[...openRuns].map((runId): StudioEvent => ({ type: 'run_finished', runId, status: 'error', summary: reason })),
    ...(openRestore ? [{ type: 'restore_failed', checkpoint: openRestore, error: reason } satisfies StudioEvent] : []),
    ...(openRemoteSync ? [{ type: 'remote_sync_failed', error: reason } satisfies StudioEvent] : []),
  ];
}

/** 쓰는 도중 서버가 멈춰도 이전 파일이 남도록 임시 파일에 쓴 뒤 이름을 바꾼다 */
export async function writeSession(data: PersistedSession): Promise<void> {
  const file = sessionFile(data.snapshot.workDir);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(data));
  await rename(temp, file);
}

/**
 * 종료 신호 처리처럼 기다릴 수 없는 곳에서 쓴다.
 * 진행 중일 수 있는 비동기 쓰기와 같은 임시 파일을 동시에 쓰지 않도록 이름을 달리한다
 */
export function writeSessionSync(data: PersistedSession): void {
  const file = sessionFile(data.snapshot.workDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.exit.tmp`;
  writeFileSync(temp, JSON.stringify(data));
  renameSync(temp, file);
}

/** 세션 폴더들에서 저장된 세션을 읽는다. 읽을 수 없거나 형식이 다른 파일은 건너뛴다 */
export async function readSessions(root: string): Promise<PersistedSession[]> {
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

/** 신호 0은 보내지 않고 권한과 존재만 확인한다. 다른 사용자의 프로세스(EPERM)도 살아 있는 것으로 본다 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 샌드박스가 없는 세션의 화면 상태. 이전 주소와 사용량은 더 이상 의미가 없다 */
export function archivedSnapshot(data: PersistedSession, error?: string): SessionSnapshot {
  return {
    ...data.snapshot,
    status: 'stopped',
    running: false,
    error,
    usage: undefined,
    services: data.snapshot.services.map((service) => ({ ...service, state: 'stopped' as const, url: undefined, detail: undefined })),
  };
}
