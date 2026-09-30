import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * main 따라잡기(ADR-076)를 실제 sessions.ts 코드로 끝까지 돌려 본다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소(로컬 bare 원격), 체크포인트, 검증 게이트, `catchUpBase`·`resolveBaseConflictsWithAgent`·`exportSession`.
 * 가짜로 바꾸는 것: 샌드박스(Docker)와 원격 GitHub API(createPullRequest). 실제 네트워크·Docker 호출은 없다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  sourceRoot: '',
  remote: '',
  execCalls: [] as string[][],
  createPullRequest: vi.fn(async () => ({ url: 'https://github.com/acme/verifyproj/pull/1', number: 1, created: true })),
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-base-catch-up-fake',
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
    async exec(_service: string, command: string[]) {
      fake.execCalls.push(command);
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

vi.mock('@b-studio/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/agent')>();
  return { ...actual, createPullRequest: (...args: unknown[]) => (fake.createPullRequest as (...a: unknown[]) => unknown)(...args) };
});

import { baseStatus, catchUpBase, createSession, exportSession, getSnapshot, resolveBaseConflictsWithAgent, sendMessage, stopSession, subscribe } from './sessions';
import type { StudioEvent } from '@/lib/studio-events';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
  gitName: process.env.B_STUDIO_GIT_AUTHOR_NAME,
  gitEmail: process.env.B_STUDIO_GIT_AUTHOR_EMAIL,
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  return stdout.trim();
}

function studioYaml(autoCatchUp?: boolean): string {
  return `version: 1
name: verifyproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
workflow:
  required: [plan, implement, run, contract_check, checkpoint]
  releaseRequires: [checkpoint]
review:
  auto: false
${autoCatchUp === undefined ? '' : `repository:\n  autoCatchUp: ${autoCatchUp}\n`}`;
}

/** 원격(bare) 저장소와, 거기서 시작한 프로젝트 폴더를 만든다. autoCatchUp을 생략하면 studio.yaml에 repository 절 자체를 넣지 않는다(기본값 켬을 그대로 확인한다) */
async function setupRepo({ autoCatchUp }: { autoCatchUp?: boolean } = {}): Promise<void> {
  const remote = path.join(root, 'orders.git');
  const source = path.join(root, 'project');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await mkdir(path.join(source, 'api/src'), { recursive: true });
  await writeFile(path.join(source, 'studio.yaml'), studioYaml(autoCatchUp));
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(source, 'api/src/Order.java'), 'class Order {}\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  fake.root = source;
  fake.sourceRoot = source;
  fake.remote = remote;
}

/** main 브랜치(기준 브랜치)에 다른 사람이 커밋을 올린다 */
async function pushToBase(file: string, content: string, message: string): Promise<string> {
  const other = await mkdtemp(path.join(root, 'main-writer-'));
  await execFileAsync('git', ['clone', '-q', '--branch', 'main', fake.remote, other]);
  await mkdir(path.dirname(path.join(other, file)), { recursive: true });
  await writeFile(path.join(other, file), content);
  await git(other, 'add', '-A');
  await git(other, 'commit', '-q', '-m', message);
  await git(other, 'push', '-q', 'origin', 'HEAD');
  return git(other, 'rev-parse', 'HEAD');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-base-catch-up-'));
  fake.execCalls = [];
  fake.createPullRequest.mockClear();

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
  const entries: Array<[string, string | undefined]> = [
    ['B_STUDIO_MODE', saved.mode],
    ['B_STUDIO_SESSIONS_DIR', saved.sessions],
    ['B_STUDIO_GIT_AUTHOR_NAME', saved.gitName],
    ['B_STUDIO_GIT_AUTHOR_EMAIL', saved.gitEmail],
  ];
  for (const [key, value] of entries) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > timeoutMs) throw new Error('시간 안에 끝나지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 파일을 바꾸고 턴을 끝내는 대본으로 요청을 보내고, 그 실행이 끝나기를 기다린다 */
async function runWrite(id: string, content: string): Promise<void> {
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
    scriptedTurns: [{ toolCalls: [{ name: 'write_file', input: { path: 'api/src/Order.java', content } }] }, { text: '메모 필드를 추가했습니다.' }],
  });
  await finished;
}

describe('main 따라잡기(ADR-076)', () => {
  it('baseStatus는 기준 브랜치가 앞서 있는 커밋 수를 센다(60초 안에는 다시 가져오지 않는다)', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    expect(await baseStatus(id)).toMatchObject({ base: 'main', behind: 0 });

    await pushToBase('CHANGELOG.md', '# changes\n', 'main 변경');
    expect(await baseStatus(id)).toMatchObject({ base: 'main', behind: 0 }); // throttle 안이라 아직 못 본다
    expect(await baseStatus(id, { force: true })).toMatchObject({ base: 'main', behind: 1 });

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('catchUpBase는 병합으로 따라잡아 체크포인트를 남기고, PR이 있으면 바로 다시 올린다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    await runWrite(id, 'class Order { String memo; }\n');
    await exportSession(id, { pullRequest: true, review: false });
    expect(getSnapshot(id)?.repository?.pullRequestUrl).toBe('https://github.com/acme/verifyproj/pull/1');

    await pushToBase('CHANGELOG.md', '# changes\n', 'main 변경');

    catchUpBase(id);
    await waitFor(() => !getSnapshot(id)?.running);

    const snapshot = getSnapshot(id)!;
    expect(snapshot.checkpoints[0]).toMatchObject({ message: 'main을 따라잡는다 (1커밋)' });
    // PR이 있었으므로 병합한 체크포인트를 바로 다시 올렸다
    expect(snapshot.repository?.pushedSha).toBe(snapshot.checkpoints[0]!.sha);

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('main과 같은 곳을 고쳐 충돌하면 사람에게 넘기고(요청 문구 없음), 에이전트에게 맡기면 대화에 채울 요청 문구를 만든다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    await runWrite(id, 'class Order { String mine; }\n');

    await pushToBase('api/src/Order.java', 'class Order { String main; }\n', 'main 변경');

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));

    catchUpBase(id);
    await waitFor(() => !getSnapshot(id)?.running);
    const failed = events.findLast((event) => event.type === 'base_sync_failed');
    expect(failed).toMatchObject({ conflicts: ['api/src/Order.java'] });
    expect(failed && 'agentRequest' in failed ? failed.agentRequest : undefined).toBeUndefined();

    const resolved = await resolveBaseConflictsWithAgent(id);
    expect(resolved.conflicts).toEqual(['api/src/Order.java']);
    expect(resolved.request).toContain('main 브랜치를 병합해 따라잡으려 했지만');
    expect(resolved.request).toContain('api/src/Order.java');
    // 자동으로 보내지는 않는다 — 대화에 요청이 접수(run_started)되지 않았다
    expect(getSnapshot(id)!.running).toBe(false);

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('repository.autoCatchUp(기본 켬)이면 올리기 전에 조용히 기준 브랜치를 따라잡는다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    await runWrite(id, 'class Order { String memo; }\n');

    await pushToBase('CHANGELOG.md', '# changes\n', 'main 변경');

    const result = await exportSession(id, { pullRequest: false, review: false });
    const checkpoints = getSnapshot(id)!.checkpoints;
    expect(checkpoints.some((checkpoint) => checkpoint.message === 'main을 따라잡는다 (1커밋)')).toBe(true);
    expect(result.sha).toBe(checkpoints[0]!.sha);
    expect((await baseStatus(id, { force: true })).behind).toBe(0);

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('repository.autoCatchUp: false면 올리기 전에 따라잡지 않는다', async () => {
    await setupRepo({ autoCatchUp: false });
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    await runWrite(id, 'class Order { String memo; }\n');

    await pushToBase('CHANGELOG.md', '# changes\n', 'main 변경');

    await exportSession(id, { pullRequest: false, review: false });
    const checkpoints = getSnapshot(id)!.checkpoints;
    expect(checkpoints.some((checkpoint) => checkpoint.message.includes('따라잡는다'))).toBe(false);
    expect((await baseStatus(id, { force: true })).behind).toBe(1);

    await stopSession(id).catch(() => {});
  }, 20_000);
});
