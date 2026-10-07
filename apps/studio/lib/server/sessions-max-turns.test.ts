import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import type { StudioEvent } from '@/lib/studio-events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 턴 상한(ADR-131)을 studio.yaml(workflow.maxTurns)과 요청 옵션(maxTurns)으로 바꿀 수 있는지, 그리고 요청
 * 옵션이 studio.yaml보다 우선하는지 본다. 진짜로 하는 것: 파일 시스템의 git 저장소·체크포인트·게이트.
 * 가짜로 바꾸는 것: 샌드박스(Docker)와 모델(ScriptedModelClient, HTTP로는 받지 않는 서버 내부 경로).
 */
const fake = vi.hoisted(() => ({ root: '' }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-max-turns-fake',
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

import { createSession, getSnapshot, sendMessage, stopSession, subscribe } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
};

function studioYaml(maxTurns: number): string {
  return `version: 1
name: verifyproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
workflow:
  required: [plan, implement, run, contract_check, checkpoint]
  maxTurns: ${maxTurns}
review:
  auto: false
`;
}

async function setupProject(maxTurns: number): Promise<void> {
  const projectRoot = path.join(root, 'project');
  await mkdir(path.join(projectRoot, 'api/src'), { recursive: true });
  await writeFile(path.join(projectRoot, 'studio.yaml'), studioYaml(maxTurns));
  await writeFile(path.join(projectRoot, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(projectRoot, 'api/src/Order.java'), 'class Order {}\n');
  fake.root = projectRoot;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-max-turns-'));
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

/** 한 번의 토막(tool call)이 끝나는 스크립트. 턴 상한이 1이면 다음 턴을 꺼내기 전에(소모하기 전에) 상한에 걸린다 */
const oneToolCallTurn = [{ toolCalls: [{ name: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'class Order {}', new_text: 'class Order { String memo; }' } }] }, { text: '못 받을 턴입니다.' }];

describe('턴 상한을 studio.yaml과 요청 옵션으로 바꿀 수 있다(ADR-131)', () => {
  it('studio.yaml(workflow.maxTurns)이 실행기에 전달된다', async () => {
    await setupProject(1);
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));

    sendMessage(id, '메모 필드 추가', { allowBreaking: false, scriptedTurns: oneToolCallTurn });
    const finished = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'run_finished' }> => event.type === 'run_finished'));

    // maxTurns: 1이라 도구 호출 한 번(턴 1) 뒤 다음 턴을 꺼내기 전에 상한에 걸린다. 바뀐 파일이 게이트를 통과하므로 done으로 남는다
    expect(finished.status).toBe('done');
    expect(finished.summary).toContain('최대 턴 수(1)를 넘었습니다');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('요청 옵션(maxTurns)이 studio.yaml보다 우선한다', async () => {
    await setupProject(1);
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));

    // 같은 대본이라도 요청 옵션 maxTurns: 2를 주면 studio.yaml의 1 대신 2를 쓴다 — 대본이 2턴을 모두 쓰고
    // 정상적으로 끝나(상한에 걸리지 않고) done으로 남는다
    sendMessage(id, '메모 필드 추가', { allowBreaking: false, scriptedTurns: oneToolCallTurn, maxTurns: 2 });
    const finished = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'run_finished' }> => event.type === 'run_finished'));

    expect(finished.status).toBe('done');
    expect(finished.summary).not.toContain('최대 턴 수');
    expect(finished.summary).toBe('못 받을 턴입니다.');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);
});
