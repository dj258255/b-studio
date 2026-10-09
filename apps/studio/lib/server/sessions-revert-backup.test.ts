import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import type { StudioEvent } from '@/lib/studio-events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 실행이 실패·중단(모델 오류, 턴 상한 등)해 작업 트리를 되돌릴 때, 그 실행이 바꾼 파일을 조용히 버리지 않고
 * DiscardBackup으로 보관한 뒤 대화에 안내하며, 되살리면 작업 트리에 돌아오되 체크포인트가 아니라 미검증
 * 상태로 남아(git에 아직 커밋되지 않은 pending 변경) 다음 요청의 검증 게이트를 거쳐야 체크포인트로 남는지 본다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 체크포인트, discard()의 백업·되살리기. 가짜로 바꾸는 것: 샌드박스(Docker).
 */
const fake = vi.hoisted(() => ({ root: '', failRestart: false, restartGate: undefined as Promise<void> | undefined }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-revert-backup-fake',
    name: 'fake',
    async start() {
      return [];
    },
    async restart(service: string) {
      // 되살린 변경이 이번에는 게이트를 통과하지 못하는 상황을 흉내 낸다(fake.failRestart)
      // 서비스가 기동하는 데 오래 걸리는 상황(Spring Boot)을 흉내 낸다(fake.restartGate)
      if (fake.restartGate) await fake.restartGate;
      if (fake.failRestart) throw new Error('재시작 실패(테스트)');
      return { service, containerPort: 8080, url: 'http://127.0.0.1:1' };
    },
    async sync() {
      return { elapsedMs: 0, checks: 1 };
    },
    async endpoint(service: string) {
      return { service, containerPort: 8080, url: 'http://127.0.0.1:1' };
    },
    async state() {
      return 'running';
    },
    async stats() {
      return [];
    },
    async *logs() {},
    async exec() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async execToFile() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async execFromFile() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    redact: (text: string) => text,
    findSecrets: () => [],
    async callExternal() {
      return { decision: 'deny' as const, status: 404, body: '', masked: 0 };
    },
    async destroy() {},
  } as unknown as Sandbox;
  return { ...actual, providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox }) };
});

vi.mock('./projects', () => ({
  findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root),
}));

import { createSession, getSnapshot, restoreDiscardedBackup, sendMessage, stopSession, subscribe } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
};

function studioYaml(): string {
  return `version: 1
name: verifyproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
workflow:
  required: [plan, implement, run, contract_check, checkpoint]
  releaseRequires: [checkpoint]
review:
  auto: false
`;
}

async function setupProject(): Promise<void> {
  const projectRoot = path.join(root, 'project');
  await mkdir(path.join(projectRoot, 'api/src'), { recursive: true });
  await writeFile(path.join(projectRoot, 'studio.yaml'), studioYaml());
  await writeFile(path.join(projectRoot, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(projectRoot, 'api/src/Order.java'), 'class Order {}\n');
  fake.root = projectRoot;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-revert-backup-'));
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'verify',
    GIT_AUTHOR_EMAIL: 'verify@example.com',
    GIT_COMMITTER_NAME: 'verify',
    GIT_COMMITTER_EMAIL: 'verify@example.com',
    B_STUDIO_GIT_AUTHOR_NAME: 'verify',
    B_STUDIO_GIT_AUTHOR_EMAIL: 'verify@example.com',
  });
});

afterAll(() => {
  if (saved.mode === undefined) delete process.env.B_STUDIO_MODE;
  else process.env.B_STUDIO_MODE = saved.mode;
  if (saved.sessions === undefined) delete process.env.B_STUDIO_SESSIONS_DIR;
  else process.env.B_STUDIO_SESSIONS_DIR = saved.sessions;
});

async function waitForReady(id: string, timeoutMs = 10_000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const status = getSnapshot(id)?.status ?? 'missing';
    if (status === 'ready' || status === 'failed' || status === 'stopped') return status;
    if (Date.now() - started > timeoutMs) throw new Error(`세션이 준비되지 않았습니다 (${status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('기대한 상태가 되지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** events는 이 세션을 구독한 배열이다(테스트가 미리 subscribe해 둔다). 새로 보낸 요청이 끝날 때까지 기다린다 */
async function sendAndWaitFinished(
  id: string,
  text: string,
  scriptedTurns: Array<{ toolCalls?: Array<{ name: string; input: Record<string, unknown> }>; text?: string }>,
  events: StudioEvent[],
): Promise<void> {
  const before = events.length;
  sendMessage(id, text, { allowBreaking: false, scriptedTurns });
  await waitFor(() => events.slice(before).find((event) => event.type === 'run_finished'));
}

describe('실행 실패로 되돌릴 때 바꾼 파일을 보관하고 안내하며, 되살리면 미검증 상태로 돌아온다', () => {
  it('모델 호출이 오류로 끝나도 바뀐 파일을 백업한 뒤 되돌리고, 되살리면 다음 요청의 게이트를 거쳐야 체크포인트로 남는다', async () => {
    await setupProject();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;
    const startCheckpoints = getSnapshot(id)!.checkpoints.length;

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));

    // 다음 턴 대본이 없어 모델 호출이 예외로 끝난다("모델/네트워크 오류로 끝난 실행"을 흉내 낸다)
    await sendAndWaitFinished(
      id,
      '메모 필드 추가',
      [{ toolCalls: [{ name: 'write_file', input: { path: 'api/src/Order.java', content: 'class Order { String memo; }\n' } }] }],
      events,
    );

    // 체크포인트는 늘지 않았다(검증 게이트를 거치지 않았으므로 되돌렸다)
    expect(getSnapshot(id)!.checkpoints.length).toBe(startCheckpoints);
    expect(await readFile(path.join(workDir, 'api/src/Order.java'), 'utf8')).toBe('class Order {}\n');

    // 대화에 "되돌린 변경 N개를 보관했습니다" 안내가 남는다(파일 목록·되살리기 백업 id 포함)
    const reverted = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'reverted' }> => event.type === 'reverted'));
    expect(reverted.files).toEqual(['api/src/Order.java']);
    expect(reverted.backup).toMatchObject({ files: ['api/src/Order.java'] });

    // 되살리면 작업 트리로 돌아온다
    restoreDiscardedBackup(id, reverted.backup!.id);
    const restored = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'backup_restored' }> => event.type === 'backup_restored'));
    expect(restored.files).toEqual(['api/src/Order.java']);
    expect(await readFile(path.join(workDir, 'api/src/Order.java'), 'utf8')).toBe('class Order { String memo; }\n');

    // 되살린 변경은 아직 체크포인트가 아니다(검증을 거치지 않은 미검증 상태)
    expect(getSnapshot(id)!.checkpoints.length).toBe(startCheckpoints);

    // 다음 요청이 이어서 그 변경 위에 작업하고 게이트를 통과하면, 되살린 파일도 함께 체크포인트로 남는다.
    // 이번 요청은 모델이 파일을 하나도 쓰지 않는다(ADR-131 실측 재현: 세션 5b640fd3, 체크포인트 15ba740 —
    // 보관본을 되살린 뒤 파일을 쓰지 않는 요청이 게이트를 건너뛰고 Workflow-Passed: none 체크포인트를 남겼다).
    const beforeSecondRequest = events.length;
    await sendAndWaitFinished(id, '컴파일 에러 확인', [{ text: '이미 반영돼 있어 추가로 바꿀 필요가 없습니다.' }], events);

    // 게이트가 실제로 돌았다(되살린 파일을 workspace가 바뀐 파일로 보고 검증을 건너뛰지 않았다)
    const verifyStarted = events
      .slice(beforeSecondRequest)
      .find((event): event is Extract<StudioEvent, { type: 'agent' }> => event.type === 'agent' && event.event.type === 'verify_start');
    expect(verifyStarted).toBeDefined();

    const checkpoint = getSnapshot(id)!.checkpoints[0]!;
    expect(checkpoint.files).toEqual(['api/src/Order.java']);
    // 검증 게이트를 통과한 기록이 실제로 남는다 — Workflow-Passed가 비어 있지 않다(none이 아니다)
    expect(checkpoint.passedStages).toBeDefined();
    expect(checkpoint.passedStages!.length).toBeGreaterThan(0);
    expect(checkpoint.verify).toBeUndefined();

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('되살린 뒤 파일을 쓰지 않는 요청도 게이트가 돌고, 통과하지 못하면 체크포인트로 남기지 않고 다시 보관한 뒤 되돌린다', async () => {
    await setupProject();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;
    const startCheckpoints = getSnapshot(id)!.checkpoints.length;

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));

    await sendAndWaitFinished(
      id,
      '메모 필드 추가',
      [{ toolCalls: [{ name: 'write_file', input: { path: 'api/src/Order.java', content: 'class Order { String memo; }\n' } }] }],
      events,
    );
    const reverted = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'reverted' }> => event.type === 'reverted'));
    restoreDiscardedBackup(id, reverted.backup!.id);
    await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'backup_restored' }> => event.type === 'backup_restored'));
    expect(getSnapshot(id)!.checkpoints.length).toBe(startCheckpoints);

    // 이번에는 되살린 변경이 검증 게이트(서비스 재시작)를 통과하지 못하게 한다. 모델은 여전히 파일을 하나도 쓰지 않는다
    fake.failRestart = true;
    const beforeSecondRequest = events.length;
    await sendAndWaitFinished(id, '컴파일 에러 확인', [{ text: '이미 반영돼 있어 추가로 바꿀 필요가 없습니다.' }], events);
    fake.failRestart = false;

    // 게이트가 실제로 돌았다(건너뛰지 않았다) — 통과하지 못해 체크포인트를 남기지 않았다
    const verifyStarted = events
      .slice(beforeSecondRequest)
      .find((event): event is Extract<StudioEvent, { type: 'agent' }> => event.type === 'agent' && event.event.type === 'verify_start');
    expect(verifyStarted).toBeDefined();
    expect(getSnapshot(id)!.checkpoints.length).toBe(startCheckpoints);

    // 실패했으므로 기존 실패 경로(ADR-099: 보관 뒤 되돌림)를 그대로 탄다 — 조용히 사라지지 않는다
    const revertedAgain = await waitFor(() =>
      events.slice(beforeSecondRequest).find((event): event is Extract<StudioEvent, { type: 'reverted' }> => event.type === 'reverted'),
    );
    expect(revertedAgain.files).toEqual(['api/src/Order.java']);
    expect(revertedAgain.backup).toMatchObject({ files: ['api/src/Order.java'] });
    expect(await readFile(path.join(workDir, 'api/src/Order.java'), 'utf8')).toBe('class Order {}\n');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);

  describe('백업을 되살리는 동안 running을 잡는다', () => {
    /** 백업이 만들어진 세션을 준비한다: 실행이 실패해 Order.java 변경을 보관한 상태 */
    async function sessionWithBackup(): Promise<{ id: string; events: StudioEvent[]; backupId: string; unsubscribe: () => void }> {
      await setupProject();
      const id = (await createSession('verifyproj', 'kim', 'copy')).id;
      expect(await waitForReady(id)).toBe('ready');
      const events: StudioEvent[] = [];
      const unsubscribe = subscribe(id, (event) => events.push(event));
      await sendAndWaitFinished(
        id,
        '메모 필드 추가',
        [{ toolCalls: [{ name: 'write_file', input: { path: 'api/src/Order.java', content: 'class Order { String memo; }\n' } }] }],
        events,
      );
      const reverted = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'reverted' }> => event.type === 'reverted'));
      return { id, events, backupId: reverted.backup!.id, unsubscribe };
    }

    it('서비스 재시작이 끝나기 전에는 sendMessage를 409로 거절하고, backup_restored 뒤에는 받아들인다', async () => {
      const { id, events, backupId, unsubscribe } = await sessionWithBackup();
      let release!: () => void;
      fake.restartGate = new Promise<void>((resolve) => (release = resolve));
      try {
        restoreDiscardedBackup(id, backupId);
        expect(getSnapshot(id)!.running).toBe(true);
        expect(events.some((event) => event.type === 'backup_restore_started')).toBe(true);
        let rejected: unknown;
        try {
          sendMessage(id, '끼어드는 요청', { allowBreaking: false, scriptedTurns: [{ text: '완료' }] });
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toMatchObject({ status: 409, message: '이전 요청을 처리하는 중입니다' });
        expect(events.some((event) => event.type === 'backup_restored')).toBe(false);

        release();
        await waitFor(() => events.find((event) => event.type === 'backup_restored'));
        expect(getSnapshot(id)!.running).toBe(false);
        expect(() => sendMessage(id, '이어서 요청', { allowBreaking: false, scriptedTurns: [{ text: '완료' }] })).not.toThrow();
        await waitFor(() => events.filter((event) => event.type === 'run_finished').length >= 2 || undefined);
      } finally {
        release();
        fake.restartGate = undefined;
        unsubscribe();
        await stopSession(id).catch(() => {});
      }
    }, 20_000);

    it('되살리기가 실패해도 backup_restore_failed보다 먼저 running을 풀어 다음 요청을 받는다', async () => {
      const { id, events, unsubscribe } = await sessionWithBackup();
      try {
        // 없는 백업 id라 restoreBackup이 예외로 끝난다
        restoreDiscardedBackup(id, 'missing-backup');
        expect(getSnapshot(id)!.running).toBe(true);
        let runningAtFailure: boolean | undefined;
        const stop = subscribe(id, (event) => {
          if (event.type === 'backup_restore_failed') runningAtFailure = getSnapshot(id)!.running;
        });
        await waitFor(() => events.find((event) => event.type === 'backup_restore_failed'));
        stop();
        expect(runningAtFailure).toBe(false);
        expect(getSnapshot(id)!.running).toBe(false);
        expect(() => sendMessage(id, '이어서 요청', { allowBreaking: false, scriptedTurns: [{ text: '완료' }] })).not.toThrow();
        await waitFor(() => events.filter((event) => event.type === 'run_finished').length >= 2 || undefined);
      } finally {
        unsubscribe();
        await stopSession(id).catch(() => {});
      }
    }, 20_000);
  });
});
