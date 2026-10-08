import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 도그푸딩 마찰 131: BE-commerce 세션(pay-2-5b640fd3)에서 에이전트가 실행 중 studio.yaml에 스키마에 맞지 않는
 * 값(workflow.autoPageChecks에 객체 대신 배열)을 썼다. 그 실행이 끝난 뒤에도 깨진 상태가 작업 복사본(생성 파일,
 * ADR-067이라 git 추적 밖)에 그대로 남아, 다음 "이어서 작업하기"가 loadProject()에서 막혀 사람이 직접 파일을
 * 고쳐야 했다. 이 테스트는 그 재개 경로가 실제 sessions.ts·CheckpointStore 코드로 끝까지 돌 때, 어느 필드가
 * 틀렸는지와 고칠 방법(마지막 체크포인트의 생성 파일 스냅샷 경로, ADR-141)을 오류에 담아 돌려주는지 본다.
 * 가짜로 바꾸는 것은 샌드박스(Docker)뿐이다.
 */
const fake = vi.hoisted(() => ({ root: '' }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-resume-spec-error-fake',
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

import { createSession, getSnapshot, resumeSession, stopSession } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
};

function studioYaml(autoPageChecks: string): string {
  return `version: 1
name: genfilesproj
services:
  web: { source: managed, template: nextjs, path: web, port: 3000, preview: browser }
workflow:
  autoPageChecks: ${autoPageChecks}
`;
}

const validAutoPageChecks = '{ service: web, mode: http }';
const brokenAutoPageChecks = '[web]'; // 실측과 같은 모양의 실수(객체 대신 배열)

/** 폴더 열기(ADR-067)가 만든 뒤 `.git/info/exclude`로 뺀 것처럼, studio.yaml을 원본 저장소에서도 git 추적 밖에 둔다 */
async function setupFolderOpenedProject(): Promise<void> {
  const source = path.join(root, 'project');
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await writeFile(path.join(source, '.git/info/exclude'), '/studio.yaml\n');
  await writeFile(path.join(source, 'studio.yaml'), studioYaml(validAutoPageChecks));
  await mkdir(path.join(source, 'web'), { recursive: true });
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  web: { build: ./web }\n');
  await execFileAsync('git', ['-C', source, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'add', '-A']);
  await execFileAsync('git', ['-C', source, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init']);
  fake.root = source;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-resume-spec-error-'));
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

describe('resumeSession과 형식이 틀린 studio.yaml(도그푸딩 마찰 131)', () => {
  it('중지한 동안 studio.yaml이 스키마에 맞지 않게 남으면, 어느 필드가 틀렸는지와 마지막 체크포인트 스냅샷 경로를 담아 거부한다', async () => {
    await setupFolderOpenedProject();
    const id = (await createSession('genfilesproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const snapshot = getSnapshot(id)!;
    const workDir = snapshot.workDir;
    const headSha = snapshot.checkpoints[0]!.sha;

    await stopSession(id);
    // 중지한 동안(또는 되돌리지 못한 실행 뒤) 생성 파일인 studio.yaml이 깨진 채로 작업 복사본에 남는다(git 추적 밖이라 되돌아가지 않는다)
    await writeFile(path.join(workDir, 'studio.yaml'), studioYaml(brokenAutoPageChecks));

    let error: { status: number; message: string } | undefined;
    await resumeSession(id).catch((caught: unknown) => {
      error = caught as { status: number; message: string };
    });
    expect(error).toMatchObject({ status: 400, message: expect.stringContaining('workflow.autoPageChecks') });

    // 복구 안내가 가리키는 마지막 체크포인트 스냅샷(ADR-141)에는 실제로 고칠 수 있는 옛(유효한) 내용이 있다
    const snapshotPath = path.join(workDir, '.git', 'b-studio', 'excluded', headSha, 'files', 'studio.yaml');
    expect(error!.message).toContain(snapshotPath);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(snapshotPath, 'utf8')).toBe(studioYaml(validAutoPageChecks));
  }, 20_000);
});
