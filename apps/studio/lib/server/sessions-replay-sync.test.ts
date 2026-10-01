import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { createView, reduceSession } from '@/lib/session-view';
import type { StudioEvent } from '@/lib/studio-events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 59번 버그: 다시 연결하면 replay가 snapshot(지금 값)을 먼저 보낸 뒤 기록을 재생하는데, exported 같은 기록
 * 이벤트는 "그 순간" 서버가 계산한 값(canCreatePullRequest 등)을 그대로 담고 있어 재생하면 지금 값을 다시
 * 옛 값으로 덮어쓴다. 이어서 작업하기(resumeSession)는 describeRepository를 새로 불러 지금 스냅샷을 고치지만
 * 기록에는 새 이벤트를 남기지 않으므로(그 전 exported 이벤트가 그대로 남는다), 서버가 그사이(예: gh 토큰을
 * 새로 찾아) canCreatePullRequest를 다르게 계산하면 이 순서 문제가 그대로 재현된다.
 *
 * 진짜로 하는 것: 파일 시스템의 git 저장소(로컬 bare 원격), 체크포인트, exportSession·stopSession·resumeSession·
 * subscribe, 그리고 화면 쪽 reduceSession까지 실제 코드로 끝까지 돌려 재연결 뒤 화면에 남는 값을 확인한다.
 * 가짜로 바꾸는 것: 샌드박스(Docker)와 canCreatePullRequest(언제 불렀는지에 따라 다른 값을 돌려주게 해 "서버가
 * 그사이 다시 계산해 달라졌다"를 흉내 낸다). 실제 네트워크·Docker·GitHub 호출은 없다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  remote: '',
  /** describeRepository가 부를 때마다 이 값을 그대로 돌려준다(호출 때마다 바꿔 가며 "그사이 달라졌다"를 흉내 낸다) */
  canCreatePullRequest: false,
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-replay-sync-fake',
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

// gh CLI 토큰 찾기(canCreatePullRequest)만 통제한다. 나머지(parseRemote·describeRepository 본문 등)는 실제 코드 그대로 쓴다
vi.mock('@b-studio/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/agent')>();
  return { ...actual, canCreatePullRequest: () => fake.canCreatePullRequest };
});

import { createSession, exportSession, getSnapshot, resumeSession, sendMessage, sessionHistory, stopSession, subscribe } from './sessions';

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

function studioYaml(): string {
  return `version: 1
name: replayproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
workflow:
  required: [plan, implement, run, contract_check, checkpoint]
  releaseRequires: [checkpoint]
review:
  auto: false
`;
}

async function setupRepo(): Promise<void> {
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
  fake.remote = remote;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-replay-sync-'));
  fake.canCreatePullRequest = false;

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

/** 파일을 바꾸고 턴을 끝내는 대본으로 요청을 보내고, 그 실행이 끝나기를 기다린다(올릴 체크포인트를 만든다) */
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

describe('재연결 replay 순서(59번 버그: 기록 재생이 지금 스냅샷을 덮어쓰지 않는다)', () => {
  it('올릴 때는 PR을 만들 수 없었지만, 이어서 작업하며 다시 계산하면 재연결 화면은 지금 값(true)으로 끝난다', async () => {
    await setupRepo();
    const id = (await createSession('replayproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    await runWrite(id, 'class Order { String memo; }\n');

    // 올릴 때는 gh 토큰을 못 찾아 canCreatePullRequest:false로 기록된다
    fake.canCreatePullRequest = false;
    await exportSession(id, { pullRequest: false, review: false });
    expect(getSnapshot(id)?.repository?.canCreatePullRequest).toBe(false);

    await stopSession(id);

    // 서버가 그사이 gh 토큰을 새로 찾았다고 치자 — 이어서 작업하면 describeRepository를 다시 불러 지금 값을 true로 고친다
    fake.canCreatePullRequest = true;
    await resumeSession(id);
    expect(getSnapshot(id)?.repository?.canCreatePullRequest).toBe(true);

    // 기록에는 올릴 때 담았던 옛 값(false)이 그대로 남아 있다 — 이어서 작업하기는 새 exported 이벤트를 만들지 않는다
    const history = sessionHistory(id);
    const exported = history.find((event) => event.type === 'exported');
    expect(exported?.type === 'exported' && exported.repository.canCreatePullRequest).toBe(false);

    // 재연결(subscribe)은 snapshot(지금 값) → 기록(옛 값으로 되돌아감) → snapshot_sync(지금 값으로 다시 맞춤) 순서로 보낸다
    const received: StudioEvent[] = [];
    subscribe(id, (event) => received.push(event))();

    expect(received[0]?.type).toBe('snapshot');
    expect(received.at(-1)?.type).toBe('snapshot_sync');
    const exportedReplayed = received.find((event) => event.type === 'exported');
    expect(exportedReplayed?.type === 'exported' && exportedReplayed.repository.canCreatePullRequest).toBe(false);

    // 화면 reducer로 전부 접으면, 기록의 옛 값이 아니라 snapshot_sync가 다시 맞춘 지금 값(true)으로 끝난다
    const first = received[0];
    if (first?.type !== 'snapshot') throw new Error('첫 이벤트가 snapshot이 아닙니다');
    const view = received.reduce(reduceSession, createView(first.snapshot));
    expect(view.snapshot.repository?.canCreatePullRequest).toBe(true);

    await stopSession(id).catch(() => {});
  }, 20_000);
});
