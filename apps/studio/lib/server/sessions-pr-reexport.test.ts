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
 * "올리고 PR 만들기"를 이미 열린 PR에 다시 할 때의 문제 셋(버그 리포트 84·85·86)을 실제 sessions.ts 코드로
 * 끝까지 돌려 본다. 진짜로 하는 것: 파일 시스템의 git 저장소(로컬 bare 원격), 체크포인트, 검증 게이트,
 * `exportSession`·`previewExport`·AI 리뷰 라운드 상태 기계. 가짜로 바꾸는 것: 샌드박스(Docker), 원격
 * GitHub API(createPullRequest·updatePullRequestBody·postComment), 모델 호출(clientForModel이 스크립트 모델을
 * 준다). 실제 네트워크·Docker·모델 호출은 없다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  sourceRoot: '',
  modelQueue: [] as ModelClient[],
  createPullRequest: vi.fn(async () => ({ url: 'https://github.com/acme/verifyproj/pull/1', number: 1, created: true })),
  updatePullRequestBody: vi.fn(async (_remote: unknown, _number: number, managedBody: string) => ({ body: managedBody })),
  postComment: vi.fn(async (): Promise<{ url?: string }> => ({ url: 'https://github.com/acme/verifyproj/pull/1#issuecomment-1' })),
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-pr-reexport-fake',
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
    createPullRequest: (...args: unknown[]) => (fake.createPullRequest as (...a: unknown[]) => unknown)(...args),
    updatePullRequestBody: (...args: unknown[]) => (fake.updatePullRequestBody as (...a: unknown[]) => unknown)(...args),
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

import { createSession, exportSession, getSnapshot, previewExport, sendMessage, stopSession, subscribe } from './sessions';

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

function studioYaml(maxRounds = 2): string {
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
review:
  auto: true
  maxRounds: ${maxRounds}
`;
}

async function setupRepo(maxRounds = 2): Promise<void> {
  const remote = path.join(root, 'orders.git');
  const source = path.join(root, 'project');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await mkdir(path.join(source, 'api/src'), { recursive: true });
  await writeFile(path.join(source, 'studio.yaml'), studioYaml(maxRounds));
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(source, 'api/src/Order.java'), 'class Order {}\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  fake.root = source;
  fake.sourceRoot = source;
}

beforeEach(() => {
  fake.modelQueue = [];
  fake.createPullRequest.mockClear();
  fake.createPullRequest.mockImplementation(async () => ({ url: 'https://github.com/acme/verifyproj/pull/1', number: 1, created: true }));
  fake.updatePullRequestBody.mockClear();
  fake.updatePullRequestBody.mockImplementation(async (_remote: unknown, _number: number, managedBody: string) => ({ body: managedBody }));
  fake.postComment.mockClear();
  fake.postComment.mockImplementation(async () => ({ url: 'https://github.com/acme/verifyproj/pull/1#issuecomment-1' }));

  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'verify',
    GIT_AUTHOR_EMAIL: 'verify@example.com',
    GIT_COMMITTER_NAME: 'verify',
    GIT_COMMITTER_EMAIL: 'verify@example.com',
    B_STUDIO_GIT_AUTHOR_NAME: 'verify',
    B_STUDIO_GIT_AUTHOR_EMAIL: 'verify@example.com',
  });
});

async function freshRoot(): Promise<void> {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-pr-reexport-'));
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
}

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

async function waitForEvent(id: string, check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > timeoutMs) throw new Error('시간 안에 끝나지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 잠깐 기다려 "아무 일도 일어나지 않았다"를 확인한다(새 커밋이 없으면 리뷰가 돌지 않는다 같은 음성 조건용) */
async function settle(ms = 150): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWrite(id: string, request: string, content: string): Promise<void> {
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
  sendMessage(id, request, { allowBreaking: false, scriptedTurns: [{ toolCalls: [{ name: 'write_file', input: { path: 'api/src/Order.java', content } }] }, { text: '완료했습니다.' }] });
  await finished;
}

const noFindings = () => JSON.stringify({ findings: [] });
const blockerFinding = () => JSON.stringify({ findings: [{ severity: 'blocker', file: 'api/src/Order.java', title: '문제', detail: '설명' }] });

describe('이미 열린 PR에 다시 export하기(버그 리포트 85·86)', () => {
  it('85: 본문을 다시 쓴다 — 새 PR을 또 만들지 않고 updatePullRequestBody로 제목 없이 본문만 갱신하고, 지금까지의 커밋을 모두 반영한다', async () => {
    await freshRoot();
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    await runWrite(id, '메모 필드 추가', 'class Order { String memo; }\n');
    const first = await exportSession(id, { pullRequest: true, review: false });
    expect(first.pullRequest).toMatchObject({ url: 'https://github.com/acme/verifyproj/pull/1', created: true });
    expect(fake.createPullRequest).toHaveBeenCalledTimes(1);
    const firstBody = (fake.createPullRequest.mock.calls[0] as unknown[])[1] as { body: string };
    expect(firstBody.body).toContain('<!-- b-studio:begin -->');
    expect(firstBody.body).toContain('<!-- b-studio:end -->');
    expect(firstBody.body).toContain('메모 필드 추가');

    await runWrite(id, '메모 필드 검증 추가', 'class Order { String memo; String note; }\n');
    const second = await exportSession(id, { pullRequest: true, review: false });

    // 새 PR을 또 만들지 않는다 — createPullRequest는 여전히 한 번만 불렸다
    expect(fake.createPullRequest).toHaveBeenCalledTimes(1);
    expect(fake.updatePullRequestBody).toHaveBeenCalledTimes(1);
    expect(second.pullRequest).toEqual({ url: 'https://github.com/acme/verifyproj/pull/1', created: false, updated: true });

    const [, prNumber, updatedBody] = fake.updatePullRequestBody.mock.calls[0] as [unknown, number, string];
    expect(prNumber).toBe(1);
    // 리뷰 수정 커밋을 포함해(이번 테스트에서는 두 번째 요청) 본문이 지금 상태로 다시 쓰였다 — 첫 커밋 하나만 남아 있지 않다
    expect(updatedBody).toContain('메모 필드 추가');
    expect(updatedBody).toContain('메모 필드 검증 추가');
    expect(updatedBody).toContain('요청 2건');

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('85: 본문 갱신이 실패해도 push·PR 결과 자체는 뒤집지 않고 경고만 남긴다', async () => {
    await freshRoot();
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    await runWrite(id, '메모 필드 추가', 'class Order { String memo; }\n');
    await exportSession(id, { pullRequest: true, review: false });

    fake.updatePullRequestBody.mockRejectedValueOnce(new Error('403 권한 없음'));
    await runWrite(id, '메모 필드 검증 추가', 'class Order { String memo; String note; }\n');
    const result = await exportSession(id, { pullRequest: true, review: false });

    expect(result.sha).toBeTruthy();
    expect(result.pullRequestUpdateWarning).toBe('403 권한 없음');
    expect(result.pullRequest).toBeUndefined();

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('86: 이미 끝난 리뷰가 있는 PR에 새 커밋이 쌓이면, 처음부터 다시 돌지 않고 그 뒤 범위만 라운드를 이어 돈다(라운드 번호 증가, 커밋 범위 표시)', async () => {
    await freshRoot();
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    await runWrite(id, '메모 필드 추가', 'class Order { String memo; }\n');
    fake.modelQueue.push(new ScriptedModelClient([{ text: noFindings() }]));
    await exportSession(id, { pullRequest: true });
    await waitForEvent(id, () => getSnapshot(id)?.review?.state === 'passed');
    expect(getSnapshot(id)!.review!.rounds).toHaveLength(1);
    expect(fake.postComment).toHaveBeenCalledTimes(1);

    await runWrite(id, '메모 필드 검증 추가', 'class Order { String memo; String note; }\n');
    fake.modelQueue.push(new ScriptedModelClient([{ text: noFindings() }]));
    await exportSession(id, { pullRequest: true });
    await waitForEvent(id, () => (getSnapshot(id)?.review?.rounds.length ?? 0) >= 2);
    await waitForEvent(id, () => getSnapshot(id)?.review?.state === 'passed');

    const review = getSnapshot(id)!.review!;
    expect(review.rounds.map((round) => round.round)).toEqual([1, 2]);
    expect(review.rounds[1]).toMatchObject({ status: 'passed' });
    expect(review.rounds[1]!.sinceSha).toBe(review.rounds[0]!.headSha);
    expect(review.rounds[1]!.headSha).not.toBe(review.rounds[0]!.headSha);
    expect(fake.postComment).toHaveBeenCalledTimes(2);
    // 두 번째 라운드 코멘트에는 이번에 본 커밋 범위가 적혀 있다(첫 라운드에는 없다 — 세션 시작부터 보는 전체 리뷰다)
    expect((fake.postComment.mock.calls[0] as unknown[])[2] as string).not.toContain('커밋 범위');
    expect((fake.postComment.mock.calls[1] as unknown[])[2] as string).toContain('커밋 범위');

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('87: 끝 지점(headSha)을 기록하기 전에 끝난 옛 라운드도 그 라운드가 시작될 때의 HEAD부터 이어 돈다', async () => {
    await freshRoot();
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    await runWrite(id, '메모 필드 추가', 'class Order { String memo; }\n');
    fake.modelQueue.push(new ScriptedModelClient([{ text: noFindings() }]));
    await exportSession(id, { pullRequest: true });
    await waitForEvent(id, () => getSnapshot(id)?.review?.state === 'passed');
    const firstHead = getSnapshot(id)!.review!.rounds[0]!.headSha;
    expect(firstHead).toBeTruthy();
    // 이 기능 전에 끝난 라운드처럼 끝 지점 기록을 지운다
    delete getSnapshot(id)!.review!.rounds[0]!.headSha;
    // 커밋 시각은 초 단위다. 실제로는 리뷰 뒤 고침 커밋이 분 단위로 늦게 생기므로, 같은 초에 겹치지 않게 1초 넘게 띄운다
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    await runWrite(id, '메모 필드 검증 추가', 'class Order { String memo; String note; }\n');
    fake.modelQueue.push(new ScriptedModelClient([{ text: noFindings() }]));
    await exportSession(id, { pullRequest: true });
    await waitForEvent(id, () => (getSnapshot(id)?.review?.rounds.length ?? 0) >= 2);
    await waitForEvent(id, () => getSnapshot(id)?.review?.state === 'passed');

    const review = getSnapshot(id)!.review!;
    expect(review.rounds.map((round) => round.round)).toEqual([1, 2]);
    expect(review.rounds[1]!.sinceSha).toBe(firstHead);

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('86: 새 커밋이 없으면 리뷰를 다시 돌리지 않는다', async () => {
    await freshRoot();
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    await runWrite(id, '메모 필드 추가', 'class Order { String memo; }\n');
    fake.modelQueue.push(new ScriptedModelClient([{ text: noFindings() }]));
    await exportSession(id, { pullRequest: true });
    await waitForEvent(id, () => getSnapshot(id)?.review?.state === 'passed');

    fake.postComment.mockClear();
    // 새 커밋 없이 같은 요청을 다시 보낸다(모델 큐를 비워 둔다 — 리뷰를 다시 부르면 clientForModel이 바로 던진다)
    await exportSession(id, { pullRequest: true });
    await settle();

    const review = getSnapshot(id)!.review!;
    expect(review.rounds).toHaveLength(1);
    expect(review.state).toBe('passed');
    expect(fake.postComment).not.toHaveBeenCalled();

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('86: 라운드 상한에 이미 닿아 있으면 새로 리뷰를 부르지 않고 그 사실을 라운드 기록과 PR 코멘트로 남긴다(조용히 건너뛰지 않는다)', async () => {
    await freshRoot();
    await setupRepo(1); // maxRounds: 1
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    await runWrite(id, '메모 필드 추가', 'class Order { String memo; }\n');
    fake.modelQueue.push(new ScriptedModelClient([{ text: blockerFinding() }]));
    await exportSession(id, { pullRequest: true });
    await waitForEvent(id, () => getSnapshot(id)?.review?.state === 'capped');
    expect(getSnapshot(id)!.review!.rounds).toHaveLength(1);

    fake.postComment.mockClear();
    await runWrite(id, '메모 필드 검증 추가', 'class Order { String memo; String note; }\n');
    // reviewAsk가 clientForModel을 호출해 모델을 하나 받아 두지만(상한 분기는 그 모델을 실제로 부르지 않는다),
    // 미리 하나 채워 둬야 "모델이 없다" 오류로 멈추지 않고 상한 분기 자체를 본다
    fake.modelQueue.push(new ScriptedModelClient([{ text: noFindings() }]));
    await exportSession(id, { pullRequest: true });
    await waitForEvent(id, () => (getSnapshot(id)?.review?.rounds.length ?? 0) >= 2);

    const review = getSnapshot(id)!.review!;
    expect(review.state).toBe('capped');
    expect(review.rounds).toHaveLength(2);
    expect(review.rounds[1]).toMatchObject({ round: 2, status: 'blocked_capped' });
    expect(review.rounds[1]!.error).toContain('라운드 상한');
    expect(fake.postComment).toHaveBeenCalledTimes(1);
    expect((fake.postComment.mock.calls[0] as unknown[])[2] as string).toContain('라운드 상한');

    await stopSession(id).catch(() => {});
  }, 20_000);
});

describe('올리기 전 미리보기는 실제로 만든 PR 본문과 같은 점검 결과를 보인다(버그 리포트 84)', () => {
  it('미리보기(올리기 전)의 "작업 트리·원격" 항목이 실제 생성(올린 뒤)과 같은 결과(통과)로 나온다', async () => {
    await freshRoot();
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    await runWrite(id, '메모 필드 추가', 'class Order { String memo; }\n');

    const preview = await previewExport(id, {});
    expect(preview.body).not.toContain('아직 원격 브랜치에 올리지 않았습니다');

    await exportSession(id, { pullRequest: true, review: false });
    const actualBody = (fake.createPullRequest.mock.calls[0] as unknown[])[1] as { body: string };

    // 점검표 통과 수(예: "올리기 전 점검 9/9 통과")가 미리보기와 실제 생성에서 같다
    const score = (body: string) => /올리기 전 점검 (\d+)\/(\d+) 통과/.exec(body);
    const previewScore = score(preview.body);
    const actualScore = score(actualBody.body);
    expect(previewScore).not.toBeNull();
    expect(previewScore![0]).toBe(actualScore![0]);

    await stopSession(id).catch(() => {});
  }, 20_000);
});
