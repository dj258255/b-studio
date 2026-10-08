import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { InfraCheckResult, Sandbox } from '@b-studio/sandbox';
import type { StudioEvent } from '@/lib/studio-events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 도그푸딩 마찰 130: 세션 상태는 ready인데 studio 밖에서 edge·부가 서비스 컨테이너가 지워진 채로 요청을
 * 보내면, 첫 샌드박스 도구부터 "service ... is not running"으로 실패하고 에이전트는 원인을 몰라 같은
 * 도구(restart_service·service_stats 등)를 턴 상한까지 반복했다(트러블슈팅 85). runPlan이 모델을 부르기
 * 전에 ensureInfra()로 확인·복구하는지, 복구에 실패하면 모델을 한 번도 부르지 않고 바로 알리는지 본다.
 *
 * 진짜로 하는 것: 파일 시스템의 git 저장소·체크포인트. 가짜로 바꾸는 것: 샌드박스(Docker)와 모델
 * (ScriptedModelClient, HTTP로는 받지 않는 서버 내부 경로) — 실제 GitHub·모델을 부르지 않고, :3000에
 * dev 서버를 띄우지 않는다.
 */
const fake = vi.hoisted(() => ({ root: '', ensureInfra: vi.fn<Sandbox['ensureInfra']>() }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-infra-recovery-fake',
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
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-infra-recovery-'));
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

describe('ready 세션의 핵심 컨테이너 확인·복구(도그푸딩 마찰 130)', () => {
  it('컨테이너가 없어도 ensureInfra가 다시 올리면 모델을 그대로 부르고 복구 사실을 알린다', async () => {
    await setupProject();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    fake.ensureInfra.mockResolvedValue({ ok: true, recovered: ['b-studio-edge'] } satisfies InfraCheckResult);

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));

    sendMessage(id, '상태만 확인', { allowBreaking: false, scriptedTurns: doneTurn });
    const finished = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'run_finished' }> => event.type === 'run_finished'));

    expect(finished.status).toBe('done');
    expect(fake.ensureInfra).toHaveBeenCalledTimes(1);
    const notice = events.find((event): event is Extract<StudioEvent, { type: 'notice' }> => event.type === 'notice' && event.text.includes('b-studio-edge'));
    expect(notice).toBeDefined();

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('컨테이너가 없는데 자동 복구도 실패하면 모델을 한 번도 부르지 않고 바로 알린다', async () => {
    await setupProject();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    fake.ensureInfra.mockResolvedValue({
      ok: false,
      recovered: [],
      missing: ['b-studio-edge'],
      reason: 'docker compose up 실패 (studio-infra-recovery-fake)',
    } satisfies InfraCheckResult);

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));

    sendMessage(id, '상태만 확인', { allowBreaking: false, scriptedTurns: doneTurn });
    const finished = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'run_finished' }> => event.type === 'run_finished'));

    expect(finished.status).toBe('error');
    expect(finished.summary).toContain('샌드박스 인프라 문제라 코드로 고칠 수 없습니다');
    expect(finished.summary).toContain('b-studio-edge');
    // 모델이 한 번도 불리지 않았다 — 'agent' 이벤트(턴·도구 호출 등)가 전혀 없어야 한다
    expect(events.some((event) => event.type === 'agent')).toBe(false);
    // 세션 상태는 ready로 남는다(이 실행 하나만 실패로 끝난다) — 사람이 다시 요청을 보낼 수 있다
    expect(getSnapshot(id)?.status).toBe('ready');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('세션이 아직 준비되지 않았으면(지연 기동 등) ensureInfra를 부르지 않는다', async () => {
    await setupProject();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    // starting 단계에서 곧바로 끼어들 수는 없으니, 준비된 뒤 확인하는 대신 ready가 된 뒤에만 불렸는지 본다
    expect(await waitForReady(id)).toBe('ready');
    // boot() 경로(세션을 막 켤 때)는 ensureInfra를 거치지 않고 sandbox.start()로 직접 올린다
    expect(fake.ensureInfra).not.toHaveBeenCalled();

    await stopSession(id).catch(() => {});
  }, 20_000);
});
