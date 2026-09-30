import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 대화 입력창의 모델 선택(sessionModelPicker·setSessionModel)이 실제 세션 스냅샷을 읽고 쓰는지 확인한다.
 * 샌드박스는 sessions-lazy.test.ts와 같은 방식으로 가짜로 바꾸고, 나머지(체크포인트·프로젝트 로딩)는 실제 코드를 쓴다.
 */
const fake = vi.hoisted(() => ({ root: '' }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-model-fake',
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

// claude-code 백엔드는 세션을 만들 때 실제 CLI 로그인을 확인한다(preflightClaudeCode). 이 테스트는 모델 선택 목록·저장만
// 보므로 CLI를 부르지 않고 바로 통과시킨다(sessions-lazy.test.ts가 샌드박스를 가짜로 바꾸는 것과 같은 이유)
vi.mock('@b-studio/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/agent')>();
  return { ...actual, preflightClaudeCode: async () => ({ ok: true as const }) };
});

import { createSession, sessionModelPicker, setSessionModel, stopSession } from './sessions';
import { StudioError } from './errors';
import { projectEffortDefault, projectModelDefault, resetProjectModelDefaultsCache } from './model-defaults';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  backend: process.env.B_STUDIO_BACKENDS,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
  defaultsFile: process.env.B_STUDIO_MODEL_DEFAULTS_FILE,
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-model-session-'));
  await mkdir(path.join(root, 'project', 'api'), { recursive: true });
  await writeFile(
    path.join(root, 'project', 'studio.yaml'),
    `version: 1
name: modelproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
`,
  );
  await writeFile(path.join(root, 'project', 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  fake.root = path.join(root, 'project');
  process.env.B_STUDIO_MODE = 'claude-code';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  process.env.B_STUDIO_MODEL_DEFAULTS_FILE = path.join(root, 'model-defaults.json');
  delete process.env.B_STUDIO_BACKENDS;
  resetProjectModelDefaultsCache();
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'model', GIT_AUTHOR_EMAIL: 'model@example.com', GIT_COMMITTER_NAME: 'model', GIT_COMMITTER_EMAIL: 'model@example.com' });
});

afterAll(() => {
  for (const [key, value] of [
    ['B_STUDIO_MODE', saved.mode],
    ['B_STUDIO_BACKENDS', saved.backend],
    ['B_STUDIO_SESSIONS_DIR', saved.sessions],
    ['B_STUDIO_MODEL_DEFAULTS_FILE', saved.defaultsFile],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('sessionModelPicker / setSessionModel', () => {
  it('처음에는 "기본"이 고른 값이고, claude-code 별칭 목록을 돌려준다', async () => {
    const { id } = await createSession('modelproj', 'kim', 'copy', { boot: 'on-demand' });

    const picker = await sessionModelPicker(id);

    expect(picker.backend).toBe('claude-code');
    expect(picker.current).toBeUndefined();
    expect(picker.options.map((option) => option.id)).toEqual(['', 'auto', 'opus', 'sonnet', 'haiku']);
    await stopSession(id).catch(() => {});
  });

  it('모델을 바꾸면 세션 스냅샷에 남고, 다음 조회에 그대로 나온다', async () => {
    const { id } = await createSession('modelproj', 'kim', 'copy', { boot: 'on-demand' });

    const result = await setSessionModel(id, 'opus');

    expect(result.current).toBe('opus');
    expect((await sessionModelPicker(id)).current).toBe('opus');
    await stopSession(id).catch(() => {});
  });

  it('빈 문자열로 바꾸면 "기본"으로 되돌아간다(undefined)', async () => {
    const { id } = await createSession('modelproj', 'kim', 'copy', { boot: 'on-demand' });
    await setSessionModel(id, 'sonnet');

    const result = await setSessionModel(id, '');

    expect(result.current).toBeUndefined();
    await stopSession(id).catch(() => {});
  });

  it('이 백엔드에서 고를 수 없는 값은 400으로 거부하고 세션을 바꾸지 않는다', async () => {
    const { id } = await createSession('modelproj', 'kim', 'copy', { boot: 'on-demand' });

    await expect(setSessionModel(id, 'gpt-5')).rejects.toThrow(StudioError);
    expect((await sessionModelPicker(id)).current).toBeUndefined();
    await stopSession(id).catch(() => {});
  });

  it('바꾼 모델을 이 프로젝트·백엔드의 다음 새 세션 기본값으로 남긴다', async () => {
    const { id } = await createSession('modelproj', 'kim', 'copy', { boot: 'on-demand' });

    await setSessionModel(id, 'haiku');

    expect(projectModelDefault('modelproj', 'claude-code')).toBe('haiku');
    await stopSession(id).catch(() => {});
  });

  it('노력 단계를 바꾸면 세션 스냅샷에 남고, 이 프로젝트·백엔드의 다음 새 세션 기본값으로도 남긴다', async () => {
    const { id } = await createSession('modelproj', 'kim', 'copy', { boot: 'on-demand' });

    const result = await setSessionModel(id, 'sonnet', 'high');

    expect(result.effort.current).toBe('high');
    expect((await sessionModelPicker(id)).effort.current).toBe('high');
    expect(projectEffortDefault('modelproj', 'claude-code')).toBe('high');
    await stopSession(id).catch(() => {});
  });

  it('modelId를 넘기지 않고 effort만 바꿀 수 있다(지금 모델은 그대로 둔다)', async () => {
    const { id } = await createSession('modelproj', 'kim', 'copy', { boot: 'on-demand' });
    await setSessionModel(id, 'opus');

    const result = await setSessionModel(id, undefined, 'low');

    expect(result.current).toBe('opus');
    expect(result.effort.current).toBe('low');
    await stopSession(id).catch(() => {});
  });

  it('effort를 넘기지 않으면(undefined) 지금 노력 단계를 그대로 둔다', async () => {
    const { id } = await createSession('modelproj', 'kim', 'copy', { boot: 'on-demand' });
    await setSessionModel(id, 'opus', 'max');

    const result = await setSessionModel(id, 'sonnet');

    expect(result.effort.current).toBe('max');
    await stopSession(id).catch(() => {});
  });

  it('이 백엔드에서 고를 수 없는 노력 단계는 400으로 거부하고 세션을 바꾸지 않는다', async () => {
    const { id } = await createSession('modelproj', 'kim', 'copy', { boot: 'on-demand' });

    await expect(setSessionModel(id, 'sonnet', 'ultra')).rejects.toThrow(StudioError);
    expect((await sessionModelPicker(id)).effort.current).toBeUndefined();
    await stopSession(id).catch(() => {});
  });
});
