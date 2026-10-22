import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { InfraCheckResult, Sandbox } from '@b-studio/sandbox';
import type { StudioEvent } from '@/lib/studio-events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 실행 기록에 AI·시작 모델·작업 종류를 남긴다(#821). AI별 결과표는 run_started의 이 값으로 실행을 묶는다.
 *
 * 진짜로 하는 것: 파일 시스템의 git 저장소·체크포인트. 가짜로 바꾸는 것: 샌드박스(Docker)와 모델
 * (ScriptedModelClient) — 실제 GitHub·모델을 부르지 않는다.
 */
const fake = vi.hoisted(() => ({ root: '', ensureInfra: vi.fn<NonNullable<Sandbox['ensureInfra']>>() }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-run-ledger-fake',
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
    ensureInfra: fake.ensureInfra,
  } as unknown as Sandbox;
  return { ...actual, providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox }) };
});

vi.mock('./projects', () => ({
  findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root),
}));

import { createSession, getSnapshot, sendMessage, stopSession, subscribe } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
};

const studioYaml = `version: 1
name: verifyproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
review:
  auto: false
`;

async function setupProject(): Promise<void> {
  const projectRoot = path.join(root, 'project');
  await mkdir(path.join(projectRoot, 'api/src'), { recursive: true });
  await writeFile(path.join(projectRoot, 'studio.yaml'), studioYaml);
  await writeFile(path.join(projectRoot, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(projectRoot, 'api/src/Order.java'), 'class Order {}\n');
  fake.root = projectRoot;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-run-ledger-'));
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
  fake.ensureInfra.mockReset();
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

const doneTurn = [{ text: '아무것도 바꾸지 않았습니다.' }];

async function startedEvent(id: string, request: string): Promise<Extract<StudioEvent, { type: 'run_started' }>> {
  const events: StudioEvent[] = [];
  const unsubscribe = subscribe(id, (event) => events.push(event));
  sendMessage(id, request, { allowBreaking: false, scriptedTurns: doneTurn });
  // 구독은 지난 기록부터 다시 보내므로 이 요청의 실행을 글로 찾는다
  const started = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'run_started' }> => event.type === 'run_started' && event.request === request));
  await waitFor(() => events.find((event) => event.type === 'run_finished' && event.runId === started.runId));
  unsubscribe();
  return started;
}

describe('실행 기록의 AI·작업 종류(#821)', () => {
  it('run_started에 세션의 백엔드와 요청의 작업 종류를 남긴다', async () => {
    await setupProject();
    fake.ensureInfra.mockResolvedValue({ ok: true, recovered: [] } satisfies InfraCheckResult);
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    const plain = await startedEvent(id, '버튼 글자를 바꿔 줘');
    expect(plain).toMatchObject({ backend: 'api', taskKind: { complexity: 'simple', risk: 'normal' } });
    // 대본 실행은 실제 모델을 고르지 않는다. 모르는 모델을 지어내지 않는다
    expect(plain.model).toBeUndefined();

    const risky = await startedEvent(id, '결제 완료 화면을 만들어 줘');
    expect(risky.taskKind).toEqual({ complexity: 'simple', risk: 'high' });

    await stopSession(id).catch(() => {});
  }, 20_000);
});
