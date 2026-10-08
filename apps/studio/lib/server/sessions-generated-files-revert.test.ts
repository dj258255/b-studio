import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import type { StudioEvent } from '@/lib/studio-events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 도그푸딩 마찰 127: 폴더 열기(ADR-067)가 만든 studio.yaml·compose.b-studio.yaml·Dockerfile.b-studio는 사용자
 * 저장소를 더럽히지 않으려고 `.git/info/exclude`로 세션 작업 복사본의 git 추적에서도 뺀다. 그런데 CheckpointStore의
 * pendingFiles()·discard()·restore()는 모두 git(add -A·status·reset·clean)으로 움직여 이 파일을 보지 못해서,
 * 실패한 실행이 고친 생성 파일이 되돌아가지 않고 그대로 남았다(세션 pay-2-5b640fd3에서 실측).
 *
 * 이 테스트는 실제 sessions.ts·project-registry.ts·CheckpointStore 코드로 끝까지 돌려, 생성 파일도 체크포인트
 * 시점으로 되돌아가는지, 성공한 실행은 그 변경을 받아들이고도 git 기록(따라서 PR)에는 섞이지 않는지 본다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 체크포인트, discard()·restore()의 생성 파일 스냅샷. 가짜로 바꾸는 것:
 * 샌드박스(Docker). 실제 Docker·GitHub 호출은 없다.
 */
const fake = vi.hoisted(() => ({ root: '' }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-generated-files-revert-fake',
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

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  return stdout.trim();
}

function studioYaml(version: number): string {
  return `version: 1
name: genfilesproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
workflow:
  required: [plan, implement, run, contract_check, checkpoint]
  releaseRequires: [checkpoint]
  revision: ${version}
review:
  auto: false
`;
}

/**
 * 폴더 열기(ADR-067)가 만든 뒤 `.git/info/exclude`로 뺀 것처럼, studio.yaml을 디스크에는 두되 원본 저장소에서도
 * git 추적 밖에 둔다(한 번도 커밋하지 않는다) — 실제로 registerFolder가 만드는 상태와 같다.
 */
async function setupFolderOpenedProject(): Promise<void> {
  const source = path.join(root, 'project');
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await writeFile(path.join(source, '.git/info/exclude'), '/studio.yaml\n');
  await writeFile(path.join(source, 'studio.yaml'), studioYaml(1));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(source, 'api/src'), { recursive: true });
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(source, 'api/src/Order.java'), 'class Order {}\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  fake.root = source;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-generated-files-revert-'));
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

/** 파일을 바꾸고 다음 턴 대본 없이 끝나(모델/네트워크 오류를 흉내 낸다) 요청이 실패로 끝나기를 기다린다 */
async function sendFailingWrites(id: string, request: string, writes: Array<{ path: string; content: string }>, events: StudioEvent[]): Promise<void> {
  const before = events.length;
  sendMessage(id, request, { allowBreaking: false, scriptedTurns: [{ toolCalls: writes.map((w) => ({ name: 'write_file', input: w })) }] });
  await waitFor(() => events.slice(before).find((event) => event.type === 'run_finished'));
}

/** 파일을 바꾸고 다음 턴에서 "완료했습니다"로 끝나(검증 게이트를 통과하는 성공한 실행) 요청이 끝나기를 기다린다 */
async function sendSuccessfulWrite(id: string, request: string, file: string, content: string, events: StudioEvent[]): Promise<void> {
  const before = events.length;
  sendMessage(id, request, {
    allowBreaking: false,
    scriptedTurns: [{ toolCalls: [{ name: 'write_file', input: { path: file, content } }] }, { text: '완료했습니다.' }],
  });
  await waitFor(() => events.slice(before).find((event) => event.type === 'run_finished'));
}

describe('생성 파일(studio.yaml 등, ADR-067)도 체크포인트 시점으로 되돌린다(도그푸딩 마찰 127)', () => {
  it('실패한 실행이 studio.yaml을 고쳐도, 되돌리면 원래 내용으로 돌아가고 되돌린 파일 목록·백업에 들어간다', async () => {
    await setupFolderOpenedProject();
    const id = (await createSession('genfilesproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;

    // 세션 작업 복사본에도 studio.yaml이 끼워져 있고(overlayGeneratedFiles), 원본과 같은 내용이다
    expect(await readFile(path.join(workDir, 'studio.yaml'), 'utf8')).toBe(studioYaml(1));

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));

    await sendFailingWrites(
      id,
      '테스트 설정 추가',
      [
        { path: 'api/src/Order.java', content: 'class Order { String memo; }\n' },
        { path: 'studio.yaml', content: studioYaml(2) },
      ],
      events,
    );

    // 체크포인트는 늘지 않았다(검증 게이트를 거치지 않아 되돌렸다)
    expect(getSnapshot(id)!.checkpoints).toHaveLength(1);
    // 추적되는 파일은 물론, git 추적 밖인 studio.yaml도 원래 내용으로 돌아갔다 — 이번 수정의 핵심
    expect(await readFile(path.join(workDir, 'api/src/Order.java'), 'utf8')).toBe('class Order {}\n');
    expect(await readFile(path.join(workDir, 'studio.yaml'), 'utf8')).toBe(studioYaml(1));

    const reverted = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'reverted' }> => event.type === 'reverted'));
    expect(reverted.files.sort()).toEqual(['api/src/Order.java', 'studio.yaml']);
    expect(reverted.backup).toMatchObject({ files: ['api/src/Order.java', 'studio.yaml'] });

    // 되살리면 생성 파일도 같이 돌아온다
    restoreDiscardedBackup(id, reverted.backup!.id);
    const restored = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'backup_restored' }> => event.type === 'backup_restored'));
    expect(restored.files.sort()).toEqual(['api/src/Order.java', 'studio.yaml']);
    expect(await readFile(path.join(workDir, 'studio.yaml'), 'utf8')).toBe(studioYaml(2));

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('성공한 실행이 studio.yaml을 고치면 디스크에는 남지만 git 기록(따라서 PR)에는 섞이지 않고, 이후 실행이 받아들인다', async () => {
    await setupFolderOpenedProject();
    const id = (await createSession('genfilesproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));

    await sendSuccessfulWrite(id, '워크플로 버전을 올린다', 'studio.yaml', studioYaml(2), events);

    // 성공했으므로 디스크에는 새 내용이 남는다
    expect(await readFile(path.join(workDir, 'studio.yaml'), 'utf8')).toBe(studioYaml(2));
    // 사용자 저장소(여기서는 세션 작업 복사본의 git 기록, PR이 그대로 올리는 커밋들)에는 studio.yaml이 전혀 없다 —
    // 체크포인트 파일 목록에도, git log에도 등장하지 않는다
    const checkpoint = getSnapshot(id)!.checkpoints[0]!;
    expect(checkpoint.files).not.toContain('studio.yaml');
    expect(await git(workDir, 'log', '--all', '--oneline', '--', 'studio.yaml')).toBe('');
    expect(await git(workDir, 'show', '--stat', '--format=', checkpoint.sha)).not.toContain('studio.yaml');

    // 뒤이은 실패한 실행(studio.yaml과 무관한 변경)이 되돌려도, 방금 받아들인 studio.yaml 내용은 그대로다
    await sendFailingWrites(id, '컴파일 에러 확인', [{ path: 'api/src/Order.java', content: 'class Order { int broken }\n' }], events);
    expect(await readFile(path.join(workDir, 'api/src/Order.java'), 'utf8')).toBe('class Order {}\n');
    expect(await readFile(path.join(workDir, 'studio.yaml'), 'utf8')).toBe(studioYaml(2));

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);
});
