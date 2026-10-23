import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import type { StudioEvent } from '@/lib/studio-events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 대화 러너도 세션의 AI 계정(#885)으로 CLI를 띄우는지 본다. 샌드박스와 CLI 러너·로그인 확인은 가짜다 — 진짜 CLI를 부르지 않고,
 * 사용자의 ~/.claude·~/.codex는 읽지 않는다(임시 HOME).
 */
const fake = vi.hoisted(() => ({
  root: '',
  claude: [] as Array<{ env?: NodeJS.ProcessEnv }>,
  claudePreflight: [] as Array<{ env?: NodeJS.ProcessEnv }>,
  codex: [] as Array<{ authHome?: string }>,
  codexPreflight: [] as Array<{ env?: NodeJS.ProcessEnv } | undefined>,
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-account-fake',
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
    redact: (text: string) => text,
    findSecrets: () => [],
    async destroy() {},
  } as unknown as Sandbox;
  return { ...actual, providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox }) };
});

vi.mock('./projects', () => ({ findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root) }));

const result = { status: 'done', summary: '설명했습니다.', changedFiles: [], verifyAttempts: 0, turns: 1, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
vi.mock('@b-studio/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@b-studio/agent')>()),
  preflightClaudeCode: async (input: { env?: NodeJS.ProcessEnv }) => {
    fake.claudePreflight.push(input);
    return { ok: true as const, account: {} };
  },
  preflightCodex: async (input?: { env?: NodeJS.ProcessEnv }) => {
    fake.codexPreflight.push(input);
    return { ok: true as const };
  },
  runClaudeCodeAgent: async (options: { env?: NodeJS.ProcessEnv }) => {
    fake.claude.push({ env: options.env });
    return result;
  },
  runCodexAgent: async (options: { authHome?: string }) => {
    fake.codex.push({ authHome: options.authHome });
    return result;
  },
}));

import { addAiAccount } from './ai-accounts';
import { createSession, getSnapshot, sendMessage, stopSession, subscribe } from './sessions';

const keys = ['HOME', 'XDG_CONFIG_HOME', 'B_STUDIO_MODE', 'B_STUDIO_AUTH', 'B_STUDIO_BACKENDS', 'B_STUDIO_SESSIONS_DIR', 'B_STUDIO_GATEWAY'] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'b-studio-account-runner-'));
  const project = path.join(home, 'project');
  await mkdir(path.join(project, 'api/src'), { recursive: true });
  await writeFile(path.join(project, 'studio.yaml'), 'version: 1\nname: acctproj\nservices:\n  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }\nreview:\n  auto: false\n');
  await writeFile(path.join(project, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(project, 'api/src/Order.java'), 'class Order {}\n');
  fake.root = project;
  fake.claude = [];
  fake.claudePreflight = [];
  fake.codex = [];
  fake.codexPreflight = [];
  Object.assign(process.env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'xdg'),
    B_STUDIO_MODE: 'api',
    B_STUDIO_AUTH: 'none',
    B_STUDIO_BACKENDS: 'claude-code,codex',
    B_STUDIO_SESSIONS_DIR: path.join(home, 'sessions'),
    GIT_AUTHOR_NAME: 'acct',
    GIT_AUTHOR_EMAIL: 'acct@example.com',
    GIT_COMMITTER_NAME: 'acct',
    GIT_COMMITTER_EMAIL: 'acct@example.com',
  });
  delete process.env.B_STUDIO_GATEWAY;
});

afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function ask(id: string): Promise<Extract<StudioEvent, { type: 'run_finished' }>> {
  const started = Date.now();
  while (getSnapshot(id)?.status !== 'ready') {
    if (Date.now() - started > 20_000) throw new Error(`세션이 준비되지 않았습니다 (${getSnapshot(id)?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const events: StudioEvent[] = [];
  const unsubscribe = subscribe(id, (event) => events.push(event));
  sendMessage(id, '설명해 줘', { allowBreaking: false, intent: 'ask' });
  try {
    for (;;) {
      const finished = events.find((event): event is Extract<StudioEvent, { type: 'run_finished' }> => event.type === 'run_finished');
      if (finished) return finished;
      if (Date.now() - started > 20_000) throw new Error('실행이 끝나지 않았습니다');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    unsubscribe();
  }
}

describe('대화 러너도 세션의 AI 계정으로 띄운다(#885)', () => {
  it('claude-code: 로그인 확인과 러너가 계정의 CLAUDE_CONFIG_DIR을 받는다', async () => {
    const account = await addAiAccount({ name: '피오', backend: 'claude-code', configDir: '~/.claude-fio' });
    const id = (await createSession('acctproj', 'kim', 'copy', { backend: 'claude-code', accountId: account.id })).id;
    expect((await ask(id)).status).toBe('done');
    expect(fake.claudePreflight.at(-1)?.env?.CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude-fio'));
    expect(fake.claude[0]?.env?.CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude-fio'));
    await stopSession(id).catch(() => {});
  }, 40_000);

  it('codex: 로그인 확인은 계정의 CODEX_HOME으로, 러너는 그 폴더의 로그인 파일을 빌린다', async () => {
    const account = await addAiAccount({ name: '마르코', backend: 'codex', configDir: '~/.codex-marco' });
    const id = (await createSession('acctproj', 'kim', 'copy', { backend: 'codex', accountId: account.id })).id;
    expect((await ask(id)).status).toBe('done');
    expect(fake.codexPreflight.at(-1)?.env?.CODEX_HOME).toBe(path.join(home, '.codex-marco'));
    expect(fake.codex[0]?.authHome).toBe(path.join(home, '.codex-marco'));
    await stopSession(id).catch(() => {});
  }, 40_000);

  it('기본 계정은 지금처럼 환경을 따로 넘기지 않는다', async () => {
    const id = (await createSession('acctproj', 'kim', 'copy', { backend: 'codex' })).id;
    expect((await ask(id)).status).toBe('done');
    expect(fake.codex[0]?.authHome).toBeUndefined();
    expect(fake.codexPreflight.at(-1)).toBeUndefined();
    await stopSession(id).catch(() => {});
  }, 40_000);
});
