import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { IssueSummary, Requirement } from '@b-studio/agent';
import { serializeRequirementsMarkdown } from '@b-studio/agent';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * "PR 만들기"가 이미 발행한 요구사항 추적 이슈(ADR-092)의 본문 표를 지금 상태로 다시 쓰는지 실제 sessions.ts
 * 코드로 끝까지 돌려 본다(버그 리포트: 발행 당시 표가 "주기적으로 갱신"된다는 문구와 달리 그 표를 다시 쓰는 경로가
 * 없어, PR이 가리키는 추적 이슈가 항상 낡은 채로 남아 있었다).
 *
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 체크포인트, 요구사항 평가(getSessionRequirements).
 * 가짜로 바꾸는 것: 샌드박스(Docker)와 원격 이슈 API(listIssues·createPullRequest·updateIssue). 실제
 * 네트워크·GitHub·3000 포트 서버 호출은 없다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  bareRemote: '',
  issues: [] as IssueSummary[],
  listIssues: vi.fn(async () => [] as IssueSummary[]),
  createPullRequest: vi.fn(async () => ({ url: 'https://github.com/acme/trackrefresh/pull/42', number: 42, created: true })),
  updateIssue: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-tracking-refresh-fake',
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

vi.mock('@b-studio/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/agent')>();
  return {
    ...actual,
    listIssues: (...args: unknown[]) => (fake.listIssues as (...a: unknown[]) => unknown)(...args),
    createPullRequest: (...args: unknown[]) => (fake.createPullRequest as (...a: unknown[]) => unknown)(...args),
    updateIssue: (...args: unknown[]) => (fake.updateIssue as (...a: unknown[]) => unknown)(...args),
    // 원격 "origin"은 실제로는 로컬 bare 저장소다(git push가 네트워크를 타지 않게) — GitHub 주소로 바꿔치기해
    // 진짜 github.com에 쓰기 요청을 보내면 안 되므로(규칙), origin이 그 bare 경로를 가리킬 때만 github으로
    // 본다고 가짜로 답한다. 그 밖의 주소는 실제 parseRemote를 그대로 쓴다
    parseRemote: (url: string, env?: Record<string, string | undefined>) => {
      if (fake.bareRemote && url.includes(fake.bareRemote)) {
        return { kind: 'github' as const, display: 'github.com/acme/trackrefresh', host: 'github.com', path: 'acme/trackrefresh', webUrl: 'https://github.com/acme/trackrefresh' };
      }
      return actual.parseRemote(url, env);
    },
  };
});

import { createSession, exportSession, getSnapshot, previewExport, sendMessage, stopSession, subscribe } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
  token: process.env.B_STUDIO_GITHUB_TOKEN,
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  return stdout.trim();
}

function studioYaml(): string {
  return `version: 1
name: trackrefresh
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
workflow:
  required: [plan, implement, run, contract_check, checkpoint]
review:
  auto: false
`;
}

/** 요구사항 하나(사람이 직접 확인함 — ADR-103). rev·manualVerification만 있으면 gateChecks·testRun 없이도 검증됨으로 매겨진다 */
function verifiedRequirement(id: string): Requirement {
  return {
    id,
    title: `${id} 기능`,
    kind: 'api',
    priority: 'must',
    acceptance: ['동작한다'],
    rev: 1,
    manualVerification: { by: 'kim', at: '2026-01-01', sha: 'seed0001', note: '이전 세션에서 이미 확인했다' },
  };
}

const TRACKING_ISSUE = 999;
const SUB_ISSUE = 101;

/** "이미 이슈로 발행해 추적 이슈(#999)·하위 이슈(#101)가 있는" 상태를 main에 미리 심어 둔다 */
async function setupRepo(): Promise<void> {
  const remote = path.join(root, 'trackrefresh.git');
  const source = path.join(root, 'project');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await mkdir(path.join(source, 'api/src'), { recursive: true });
  await mkdir(path.join(source, 'docs'), { recursive: true });
  await writeFile(path.join(source, 'studio.yaml'), studioYaml());
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(source, 'api/src/Order.java'), 'class Order {}\n');

  const requirements = [verifiedRequirement('R2')];
  const statusById = { R2: '검증됨' as const };
  await writeFile(path.join(source, 'docs/requirements.md'), serializeRequirementsMarkdown(requirements, statusById));
  await writeFile(
    path.join(source, 'docs/requirements.issues.json'),
    `${JSON.stringify(
      {
        tracking: { issue: TRACKING_ISSUE, url: `https://github.com/acme/trackrefresh/issues/${TRACKING_ISSUE}` },
        byId: { R2: { issue: SUB_ISSUE, rev: 1, publishedHash: 'seed', publishedAt: '2026-01-01T00:00:00.000Z' } },
      },
      null,
      2,
    )}\n`,
  );

  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init (R2 이미 이슈로 발행됨)');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  fake.root = source;
  fake.bareRemote = remote;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-tracking-refresh-'));
  fake.listIssues.mockReset().mockImplementation(async () => fake.issues);
  fake.createPullRequest.mockReset().mockResolvedValue({ url: 'https://github.com/acme/trackrefresh/pull/42', number: 42, created: true });
  fake.updateIssue.mockReset().mockResolvedValue(undefined);
  fake.issues = [];

  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  process.env.B_STUDIO_GITHUB_TOKEN = 'ghp_test';
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
    ['B_STUDIO_GITHUB_TOKEN', saved.token],
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

/**
 * 파일을 바꾸고 턴을 끝내는 대본으로 요청을 보내고, 그 실행이 끝나기를 기다린다(한 번에 체크포인트 하나) —
 * exportSession이 "올릴 체크포인트가 없습니다"로 막히지 않으려면 세션 시작점 위에 커밋이 최소 하나 있어야 한다
 */
async function runWrite(id: string, request: string, file: string, content: string): Promise<void> {
  let armed = false;
  const finished = new Promise<void>((resolve) => {
    const unsubscribe = subscribe(id, (event) => {
      if (armed && event.type === 'run_finished') {
        unsubscribe();
        resolve();
      }
    });
    armed = true;
  });
  sendMessage(id, request, { allowBreaking: false, scriptedTurns: [{ toolCalls: [{ name: 'write_file', input: { path: file, content } }] }, { text: '완료했습니다.' }] });
  await finished;
}

async function readySession(): Promise<string> {
  await setupRepo();
  const id = (await createSession('trackrefresh', 'kim', 'copy')).id;
  expect(await waitForReady(id)).toBe('ready');
  // origin은 그대로 로컬 bare 저장소를 가리킨다(실제 push가 네트워크를 타지 않는다) — 위 가짜 parseRemote가
  // 이 경로를 github으로 본다고 답해 requirementIssuesContext·lookupIssues가 github 경로를 타게 한다
  await runWrite(id, '[R2] 세부 사항을 고친다', 'api/src/OrderDetail.java', 'class OrderDetail {}\n');
  return id;
}

describe('PR 만들기와 요구사항 추적 이슈 갱신', () => {
  it('PR을 만들 때 추적 이슈 본문 갱신 호출이 나가고, 이슈를 다시 열지 않는다(본문만 고친다)', async () => {
    const id = await readySession();

    const result = await exportSession(id, { pullRequest: true, issues: [] });

    expect(result.pullRequest).toEqual({ url: 'https://github.com/acme/trackrefresh/pull/42', created: true });
    expect(result.requirementsTrackingWarning).toBeUndefined();

    const trackingCall = fake.updateIssue.mock.calls.find((call) => call[1] === TRACKING_ISSUE);
    expect(trackingCall).toBeDefined();
    const [, , input] = trackingCall!;
    expect((input as { body: string }).body).toContain('검증됨');
    expect((input as { body: string }).body).toContain(`#${SUB_ISSUE}`);
    // 본문만 고친다 — state를 주지 않으면 GitHub·Gitea 둘 다 닫힌 이슈를 다시 열지 않는다
    expect(input).not.toHaveProperty('state');

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('추적 이슈 갱신이 실패해도 PR 만들기 결과는 그대로 성공하고, 경고만 남긴다', async () => {
    const id = await readySession();
    fake.updateIssue.mockRejectedValue(new Error('네트워크 오류'));

    const result = await exportSession(id, { pullRequest: true, issues: [] });

    expect(result.pullRequest).toEqual({ url: 'https://github.com/acme/trackrefresh/pull/42', created: true });
    expect(result.pullRequestError).toBeUndefined();
    expect(result.requirementsTrackingWarning).toContain('네트워크 오류');

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('미리보기는 추적 이슈 갱신을 예고만 하고 원격에 쓰지 않는다', async () => {
    const id = await readySession();

    const preview = await previewExport(id, { issues: [] });

    expect(fake.updateIssue).not.toHaveBeenCalled();
    expect(fake.createPullRequest).not.toHaveBeenCalled();
    const check = preview.checks.find((item) => item.id === 'tracking_issue_refresh');
    expect(check).toBeDefined();
    expect(check!.detail).toContain(`#${TRACKING_ISSUE}`);

    await stopSession(id).catch(() => {});
  }, 20_000);
});
