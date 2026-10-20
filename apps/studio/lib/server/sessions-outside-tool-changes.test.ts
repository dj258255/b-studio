import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import type { StudioEvent } from '@/lib/studio-events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 러너 실행도 "체크포인트로 남는 내용 = 게이트가 검증한 내용"이 되는지 본다(#758).
 * 진짜로 하는 것: 파일 시스템의 git 저장소·체크포인트·검증 게이트.
 * 가짜로 바꾸는 것: 샌드박스(Docker)와 모델(ScriptedModelClient, HTTP로는 받지 않는 서버 내부 경로).
 */
const fake = vi.hoisted(() => ({
  root: '',
  /** claude-code 러너가 대신 돌려줄 결과. 지문을 싣지 않는 러너를 흉내 낼 때 쓴다 */
  runner: undefined as undefined | ((root: string) => Promise<Record<string, unknown>>),
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-outside-fake',
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

// 실제 Claude Code CLI를 부르지 않고, 러너가 돌려주는 결과를 테스트가 정한다
vi.mock('@b-studio/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/agent')>();
  return {
    ...actual,
    preflightClaudeCode: async () => ({ ok: true as const }),
    runClaudeCodeAgent: async (options: { project: { root: string } }) => {
      if (!fake.runner) throw new Error('테스트에 준비된 러너 결과가 없습니다');
      return fake.runner(options.project.root);
    },
  };
});

import { createSession, getSnapshot, sendMessage, stopSession, subscribe } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
};

const EDITS = [
  { toolCalls: [{ name: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'class Order {}', new_text: 'class Order { String memo; }' } }] },
  { text: '메모 필드를 추가했습니다.' },
];

async function setupProject(withTests: boolean): Promise<void> {
  const projectRoot = path.join(root, 'project');
  await mkdir(path.join(projectRoot, 'api/src'), { recursive: true });
  const workflow = withTests
    ? `workflow:
  tests:
    - name: unit
      service: api
      command: ["./gradlew", "test"]
      maxAttempts: 1
`
    : '';
  await writeFile(
    path.join(projectRoot, 'studio.yaml'),
    `version: 1
name: outsideproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
${workflow}review:
  auto: false
`,
  );
  await writeFile(path.join(projectRoot, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(projectRoot, 'api/src/Order.java'), 'class Order {}\n');
  fake.root = projectRoot;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-outside-session-'));
  fake.runner = undefined;
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  delete process.env.B_STUDIO_GATEWAY;
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'outside',
    GIT_AUTHOR_EMAIL: 'outside@example.com',
    GIT_COMMITTER_NAME: 'outside',
    GIT_COMMITTER_EMAIL: 'outside@example.com',
    B_STUDIO_GIT_AUTHOR_NAME: 'outside',
    B_STUDIO_GIT_AUTHOR_EMAIL: 'outside@example.com',
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

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('기대한 상태가 되지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function runFinished(events: StudioEvent[]) {
  return events.find((event): event is Extract<StudioEvent, { type: 'run_finished' }> => event.type === 'run_finished');
}

/** 가짜 러너가 돌려줄 결과. 필요한 필드만 덮어쓴다 */
function agentResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'done',
    summary: '끝냈습니다.',
    changedFiles: [],
    verifyAttempts: 0,
    turns: 1,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...overrides,
  };
}

/** git이 스테이징할 때와 같은 blob 지문. 세션이 expectStaged에 쓰는 값과 같은 꼴이다 */
async function stagedFingerprint(workDir: string, file: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', workDir, 'hash-object', '--', file]);
  return `blob:${stdout.trim()}`;
}

describe('러너 실행의 체크포인트는 게이트가 검증한 내용과 같아야 한다', () => {
  it('게이트를 통과하면 검증한 내용의 지문과 함께 체크포인트를 남긴다', async () => {
    await setupProject(false);
    const id = (await createSession('outsideproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));

    sendMessage(id, '메모 필드 추가', { allowBreaking: false, scriptedTurns: [...EDITS] });
    const finished = await waitFor(() => runFinished(events));

    expect(finished.status).toBe('done');
    // 러너 결과에 게이트가 검증한 파일의 지문이 실린다(세션이 스테이징될 내용과 견주는 데 쓴다)
    const done = events.find((event) => event.type === 'agent' && event.event.type === 'done');
    const result = done?.type === 'agent' && done.event.type === 'done' ? done.event.result : undefined;
    expect(result?.verifiedFingerprints?.['api/src/Order.java']).toMatch(/^blob:/);
    expect(events.some((event) => event.type === 'checkpoint')).toBe(true);
    expect(getSnapshot(id)!.checkpoints).toHaveLength(2);

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('검증한 뒤에 파일이 바뀌면 체크포인트를 남기지 않고 되돌린다', async () => {
    await setupProject(false);
    const id = (await createSession('outsideproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;
    const events: StudioEvent[] = [];
    // 게이트가 통과한 뒤(agent done), 커밋하기 전에 백그라운드 프로세스가 추적되는 파일을 고치는 상황을 흉내 낸다.
    // 검사하는 동안 바뀐 파일은 게이트가 두 번째 sync로 먼저 잡으므로(#758), 세션의 마지막 견줌은 그 뒤에 바뀐 것을 본다
    const unsubscribe = subscribe(id, (event) => {
      events.push(event);
      if (event.type === 'agent' && event.event.type === 'done') {
        writeFileSync(path.join(workDir, 'api/src/Order.java'), 'class Order { String memo; String note; }\n');
      }
    });

    sendMessage(id, '메모 필드 추가', { allowBreaking: false, scriptedTurns: [...EDITS] });
    const finished = await waitFor(() => runFinished(events));

    // 성공으로 남지 않는다
    expect(finished.status).toBe('error');
    expect(finished.summary).toContain('검증한 뒤에 바뀐 파일이 있어 체크포인트를 남기지 않고 되돌렸습니다');
    expect(events.some((event) => event.type === 'notice' && event.text.includes('검증한 뒤에 바뀐 파일이 있어'))).toBe(true);
    // 체크포인트는 처음 하나뿐이고, 작업 복사본은 되돌아갔다
    expect(getSnapshot(id)!.checkpoints).toHaveLength(1);
    expect(await readFile(path.join(workDir, 'api/src/Order.java'), 'utf8')).toBe('class Order {}\n');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);
});

describe('지문을 싣지 않는 러너', () => {
  async function withClaudeCodeSession(body: (id: string, workDir: string) => Promise<void>): Promise<void> {
    process.env.B_STUDIO_MODE = 'claude-code';
    try {
      const id = (await createSession('outsideproj', 'kim', 'copy')).id;
      expect(await waitForReady(id)).toBe('ready');
      await body(id, getSnapshot(id)!.workDir);
      await stopSession(id).catch(() => {});
    } finally {
      process.env.B_STUDIO_MODE = 'api';
      fake.runner = undefined;
    }
  }

  it('지문 없이 done을 돌려주고 스테이징될 변경이 있으면 체크포인트 없이 되돌린다', async () => {
    await setupProject(false);
    fake.runner = async (workDir) => {
      await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String memo; }\n');
      return agentResult({ changedFiles: ['api/src/Order.java'] });
    };

    await withClaudeCodeSession(async (id, workDir) => {
      const events: StudioEvent[] = [];
      const unsubscribe = subscribe(id, (event) => events.push(event));

      sendMessage(id, '메모 필드 추가', { allowBreaking: false });
      const finished = await waitFor(() => runFinished(events));

      // 지문을 싣지 않은 결과라도 검증하지 않은 내용을 체크포인트로 남기지 않는다
      expect(finished.status).toBe('error');
      expect(finished.summary).toContain('검증한 뒤에 바뀐 파일이 있어 체크포인트를 남기지 않고 되돌렸습니다');
      expect(events.some((event) => event.type === 'notice' && event.text.includes('검증한 뒤에 바뀐 파일이 있어'))).toBe(true);
      expect(getSnapshot(id)!.checkpoints).toHaveLength(1);
      expect(await readFile(path.join(workDir, 'api/src/Order.java'), 'utf8')).toBe('class Order {}\n');

      unsubscribe();
    });
  }, 20_000);

  it('지문 없이 done이고 바뀐 파일도 없으면 지금처럼 끝난다', async () => {
    await setupProject(false);
    fake.runner = async () => agentResult();

    await withClaudeCodeSession(async (id) => {
      const events: StudioEvent[] = [];
      const unsubscribe = subscribe(id, (event) => events.push(event));

      sendMessage(id, '설명만 해줘', { allowBreaking: false });
      const finished = await waitFor(() => runFinished(events));

      expect(finished.status).toBe('done');
      expect(events.some((event) => event.type === 'checkpoint')).toBe(false);
      expect(getSnapshot(id)!.checkpoints).toHaveLength(1);

      unsubscribe();
    });
  }, 20_000);

  it('질문 전에 게이트를 통과한 awaiting_input에는 지문이 실려 체크포인트가 남는다', async () => {
    await setupProject(false);
    fake.runner = async (workDir) => {
      await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String memo; }\n');
      const fingerprint = await stagedFingerprint(workDir, 'api/src/Order.java');
      return agentResult({
        status: 'awaiting_input',
        summary: '계속할까요?',
        changedFiles: ['api/src/Order.java'],
        gateOutcome: 'pass',
        report: { ok: true, sync: { elapsedMs: 0 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] },
        checks: [],
        question: { question: '계속할까요?', options: ['예', '아니요'], allowOther: true },
        verifiedFingerprints: { 'api/src/Order.java': fingerprint },
      });
    };

    await withClaudeCodeSession(async (id) => {
      const events: StudioEvent[] = [];
      const unsubscribe = subscribe(id, (event) => events.push(event));

      sendMessage(id, '메모 필드 추가', { allowBreaking: false });
      const finished = await waitFor(() => runFinished(events));

      expect(finished.status).toBe('awaiting_input');
      expect(events.some((event) => event.type === 'checkpoint')).toBe(true);
      expect(getSnapshot(id)!.checkpoints).toHaveLength(2);
      expect(getSnapshot(id)!.pendingQuestion?.question).toBe('계속할까요?');

      unsubscribe();
    });
  }, 20_000);
});
