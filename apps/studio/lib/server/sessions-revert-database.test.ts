import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import type { StudioEvent } from '@/lib/studio-events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 실측(세션 5b640fd3, 체크포인트 57cced6): 턴 상한으로 실패한 실행이 작업 트리 파일은 되돌렸지만 DB는 되돌리지
 * 않아, 그 실행이 적용한 Flyway 마이그레이션 기록이 flyway_schema_history에 남고(파일은 사라졌는데) 다음 기동이
 * "적용된 마이그레이션 파일이 없다"로 실패했다. 원인: revertRun이 문서를 먼저 지키려고(ADR-099) 새 체크포인트
 * (docsCheckpoint)를 남기면 session.snapshot.checkpoints[0]이 그 체크포인트로 바뀌는데, 그 체크포인트는 DB 덤프를
 * 남기지 않는다(saveDatabases를 부르지 않는다) — discardWorkingCopy **뒤**의 checkpoints[0]으로 DB를 복원하려
 * 하면 덤프를 찾지 못해(action: 'missing') DB가 그대로 남는다.
 *
 * 이 테스트는 실패한 요청이 문서(docs/requirements.md)와 코드를 함께 바꿔 되돌리는 도중 문서 체크포인트가 생기는
 * 상황을 그대로 재현해, DB가 "missing"이 아니라 실제로 복원되는지(action: 'restored') 본다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 체크포인트, discard()의 백업. 가짜로 바꾸는 것: 샌드박스(Docker) —
 * pg_dump·psql은 호출만 기록하고 내용은 미리 정한 값을 오간다. 실제 Docker·Postgres 호출은 없다.
 */
const fake = vi.hoisted(() => ({ root: '', dumps: [] as string[], execFromFileCalls: [] as Array<{ service: string; input: string }> }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-revert-database-fake',
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
    async execToFile(service: string, command: string[], outputFile: string) {
      if (command[0] === 'pg_dump') await writeFile(outputFile, fake.dumps.shift() ?? '', 'utf8');
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async execFromFile(service: string, command: string[], inputFile: string) {
      const input = await readFile(inputFile, 'utf8');
      fake.execFromFileCalls.push({ service, input });
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

import { createSession, getSnapshot, restoreCheckpoint, sendMessage, stopSession, subscribe } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
};

function studioYaml(): string {
  return `version: 1
name: verifyproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
databases:
  db: { engine: postgres, database: app, user: app }
workflow:
  required: [plan, implement, run, contract_check, checkpoint]
  releaseRequires: [checkpoint]
review:
  auto: false
`;
}

function composeYaml(): string {
  return `services:
  api:
    build: ./api
    depends_on:
      db: { condition: service_healthy }
  db:
    image: postgres:17-alpine
`;
}

async function setupProject(): Promise<void> {
  const projectRoot = path.join(root, 'project');
  await mkdir(path.join(projectRoot, 'api/src'), { recursive: true });
  await writeFile(path.join(projectRoot, 'studio.yaml'), studioYaml());
  await writeFile(path.join(projectRoot, 'compose.yaml'), composeYaml());
  await writeFile(path.join(projectRoot, 'api/src/Order.java'), 'class Order {}\n');
  fake.root = projectRoot;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-revert-db-'));
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
  fake.dumps = [];
  fake.execFromFileCalls = [];
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

const BASELINE_DUMP = '-- PostgreSQL database dump\nCREATE TABLE orders ();\n';
const MIGRATED_DUMP = '-- PostgreSQL database dump\nCREATE TABLE orders ();\nCREATE TABLE flyway_schema_history ();\n';

describe('실행 실패로 되돌릴 때 DB도 체크포인트 시점으로 되돌린다(ADR-018·ADR-131 실측: 세션 5b640fd3)', () => {
  it('되돌리기 도중 문서 체크포인트가 생겨도(ADR-099) DB 복원은 그 전의(덤프가 있는) 체크포인트를 기준으로 삼는다', async () => {
    await setupProject();
    // 세션을 띄우면 시작 체크포인트의 DB 상태를 저장한다(baseline)
    fake.dumps = [BASELINE_DUMP];
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));

    // 되돌리기 도중 restore()가 "지금" 상태를 한 번 더 떠서 baseline과 비교한다(다르게 둬 실제로 복원이 일어나게 한다).
    // 문서 체크포인트가 생기면 복원한(올바른) 상태를 그 체크포인트의 덤프로도 다시 남기므로 pg_dump가 한 번 더 불린다.
    // 세 번째 값은 뒤이어 "지금 체크포인트로 되돌리기"를 다시 불러도 이미 맞는 상태(unchanged)인지 보는 데 쓴다
    fake.dumps = [MIGRATED_DUMP, BASELINE_DUMP, BASELINE_DUMP];

    // 실패한 요청: 문서(requirements.md)와 코드를 함께 바꾸고, 마이그레이션을 적용한 뒤(가짜 DB 변화) 모델이 다음 턴 없이 끝나 예외로 끝난다
    const finished = new Promise<void>((resolve) => {
      const unsub = subscribe(id, (event) => {
        if (event.type === 'run_finished') {
          unsub();
          resolve();
        }
      });
    });
    sendMessage(id, '숏폼 작업', {
      allowBreaking: false,
      scriptedTurns: [
        {
          toolCalls: [
            { name: 'write_file', input: { path: 'docs/requirements.md', content: '# 요구사항\n\n- R21 숏폼\n' } },
            { name: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'class Order {}', new_text: 'class Order { String memo; }' } },
          ],
        },
        // 다음 턴 대본이 없어 모델 호출이 예외로 끝난다("모델/네트워크 오류로 끝난 실행"을 흉내 낸다)
      ],
    });
    await finished;

    // 1) 문서는 사라지지 않고 체크포인트로 남았다(그래서 session.snapshot.checkpoints[0]이 바뀐다)
    const checkpoints = getSnapshot(id)!.checkpoints;
    expect(checkpoints[0]).toMatchObject({ files: ['docs/requirements.md'], verify: 'docs' });

    // 2) 코드 변경은 되돌려졌다
    expect(await readFile(path.join(workDir, 'api/src/Order.java'), 'utf8')).toBe('class Order {}\n');

    // 3) DB는 "덤프가 없어 missing"이 아니라 실제로 복원됐다 — 이것이 이번 수정의 핵심 회귀 검증이다
    const reverted = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'reverted' }> => event.type === 'reverted'));
    expect(reverted.databases).toMatchObject([{ service: 'db', action: 'restored' }]);
    // 복원은 저장해 둔 baseline(마이그레이션 적용 전) 덤프를 그대로 psql에 넘긴다
    expect(fake.execFromFileCalls).toEqual([{ service: 'db', input: BASELINE_DUMP }]);

    // 4) 이미 고친 되돌리기(revertRun)가 DB를 바로잡았으므로, "지금 체크포인트로 되돌리기"로 DB를 다시 맞출
    // 필요가 아예 없다 — 불러도 이미 맞는 상태(unchanged)로 조용히 끝난다(수동 우회가 더는 필요 없다는 증거)
    restoreCheckpoint(id, checkpoints[0]!.sha);
    const restored = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'restored' }> => event.type === 'restored'));
    expect(restored.databases).toMatchObject([{ service: 'db', action: 'unchanged' }]);

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('문서 변경이 없어 문서 체크포인트가 생기지 않으면(지금까지의 경로) DB도 그대로 복원된다', async () => {
    await setupProject();
    fake.dumps = [BASELINE_DUMP];
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));
    fake.dumps = [MIGRATED_DUMP];

    const finished = new Promise<void>((resolve) => {
      const unsub = subscribe(id, (event) => {
        if (event.type === 'run_finished') {
          unsub();
          resolve();
        }
      });
    });
    sendMessage(id, '코드만 바꾸는 작업', {
      allowBreaking: false,
      scriptedTurns: [{ toolCalls: [{ name: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'class Order {}', new_text: 'class Order { String memo; }' } }] }],
    });
    await finished;

    const reverted = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'reverted' }> => event.type === 'reverted'));
    expect(reverted.databases).toMatchObject([{ service: 'db', action: 'restored' }]);

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);
});

/**
 * "지금 체크포인트로 되돌리기"가 더는 "이미 최신 체크포인트입니다"로 거부되지 않는다(ADR-131 실측: 세션 5b640fd3,
 * 사용자가 체크포인트 57cced6 — 그때의 head — 으로 되돌리려다 409를 겪었다). 파일은 움직일 게 없어도
 * 데이터베이스가 그 체크포인트 이후 어긋났을 수 있어, DB만 다시 맞추는 안전한 경로로 다룬다.
 */
describe('"지금 체크포인트로 되돌리기"는 파일이 아니라 데이터베이스를 다시 맞추는 경로로 쓸 수 있다', () => {
  it('지금(head) 체크포인트를 가리켜도 거부하지 않고 어긋난 데이터베이스만 다시 맞춘다', async () => {
    await setupProject();
    fake.dumps = [BASELINE_DUMP];
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const head = getSnapshot(id)!.checkpoints[0]!;

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));
    // 세션 밖에서(예: 사람이 psql로 직접) DB가 어긋났다고 흉내 낸다
    fake.dumps = [MIGRATED_DUMP];

    restoreCheckpoint(id, head.sha);
    const restored = await waitFor(() => events.find((event): event is Extract<StudioEvent, { type: 'restored' }> => event.type === 'restored'));

    expect(restored.databases).toMatchObject([{ service: 'db', action: 'restored' }]);
    expect(restored.files).toEqual([]);
    // 체크포인트 기록 자체는 그대로다(파일을 움직인 게 아니다)
    expect(getSnapshot(id)!.checkpoints.map((checkpoint) => checkpoint.sha)).toEqual([head.sha]);

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('데이터베이스를 선언하지 않은 프로젝트는 지금 체크포인트를 가리키면 정말 할 일이 없으므로 그대로 거부한다', async () => {
    const projectRoot = path.join(root, 'project');
    await mkdir(path.join(projectRoot, 'api/src'), { recursive: true });
    await writeFile(
      path.join(projectRoot, 'studio.yaml'),
      'version: 1\nname: verifyproj\nservices:\n  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }\n',
    );
    await writeFile(path.join(projectRoot, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
    await writeFile(path.join(projectRoot, 'api/src/Order.java'), 'class Order {}\n');
    fake.root = projectRoot;

    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const head = getSnapshot(id)!.checkpoints[0]!;

    expect(() => restoreCheckpoint(id, head.sha)).toThrow('이미 최신 체크포인트이고 되돌릴 데이터베이스도 없습니다');

    await stopSession(id).catch(() => {});
  }, 20_000);
});
