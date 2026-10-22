import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import type { StudioEvent } from '@/lib/studio-events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 에이전트가 요청과 확인의 어긋남을 알리면(report_mismatch, #666) 게이트를 통과한 실행도 run_finished에 그 사실을 싣는지 본다.
 * 판정과 체크포인트는 그대로여야 한다(상태를 낮추기만 한다). 진짜로 하는 것: 파일 시스템의 git 저장소·체크포인트·게이트.
 * 가짜로 바꾸는 것: 샌드박스(Docker)와 모델(ScriptedModelClient, HTTP로는 받지 않는 서버 내부 경로).
 */
const fake = vi.hoisted(() => ({ root: '' }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-mismatch-fake',
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
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-mismatch-'));
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

const mismatch = { request_value: '메모는 200자까지', check_value: 'OrderTest는 100자를 기대', followed: 'check', note: '테스트를 따랐습니다' };

describe('요청과 확인의 어긋남을 실행 결과에 싣는다 (#666)', () => {
  it('어긋남을 알린 실행은 done·체크포인트 그대로 run_finished에 mismatches가 실리고, 다음 실행에는 없다', async () => {
    await setupProject(10);
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));
    const finishedRuns = () => events.filter((event): event is Extract<StudioEvent, { type: 'run_finished' }> => event.type === 'run_finished');

    sendMessage(id, '메모 필드 추가(200자)', {
      allowBreaking: false,
      scriptedTurns: [
        { toolCalls: [{ name: 'report_mismatch', input: mismatch }] },
        { toolCalls: [{ name: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'class Order {}', new_text: 'class Order { String memo; }' } }] },
        { text: '메모 필드를 더했습니다.' },
      ],
    });
    const first = await waitFor(() => finishedRuns()[0]);
    expect(first.status).toBe('done');
    expect(first.mismatches).toEqual([{ requestValue: '메모는 200자까지', checkValue: 'OrderTest는 100자를 기대', followed: 'check', note: '테스트를 따랐습니다' }]);
    // 게이트를 통과한 변경은 그대로 체크포인트로 남는다
    expect(events.some((event) => event.type === 'checkpoint' && event.runId === first.runId)).toBe(true);

    sendMessage(id, '메모 길이 안내 추가', {
      allowBreaking: false,
      scriptedTurns: [
        { toolCalls: [{ name: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'String memo;', new_text: 'String memo; // 100자' } }] },
        { text: '더했습니다.' },
      ],
    });
    const second = await waitFor(() => finishedRuns()[1]);
    expect(second.status).toBe('done');
    expect(second.mismatches).toBeUndefined();

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);
});
