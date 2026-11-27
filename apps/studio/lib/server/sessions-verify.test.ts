import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** 가짜 제공자·프로젝트가 쓰는 상태. vi.mock 팩토리에서 쓰려고 hoisted로 둔다 */
const fake = vi.hoisted(() => ({
  root: '',
  execCalls: [] as string[][],
  baselineCalls: [] as string[][],
  /** 재시작을 실패시킨다: 'platform'은 샌드박스 쪽 오류(SandboxError.platform), 'code'는 서비스가 뜨지 않음 */
  restartFails: undefined as undefined | 'platform' | 'code',
  restarts: 0,
  /** 이 낱말이 든 명령은 종료 코드 1로 끝난다(선언한 테스트를 실패시킬 때 쓴다) */
  failCommands: [] as string[],
  /** syncEvaluationAssets가 받은 평가 자산(복사본 내용이 마지막 체크포인트의 판인지 본다) */
  evaluationSyncs: [] as Array<Array<{ path: string; kind: string; files: Array<{ path: string; content: string; executable: boolean }> }>>,
  /** provider.create가 받은 평가 자산의 첫 내용(자리 종류를 체크포인트 판으로 정하는지 본다) */
  creates: [] as Array<Array<{ path: string; kind: string }>>,
}));

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
      fake.restarts += 1;
      if (fake.restartFails === 'platform') throw new actual.SandboxError('/work/.git/b-studio 폴더를 가릴 빈 폴더를 준비하지 못했습니다', 'EEXIST: file already exists', { platform: true });
      if (fake.restartFails === 'code') throw new Error('컨테이너가 종료됐습니다');
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
    async syncEvaluationAssets(assets: ReadonlyArray<{ path: string; kind: string; files: ReadonlyArray<{ path: string; content: Buffer; executable: boolean }> }>) {
      fake.evaluationSyncs.push(
        assets.map((asset) => ({
          path: asset.path,
          kind: asset.kind,
          files: asset.files.map((file) => ({ path: file.path, content: file.content.toString('base64'), executable: file.executable })),
        })),
      );
    },
    async *logs() {},
    async exec(_service: string, command: string[]) {
      // 게이트가 테스트 전에 보고서 자리를 비우는 명령(#756)은 테스트 명령으로 세지 않는다
      if (command[0] === 'sh' && command[2]?.startsWith('rm -f /tmp/b-studio-test-report.json ')) return { exitCode: 0, stdout: '', stderr: '' };
      // 실패한 시험을 변경 전 기준에서 다시 돌리는 명령(#1435)은 시험 명령으로 세지 않는다. 변경 전에는 통과했다고 답한다
      if (command[0] === 'sh' && command[2]?.includes('b-studio-baseline.')) {
        fake.baselineCalls.push(command.slice(4));
        return { exitCode: 0, stdout: '__B_STUDIO_BASELINE_READY__\n', stderr: '' };
      }
      fake.execCalls.push(command);
      if (fake.failCommands.some((word) => command.includes(word))) return { exitCode: 1, stdout: '', stderr: 'FAILED' };
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
  return {
    ...actual,
    providerFromEnv: () => ({
      name: 'fake',
      isolation: undefined,
      create: async (_project: unknown, options?: { evaluationAssets?: ReadonlyArray<{ path: string; kind: string }> }) => {
        fake.creates.push((options?.evaluationAssets ?? []).map((asset) => ({ path: asset.path, kind: asset.kind })));
        return sandbox;
      },
    }),
  };
});

// 프로젝트 탐색만 임시 폴더의 studio.yaml로 바꾼다(작업 복사본·체크포인트·게이트 흐름은 실제 코드가 돈다)
vi.mock('./projects', () => ({
  findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root),
}));

vi.mock('./session-terminal', async () => (await import('./test-support/session-terminal-stub')).sessionTerminalStub());

import { createSession, getSnapshot, sendMessage, sessionHistory, setTerminalCheckChanges, stopSession, subscribe } from './sessions';
import { completeTerminalRun, driveTerminalSteps, type TerminalStep } from './test-support/terminal-run';
import type { StudioEvent } from '@/lib/studio-events';

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
`,
  );
  await writeFile(path.join(root, 'project', 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(root, 'project', 'api', 'src', 'Order.java'), 'class Order {}\n');
  fake.root = path.join(root, 'project');
  fake.execCalls = [];
  fake.failCommands = [];
  fake.evaluationSyncs = [];
  fake.creates = [];
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

async function waitForEvent<T extends StudioEvent>(events: StudioEvent[], from: number, match: (event: StudioEvent) => event is T, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const found = events.slice(from).find(match);
    if (found) return found;
    if (Date.now() - started > timeoutMs) throw new Error('기다린 이벤트가 오지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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

/** 터미널 경로로 같은 변경을 하고 게이트를 통과시켜 체크포인트를 남긴다(채팅 경로 없이) */
async function runWriteInTerminal(id: string): Promise<void> {
  await completeTerminalRun(id, '주문에 메모 필드 추가', { 'api/src/Order.java': 'class Order { String memo; }\n' });
}

// `verify: 'light'`는 대화 창의 요청 옵션이고 세션 터미널 경로에는 없다(sessions.ts의 beginTerminalRun·게이트 생성은 verify를 받지 않는다).
// 그래서 이 묶음은 채팅 경로와 함께 지워질 시험이다. 옮기면 light를 확인하지 못하고 전체 검증 대조만 남는다
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

  it('전체 검증(full)은 지금처럼 테스트까지 돌린다', async () => {
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

/** 파일을 쓰고 끝냈다고 말한다. 게이트가 돌려보낼 때마다 다시 끝냈다고 말한다(통과하면 거기서 멈춘다) */
const writeThenStops: TerminalStep[] = [
  { write: { 'api/src/Order.java': 'class Order { String memo; }\n' } },
  ...Array.from({ length: 6 }, () => ({ stop: '완료했습니다' })),
];

describe('샌드박스·도커 쪽 문제로 검증하지 못한 변경은 되돌리지 않는다 (트러블슈팅 117)', () => {
  /** 터미널 경로로 요청을 하고(파일 쓰기·Stop 훅) 그 실행이 닫히기를 기다려 이벤트를 모은다. 구독은 지난 이벤트를 다시 보내므로 구독 직후의 길이 뒤만 본다 */
  async function runAndCollect(id: string, steps: TerminalStep[], prompt = '주문에 메모 필드 추가') {
    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));
    const before = events.length;
    await driveTerminalSteps(id, prompt, steps);
    const finished = await waitForEvent(events, before, (event): event is Extract<StudioEvent, { type: 'run_finished' }> => event.type === 'run_finished');
    unsubscribe();
    return { finished, events: events.slice(before) };
  }

  it('플랫폼 쪽 실패면 실행은 실패로 끝나지만 변경이 작업 복사본에 남고, 다음 요청의 게이트가 그 변경을 검증해 체크포인트로 남긴다', async () => {
    const created = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(created)).toBe('ready');
    const workDir = getSnapshot(created)!.workDir;
    const before = getSnapshot(created)!.checkpoints.length;

    fake.restartFails = 'platform';
    fake.restarts = 0;
    const first = await runAndCollect(created, writeThenStops);
    fake.restartFails = undefined;

    expect(first.finished.status).toBe('failed');
    expect(first.finished.summary).toContain('b-studio 쪽(샌드박스·도커) 문제로 검증을 끝내지 못했습니다');
    expect(first.finished.summary).not.toContain('번 통과하지 못했습니다');
    // 되돌리지 않았다: 파일이 그대로 있고, 되돌림 이벤트가 없고, 체크포인트도 늘지 않았다
    expect(await readFile(path.join(workDir, 'api/src/Order.java'), 'utf8')).toBe('class Order { String memo; }\n');
    expect(first.events.some((event) => event.type === 'reverted')).toBe(false);
    expect(getSnapshot(created)!.checkpoints.length).toBe(before);
    expect(first.events.some((event) => event.type === 'notice' && String(event.text).includes('변경을 되돌리지 않고 작업 복사본에 그대로 뒀습니다'))).toBe(true);
    // 모델을 거치지 않고 한 번만 다시 해 봤다
    expect(fake.restarts).toBe(2);

    // 문제가 풀린 뒤의 다음 요청: 에이전트가 파일을 건드리지 않아도 남은 변경이 게이트를 거쳐 체크포인트가 된다
    const second = await runAndCollect(created, [{ stop: '앞의 변경을 그대로 마무리했습니다.' }]);
    expect(second.finished.status).toBe('done');
    const head = getSnapshot(created)!.checkpoints[0]!;
    expect(getSnapshot(created)!.checkpoints.length).toBe(before + 1);
    expect(head.files).toContain('api/src/Order.java');
    expect(head.passedStages).toEqual(expect.arrayContaining(['run', 'test']));

    await stopSession(created).catch(() => {});
  }, 30_000);

  it('서비스가 뜨지 않은 실패는 지금처럼 재시도를 다 쓰고 되돌린다', async () => {
    const created = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(created)).toBe('ready');
    const workDir = getSnapshot(created)!.workDir;

    fake.restartFails = 'code';
    const run = await runAndCollect(created, writeThenStops);
    fake.restartFails = undefined;

    expect(run.finished.status).toBe('failed');
    expect(run.finished.summary).toContain('번 통과하지 못했습니다');
    expect(run.events.some((event) => event.type === 'reverted')).toBe(true);
    // 마지막 체크포인트의 내용으로 돌아갔다
    expect(await readFile(path.join(workDir, 'api/src/Order.java'), 'utf8')).toBe('class Order {}\n');

    await stopSession(created).catch(() => {});
  }, 30_000);
});

describe('지금 실패하는 확인의 선언은 사용자가 허용한 요청에서 고친다 (ADR-164, 트러블슈팅 129)', () => {
  const FIXED_SPEC = `version: 1
name: verifyproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
workflow:
  required: [plan, implement, run, contract_check, test, review, checkpoint]
  tests:
    - name: unit
      service: api
      command: [./gradlew, check]
`;
  /** 선언을 고치고 파일 하나를 바꾼 뒤 턴을 끝낸다. 게이트가 되돌려 보낼 때마다 한 줄씩 더 말한다 */
  const fixDeclarationSteps: TerminalStep[] = [
    { write: { 'studio.yaml': FIXED_SPEC, 'api/src/Order.java': 'class Order { String memo; }\n' } },
    { stop: '선언을 고쳤습니다.' },
    ...Array.from({ length: 5 }, () => ({ stop: '선언은 이미 고쳤습니다.' })),
  ];

  async function runFix(id: string, allowCheckChanges: boolean): Promise<{ status?: string; summary?: string }> {
    // 터미널의 요청은 요청마다 옵션을 실을 자리가 없어, 사람이 미리 켜 두면 그 뒤 처음 시작되는 만들기 실행이 가져간다
    if (allowCheckChanges) expect(setTerminalCheckChanges(id, true)).toBe(true);
    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));
    const before = events.length;
    await driveTerminalSteps(id, '테스트 선언을 ./gradlew check로 바꿔 주세요', fixDeclarationSteps);
    const finished = await waitForEvent(events, before, (event): event is Extract<StudioEvent, { type: 'run_finished' }> => event.type === 'run_finished');
    unsubscribe();
    return finished;
  }

  it('허용이 없으면 고친 선언이 쓰이지 않아 실패하고 되돌려지며, 빠져나오는 길을 사유에 적는다', async () => {
    const created = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(created)).toBe('ready');
    // 지금 선언된 테스트(./gradlew test)가 실패하고 있다
    fake.failCommands = ['test'];
    fake.execCalls = [];
    const workDir = getSnapshot(created)!.workDir!;

    const finished = await runFix(created, false);

    expect(finished.status).toBe('failed');
    // 세 번 모두 실행을 시작할 때의 선언으로 돌았다
    expect(fake.execCalls).toEqual([['./gradlew', 'test'], ['./gradlew', 'test'], ['./gradlew', 'test']]);
    expect(JSON.stringify(sessionHistory(created))).toContain("확인의 선언을 바꾸려던 것이면 '확인 선언 변경 허용'을 켜고 다시 요청하세요");
    // 변경은 되돌려졌고 선언도 옛 것이다
    expect(await readFile(path.join(workDir, 'studio.yaml'), 'utf8')).toContain('command: [./gradlew, test]');
    expect(getSnapshot(created)!.checkpoints.some((checkpoint) => checkpoint.message.includes('테스트 선언'))).toBe(false);

    await stopSession(created).catch(() => {});
  });

  it('허용하면 고친 선언으로 검증해 체크포인트를 만들고, 다음 요청부터 그 선언을 쓴다', async () => {
    const created = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(created)).toBe('ready');
    fake.failCommands = ['test'];
    fake.execCalls = [];
    const workDir = getSnapshot(created)!.workDir!;

    const finished = await runFix(created, true);

    expect(finished.status).toBe('done');
    // 옛 선언(./gradlew test)은 돌지 않았고 고친 선언이 돌았다
    expect(fake.execCalls).toEqual([['./gradlew', 'check']]);
    const checkpoint = getSnapshot(created)!.checkpoints[0]!;
    expect(checkpoint.passedStages).toEqual(expect.arrayContaining(['run', 'contract_check', 'test', 'review']));
    expect(await readFile(path.join(workDir, 'studio.yaml'), 'utf8')).toContain('command: [./gradlew, check]');
    // 무엇이 바뀌었는지가 대화 기록에 남는다
    expect(JSON.stringify(sessionHistory(created))).toContain('사용자가 허용해 바뀐 확인 선언으로 검증했습니다 — 변경: 테스트 unit');

    // 다음 요청은 허용 없이도 고친 선언으로 돈다
    fake.execCalls = [];
    await completeTerminalRun(created, '주문에 메모 필드 하나 더', { 'api/src/Order.java': 'class Order { String memo; String note; }\n' });
    expect(fake.execCalls).toEqual([['./gradlew', 'check']]);

    await stopSession(created).catch(() => {});
  });
});

// #745: 컨테이너에 붙는 평가 자산은 작업 복사본이 아니라 b-studio가 가진 복사본이고, 그 내용은 마지막 체크포인트의 판이어야 한다
describe('평가 자산 복사본(#745)', () => {
  async function declareAssets(): Promise<void> {
    const specPath = path.join(root, 'project', 'studio.yaml');
    const spec = await readFile(specPath, 'utf8');
    await writeFile(specPath, spec.replace('workflow:\n', 'workflow:\n  evaluationAssets: [tests/acceptance, expected.json]\n'));
    await mkdir(path.join(root, 'project', 'tests', 'acceptance'), { recursive: true });
    await writeFile(path.join(root, 'project', 'tests', 'acceptance', 'case.json'), '{"case":1}\n');
    await writeFile(path.join(root, 'project', 'expected.json'), '{"expected":true}\n');
  }

  it('샌드박스가 준비될 때와 실행을 시작할 때 마지막 체크포인트의 자산을 syncEvaluationAssets로 넘긴다', async () => {
    await declareAssets();
    const created = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(created)).toBe('ready');

    // boot가 마지막 체크포인트에서 꺼낸 폴더·파일 자산을 그대로 넘겼다
    expect(fake.evaluationSyncs.length).toBeGreaterThan(0);
    const boot = fake.evaluationSyncs.at(-1)!;
    expect(boot.map((asset) => [asset.path, asset.kind])).toEqual([
      ['tests/acceptance', 'directory'],
      ['expected.json', 'file'],
    ]);
    expect(boot[0]!.files).toEqual([{ path: 'tests/acceptance/case.json', content: Buffer.from('{"case":1}\n').toString('base64'), executable: false }]);
    expect(boot[1]!.files).toEqual([{ path: 'expected.json', content: Buffer.from('{"expected":true}\n').toString('base64'), executable: false }]);

    // 샌드박스를 만들 때도 마지막 체크포인트의 판을 넘겨 자리 종류와 첫 내용을 정한다(작업 복사본의 지금 모습이 아니다)
    expect(fake.creates.at(-1)).toEqual([
      { path: 'tests/acceptance', kind: 'directory' },
      { path: 'expected.json', kind: 'file' },
    ]);

    // 실행을 시작할 때도 같은 판을 넘긴다(작업 복사본의 지금 상태가 아니다)
    fake.evaluationSyncs = [];
    await runWriteInTerminal(created);
    expect(fake.evaluationSyncs.length).toBeGreaterThan(0);
    expect(fake.evaluationSyncs.at(-1)).toEqual(boot);

    await stopSession(created).catch(() => {});
  });
});
