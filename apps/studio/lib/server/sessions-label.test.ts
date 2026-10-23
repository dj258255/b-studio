import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 세션 이름(setSessionLabel, #864)이 실제 세션 스냅샷과 저장 기록에 남는지 확인한다.
 * 샌드박스는 sessions-lazy.test.ts와 같은 방식으로 가짜로 바꾸고, 나머지(체크포인트·프로젝트 로딩)는 실제 코드를 쓴다.
 */
const fake = vi.hoisted(() => ({ root: '' }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-label-fake',
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

// claude-code 백엔드는 세션을 만들 때 실제 CLI 로그인을 확인한다(preflightClaudeCode). 이 테스트는 세션 이름 저장만
// 보므로 CLI를 부르지 않고 바로 통과시킨다(sessions-lazy.test.ts가 샌드박스를 가짜로 바꾸는 것과 같은 이유).
// fetchClaudeCodeModels도 실제 CLI를 띄우므로 늘 실패하게 해 model-picker.ts가 알려진 대체 표(CLAUDE_CODE_ALIASES)로
// 되돌아가게 한다(SDK 응답 매핑 자체는 model-picker.test.ts가 별도로 확인한다)
vi.mock('@b-studio/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/agent')>();
  return {
    ...actual,
    preflightClaudeCode: async () => ({ ok: true as const }),
    fetchClaudeCodeModels: async () => {
      throw new Error('테스트에서는 실제 Claude Code를 부르지 않습니다');
    },
  };
});

import { createSession, getSnapshot, setSessionLabel, stopSession } from './sessions';
import { sessionFile, stateDirOf } from './session-store';
import { StudioError } from './errors';

let root: string;
const saved = { mode: process.env.B_STUDIO_MODE, backend: process.env.B_STUDIO_BACKENDS, sessions: process.env.B_STUDIO_SESSIONS_DIR };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-label-session-'));
  await mkdir(path.join(root, 'project', 'api'), { recursive: true });
  await writeFile(
    path.join(root, 'project', 'studio.yaml'),
    `version: 1
name: labelproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
`,
  );
  await writeFile(path.join(root, 'project', 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  fake.root = path.join(root, 'project');
  process.env.B_STUDIO_MODE = 'claude-code';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  delete process.env.B_STUDIO_BACKENDS;
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'label', GIT_AUTHOR_EMAIL: 'label@example.com', GIT_COMMITTER_NAME: 'label', GIT_COMMITTER_EMAIL: 'label@example.com' });
});

afterAll(() => {
  for (const [key, value] of [
    ['B_STUDIO_MODE', saved.mode],
    ['B_STUDIO_BACKENDS', saved.backend],
    ['B_STUDIO_SESSIONS_DIR', saved.sessions],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('setSessionLabel(#864)', () => {
  it('이름을 앞뒤 빈칸 없이 세션 스냅샷에 남기고, 멈춘 뒤에도 세션 기록에 남는다', async () => {
    const { id } = await createSession('labelproj', 'kim', 'copy', { boot: 'on-demand' });

    const snapshot = await setSessionLabel(id, '  결제 화면 고치기  ');

    expect(snapshot.label).toBe('결제 화면 고치기');
    expect(getSnapshot(id)?.label).toBe('결제 화면 고치기');
    const stopped = await stopSession(id);
    const saved = JSON.parse(await readFile(sessionFile(stateDirOf(stopped)), 'utf8')) as { snapshot: { label?: string } };
    expect(saved.snapshot.label).toBe('결제 화면 고치기');
  });

  it('빈 이름은 이름을 지운다', async () => {
    const { id } = await createSession('labelproj', 'kim', 'copy', { boot: 'on-demand' });
    await setSessionLabel(id, '첫 이름');

    const snapshot = await setSessionLabel(id, '   ');

    expect(snapshot.label).toBeUndefined();
    await stopSession(id).catch(() => {});
  });

  it('제어 글자는 빼고, 60자를 넘으면 400으로 거부하고 이름을 바꾸지 않는다', async () => {
    const { id } = await createSession('labelproj', 'kim', 'copy', { boot: 'on-demand' });

    expect((await setSessionLabel(id, '줄\n바꿈\x1b[31m')).label).toBe('줄바꿈[31m');
    await expect(setSessionLabel(id, '가'.repeat(61))).rejects.toThrow(StudioError);
    expect(getSnapshot(id)?.label).toBe('줄바꿈[31m');
    await stopSession(id).catch(() => {});
  });
});
