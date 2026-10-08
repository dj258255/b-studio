import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ModelClient } from '@b-studio/agent';
import { ScriptedModelClient } from '@b-studio/agent';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * PR 자동 리뷰 라운드(ADR-074)의 상태 기계를 실제 sessions.ts 코드로 끝까지 돌려 본다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소(로컬 bare 원격), 체크포인트, 검증 게이트, `runReviewRound`.
 * 가짜로 바꾸는 것: 샌드박스(Docker), 원격 GitHub API(createPullRequest·postComment), 모델 호출(clientForModel이 스크립트 모델을 준다).
 * 실제 네트워크·Docker·모델 호출은 없다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  sourceRoot: '',
  execExitCode: 0,
  execCalls: [] as string[][],
  modelQueue: [] as ModelClient[],
  createPullRequest: vi.fn(async () => ({ url: 'https://github.com/acme/verifyproj/pull/1', number: 1, created: true })),
  postComment: vi.fn(async (): Promise<{ url?: string }> => ({ url: 'https://github.com/acme/verifyproj/pull/1#issuecomment-1' })),
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-review-fake',
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
    async exec(_service: string, command: string[]) {
      fake.execCalls.push(command);
      return { exitCode: fake.execExitCode, stdout: '', stderr: fake.execExitCode === 0 ? '' : 'FAILED' };
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
    createPullRequest: (...args: unknown[]) => (fake.createPullRequest as (...a: unknown[]) => unknown)(...args),
    postComment: (...args: unknown[]) => (fake.postComment as (...a: unknown[]) => unknown)(...args),
  };
});

vi.mock('./model-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./model-registry')>();
  const fakeModel = {
    id: 'fake',
    provider: 'anthropic' as const,
    model: 'fake',
    label: 'Fake',
    capabilities: ['tools'] as const,
    contextWindow: 200_000,
    pricing: { inputPerMillion: 0, outputPerMillion: 0 },
    baselineQuality: 0.5,
    baselineLatencyMs: 0,
  };
  return {
    ...actual,
    routingDecision: () => ({ selected: fakeModel, complexity: 'simple' as const, risk: 'normal' as const, inputTokens: 0, outputTokens: 0, candidates: [], reason: 'test' }),
    clientForModel: () => {
      const next = fake.modelQueue.shift();
      if (!next) throw new Error('테스트에 준비된 모델 응답이 없습니다(fake.modelQueue가 비었습니다)');
      return next;
    },
  };
});

import { createSession, exportSession, getSnapshot, resolveReviewFinding, runReviewRound, sendMessage, stopSession, subscribe } from './sessions';

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

function studioYaml(maxRounds?: number): string {
  return `version: 1
name: verifyproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
workflow:
  required: [plan, implement, run, contract_check, test, checkpoint]
  tests:
    - name: unit
      service: api
      command: [./gradlew, test]
  releaseRequires: [test, checkpoint]
${maxRounds === undefined ? '' : `review:\n  maxRounds: ${maxRounds}\n`}`;
}

/** 세션을 만들기 전에 studio.yaml의 라운드 상한을 바꾸고 커밋한다(clone은 커밋된 상태만 본다) */
async function useMaxRounds(maxRounds: number): Promise<void> {
  await writeFile(path.join(fake.sourceRoot, 'studio.yaml'), studioYaml(maxRounds));
  await git(fake.sourceRoot, 'add', '-A');
  await git(fake.sourceRoot, 'commit', '-q', '-m', 'maxRounds');
  await git(fake.sourceRoot, 'push', '-q', 'origin', 'main');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-review-session-'));
  fake.execCalls = [];
  fake.execExitCode = 0;
  fake.modelQueue = [];
  fake.createPullRequest.mockClear();
  fake.postComment.mockClear();
  fake.postComment.mockImplementation(async () => ({ url: 'https://github.com/acme/verifyproj/pull/1#issuecomment-1' }));

  // 원격(bare) 저장소와, 거기서 시작한 프로젝트 폴더. exportSession의 push·PR 흐름이 진짜 git으로 돈다(네트워크는 없다 — 로컬 경로)
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
  fake.sourceRoot = source;

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

async function waitForEvent(id: string, check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > timeoutMs) throw new Error('시간 안에 끝나지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 파일을 바꾸고 턴을 끝내는 대본으로 요청을 보내고, 그 실행이 끝나기를 기다린다 */
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

/** 첫 요청까지 마친 준비된 세션과, PR을 만들어 둔 상태를 만든다(review는 이 시점에 자동으로 돌리지 않는다) */
async function setupSessionWithPullRequest(): Promise<string> {
  const created = (await createSession('verifyproj', 'kim', 'copy')).id;
  expect(await waitForReady(created)).toBe('ready');
  await runWrite(created, 'class Order { String memo; }\n');
  await exportSession(created, { pullRequest: true, review: false });
  expect(getSnapshot(created)?.repository?.pullRequestUrl).toBe('https://github.com/acme/verifyproj/pull/1');
  return created;
}

const noFindings = () => JSON.stringify({ findings: [] });
const blockerFinding = () => JSON.stringify({ findings: [{ severity: 'blocker', file: 'api/src/Order.java', title: '문제', detail: '설명' }] });

describe('PR 자동 리뷰 라운드(ADR-074)', () => {
  it('1라운드에 차단·주요 지적이 없으면 사람 검토 대기(리뷰 통과)로 끝나고, PR에 댓글을 남긴다', async () => {
    const id = await setupSessionWithPullRequest();
    fake.modelQueue.push(new ScriptedModelClient([{ text: noFindings() }]));

    await runReviewRound(id);
    await waitForEvent(id, () => getSnapshot(id)?.review?.state === 'passed', 15_000);

    const review = getSnapshot(id)!.review!;
    expect(review.rounds).toHaveLength(1);
    expect(review.rounds[0]).toMatchObject({ round: 1, status: 'passed', commentUrl: 'https://github.com/acme/verifyproj/pull/1#issuecomment-1' });
    expect(fake.postComment).toHaveBeenCalledTimes(1);

    await stopSession(id).catch(() => {});
    // 같은 파일의 다른 테스트처럼 제한 시간을 준다. 세션 준비(git·PR 내보내기)와 리뷰가 기본 5초 안에 끝나야 해서,
    // 병렬 테스트 부하에서 자주 시간 초과로 실패했다(도그푸딩 마찰 91)
  }, 20_000);

  it('차단 지적이 있으면 고침을 요청해 검증을 통과시키고, 다음 라운드에서 통과로 끝난다', async () => {
    const id = await setupSessionWithPullRequest();
    // 리뷰어를 부르는 방법(ask)은 runReviewRound가 한 번만 만들어 라운드마다 다시 쓴다 — 그래서 리뷰어 응답은
    // 라운드 수만큼(1·2라운드 두 번) 한 client에 순서대로 담는다. 고침 요청은 sendMessage의 보통 경로라 따로 client를 쓴다
    fake.modelQueue.push(
      new ScriptedModelClient([{ text: blockerFinding() }, { text: noFindings() }]),
      new ScriptedModelClient([{ toolCalls: [{ name: 'write_file', input: { path: 'api/src/Order.java', content: 'class Order { String memo; String note; }\n' } }] }, { text: '고쳤습니다.' }]),
    );

    await runReviewRound(id);
    await waitForEvent(id, () => getSnapshot(id)?.review !== undefined && getSnapshot(id)!.review!.state !== 'running', 45_000);

    const review = getSnapshot(id)!.review!;
    expect(review.state).toBe('passed');
    expect(review.rounds.map((round) => round.status)).toEqual(['blocked_continue', 'passed']);
    expect(review.rounds[0]!.fixCheckpoint).toBeDefined();
    // 고침이 검증을 통과해 새 체크포인트로 남았다 — 요청 글의 공통 문구가 아니라 지적 제목("문제")으로 커밋 제목을 만든다(과제 66)
    expect(getSnapshot(id)!.checkpoints[0]!.message).toBe('fix: 리뷰 지적 1건 반영 — 문제');

    await stopSession(id).catch(() => {});
  }, 50_000);

  it('라운드 상한이 1이면 막는 지적이 있어도 고치지 않고 사람 검토 대기(라운드 상한)로 바로 끝난다', async () => {
    await useMaxRounds(1);
    const id = await setupSessionWithPullRequest();
    fake.modelQueue.push(new ScriptedModelClient([{ text: blockerFinding() }]));

    await runReviewRound(id);
    await waitForEvent(id, () => getSnapshot(id)?.review?.state === 'capped', 20_000);

    const review = getSnapshot(id)!.review!;
    expect(review.rounds).toHaveLength(1);
    expect(review.rounds[0]!.status).toBe('blocked_capped');
    // 상한이라 고침을 요청하지 않는다 — 고침을 시도했다면 준비해 둔 모델 응답이 없어 clientForModel이 던지고 라운드가 error로 끝났을 것이다
    expect(fake.modelQueue).toHaveLength(0);

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('고침 요청이 검증 게이트를 통과하지 못하면 멈추고(stopped) 사람에게 넘긴다', async () => {
    const id = await setupSessionWithPullRequest();
    fake.modelQueue.push(
      new ScriptedModelClient([{ text: blockerFinding() }]),
      new ScriptedModelClient([{ toolCalls: [{ name: 'write_file', input: { path: 'api/src/Order.java', content: 'class Order { String memo; String broken; }\n' } }] }, { text: '고쳤습니다.' }]),
    );
    fake.execExitCode = 1; // 이 라운드의 고침 요청부터 테스트 단계가 실패하게 한다

    await runReviewRound(id);
    await waitForEvent(id, () => getSnapshot(id)?.review?.state === 'stopped', 20_000);

    const review = getSnapshot(id)!.review!;
    expect(review.rounds.map((round) => round.status)).toEqual(['fix_failed']);
    expect(review.rounds[0]!.error).toBeTruthy();

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('라운드 상한에 걸린 지적을 사람이 오탐으로 닫으면 라운드는 "사람이 확인함"으로, 리뷰 상태는 resolved로 바뀌고 PR에 답글을 남긴다', async () => {
    await useMaxRounds(1);
    const id = await setupSessionWithPullRequest();
    fake.modelQueue.push(new ScriptedModelClient([{ text: blockerFinding() }]));

    await runReviewRound(id);
    await waitForEvent(id, () => getSnapshot(id)?.review?.state === 'capped', 20_000);
    fake.postComment.mockClear();

    const snapshot = await resolveReviewFinding(id, { round: 1, findingIndex: 0, reason: '실제 PostgreSQL에서 새 글 id 43·44 확인', by: 'kim' });
    expect(snapshot.review!.state).toBe('resolved');
    expect(snapshot.review!.rounds[0]).toMatchObject({ status: 'resolved_by_human' });
    expect(snapshot.review!.rounds[0]!.humanResolutions?.[0]).toMatchObject({ reason: '실제 PostgreSQL에서 새 글 id 43·44 확인', by: 'kim' });
    expect(fake.postComment).toHaveBeenCalledTimes(1);
    expect((fake.postComment.mock.calls[0] as unknown[])[2]).toContain('새 글 id 43·44 확인');

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('지적을 찾지 못하거나 이유가 비어 있으면 거부한다', async () => {
    await useMaxRounds(1);
    const id = await setupSessionWithPullRequest();
    fake.modelQueue.push(new ScriptedModelClient([{ text: blockerFinding() }]));

    await runReviewRound(id);
    await waitForEvent(id, () => getSnapshot(id)?.review?.state === 'capped', 20_000);

    await expect(resolveReviewFinding(id, { round: 1, findingIndex: 0, reason: '   ' })).rejects.toThrow('이유');
    await expect(resolveReviewFinding(id, { round: 1, findingIndex: 99, reason: '근거' })).rejects.toThrow('지적');
    await expect(resolveReviewFinding(id, { round: 99, findingIndex: 0, reason: '근거' })).rejects.toThrow('라운드');

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('PR 댓글 올리기가 실패해도 라운드는 멈추지 않고 commentError만 남긴다', async () => {
    const id = await setupSessionWithPullRequest();
    fake.postComment.mockRejectedValueOnce(new Error('B_STUDIO_GITHUB_TOKEN 토큰이 없어 댓글을 남길 수 없습니다'));
    fake.modelQueue.push(new ScriptedModelClient([{ text: noFindings() }]));

    await runReviewRound(id);
    await waitForEvent(id, () => getSnapshot(id)?.review?.state === 'passed');

    const review = getSnapshot(id)!.review!;
    expect(review.rounds[0]).toMatchObject({ status: 'passed', commentError: 'B_STUDIO_GITHUB_TOKEN 토큰이 없어 댓글을 남길 수 없습니다' });
    expect(review.rounds[0]!.commentUrl).toBeUndefined();

    await stopSession(id).catch(() => {});
  });
});
