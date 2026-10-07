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
const fake = vi.hoisted(() => ({ root: '' }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-revert-backup-fake',
    name: 'fake',
    async start() {
      return [];
    },
    async restart(service: string) {
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

    // 다음 요청이 이어서 그 변경 위에 작업하고 게이트를 통과하면, 되살린 파일도 함께 체크포인트로 남는다
    await sendAndWaitFinished(id, '컴파일 에러 확인', [{ text: '이미 반영돼 있어 추가로 바꿀 필요가 없습니다.' }], events);
    const checkpoint = getSnapshot(id)!.checkpoints[0]!;
    expect(checkpoint.files).toEqual(['api/src/Order.java']);

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);
});
