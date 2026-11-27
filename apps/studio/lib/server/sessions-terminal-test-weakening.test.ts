import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 시험을 약하게 만드는 변경(이슈 #1436)을 지원 경로(세션 터미널, claude-code의 Stop 훅)의 턴 끝 게이트가 실제로 돌려보내는지 본다.
 * CLI가 하는 일은 훅을 부르는 것과 작업 복사본의 파일을 고치는 것이다. 지우기·옮기기는 훅을 거치지 않는 셸 변경처럼 파일 시스템으로 직접 한다.
 * 작업 복사본·체크포인트·게이트는 실제 sessions.ts 코드가 돈다(가짜는 샌드박스와 `./session-terminal`뿐이다). 시험은 임시 폴더만 쓴다.
 */
const fake = vi.hoisted(() => ({ root: '' }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-test-weakening-fake',
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

vi.mock('./projects', () => ({ findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root) }));
vi.mock('./session-terminal', async () => (await import('./test-support/session-terminal-stub')).sessionTerminalStub('host'));

import { createSession, getSnapshot, setTerminalCheckChanges, stopSession } from './sessions';
import { cliWrite, openTerminalRunWithFiles, stopTerminalTurn } from './test-support/terminal-run';

const saved = { mode: process.env.B_STUDIO_MODE, auth: process.env.B_STUDIO_AUTH, sessions: process.env.B_STUDIO_SESSIONS_DIR };

const ORDER_TEST = ['import org.junit.jupiter.api.Test;', 'class OrderTest {', '  @Test void a() {}', '  @Test void b() {}', '  @Test void c() {}', '}', ''].join('\n');
const CART_TEST = ["import { it } from 'vitest';", "it('a', () => {});", "it('b', () => {});", "it('c', () => {});", ''].join('\n');

function studioYaml(): string {
  return `version: 1
name: testweak
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
workflow:
  required: [plan, implement, run, contract_check, checkpoint]
review:
  auto: false
`;
}

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-test-weakening-'));
  const project = path.join(root, 'project');
  await mkdir(path.join(project, 'api/src'), { recursive: true });
  await mkdir(path.join(project, 'web'), { recursive: true });
  await writeFile(path.join(project, 'studio.yaml'), studioYaml());
  await writeFile(path.join(project, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(project, 'api/src/Order.java'), 'class Order {}\n');
  await writeFile(path.join(project, 'api/src/OrderTest.java'), ORDER_TEST);
  await writeFile(path.join(project, 'web/cart.test.ts'), CART_TEST);
  fake.root = project;
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
  for (const [key, value] of [
    ['B_STUDIO_MODE', saved.mode],
    ['B_STUDIO_AUTH', saved.auth],
    ['B_STUDIO_SESSIONS_DIR', saved.sessions],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function open(): Promise<string> {
  const id = (await createSession('testweak', 'kim', 'copy')).id;
  const started = Date.now();
  while (getSnapshot(id)?.status !== 'ready') {
    if (Date.now() - started > 10_000) throw new Error(`세션이 준비되지 않았습니다 (${getSnapshot(id)?.status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return id;
}

/** 요청을 열고 코드를 한 파일 고친 뒤(게이트가 변경으로 보게), 그 위에 셸 같은 도구 밖 변경을 한다 */
async function openWithChange(id: string, shell: (work: string) => Promise<void>) {
  const run = await openTerminalRunWithFiles(id, '주문에 메모 필드 추가', { 'api/src/Order.java': 'class Order { String memo; }\n' });
  await shell(run.work);
  return run;
}

describe('허용 없이 시험 파일을 지우거나 건너뛰기 표시를 더하면 턴 끝 게이트가 돌려보낸다 (#1436)', () => {
  it('셸로 시험 파일을 지우면 돌려보내고, 되돌린 뒤 다시 끝내면 통과한다', async () => {
    const id = await open();
    const before = getSnapshot(id)!.checkpoints.length;
    const run = await openWithChange(id, (work) => rm(path.join(work, 'web/cart.test.ts')));

    const answer = await stopTerminalTurn(run);
    expect(answer.feedback).toContain('test-weakening');
    expect(answer.feedback).toContain('지운 시험 파일: web/cart.test.ts');
    expect(getSnapshot(id)!.checkpoints).toHaveLength(before);

    await writeFile(path.join(run.work, 'web/cart.test.ts'), CART_TEST);
    const retry = await stopTerminalTurn(run);
    expect(retry.feedback).toBeUndefined();
    expect(getSnapshot(id)!.checkpoints).toHaveLength(before + 1);
    await stopSession(id);
  }, 60_000);

  it('CLI가 쓰기 훅을 거쳐 건너뛰기 표시를 더해도 돌려보낸다', async () => {
    const id = await open();
    const before = getSnapshot(id)!.checkpoints.length;
    const run = await openWithChange(id, async () => {});
    await cliWrite(run, 'api/src/OrderTest.java', ORDER_TEST.replace('  @Test void b() {}', '  @Disabled @Test void b() {}'));

    const answer = await stopTerminalTurn(run);
    expect(answer.feedback).toContain('test-weakening');
    expect(answer.feedback).toContain('api/src/OrderTest.java(@Disabled');
    expect(getSnapshot(id)!.checkpoints).toHaveLength(before);
    await stopSession(id);
  }, 60_000);

  it('시험이 아닌 이름으로 옮기면 돌려보내고, 시험 파일 사이에서 옮기면 통과한다', async () => {
    const id = await open();
    const before = getSnapshot(id)!.checkpoints.length;
    const run = await openWithChange(id, (work) => rename(path.join(work, 'web/cart.test.ts'), path.join(work, 'web/cart.ts.bak')));
    const hidden = await stopTerminalTurn(run);
    expect(hidden.feedback).toContain('web/cart.test.ts → web/cart.ts.bak');
    expect(getSnapshot(id)!.checkpoints).toHaveLength(before);

    await rename(path.join(run.work, 'web/cart.ts.bak'), path.join(run.work, 'web/cart.test.ts'));
    await mkdir(path.join(run.work, 'web/__tests__'), { recursive: true });
    await rename(path.join(run.work, 'web/cart.test.ts'), path.join(run.work, 'web/__tests__/cart.test.ts'));
    const moved = await stopTerminalTurn(run);
    expect(moved.feedback).toBeUndefined();
    expect(getSnapshot(id)!.checkpoints).toHaveLength(before + 1);
    await stopSession(id);
  }, 60_000);

  it('원래 있던 건너뛰기 표시는 세지 않는다', async () => {
    const id = await open();
    const before = getSnapshot(id)!.checkpoints.length;
    // 먼저 건너뛰기가 든 시험을 체크포인트로 남긴다(허용을 켠 요청에서)
    setTerminalCheckChanges(id, true);
    const first = await openTerminalRunWithFiles(id, '시험 하나를 잠시 건너뜁니다', { 'web/cart.test.ts': `${CART_TEST}it.skip('later', () => {});\n` });
    expect((await stopTerminalTurn(first)).feedback).toBeUndefined();
    expect(getSnapshot(id)!.checkpoints).toHaveLength(before + 1);

    // 다음 요청은 그 표시를 건드리지 않고 다른 줄만 바꾼다: 더해진 건너뛰기 표시가 없으므로 통과한다
    const second = await openTerminalRunWithFiles(id, '시험 하나를 더합니다', { 'web/cart.test.ts': `${CART_TEST}it.skip('later', () => {});\nit('d', () => {});\n` });
    expect((await stopTerminalTurn(second)).feedback).toBeUndefined();
    expect(getSnapshot(id)!.checkpoints).toHaveLength(before + 2);
    await stopSession(id);
  }, 60_000);

  it('사람이 확인 변경을 허용했으면 통과하고, 허용은 그 요청 하나만 받는다', async () => {
    const id = await open();
    const before = getSnapshot(id)!.checkpoints.length;
    setTerminalCheckChanges(id, true);
    const allowed = await openWithChange(id, (work) => rm(path.join(work, 'web/cart.test.ts')));
    const answer = await stopTerminalTurn(allowed);
    expect(answer.feedback).toBeUndefined();
    expect(getSnapshot(id)!.checkpoints).toHaveLength(before + 1);
    const latest = getSnapshot(id)!.checkpoints[0]!;
    expect(latest.files).toContain('web/cart.test.ts');

    // 다음 요청은 허용이 없다
    const next = await openTerminalRunWithFiles(id, '다른 시험도 지웁니다', { 'api/src/Order.java': 'class Order { String memo; String note; }\n' });
    await rm(path.join(next.work, 'api/src/OrderTest.java'));
    expect((await stopTerminalTurn(next)).feedback).toContain('test-weakening');
    expect(getSnapshot(id)!.checkpoints).toHaveLength(before + 1);
    expect(await readFile(path.join(next.work, 'api/src/Order.java'), 'utf8')).toContain('note');
    await stopSession(id);
  }, 60_000);
});
