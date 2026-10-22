import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 세션의 "다시 검증"(#798)을 실제 sessions.ts 코드로 끝까지 돌려 본다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 체크포인트, 검증 게이트, `reverifySession`.
 * 가짜로 바꾸는 것: 샌드박스(Docker). 선언한 테스트 명령의 종료 코드와, 테스트 도중 작업 복사본을 바꾸는 일을 여기서 정한다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  restarted: [] as string[],
  testExit: 0,
  /** 테스트 명령이 도는 동안 할 일(작업 복사본을 바꾸는 백그라운드 흉내) */
  duringTest: undefined as undefined | (() => Promise<void>),
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-reverify-fake',
    name: 'fake',
    async start() {
      return [];
    },
    async restart(service: string) {
      fake.restarted.push(service);
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
    async exec(_service: string, command: string[]) {
      if (command[0] === 'run-tests') {
        await fake.duringTest?.();
        return { exitCode: fake.testExit, stdout: fake.testExit === 0 ? 'ok' : 'FAILED OrderTest', stderr: '' };
      }
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

import { createSession, getSnapshot, reverifySession, sendMessage, stopSession, subscribe } from './sessions';
import type { StudioEvent } from '@/lib/studio-events';

let root: string;
const saved = { mode: process.env.B_STUDIO_MODE, sessions: process.env.B_STUDIO_SESSIONS_DIR };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  return stdout.trim();
}

const STUDIO_YAML = `version: 1
name: verifyproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
  web: { source: managed, template: nextjs, path: web, port: 3000, preview: browser }
workflow:
  required: [plan, implement, run, contract_check, test, checkpoint]
  releaseRequires: [checkpoint, test]
  tests:
    - { name: api-test, service: api, command: [run-tests] }
review:
  auto: false
`;

async function setupRepo(): Promise<void> {
  const source = path.join(root, 'project');
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await mkdir(path.join(source, 'api/src'), { recursive: true });
  await mkdir(path.join(source, 'web'), { recursive: true });
  await writeFile(path.join(source, 'studio.yaml'), STUDIO_YAML);
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  api: { build: ./api }\n  web: { build: ./web }\n');
  await writeFile(path.join(source, 'api/src/Order.java'), 'class Order {}\n');
  await writeFile(path.join(source, 'web/page.tsx'), 'export default function Page() { return null }\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  fake.root = source;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-reverify-'));
  fake.restarted = [];
  fake.testExit = 0;
  fake.duringTest = undefined;
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
  for (const [key, value] of [
    ['B_STUDIO_MODE', saved.mode],
    ['B_STUDIO_SESSIONS_DIR', saved.sessions],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > timeoutMs) throw new Error('시간 안에 끝나지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readySession(): Promise<string> {
  await setupRepo();
  const id = (await createSession('verifyproj', 'kim', 'copy')).id;
  await waitFor(() => getSnapshot(id)?.status === 'ready');
  // 에이전트 실행 하나로 게이트를 통과한 체크포인트를 남긴다
  const finished = new Promise<void>((resolve) => {
    const unsubscribe = subscribe(id, (event) => {
      if (event.type === 'run_finished') {
        unsubscribe();
        resolve();
      }
    });
  });
  sendMessage(id, '주문에 메모 필드 추가', {
    allowBreaking: false,
    scriptedTurns: [{ toolCalls: [{ name: 'write_file', input: { path: 'api/src/Order.java', content: 'class Order { String memo; }\n' } }] }, { text: '추가했습니다.' }],
  });
  await finished;
  expect(getSnapshot(id)!.checkpoints[0]!.passedStages).toContain('test');
  return id;
}

/** 다시 검증을 시작하고 끝난 기록을 돌려준다 */
async function reverify(id: string, by = 'lee'): Promise<Extract<StudioEvent, { type: 'reverify_finished' }>> {
  const events: StudioEvent[] = [];
  const unsubscribe = subscribe(id, (event) => events.push(event));
  await reverifySession(id, by);
  await waitFor(() => events.some((event) => event.type === 'reverify_finished'));
  unsubscribe();
  expect(events.find((event) => event.type === 'reverify_started')).toBeTruthy();
  return events.find((event): event is Extract<StudioEvent, { type: 'reverify_finished' }> => event.type === 'reverify_finished')!;
}

describe('다시 검증(#798)', () => {
  it('에이전트 실행 없이 지금 체크포인트를 같은 게이트로 처음부터 돌리고, 결과는 체크포인트를 만들지 않고 세션 기록에 남긴다', async () => {
    const id = await readySession();
    const before = getSnapshot(id)!.checkpoints;
    fake.restarted = [];

    const finished = await reverify(id, 'lee');

    expect(finished.record).toMatchObject({ sha: before[0]!.sha, shortSha: before[0]!.shortSha, by: 'lee', ok: true });
    expect(finished.record.passedStages).toEqual(expect.arrayContaining(['run', 'contract_check', 'test', 'review']));
    // 바뀐 파일이 없어도 처음부터: 관리 서비스를 모두 다시 띄운다
    expect([...new Set(fake.restarted)].sort()).toEqual(['api', 'web']);
    const after = getSnapshot(id)!;
    // 새 체크포인트를 만들지 않고, 통과 기록(트레일러)도 바꾸지 않는다 — 배포 조건은 이 기록을 받지 않는다
    expect(after.checkpoints.map((checkpoint) => [checkpoint.sha, checkpoint.passedStages])).toEqual(before.map((checkpoint) => [checkpoint.sha, checkpoint.passedStages]));
    expect(after.reverifications?.[0]).toMatchObject({ sha: before[0]!.sha, ok: true, by: 'lee' });
    expect(after.running).toBe(false);

    await stopSession(id).catch(() => {});
  }, 30_000);

  it('선언한 테스트가 지금은 실패하면 실패로 남기고, 체크포인트와 작업 복사본은 그대로 둔다', async () => {
    const id = await readySession();
    const before = getSnapshot(id)!.checkpoints;
    fake.testExit = 1;

    const finished = await reverify(id);

    expect(finished.record.ok).toBe(false);
    expect(finished.record.failed.map((check) => check.name)).toContain('api-test');
    expect(getSnapshot(id)!.checkpoints.map((checkpoint) => checkpoint.sha)).toEqual(before.map((checkpoint) => checkpoint.sha));

    await stopSession(id).catch(() => {});
  }, 30_000);

  it('작업 복사본에 체크포인트에 없는 변경이 있으면 돌리지 않는다(검증한 내용과 기록할 체크포인트가 달라진다)', async () => {
    const id = await readySession();
    await writeFile(path.join(getSnapshot(id)!.workDir, 'api/src/Order.java'), 'class Order { String other; }\n');

    await expect(reverifySession(id, 'lee')).rejects.toMatchObject({ status: 409 });
    expect(getSnapshot(id)!.running).toBe(false);

    await stopSession(id).catch(() => {});
  }, 30_000);

  it('지금 체크포인트가 아닌 것을 고르면 돌리지 않는다', async () => {
    const id = await readySession();
    const older = getSnapshot(id)!.checkpoints[1]!;

    await expect(reverifySession(id, 'lee', older.sha)).rejects.toMatchObject({ status: 409 });

    await stopSession(id).catch(() => {});
  }, 30_000);

  it('검사하는 동안 작업 복사본이 바뀌면 통과로 남기지 않는다', async () => {
    const id = await readySession();
    const workDir = getSnapshot(id)!.workDir;
    fake.duringTest = () => writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String changed; }\n');

    const finished = await reverify(id);

    expect(finished.record.ok).toBe(false);
    expect(finished.record.summary).toContain('바뀌');

    await stopSession(id).catch(() => {});
  }, 30_000);

  it('다른 작업이 도는 중이면 돌리지 않는다', async () => {
    const id = await readySession();
    getSnapshot(id)!.running = true;

    await expect(reverifySession(id, 'lee')).rejects.toMatchObject({ status: 409 });

    getSnapshot(id)!.running = false;
    await stopSession(id).catch(() => {});
  }, 30_000);
});
