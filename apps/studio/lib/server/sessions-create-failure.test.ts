import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const run = promisify(execFile);

/**
 * 세션을 만들다 실패했을 때 만든 것이 남는지를 고정한다(ADR-206, 4f B2c, 트러블슈팅 215).
 * 옛 `startSession`은 세션 폴더(작업 복사본, 내 폴더 세션이면 상태 폴더의 체크포인트 git)를 만든 뒤 프로젝트 읽기·로그인 확인·평가 자산·샌드박스 만들기가
 * 실패해도 그 폴더를 치우지 않았다. 저장 파일이 쓰이기 전이라 복구 목록에도 오르지 않아 지울 길이 없다. 샌드박스를 만든 뒤에 실패하면 샌드박스도 남고,
 * 세션을 맵에 넣은 뒤에 실패하면 반쯤 만든 세션이 맵·레지스트리에 남는다.
 *
 * 진짜로 하는 것: 세션 폴더 만들기·복제·체크포인트·지우기. 가짜로 바꾸는 것: 샌드박스(Docker), 로그인 확인(CLI), 미리보기 게이트웨이.
 * 모든 폴더는 임시 폴더 안에 만든다(실제 세션 폴더나 홈 폴더를 쓰지 않는다).
 */
const fake = vi.hoisted(() => ({
  /** findProject가 돌려줄 프로젝트 폴더(프로젝트 id별) */
  roots: {} as Record<string, string>,
  /** 켜기가 끝난 뒤 findProject가 원본의 studio.yaml을 이 글로 망가뜨린다(복사본이 망가진 채로 복제된다) */
  corruptSpecAfterFind: false,
  preflightFails: false,
  createFails: false,
  creates: 0,
  destroyCalls: 0,
  destroyFails: false,
  startCalls: 0,
  startFailures: 0,
  gatewayFails: false,
  /** 미리보기 게이트웨이가 던지기 직전에 불린다(맵에 든 세션의 저장이 예약된 채 실패하는 경우를 만든다) */
  beforeGatewayFails: undefined as (() => void) | undefined,
  /** 다음 `randomUUID()`가 이 값을 돌려준다(8자 id가 겹치는 경우를 만든다) */
  forcedUuid: undefined as string | undefined,
  /** 샌드박스를 만드는 사이에 불린다(만들기가 도는 동안 다른 곳이 같은 id를 맵에 넣는 경우를 만든다) */
  duringCreate: undefined as (() => void) | undefined,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomUUID: () => {
      if (fake.forcedUuid !== undefined) return `${fake.forcedUuid}-0000-0000-0000-000000000000` as ReturnType<typeof actual.randomUUID>;
      return actual.randomUUID();
    },
  };
});

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-create-fake-abcdef',
    name: 'fake',
    async start() {
      fake.startCalls += 1;
      if (fake.startFailures > 0) {
        fake.startFailures -= 1;
        throw new Error('샌드박스 시작 실패');
      }
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
    async destroy() {
      fake.destroyCalls += 1;
      if (fake.destroyFails) throw new Error('샌드박스 정리 실패');
    },
  } as unknown as Sandbox;
  return {
    ...actual,
    providerFromEnv: () => ({
      name: 'fake',
      isolation: undefined,
      create: async () => {
        if (fake.createFails) throw new Error('샌드박스를 만들지 못했습니다(가짜)');
        fake.creates += 1;
        fake.duringCreate?.();
        return sandbox;
      },
    }),
  };
});

vi.mock('@b-studio/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/agent')>();
  return { ...actual, preflightClaudeCode: async () => (fake.preflightFails ? { ok: false as const, reason: '로그인되어 있지 않습니다(가짜)' } : { ok: true as const }) };
});

vi.mock('./preview-gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./preview-gateway')>();
  return {
    ...actual,
    createPreviewGateway: (...args: Parameters<typeof actual.createPreviewGateway>) => {
      if (fake.gatewayFails) {
        fake.beforeGatewayFails?.();
        throw new Error('미리보기 게이트웨이를 만들지 못했습니다(가짜)');
      }
      return actual.createPreviewGateway(...args);
    },
  };
});

vi.mock('./projects', () => ({
  findProject: async (projectId: string) => {
    const dir = fake.roots[projectId];
    if (!dir) return undefined;
    const loaded = await (await import('@b-studio/spec')).loadProject(dir);
    if (fake.corruptSpecAfterFind) await (await import('node:fs/promises')).writeFile(path.join(dir, 'studio.yaml'), 'version: 1\nname: [깨진 형식\n  services: : :\n');
    return loaded;
  },
}));

import { createSession, getSnapshot, stopSession } from './sessions';

let root: string;
let sessionsDir: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  auth: process.env.B_STUDIO_AUTH,
  backends: process.env.B_STUDIO_BACKENDS,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
  previewDomain: process.env.B_STUDIO_PREVIEW_DOMAIN,
};

interface Internals {
  snapshot: { id: string };
}
function liveSessions(): Map<string, Internals> {
  return (globalThis as { __bStudio?: { sessions: Map<string, Internals> } }).__bStudio!.sessions;
}
/** 레지스트리에 든 세션인가(없으면 404, 있으면 멈추지 않았다는 409) */
function registered(id: string): boolean {
  const registry = (globalThis as { __bStudio?: { registry?: { beginResume(id: string, archived: boolean): void } } }).__bStudio!.registry!;
  try {
    registry.beginResume(id, false);
    return true;
  } catch (error) {
    return (error as { status?: number }).status !== 404;
  }
}

async function makeProject(projectDir: string, name: string, extra = ''): Promise<void> {
  await mkdir(path.join(projectDir, 'api', 'src'), { recursive: true });
  await writeFile(path.join(projectDir, 'studio.yaml'), `version: 1\nname: ${name}\nservices:\n  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }\nreview:\n  auto: false\n${extra}`);
  await writeFile(path.join(projectDir, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(projectDir, 'api', 'src', 'Order.java'), 'class Order {}\n');
}

async function gitInit(projectDir: string): Promise<void> {
  await run('git', ['init', '-q', '-b', 'main'], { cwd: projectDir });
  await run('git', ['add', '-A'], { cwd: projectDir });
  await run('git', ['commit', '-q', '-m', 'init'], { cwd: projectDir });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-create-failure-'));
  sessionsDir = path.join(root, 'sessions');
  fake.roots = { failproj: path.join(root, 'project') };
  Object.assign(fake, {
    corruptSpecAfterFind: false,
    preflightFails: false,
    createFails: false,
    creates: 0,
    destroyCalls: 0,
    destroyFails: false,
    startCalls: 0,
    startFailures: 0,
    gatewayFails: false,
    beforeGatewayFails: undefined,
    forcedUuid: undefined,
    duringCreate: undefined,
  });
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_BACKENDS = 'claude-code';
  process.env.B_STUDIO_SESSIONS_DIR = sessionsDir;
  delete process.env.B_STUDIO_PREVIEW_DOMAIN;
  Object.assign(process.env, { GIT_AUTHOR_NAME: 'cf', GIT_AUTHOR_EMAIL: 'cf@example.com', GIT_COMMITTER_NAME: 'cf', GIT_COMMITTER_EMAIL: 'cf@example.com', B_STUDIO_GIT_AUTHOR_NAME: 'cf', B_STUDIO_GIT_AUTHOR_EMAIL: 'cf@example.com' });
});

afterEach(async () => {
  delete process.env.B_STUDIO_PREVIEW_DOMAIN;
  // 이 파일의 시험이 만든 세션을 정리한다(맵은 프로세스 전역이다)
  for (const id of [...liveSessions().keys()]) await stopSession(id).catch(() => {});
  liveSessions().clear();
});

afterAll(() => {
  for (const [key, value] of [
    ['B_STUDIO_MODE', saved.mode],
    ['B_STUDIO_AUTH', saved.auth],
    ['B_STUDIO_BACKENDS', saved.backends],
    ['B_STUDIO_SESSIONS_DIR', saved.sessions],
    ['B_STUDIO_PREVIEW_DOMAIN', saved.previewDomain],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function entries(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [])).sort();
}

/** 폴더 안의 모든 파일을 (상대 경로 → 내용 해시)로 읽는다. 폴더가 그대로인지 파일 하나하나 견준다 */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) {
        out[`${rel}/`] = 'dir';
        await walk(full);
      } else {
        out[rel] = createHash('sha256').update(await readFile(full)).digest('hex');
      }
    }
  }
  await walk(dir);
  return out;
}

async function failure(task: Promise<unknown>): Promise<{ status?: number; message: string }> {
  try {
    await task;
  } catch (error) {
    return { status: (error as { status?: number }).status, message: error instanceof Error ? error.message : String(error) };
  }
  throw new Error('세션 만들기가 실패해야 하는데 성공했습니다');
}

describe('작업 복사본 세션: 만들다 실패하면 이 호출이 만든 것을 치운다', () => {
  beforeEach(async () => {
    await makeProject(fake.roots.failproj!, 'failproj');
  });

  it('프로젝트 읽기(loadProject)가 실패하면 세션 폴더가 남지 않는다', async () => {
    fake.corruptSpecAfterFind = true;
    const error = await failure(createSession('failproj', 'kim', 'copy'));
    expect(error.message, '옛 오류 글과 같아야 한다').toMatch(/studio\.yaml/);
    expect(await entries(sessionsDir), '실패한 세션의 폴더').toEqual([]);
    expect(liveSessions().size).toBe(0);
    expect(fake.creates, '프로젝트 읽기에서 실패하면 샌드박스를 만들지 않는다').toBe(0);
  });

  it('로그인 확인(assertBackendReady)이 실패하면 409로 던지고 세션 폴더가 남지 않는다', async () => {
    fake.preflightFails = true;
    const error = await failure(createSession('failproj', 'kim', 'copy', { backend: 'claude-code' }));
    expect(error.status).toBe(409);
    expect(error.message).toBe('로컬 Claude Code를 쓸 수 없습니다: 로그인되어 있지 않습니다(가짜)');
    expect(await entries(sessionsDir)).toEqual([]);
    expect(fake.creates).toBe(0);
  });

  it('평가 자산을 꺼내지 못하면 500으로 던지고 세션 폴더가 남지 않는다', async () => {
    // 선언한 자산이 체크포인트에 없다
    // (git ls-tree가 거부하는 경로 지정자라 꺼내기가 던진다. 없는 파일은 "빈 폴더 자산"이 되어 던지지 않는다)
    await makeProject(fake.roots.failproj!, 'failproj', 'workflow:\n  required: [plan, implement, run, contract_check, test, review, checkpoint]\n  tests:\n    - { name: unit, service: api, command: [./gradlew, test] }\n  evaluationAssets: [":(bogus)asset.json"]\n');
    const error = await failure(createSession('failproj', 'kim', 'copy'));
    expect(error.status).toBe(500);
    expect(error.message).toMatch(/^평가 자산을 준비하지 못해 세션을 만들지 않았습니다: /);
    expect(await entries(sessionsDir)).toEqual([]);
    expect(fake.creates).toBe(0);
  });

  it('샌드박스 만들기(provider.create)가 실패하면 세션 폴더가 남지 않는다', async () => {
    fake.createFails = true;
    const error = await failure(createSession('failproj', 'kim', 'copy'));
    expect(error.message).toBe('샌드박스를 만들지 못했습니다(가짜)');
    expect(await entries(sessionsDir)).toEqual([]);
    expect(liveSessions().size).toBe(0);
  });

  it('세션을 맵에 넣은 뒤에 실패하면 샌드박스를 치우고 맵·레지스트리에서 빼고 폴더를 지운다', async () => {
    process.env.B_STUDIO_PREVIEW_DOMAIN = 'preview.example.test';
    fake.gatewayFails = true;
    const error = await failure(createSession('failproj', 'kim', 'copy'));
    expect(error.message).toBe('미리보기 게이트웨이를 만들지 못했습니다(가짜)');
    expect(fake.creates).toBe(1);
    expect(fake.destroyCalls, '만든 샌드박스를 치웠다').toBe(1);
    expect(liveSessions().size, '반쯤 만든 세션이 맵에 남았다').toBe(0);
    expect(await entries(sessionsDir), '세션 폴더가 남았다').toEqual([]);
  });

  it('맵에 넣은 뒤 저장이 예약된 채 실패해도, 지운 세션 폴더에 저장 파일이 다시 생기지 않는다(다음 시작 때 유령 세션이 되지 않는다)', async () => {
    process.env.B_STUDIO_PREVIEW_DOMAIN = 'preview.example.test';
    fake.gatewayFails = true;
    // 게이트웨이가 던지기 직전에, 맵에 든 세션의 저장을 예약해 둔다(이벤트 하나가 저장을 예약한 것과 같다)
    fake.beforeGatewayFails = () => {
      for (const session of liveSessions().values()) (session as unknown as { persist: { schedule(): void } }).persist.schedule();
    };
    const error = await failure(createSession('failproj', 'kim', 'copy'));
    expect(error.message).toBe('미리보기 게이트웨이를 만들지 못했습니다(가짜)');
    // 저장 예약(500ms)이 지나도록 기다린다
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(await entries(sessionsDir), '지운 세션 폴더에 예약된 저장이 저장 파일을 다시 썼다').toEqual([]);
  });

  it('샌드박스를 치우다 실패해도 원래 오류를 던지고, 그래도 폴더는 지운다', async () => {
    process.env.B_STUDIO_PREVIEW_DOMAIN = 'preview.example.test';
    fake.gatewayFails = true;
    fake.destroyFails = true;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const error = await failure(createSession('failproj', 'kim', 'copy'));
      expect(error.message, '치우기 오류가 아니라 원래 오류').toBe('미리보기 게이트웨이를 만들지 못했습니다(가짜)');
      expect(fake.destroyCalls).toBe(1);
      expect(logged, '치우기 실패는 로그로 남는다').toHaveBeenCalled();
      expect(await entries(sessionsDir)).toEqual([]);
      expect(liveSessions().size).toBe(0);
    } finally {
      logged.mockRestore();
    }
  });
});

describe('내 폴더 세션: 상태 폴더만 치우고 사용자 폴더는 그대로 둔다', () => {
  let userDir: string;
  beforeEach(async () => {
    userDir = path.join(root, 'my-folder');
    fake.roots.failproj = userDir;
    await makeProject(userDir, 'failproj');
  });

  it('프로젝트 읽기 뒤(샌드박스 만들기)에 실패하면 상태 폴더만 남지 않고 사용자 폴더는 파일 하나하나 같다', async () => {
    const before = await snapshotTree(userDir);
    fake.createFails = true;
    await failure(createSession('failproj', 'kim', 'local'));
    expect(await entries(sessionsDir), '상태 폴더(체크포인트 git)가 남았다').toEqual([]);
    expect(await snapshotTree(userDir), '사용자 폴더가 달라졌다').toEqual(before);
  });

  it('로그인 확인이 실패해도 마찬가지이고, 폴더 점유가 풀려 다시 만들 수 있다', async () => {
    const before = await snapshotTree(userDir);
    fake.preflightFails = true;
    await failure(createSession('failproj', 'kim', 'local', { backend: 'claude-code' }));
    expect(await entries(sessionsDir)).toEqual([]);
    expect(await snapshotTree(userDir)).toEqual(before);
    fake.preflightFails = false;
    const second = await createSession('failproj', 'kim', 'local', { backend: 'claude-code' });
    expect(second.id).toBeTruthy();
    await stopSession(second.id).catch(() => {});
  }, 60_000);

  it('세션을 맵에 넣은 뒤에 실패해도 사용자 폴더는 그대로이고 상태 폴더만 지운다', async () => {
    process.env.B_STUDIO_PREVIEW_DOMAIN = 'preview.example.test';
    fake.gatewayFails = true;
    const before = await snapshotTree(userDir);
    await failure(createSession('failproj', 'kim', 'local'));
    expect(fake.destroyCalls).toBe(1);
    expect(liveSessions().size).toBe(0);
    expect(await entries(sessionsDir)).toEqual([]);
    expect(await snapshotTree(userDir)).toEqual(before);
  }, 60_000);
});

describe('경계: 이 호출이 만들지 않은 것은 지우지 않는다', () => {
  beforeEach(async () => {
    await makeProject(fake.roots.failproj!, 'failproj');
  });

  it('id가 겹쳐 세션 폴더가 이미 있으면(작업 복사본, git이 아닌 원본) 그 폴더를 건드리지 않고 거절한다', async () => {
    // 옛 코드는 없는 폴더를 만들 때와 같이 `cp`가 이미 있는 폴더에 복사본을 섞어 넣고 세션을 만들었다. 다른 세션의 폴더일 수 있다
    const existing = path.join(sessionsDir, 'failproj-abcd1234');
    await mkdir(path.join(existing, '.git', 'b-studio'), { recursive: true });
    await writeFile(path.join(existing, 'precious.txt'), '다른 세션의 파일\n');
    const before = await snapshotTree(existing);
    fake.forcedUuid = 'abcd1234';
    const error = await failure(createSession('failproj', 'kim', 'copy'));
    expect(error.message).toMatch(/이미 있어 새로 만들지 않았습니다/);
    expect(await snapshotTree(existing), '이미 있던 폴더가 달라졌다').toEqual(before);
    expect(fake.creates, '폴더를 만들지 못하면 뒤 단계로 가지 않는다').toBe(0);
    expect(liveSessions().size).toBe(0);
  });

  it('id가 겹쳐 세션 폴더가 이미 있으면(git 원본) 그 폴더를 건드리지 않는다', async () => {
    await gitInit(fake.roots.failproj!);
    const existing = path.join(sessionsDir, 'failproj-abcd1234');
    await mkdir(existing, { recursive: true });
    await writeFile(path.join(existing, 'precious.txt'), '다른 세션의 파일\n');
    const before = await snapshotTree(existing);
    fake.forcedUuid = 'abcd1234';
    await failure(createSession('failproj', 'kim', 'copy'));
    expect(await snapshotTree(existing), '이미 있던 폴더가 달라졌다').toEqual(before);
    expect(liveSessions().size).toBe(0);
  });

  it('세션 폴더가 빈 폴더로 이미 있어도 거절한다(옛 코드는 빈 폴더에 복제했다)', async () => {
    await mkdir(path.join(sessionsDir, 'failproj-abcd1234'), { recursive: true });
    fake.forcedUuid = 'abcd1234';
    await failure(createSession('failproj', 'kim', 'copy'));
    expect(await entries(path.join(sessionsDir, 'failproj-abcd1234')), '이 호출이 만든 것이 아니므로 지우지 않는다').toEqual([]);
    expect((await stat(path.join(sessionsDir, 'failproj-abcd1234'))).isDirectory()).toBe(true);
  });

  it('맵에 같은 id의 세션이 이미 있으면(다른 프로젝트) 그 세션을 덮어쓰지도 빼지도 않는다', async () => {
    fake.roots.otherproj = path.join(root, 'other-project');
    await makeProject(fake.roots.otherproj, 'otherproj');
    fake.forcedUuid = 'beef0001';
    const first = await createSession('failproj', 'kim', 'copy');
    expect(first.id).toBe('beef0001');
    const firstSession = liveSessions().get('beef0001');
    const error = await failure(createSession('otherproj', 'kim', 'copy'));
    expect(error.status).toBe(500);
    expect(liveSessions().get('beef0001'), '첫 세션이 덮어써졌거나 빠졌다').toBe(firstSession);
    expect(registered('beef0001')).toBe(true);
    expect(getSnapshot('beef0001')?.projectId).toBe('failproj');
    expect(await entries(sessionsDir), '둘째 프로젝트의 폴더를 만들지 않았다').toEqual(['failproj-beef0001']);
    expect(fake.destroyCalls, '첫 세션의 샌드박스를 치우지 않았다').toBe(0);
    await stopSession('beef0001').catch(() => {});
  }, 60_000);

  it('만들기가 도는 사이에 같은 id가 맵에 들어오면 덮어쓰지 않고 실패하며, 그 세션을 빼지도 않고 이 호출이 만든 것만 치운다', async () => {
    fake.forcedUuid = 'beef0002';
    const other = { snapshot: { id: 'beef0002' }, marker: '다른 곳이 넣은 세션' } as unknown as Internals;
    fake.duringCreate = () => void liveSessions().set('beef0002', other);
    const error = await failure(createSession('failproj', 'kim', 'copy'));
    expect(error.status).toBe(500);
    expect(liveSessions().get('beef0002'), '다른 곳이 넣은 항목이 덮어써졌거나 빠졌다').toBe(other);
    expect(registered('beef0002'), '이 호출은 레지스트리에 넣지 않았다').toBe(false);
    expect(fake.destroyCalls, '이 호출이 만든 샌드박스는 치웠다').toBe(1);
    expect(await entries(sessionsDir), '이 호출이 만든 세션 폴더는 지웠다').toEqual([]);
  });

  it('세션 저장소가 링크인 설정: 만들기는 지금처럼 되고, 만들다 실패하면 링크 너머의 세션 폴더도 치운다(저장소 자체와 다른 폴더는 그대로)', async () => {
    const real = path.join(root, 'real-sessions');
    await mkdir(real, { recursive: true });
    await writeFile(path.join(real, 'other-session-file.txt'), 'keep\n');
    await symlink(real, sessionsDir);
    process.env.B_STUDIO_SESSIONS_DIR = sessionsDir;
    const created = await createSession('failproj', 'kim', 'copy');
    expect(await entries(real)).toEqual(expect.arrayContaining([`failproj-${created.id}`, 'other-session-file.txt']));
    await stopSession(created.id).catch(() => {});

    const before = await entries(real);
    fake.createFails = true;
    await failure(createSession('failproj', 'kim', 'copy'));
    expect(await entries(real), '실패한 세션의 폴더만 사라지고 나머지는 그대로').toEqual(before);
    expect(await readFile(path.join(real, 'other-session-file.txt'), 'utf8')).toBe('keep\n');
  }, 60_000);
});

describe('켜기: 즉시 기동·지연 기동·failed에서 다시 켜기(B2b 규칙 그대로)', () => {
  beforeEach(async () => {
    await makeProject(fake.roots.failproj!, 'failproj');
  });

  async function until(condition: () => boolean, label: string): Promise<void> {
    const started = Date.now();
    while (!condition()) {
      if (Date.now() - started > 10_000) throw new Error(`기다린 조건이 되지 않았습니다: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('즉시 기동은 만들자마자 켠다', async () => {
    const created = await createSession('failproj', 'kim', 'copy');
    // 스냅샷은 같은 객체라 가짜 샌드박스가 바로 켜지면 이미 ready일 수 있다. 켜기가 시작됐다는 것만 본다
    expect(['starting', 'ready']).toContain(created.status);
    await until(() => getSnapshot(created.id)?.status === 'ready', 'ready');
    expect(fake.startCalls).toBe(1);
    await stopSession(created.id).catch(() => {});
  });

  it('지연 기동은 idle로 두고 켜지 않는다', async () => {
    const created = await createSession('failproj', 'kim', 'copy', { boot: 'on-demand' });
    expect(created.status).toBe('idle');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.startCalls).toBe(0);
    expect(getSnapshot(created.id)?.status).toBe('idle');
    await stopSession(created.id).catch(() => {});
  });

  it('켜기가 실패하면 failed이고 세션 폴더는 지우지 않으며, 지금 켜기로 다시 켜면 ready가 된다', async () => {
    fake.startFailures = 1;
    const created = await createSession('failproj', 'kim', 'copy');
    await until(() => getSnapshot(created.id)?.status === 'failed', 'failed');
    expect(await entries(sessionsDir), '켜기 실패는 만들기 실패가 아니다: 세션과 폴더가 남는다').toEqual([`failproj-${created.id}`]);
    const { bootSession } = await import('./sessions');
    await bootSession(created.id);
    expect(getSnapshot(created.id)?.status).toBe('ready');
    expect(fake.startCalls).toBe(2);
    await stopSession(created.id).catch(() => {});
  });
});
