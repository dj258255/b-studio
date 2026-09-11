import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Checkpoint } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import type { SessionSnapshot, StudioEvent } from '../studio-events';
import {
  archivedSnapshot,
  closeUnfinished,
  isProcessAlive,
  PERSISTED_HISTORY_LIMIT,
  readSessions,
  sessionFile,
  stateDirOf,
  trimHistory,
  writeSession,
  writeSessionSync,
  type PersistedSession,
} from './session-store';

const checkpoint = { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', message: '세션 시작', at: '2026-09-11T00:00:00Z', files: [] } as unknown as Checkpoint;

function snapshot(workDir: string): SessionSnapshot {
  return {
    id: 'ab12cd34',
    projectId: 'orders',
    projectName: 'orders',
    workDir,
    status: 'ready',
    mode: 'demo',
    running: true,
    services: [{ name: 'web', template: 'nextjs', preview: 'browser', state: 'ready', url: 'http://127.0.0.1:33020', hasContract: false }],
    checkpoints: [checkpoint],
    usage: { at: '2026-09-11T00:00:00Z', services: [] },
  };
}

describe('세션 저장', () => {
  it('화면을 다시 그리는 이벤트만 남기고 개수를 제한한다', () => {
    const history: StudioEvent[] = [
      { type: 'status', status: 'ready' },
      { type: 'log', service: 'web', text: 'x', at: 'now' },
      { type: 'service', service: 'web', state: 'ready' },
      { type: 'run_started', runId: 'r1', request: '주문 목록' },
      { type: 'checkpoint', runId: 'r1', checkpoint },
    ];
    expect(trimHistory(history).map((event) => event.type)).toEqual(['run_started', 'checkpoint']);

    const many = Array.from({ length: PERSISTED_HISTORY_LIMIT + 5 }, (_, index): StudioEvent => ({ type: 'run_started', runId: `r${index}`, request: 'x' }));
    const trimmed = trimHistory(many);
    expect(trimmed).toHaveLength(PERSISTED_HISTORY_LIMIT);
    expect(trimmed[0]).toMatchObject({ runId: 'r5' });
  });

  it('끝나지 못한 요청과 되돌리기를 이유와 함께 닫는다', () => {
    const history: StudioEvent[] = [
      { type: 'run_started', runId: 'done', request: 'A' },
      { type: 'run_finished', runId: 'done', status: 'done', summary: 'ok' },
      { type: 'run_started', runId: 'cut', request: 'B' },
      { type: 'restore_started', checkpoint },
    ];
    expect(closeUnfinished(history, '서버가 멈췄습니다').slice(4)).toEqual([
      { type: 'run_finished', runId: 'cut', status: 'error', summary: '서버가 멈췄습니다' },
      { type: 'restore_failed', checkpoint, error: '서버가 멈췄습니다' },
    ]);
    expect(closeUnfinished(history.slice(0, 2), 'x')).toHaveLength(2);
    expect(closeUnfinished([{ type: 'remote_sync_started' }], '서버가 멈췄습니다')).toEqual([
      { type: 'remote_sync_started' },
      { type: 'remote_sync_failed', error: '서버가 멈췄습니다' },
    ]);
    const deploy: StudioEvent = { type: 'deploy_started', action: 'deploy', target: 'abc1234', at: '2026-09-12T00:00:00Z' };
    expect(closeUnfinished([deploy], '서버가 멈췄습니다').at(-1)).toEqual({ type: 'deploy_failed', action: 'deploy', target: 'abc1234', error: '서버가 멈췄습니다' });
    expect(trimHistory([deploy, { type: 'deploy_log', line: 'building' }])).toEqual([deploy]);
  });

  it('작업 복사본의 .git 아래에 쓰고 세션 폴더들에서 다시 읽으며, 깨진 파일은 건너뛴다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-store-'));
    const workDir = path.join(root, 'orders-ab12cd34');
    const data: PersistedSession = {
      version: 1,
      savedAt: '2026-09-11T00:00:00Z',
      owner: { pid: 4242 },
      snapshot: snapshot(workDir),
      history: [{ type: 'run_started', runId: 'r1', request: 'A' }],
      conversation: [{ role: 'user', content: 'A' }],
      demoIndex: 1,
      claudeCode: { notes: [] },
      sourceDirtyFiles: 0,
      sandbox: { id: 'studio-orders-1a2b3c', provider: 'local-docker' },
    };
    await writeSession(data);
    expect(sessionFile(workDir)).toBe(path.join(workDir, '.git', 'b-studio', 'session.json'));

    const broken = path.join(root, 'orders-broken', '.git', 'b-studio');
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, 'session.json'), '{ not json');
    await mkdir(path.join(root, 'no-session'));

    expect(await readSessions(root)).toEqual([data]);
    expect(await readSessions(path.join(root, 'missing'))).toEqual([]);

    // 종료 신호 처리에서 쓰는 동기 쓰기도 같은 파일을 바꾼다
    writeSessionSync({ ...data, demoIndex: 2 });
    expect(await readSessions(root)).toEqual([{ ...data, demoIndex: 2 }]);
  });

  it('로컬 폴더 세션은 사용자 폴더가 아니라 세션 폴더의 .git 아래에 쓰고 다시 읽는다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-store-'));
    const folder = await mkdtemp(path.join(tmpdir(), 'my-orders-'));
    const stateDir = path.join(root, 'orders-ef56ab78');
    const data: PersistedSession = {
      version: 1,
      savedAt: '2026-09-11T00:00:00Z',
      owner: { pid: 4242 },
      snapshot: { ...snapshot(folder), id: 'ef56ab78', workspace: 'local', stateDir },
      history: [],
      conversation: [],
      demoIndex: 0,
      claudeCode: { notes: [] },
      sourceDirtyFiles: 0,
      sandbox: { id: 'studio-orders-9f8e7d', provider: 'local-docker' },
    };
    await writeSession(data);

    expect(stateDirOf(data.snapshot)).toBe(stateDir);
    expect(stateDirOf(snapshot(folder))).toBe(folder);
    expect(await readSessions(root)).toEqual([data]);
    expect(await readdir(folder)).toEqual([]);
  });

  it('끝난 프로세스와 살아 있는 프로세스를 구분한다', () => {
    const exited = spawnSync('true');
    expect(exited.pid).toBeGreaterThan(0);
    expect(isProcessAlive(exited.pid!)).toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('샌드박스가 없는 세션은 중지 상태로, 이전 주소와 사용량 없이 보여 준다', () => {
    const data = { snapshot: snapshot('/tmp/x') } as PersistedSession;
    const archived = archivedSnapshot(data, '스튜디오 서버가 다시 시작됐습니다');

    expect(archived).toMatchObject({ status: 'stopped', running: false, error: '스튜디오 서버가 다시 시작됐습니다', usage: undefined });
    expect(archived.services).toEqual([{ name: 'web', template: 'nextjs', preview: 'browser', state: 'stopped', url: undefined, detail: undefined, hasContract: false }]);
    expect(archived.checkpoints).toEqual([checkpoint]);
  });
});
