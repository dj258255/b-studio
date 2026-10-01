import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * createSession의 seedFromSessionId(ADR-096, 작업 분해 레인·통합이 프로젝트 원본이 아니라 다른 세션의 최신
 * 체크포인트에서 시작한다)를 실제 sessions.ts 코드로 끝까지 돌려 본다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 체크포인트, 요구사항 저장. 가짜로 바꾸는 것: 샌드박스(Docker)뿐이다.
 */
const fake = { root: '' };

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-seed-from-session-fake',
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

import { applySessionRequirements, createSession, getSnapshot, stopSession } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  return stdout.trim();
}

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

async function setupRepo(): Promise<string> {
  const remote = path.join(root, 'orders.git');
  const source = path.join(root, 'project');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await mkdir(path.join(source, 'api/src'), { recursive: true });
  await writeFile(path.join(source, 'studio.yaml'), studioYaml());
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(source, 'api/src/Order.java'), 'class Order {}\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  fake.root = source;
  return remote;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-seed-from-session-'));
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

const sample = { id: 'R1', title: '로그인', kind: 'api', priority: 'must', acceptance: ['a'] };

describe('createSession의 seedFromSessionId(ADR-096)', () => {
  it('레인·통합 세션은 프로젝트 원본이 아니라 원본 세션의 최신 체크포인트(저장한 요구사항 포함)에서 시작한다', async () => {
    await setupRepo();
    const originId = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(originId)).toBe('ready');
    // 요구사항을 저장하면 문서 체크포인트가 바로 작업 복사본에 남는다(세션 안에서는 저장만으로 충분하다)
    await applySessionRequirements(originId, { requirements: [sample] });
    const originWorkDir = getSnapshot(originId)!.workDir;
    // 원본 세션에서만 진행 중이던(아직 체크포인트 없는) 코드 변경도 하나 둔다 — 레인이 이 변경까지 가져가면 안 된다
    await writeFile(path.join(originWorkDir, 'api/src/Order.java'), 'class Order { String wip; }\n');

    const laneId = (await createSession('verifyproj', 'kim', 'copy', { seedFromSessionId: originId })).id;
    expect(await waitForReady(laneId)).toBe('ready');
    const lane = getSnapshot(laneId)!;

    // 레인은 요구사항 저장 체크포인트까지만 물려받는다(원본 세션의 아직 커밋하지 않은 코드 변경은 들어오지 않는다)
    expect(await readFile(path.join(lane.workDir, 'docs/requirements.md'), 'utf8')).toContain('로그인');
    expect(await readFile(path.join(lane.workDir, 'api/src/Order.java'), 'utf8')).toBe('class Order {}\n');
    // PR 대상 기준 브랜치는 원본 세션의 브랜치가 아니라 프로젝트가 실제로 갈라져 나온 기준 브랜치(main)를 물려받는다
    expect(lane.repository).toMatchObject({ base: 'main' });
    expect(lane.repository?.remote).toContain('orders.git');
    // 레인은 자기 자신의 새 세션 브랜치에서 시작한다(원본 세션 브랜치를 그대로 쓰지 않는다)
    expect(lane.repository?.branch).not.toBe(await git(originWorkDir, 'branch', '--show-current'));

    await stopSession(originId).catch(() => {});
    await stopSession(laneId).catch(() => {});
  }, 30_000);

  it('원본 세션이 "내 폴더에서" 세션(workspace: local)이면 조용히 건너뛰고 프로젝트 원본에서 시작한다', async () => {
    await setupRepo();
    const originId = (await createSession('verifyproj', 'kim', 'local')).id;
    expect(await waitForReady(originId)).toBe('ready');

    const laneId = (await createSession('verifyproj', 'kim', 'copy', { seedFromSessionId: originId })).id;
    expect(await waitForReady(laneId)).toBe('ready');
    const lane = getSnapshot(laneId)!;

    // 로컬 폴더 세션은 체크포인트가 별도 git(gitDir)에 있어 물려받지 못한다 — 지금처럼 프로젝트 원본에서 시작한다
    expect(lane.repository).toMatchObject({ base: 'main' });
    expect(await readFile(path.join(lane.workDir, 'api/src/Order.java'), 'utf8')).toBe('class Order {}\n');

    await stopSession(originId).catch(() => {});
    await stopSession(laneId).catch(() => {});
  }, 30_000);
});
