import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** 가짜 제공자·프로젝트가 쓰는 상태. vi.mock 팩토리에서 쓰려고 hoisted로 둔다 */
const fake = vi.hoisted(() => ({ root: '', execCalls: [] as string[][] }));

// 샌드박스(Docker)를 띄우지 않는다. providerFromEnv만 가짜로 바꾸고 나머지는 그대로 쓴다
vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-verify-fake',
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

// 프로젝트 탐색만 임시 폴더의 studio.yaml로 바꾼다(작업 복사본·체크포인트·게이트 흐름은 실제 코드가 돈다)
vi.mock('./projects', () => ({
  findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root),
}));

import { applySessionRequirements, createSession, deploySession, getSnapshot, releaseBasisCheckpoint, sendMessage, stopSession, subscribe } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
  gitName: process.env.B_STUDIO_GIT_AUTHOR_NAME,
  gitEmail: process.env.B_STUDIO_GIT_AUTHOR_EMAIL,
};

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-verify-session-'));
  await mkdir(path.join(root, 'project', 'api', 'src'), { recursive: true });
  await writeFile(
    path.join(root, 'project', 'studio.yaml'),
    `version: 1
name: verifyproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
workflow:
  required: [plan, implement, run, contract_check, test, review, checkpoint]
  tests:
    - name: unit
      service: api
      command: [./gradlew, test]
  releaseRequires: [test, checkpoint]
`,
  );
  await writeFile(path.join(root, 'project', 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(root, 'project', 'api', 'src', 'Order.java'), 'class Order {}\n');
  fake.root = path.join(root, 'project');
  fake.execCalls = [];
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  // 커밋 작성자와 체크포인트 저장소가 기대하는 작성자를 같게 맞춘다(다르면 트레일러를 신뢰하지 않는다)
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

/** 파일을 바꾸고 턴을 끝내는 대본. 게이트가 돌아야 완료로 인정된다 */
const writeTurns = [
  { toolCalls: [{ name: 'write_file', input: { path: 'api/src/Order.java', content: 'class Order { String memo; }\n' } }] },
  { text: '메모 필드를 추가했습니다.' },
];

async function runWrite(id: string, verify: 'light' | undefined): Promise<void> {
  const finished = new Promise<void>((resolve) => {
    const unsubscribe = subscribe(id, (event) => {
      if (event.type === 'run_finished') {
        unsubscribe();
        resolve();
      }
    });
  });
  sendMessage(id, '주문에 메모 필드 추가', { allowBreaking: false, ...(verify ? { verify } : {}), scriptedTurns: writeTurns });
  await finished;
}

describe('가볍게 확인(verify light)', () => {
  it('테스트 단계를 건너뛰고 계약까지만 확인해 체크포인트를 만든다(트레일러 표기 포함)', async () => {
    const created = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(created)).toBe('ready');
    fake.execCalls = [];

    await runWrite(created, 'light');

    const snapshot = getSnapshot(created)!;
    const checkpoint = snapshot.checkpoints[0]!;
    // conventional commits(ADR-080)가 기본으로 켜져 있어, 고침 낱말이 없는 요청은 feat: 접두어가 붙는다
    expect(checkpoint.message).toBe('feat: 주문에 메모 필드 추가');
    // 통과한 단계는 run·contract_check뿐이고, 가볍게 확인 표시가 남는다
    expect(checkpoint.passedStages).toEqual(['run', 'contract_check']);
    expect(checkpoint.verify).toBe('light');
    // 선언한 테스트(./gradlew test)는 돌지 않았다
    expect(fake.execCalls).toEqual([]);

    await stopSession(created).catch(() => {});
  });

  it('가볍게 확인한 체크포인트는 배포 조건(releaseRequires)을 채우지 못해 배포를 거부한다', async () => {
    const created = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(created)).toBe('ready');

    await runWrite(created, 'light');

    // releaseRequires에 test가 있는데 가볍게 확인은 test를 건너뛰었으므로 막혀야 하고, 안내가 나와야 한다
    expect(() => deploySession(created, { by: 'kim' })).toThrow(/배포 조건을 채우지 못했습니다.*test.*가볍게 확인한 체크포인트는 전체 검증 뒤 배포할 수 있습니다/s);

    await stopSession(created).catch(() => {});
  });

  it('전체 검증(full)은 지금처럼 테스트까지 돌려 배포 조건을 채운다', async () => {
    const created = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(created)).toBe('ready');
    fake.execCalls = [];

    await runWrite(created, undefined);

    const checkpoint = getSnapshot(created)!.checkpoints[0]!;
    expect(checkpoint.passedStages).toEqual(expect.arrayContaining(['run', 'contract_check', 'test', 'review']));
    expect(checkpoint.verify).toBeUndefined();
    // 선언한 테스트가 실제로 돌았다
    expect(fake.execCalls).toEqual([[ './gradlew', 'test' ]]);

    await stopSession(created).catch(() => {});
  });
});

describe('배포 조건은 코드가 같은 체크포인트의 통과 기록을 본다(도그푸딩 마찰 166)', () => {
  const full = { sha: 'c2', passedStages: ['run', 'test'] };
  const first = { sha: 'c0' };
  const requirementsDoc = { sha: 'd1', verify: 'docs', files: ['docs/requirements.md'], outsideFiles: 0 };

  it('요구사항 기록만 바꾼 문서 체크포인트는 건너뛰고 그 앞의 가장 최근 체크포인트를 본다', () => {
    expect(releaseBasisCheckpoint([requirementsDoc, full, first], requirementsDoc)).toBe(full);
    // 문서 체크포인트가 여러 개 쌓여도 같다
    const another = { ...requirementsDoc, sha: 'd2' };
    expect(releaseBasisCheckpoint([another, requirementsDoc, full, first], another)).toBe(full);
    // 게이트를 거친 체크포인트는 자기 자신이다
    expect(releaseBasisCheckpoint([requirementsDoc, full, first], full)).toBe(full);
  });

  it('고른 체크포인트보다 새 체크포인트의 통과 기록은 보지 않는다(앞으로가 아니라 뒤로만 간다)', () => {
    const newer = { sha: 'c3', passedStages: ['run', 'test', 'review'] };
    expect(releaseBasisCheckpoint([newer, requirementsDoc, full, first], requirementsDoc)).toBe(full);
  });

  it('코드를 바꿨을 수 있는 체크포인트는 건너뛰지 않는다', () => {
    const light = { sha: 'l1', verify: 'light', passedStages: ['run'], files: ['api/src/Order.java'] };
    expect(releaseBasisCheckpoint([light, full], light)).toBe(light);
    // 다른 문서를 바꾼 문서 체크포인트, 프로젝트 폴더 밖 변경이 있는 것, 파일 목록을 모르는 것
    const otherDoc = { sha: 'd3', verify: 'docs', files: ['docs/api.md'], outsideFiles: 0 };
    const outside = { sha: 'd4', verify: 'docs', files: ['docs/requirements.md'], outsideFiles: 1 };
    const unknownFiles = { sha: 'd5', verify: 'docs' };
    for (const head of [otherDoc, outside, unknownFiles]) expect(releaseBasisCheckpoint([head, full], head)).toBe(head);
  });

  it('체크포인트가 전부 문서 체크포인트면 가장 오래된 것을 보고, 목록에 없는 체크포인트는 그대로 돌려준다', () => {
    const oldest = { ...requirementsDoc, sha: 'd0' };
    expect(releaseBasisCheckpoint([requirementsDoc, oldest], requirementsDoc)).toBe(oldest);
    const stray = { sha: 'zz' };
    expect(releaseBasisCheckpoint([requirementsDoc, full], stray)).toBe(stray);
  });

  it('가볍게 확인한 체크포인트 위에 요구사항을 저장해도 배포는 그 체크포인트의 통과 기록으로 막히고 이유를 알린다', async () => {
    const created = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(created)).toBe('ready');
    await runWrite(created, 'light');
    const light = getSnapshot(created)!.checkpoints[0]!;

    // 화면에서 요구사항을 저장하면 문서 체크포인트가 맨 앞에 놓인다
    await applySessionRequirements(created, { requirements: [{ id: 'R1', title: '주문 메모', kind: 'api', priority: 'must', acceptance: ['메모를 저장한다'] }] });
    const head = getSnapshot(created)!.checkpoints[0]!;
    expect(head.sha).not.toBe(light.sha);
    expect(head.verify).toBe('docs');
    expect(head.passedStages).toBeUndefined();

    // 전에는 HEAD(문서 체크포인트)의 빈 통과 기록을 봐서 "검증 게이트를 거치지 않은 체크포인트"라고만 했다
    let message = '';
    try {
      deploySession(created, { by: 'kim' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`코드가 같은 체크포인트 ${light.shortSha}의 통과 기록을 봤습니다`);
    expect(message).toContain('가볍게 확인한 체크포인트는 전체 검증 뒤 배포할 수 있습니다');
    expect(message).not.toContain('검증 게이트를 거치지 않은 체크포인트입니다');
    // 가볍게 확인이 통과시킨 단계(run)는 빠진 단계로 나오지 않는다
    expect(message).not.toMatch(/통과 기록이 없는 단계: [^.(]*\brun\b/);

    await stopSession(created).catch(() => {});
  });
});

