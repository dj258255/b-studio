import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../studio-events';

const run = promisify(execFile);

/**
 * 요청 실행의 끝 결정(ADR-208, 4f B3b). 샌드박스(Docker)·CLI 러너·로그인 확인은 가짜이고 임시 폴더만 쓴다(실제 모델·docker·네트워크 없음).
 * 가짜 러너가 작업 복사본의 파일을 바꾸고 결과를 돌려준다. 끝 결정은 그 결과와 세션의 사실(켠 세션인지·상태·취소·멈춤)로 정해진다.
 */
interface RunnerOptions {
  signal: AbortSignal;
  ensureSandbox?: () => Promise<void>;
}
const fake = vi.hoisted(() => ({
  root: '',
  startError: undefined as string | undefined,
  startCalls: 0,
  script: undefined as undefined | ((options: RunnerOptions) => Promise<Record<string, unknown>>),
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-outcome-fake-abcdef',
    name: 'fake',
    async start() {
      fake.startCalls += 1;
      if (fake.startError) throw new Error(fake.startError);
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
    async *logs() {
      yield* [];
    },
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

vi.mock('@b-studio/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@b-studio/agent')>()),
  preflightClaudeCode: async () => ({ ok: true as const, account: {} }),
  runClaudeCodeAgent: (options: RunnerOptions) => fake.script!(options),
}));

import { cancelRun, createSession, getSnapshot, sendMessage, stopSession, subscribe } from './sessions';

interface Internals {
  project: { root: string };
  checkpoints: { stagedFingerprints: (files: string[]) => Promise<Map<string, string>>; pendingExcludedFiles: () => Promise<string[]> };
}

let root: string;
const saved = { mode: process.env.B_STUDIO_MODE, backend: process.env.B_STUDIO_BACKENDS, sessions: process.env.B_STUDIO_SESSIONS_DIR, usage: process.env.B_STUDIO_USAGE_DIR };
const opened: Array<() => void> = [];
const ids: string[] = [];

function internals(id: string): Internals {
  return (globalThis as { __bStudio?: { sessions: Map<string, Internals> } }).__bStudio!.sessions.get(id)!;
}

async function until(condition: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`기다린 조건이 되지 않았습니다: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const result = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ status: 'done', summary: '했습니다.', changedFiles: [], verifyAttempts: 0, turns: 1, usage, ...over });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-run-outcome-'));
  await mkdir(path.join(root, 'project', 'api'), { recursive: true });
  await writeFile(
    path.join(root, 'project', 'studio.yaml'),
    `version: 1
name: outcomeproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
review:
  auto: false
`,
  );
  await writeFile(path.join(root, 'project', 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  fake.root = path.join(root, 'project');
  fake.startError = undefined;
  fake.startCalls = 0;
  fake.script = undefined;
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_BACKENDS = 'claude-code';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  process.env.B_STUDIO_USAGE_DIR = path.join(root, 'usage');
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'outcome', GIT_AUTHOR_EMAIL: 'outcome@example.com', GIT_COMMITTER_NAME: 'outcome', GIT_COMMITTER_EMAIL: 'outcome@example.com' });
});

afterEach(async () => {
  for (const close of opened.splice(0)) close();
  for (const id of ids.splice(0)) await stopSession(id).catch(() => {});
});

afterAll(() => {
  for (const [key, value] of [['B_STUDIO_MODE', saved.mode], ['B_STUDIO_BACKENDS', saved.backend], ['B_STUDIO_SESSIONS_DIR', saved.sessions], ['B_STUDIO_USAGE_DIR', saved.usage]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function open(boot: 'on-demand' | 'eager'): Promise<{ id: string; events: StudioEvent[] }> {
  const id = (await createSession('outcomeproj', 'kim', 'copy', { backend: 'claude-code', boot })).id;
  ids.push(id);
  await until(() => getSnapshot(id)?.status === (boot === 'eager' ? 'ready' : 'idle'), `상태 ${boot}`);
  const events: StudioEvent[] = [];
  opened.push(subscribe(id, (event) => events.push(event)));
  return { id, events };
}

type Finished = Extract<StudioEvent, { type: 'run_finished' }>;
const finishedOf = (events: StudioEvent[]): Finished | undefined => events.find((event): event is Finished => event.type === 'run_finished');
const noticesOf = (events: StudioEvent[]): string[] => events.flatMap((event) => (event.type === 'notice' ? [event.text] : []));
const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false);

async function commitCount(dir: string): Promise<number> {
  const { stdout } = await run('git', ['-C', dir, 'rev-list', '--count', 'HEAD']);
  return Number(stdout.trim());
}

const build = (id: string) => sendMessage(id, '파일을 만들어 줘', { allowBreaking: false, intent: 'build', steering: true });

describe('결함 1: 샌드박스를 켜지 않은 세션의 done', () => {
  it('켜지 않은 채 파일을 바꾸고 done으로 끝나면 검증하지 않은 변경을 남기지 않고 되돌린다', async () => {
    const { id, events } = await open('on-demand');
    const dir = internals(id).project.root;
    const before = await commitCount(dir);
    fake.script = async () => {
      await writeFile(path.join(dir, 'ghost.txt'), '검증하지 않은 내용\n');
      return result({ changedFiles: ['ghost.txt'] });
    };
    build(id);
    await until(() => finishedOf(events) !== undefined, 'run_finished');

    expect(fake.startCalls).toBe(0);
    expect(await exists(path.join(dir, 'ghost.txt'))).toBe(false);
    expect(await commitCount(dir)).toBe(before);
    expect(finishedOf(events)?.status).toBe('error');
    expect(finishedOf(events)?.summary).toContain('ghost.txt');
  });

  it('바꾼 것이 없으면 아무것도 하지 않고 done이다(경계)', async () => {
    const { id, events } = await open('on-demand');
    fake.script = async () => result();
    build(id);
    await until(() => finishedOf(events) !== undefined, 'run_finished');
    expect(finishedOf(events)?.status).toBe('done');
    expect(noticesOf(events).join('\n')).not.toContain('되돌');
  });
});

describe('결함 2: 실행 도중 샌드박스를 켜다 실패해 failed가 된 세션', () => {
  it('바뀐 파일을 되돌리지 않았다면(샌드박스 쪽 실패) 남아 있다고 알린다', async () => {
    fake.startError = '도커 데몬에 닿지 않습니다';
    const { id, events } = await open('on-demand');
    const dir = internals(id).project.root;
    fake.script = async (options) => {
      await options.ensureSandbox!().catch(() => {});
      await writeFile(path.join(dir, 'partial.txt'), '켜지 못한 채 바뀐 내용\n');
      return result({ status: 'failed', summary: '샌드박스를 켜지 못했습니다', changedFiles: ['partial.txt'] });
    };
    build(id);
    await until(() => finishedOf(events) !== undefined, 'run_finished');

    expect(getSnapshot(id)?.status).toBe('failed');
    // ADR-131: 샌드박스 쪽 문제로 검증하지 못한 변경은 되돌리지 않는다. 대신 남아 있다는 것과 이유를 알린다
    expect(await exists(path.join(dir, 'partial.txt'))).toBe(true);
    expect(noticesOf(events).join('\n')).toContain('partial.txt');
  });

  it('오류로 끝나도 같다', async () => {
    fake.startError = '도커 데몬에 닿지 않습니다';
    const { id, events } = await open('on-demand');
    const dir = internals(id).project.root;
    fake.script = async (options) => {
      await options.ensureSandbox!().catch(() => {});
      await writeFile(path.join(dir, 'partial.txt'), '켜지 못한 채 바뀐 내용\n');
      throw new Error('러너가 죽었습니다');
    };
    build(id);
    await until(() => finishedOf(events) !== undefined, 'run_finished');
    expect(finishedOf(events)?.status).toBe('error');
    expect(await exists(path.join(dir, 'partial.txt'))).toBe(true);
    expect(noticesOf(events).join('\n')).toContain('partial.txt');
  });
});

describe('결함 3: 체크포인트를 저장하려던 때 멈춘 세션', () => {
  it('저장을 시작하기 전에 멈췄으면 멈춘 세션에 새 체크포인트를 남기지 않는다', async () => {
    const { id, events } = await open('eager');
    const session = internals(id);
    const dir = session.project.root;
    const before = await commitCount(dir);
    let reached!: () => void;
    const gateReached = new Promise<void>((resolve) => (reached = resolve));
    let open_!: () => void;
    const gate = new Promise<void>((resolve) => (open_ = resolve));
    const original = session.checkpoints.pendingExcludedFiles.bind(session.checkpoints);
    // 저장 단계의 첫 읽기에서 붙잡는다(체크포인트 저장 안: 점유는 저장 중이다)
    session.checkpoints.pendingExcludedFiles = async () => {
      reached();
      await gate;
      return original();
    };
    fake.script = async () => {
      await writeFile(path.join(dir, 'verified.txt'), '검증한 내용\n');
      return result({ changedFiles: ['verified.txt'], verifiedFingerprints: Object.fromEntries(await session.checkpoints.stagedFingerprints(['verified.txt'])) });
    };
    build(id);
    await gateReached;
    expect(getSnapshot(id)?.running).toBe(true);
    await stopSession(id);
    open_();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(getSnapshot(id)?.status).toBe('stopped');
    // 멈춘 뒤에는 알림도 체크포인트도 없다
    expect(finishedOf(events)).toBeUndefined();
    expect(await commitCount(dir)).toBe(before);
  });

  it('러너가 돌아오기 전에 멈췄어도 새 체크포인트를 남기지 않고 알리지도 않는다', async () => {
    const { id, events } = await open('eager');
    const session = internals(id);
    const dir = session.project.root;
    const before = await commitCount(dir);
    fake.script = async () => {
      await writeFile(path.join(dir, 'verified.txt'), '검증한 내용\n');
      const fingerprints = Object.fromEntries(await session.checkpoints.stagedFingerprints(['verified.txt']));
      await stopSession(id);
      return result({ changedFiles: ['verified.txt'], verifiedFingerprints: fingerprints });
    };
    build(id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(getSnapshot(id)?.status).toBe('stopped');
    expect(finishedOf(events)).toBeUndefined();
    expect(await commitCount(dir)).toBe(before);
  });

  it('멈추지 않으면 저장한다(경계)', async () => {
    const { id, events } = await open('eager');
    const session = internals(id);
    const dir = session.project.root;
    const before = await commitCount(dir);
    fake.script = async () => {
      await writeFile(path.join(dir, 'verified.txt'), '검증한 내용\n');
      return result({ changedFiles: ['verified.txt'], verifiedFingerprints: Object.fromEntries(await session.checkpoints.stagedFingerprints(['verified.txt'])) });
    };
    build(id);
    await until(() => finishedOf(events) !== undefined, 'run_finished');
    expect(finishedOf(events)?.status).toBe('done');
    expect(await commitCount(dir)).toBe(before + 1);
    expect(await readFile(path.join(dir, 'verified.txt'), 'utf8')).toContain('검증한 내용');
  });
});

describe('결함 4: 켜지 않은 세션의 취소 글', () => {
  it('아무것도 바꾸지 않고 취소하면 되돌리지 못했다고 말하지 않는다', async () => {
    const { id, events } = await open('on-demand');
    let started!: () => void;
    const startedGate = new Promise<void>((resolve) => (started = resolve));
    fake.script = (options) =>
      new Promise((_, reject) => {
        started();
        options.signal.addEventListener('abort', () => reject(options.signal.reason ?? new Error('중단')));
      });
    const { runId } = build(id);
    await startedGate;
    cancelRun(id, runId);
    await until(() => finishedOf(events) !== undefined, 'run_finished');
    const finished = finishedOf(events)!;
    expect(finished.status).toBe('cancelled');
    expect(finished.summary).not.toContain('되돌리지 못했습니다');
    expect(finished.summary).not.toContain('undefined');
  });
});
