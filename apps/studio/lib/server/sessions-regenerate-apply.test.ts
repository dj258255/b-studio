import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "이 세션에도 적용"(ADR-0XX)을 실제 sessions.ts·project-registry.ts 코드로 끝까지 돌려 본다.
 * 진짜로 하는 것: 폴더 등록(project-registry), 생성 파일 다시 만들기(project-detect), 세션 작업 복사본, restartServicesFor.
 * 가짜로 바꾸는 것: 샌드박스(Docker)뿐이다 — restart가 실제로 뭘 다시 띄우는지는 sandbox 쪽 책임이라, 여기서는
 * "어떤 서비스를 restart했는지"만 확인한다.
 */
const fake = vi.hoisted(() => ({ restartCalls: [] as string[] }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-regenerate-apply-fake',
    name: 'fake',
    async start() {
      return [];
    },
    async restart(service: string) {
      fake.restartCalls.push(service);
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

import { applyRegeneration, proposeRegeneration, registerFolder } from './project-registry';
import { applyRegeneratedFilesToSession, createSession, getSnapshot, stopSession } from './sessions';

const made: string[] = [];
const saved = {
  mode: process.env.B_STUDIO_MODE,
  auth: process.env.B_STUDIO_AUTH,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
  registry: process.env.B_STUDIO_PROJECT_REGISTRY,
  projects: process.env.B_STUDIO_PROJECTS_DIR,
};

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-regen-apply-'));
  made.push(dir);
  return dir;
}

const nextPackageNoLock = JSON.stringify({ name: 'shop', dependencies: { next: '16.0.0', react: '19.0.0' } });

beforeEach(async () => {
  const root = await tmp();
  fake.restartCalls = [];
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  process.env.B_STUDIO_PROJECT_REGISTRY = path.join(root, 'projects.json');
  process.env.B_STUDIO_PROJECTS_DIR = path.join(root, 'examples'); // 빈 폴더: 예제 프로젝트 스캔이 아무것도 못 찾게 한다
  await mkdir(process.env.B_STUDIO_PROJECTS_DIR, { recursive: true });
});

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    const envKey = `B_STUDIO_${key.toUpperCase()}`;
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
});

/** 폴더를 등록하고, pnpm 잠금 파일을 더해 "그사이 바뀜"을 만들고, 다시 만들기까지 적용해 written 목록을 돌려준다 */
async function registerAndRegenerate(): Promise<{ projectId: string; folder: string; written: string[] }> {
  const folder = await tmp();
  await writeFile(path.join(folder, 'package.json'), nextPackageNoLock);
  const registered = await registerFolder(folder, new Set());

  // 등록 뒤 pnpm으로 바꿈 — Dockerfile.b-studio 내용이 달라져야 "다시 만들기"가 쓸모 있다
  await writeFile(path.join(folder, 'pnpm-lock.yaml'), '');
  const proposal = await proposeRegeneration(registered.id);
  const changed = proposal.files.filter((file) => file.changed).map((file) => file.path);
  const { written } = await applyRegeneration(registered.id, changed);
  return { projectId: registered.id, folder, written };
}

async function waitForReady(id: string, timeoutMs = 10_000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const status = getSnapshot(id)?.status ?? 'missing';
    if (status === 'ready' || status === 'failed' || status === 'stopped') return status;
    if (Date.now() - started > timeoutMs) throw new Error(`세션이 준비되지 않았습니다 (${status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('applyRegeneratedFilesToSession(ADR-0XX, "이 세션에도 적용")', () => {
  it('작업 복사본 세션(copy)에 다시 만든 파일을 덮어쓰고 영향받은 서비스를 다시 띄운다', async () => {
    const { projectId, written } = await registerAndRegenerate();
    expect(written).toContain('Dockerfile.b-studio');

    const session = await createSession(projectId, 'kim', 'copy');
    expect(await waitForReady(session.id)).toBe('ready');

    const result = await applyRegeneratedFilesToSession(session.id, written);

    expect(result.restarted.map((check) => check.service)).toContain('web');
    expect(fake.restartCalls).toContain('web');
    const dockerfile = await readFile(path.join(session.workDir, 'Dockerfile.b-studio'), 'utf8');
    expect(dockerfile).toContain('pnpm install --frozen-lockfile');

    await stopSession(session.id).catch(() => {});
  }, 20_000);

  it('내 폴더 세션(local)은 이미 원본과 같은 폴더라 복사 없이도 서비스를 다시 띄운다', async () => {
    const { projectId, folder, written } = await registerAndRegenerate();

    const session = await createSession(projectId, 'kim', 'local');
    expect(await waitForReady(session.id)).toBe('ready');
    expect(session.workDir).toBe(folder);

    const result = await applyRegeneratedFilesToSession(session.id, written);
    expect(result.restarted.map((check) => check.service)).toContain('web');

    await stopSession(session.id).catch(() => {});
  }, 20_000);

  it('폴더로 열지 않은(등록하지 않은) 프로젝트의 세션에는 적용할 생성 파일이 없다고 거부한다', async () => {
    // 등록한 폴더(project-registry)가 아니라, 예제 폴더처럼 직접 studio.yaml을 둔 프로젝트다
    const projectId = 'plainapp';
    const folder = path.join(process.env.B_STUDIO_PROJECTS_DIR!, projectId);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'studio.yaml'), ['version: 1', 'name: plain', 'services:', '  web: { source: external, baseUrl: https://example.com }', ''].join('\n'));
    await writeFile(path.join(folder, 'compose.yaml'), 'services: {}\n');

    const session = await createSession(projectId, 'kim', 'copy');
    expect(await waitForReady(session.id)).toBe('ready');

    await expect(applyRegeneratedFilesToSession(session.id, ['studio.yaml'])).rejects.toMatchObject({ status: 409 });

    await stopSession(session.id).catch(() => {});
  }, 20_000);

  it('넘긴 파일이 없으면 아무것도 하지 않는다(재시작도 없다)', async () => {
    const { projectId } = await registerAndRegenerate();
    const session = await createSession(projectId, 'kim', 'copy');
    expect(await waitForReady(session.id)).toBe('ready');

    const result = await applyRegeneratedFilesToSession(session.id, []);
    expect(result).toEqual({ restarted: [], skippedOff: [] });
    expect(fake.restartCalls).toEqual([]);

    await stopSession(session.id).catch(() => {});
  }, 20_000);
});
