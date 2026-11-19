import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** 가짜 제공자·프로젝트가 쓰는 상태. vi.mock 팩토리에서 쓰려고 hoisted로 둔다 */
const fake = vi.hoisted(() => ({ root: '' }));

// 샌드박스(Docker)를 띄우지 않는다. providerFromEnv만 가짜로 바꾸고 나머지는 그대로 쓴다(세션 만들기·중지·체크포인트는 실제 코드가 돈다)
vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-trust-fake',
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

// 프로젝트 탐색만 임시 폴더의 studio.yaml로 바꾼다(작업 복사본·체크포인트·기동 흐름은 실제 코드가 돈다)
vi.mock('./projects', () => ({
  findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root),
}));

// 로그인 확인만 가짜로 바꾼다(실제 claude·모델을 부르지 않는다)
vi.mock('@b-studio/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@b-studio/agent')>()),
  preflightClaudeCode: async () => ({ ok: true as const, account: {} }),
}));

import { addAiAccount } from './ai-accounts';
import { createSession, deleteSession, sessionFolderTrustFailure, sessionHistory, stopSession } from './sessions';

// 복사 모드 세션의 폴더를 claude의 폴더 신뢰에 적고 지운다(ADR-222). 모든 설정 파일은 임시 폴더 안의 것이다 — 실제 ~/.claude.json은 읽지도 쓰지도 않는다
const keys = ['HOME', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'B_STUDIO_CLAUDE_CONFIG_DIR', 'B_STUDIO_MODE', 'B_STUDIO_AUTH', 'B_STUDIO_BACKENDS', 'B_STUDIO_SESSIONS_DIR', 'B_STUDIO_TERMINAL'] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let root: string;
let defaultConfig: string;

async function makeProject(projectDir: string, name: string): Promise<void> {
  await mkdir(path.join(projectDir, 'api', 'src'), { recursive: true });
  await writeFile(
    path.join(projectDir, 'studio.yaml'),
    `version: 1
name: ${name}
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
`,
  );
  await writeFile(path.join(projectDir, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(projectDir, 'api', 'src', 'Order.java'), 'class Order {}\n');
}

async function readJson(file: string): Promise<{ projects: Record<string, unknown>; [key: string]: unknown }> {
  return JSON.parse(await readFile(file, 'utf8'));
}

const exists = (target: string) => stat(target).then(() => true, () => false);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-folder-trust-'));
  defaultConfig = path.join(root, '.claude.json');
  await writeFile(defaultConfig, JSON.stringify({ numStartups: 3, projects: { '/elsewhere': { hasTrustDialogAccepted: true } } }, null, 2));
  // 기본 계정의 설정 파일은 홈의 .claude.json이다(터미널에는 서버의 CLAUDE_CONFIG_DIR이 넘어가지 않는다)
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.B_STUDIO_CLAUDE_CONFIG_DIR;
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_BACKENDS = 'claude-code';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  delete process.env.B_STUDIO_TERMINAL;
  Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' });
  const projectDir = path.join(root, 'project');
  await makeProject(projectDir, 'trustproj');
  fake.root = projectDir;
});

afterAll(() => {
  for (const key of keys) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('복사 모드 세션의 폴더 신뢰', () => {
  it('만들면 세션 폴더(실제 경로)를 적고, 지우면 그 기록만 지운다', async () => {
    const created = await createSession('trustproj', 'kim', 'copy');
    const key = await realpath(created.workDir);
    let config = await readJson(defaultConfig);
    expect(config.projects[key]).toEqual({ hasTrustDialogAccepted: true });
    expect(config.projects['/elsewhere']).toEqual({ hasTrustDialogAccepted: true });
    expect(config.numStartups).toBe(3);
    expect(sessionFolderTrustFailure(created.id)).toBeUndefined();

    await stopSession(created.id);
    await deleteSession(created.id);
    config = await readJson(defaultConfig);
    expect(Object.keys(config.projects)).toEqual(['/elsewhere']);
    expect(config.numStartups).toBe(3);
  });

  it('사용자가 연 로컬 폴더는 적지 않는다', async () => {
    const before = await readFile(defaultConfig, 'utf8');
    const created = await createSession('trustproj', 'kim', 'local');
    expect(await readFile(defaultConfig, 'utf8')).toBe(before);
    expect(sessionFolderTrustFailure(created.id)).toBeUndefined();
    await stopSession(created.id);
    await deleteSession(created.id);
    expect(await readFile(defaultConfig, 'utf8')).toBe(before);
  });

  it('설정 파일이 없으면 만들지 않고 사유만 남긴다(세션 알림은 내지 않는다 — 터미널 레인이 안내한다)', async () => {
    const { rm } = await import('node:fs/promises');
    await rm(defaultConfig);
    const created = await createSession('trustproj', 'kim', 'copy');
    expect(await exists(defaultConfig)).toBe(false);
    expect(sessionFolderTrustFailure(created.id)).toContain('claude 설정 파일');
    expect(sessionHistory(created.id).some((event) => event.type === 'notice' && event.text.includes('폴더 신뢰'))).toBe(false);
    await stopSession(created.id);
    await deleteSession(created.id);
    expect(await exists(defaultConfig)).toBe(false);
  });

  it('JSON이 깨진 설정 파일은 건드리지 않는다', async () => {
    await writeFile(defaultConfig, '{ broken');
    const created = await createSession('trustproj', 'kim', 'copy');
    expect(await readFile(defaultConfig, 'utf8')).toBe('{ broken');
    expect(sessionFolderTrustFailure(created.id)).toContain('올바른 JSON이 아니라');
    // 파일은 있는데 못 쓴 경우는 사용자가 알 수 있게 알림을 남긴다
    expect(sessionHistory(created.id).some((event) => event.type === 'notice' && event.text.includes('폴더 신뢰를 적지 못했습니다'))).toBe(true);
    await stopSession(created.id);
    await deleteSession(created.id);
    expect(await readFile(defaultConfig, 'utf8')).toBe('{ broken');
  });

  it('컨테이너 방식 터미널은 이 컴퓨터의 설정 파일을 쓰지 않는다', async () => {
    process.env.B_STUDIO_TERMINAL = 'container';
    const before = await readFile(defaultConfig, 'utf8');
    const created = await createSession('trustproj', 'kim', 'copy');
    expect(await readFile(defaultConfig, 'utf8')).toBe(before);
    await stopSession(created.id);
    await deleteSession(created.id);
  });

  it('다른 계정의 세션은 그 계정의 설정 폴더 파일에 적고, 기본 계정의 파일은 건드리지 않는다', async () => {
    const accountDir = path.join(root, 'claude-fio');
    await mkdir(accountDir, { recursive: true });
    const accountConfig = path.join(accountDir, '.claude.json');
    await writeFile(accountConfig, JSON.stringify({ projects: {} }, null, 2));
    const account = await addAiAccount({ name: '피오', backend: 'claude-code', configDir: accountDir });
    const before = await readFile(defaultConfig, 'utf8');

    const created = await createSession('trustproj', 'kim', 'copy', { backend: 'claude-code', accountId: account.id });
    expect((await readJson(accountConfig)).projects[await realpath(created.workDir)]).toEqual({ hasTrustDialogAccepted: true });
    expect(await readFile(defaultConfig, 'utf8')).toBe(before);

    await stopSession(created.id);
    await deleteSession(created.id);
    expect((await readJson(accountConfig)).projects).toEqual({});
  });
});
