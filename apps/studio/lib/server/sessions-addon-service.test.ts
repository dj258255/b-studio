import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import type { StudioEvent } from '@/lib/studio-events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 도그푸딩 마찰 138(ADR-146): BE-commerce 세션에서 에이전트가 실행 중 compose에 새 부가 서비스(mediamtx)를
 * 더했지만 어느 경로로도 뜨지 않았다. 세션을 다시 시작·이어서 작업해도 저장된 서비스 선택(ADR-083)이
 * known(저장 시점의 compose 서비스 전체)을 몰라 새로 생긴 서비스를 계속 가려내지 못했다.
 *
 * 실측 compose.b-studio.yaml을 다시 보니 mediamtx에는 아무 서비스도 depends_on을 걸지 않는다(MediaMTX가
 * commerce의 훅을 부르는 반대 방향이라서다). 그래서 이 테스트의 mediamtx도 depends_on 없이 둔다 — depends_on
 * 기준으로만 "새 서비스를 켤지" 판단하면 이 실제 사례를 그대로 놓친다.
 *
 * 저장된 선택에 known을 같이 두고, 다음에 읽을 때 known에 없는 서비스는 depends_on 여부와 무관하게 자동으로
 * 켜는지(처음 폴더를 열 때는 그러지 않는지), 사람이 끈 서비스는 그대로 두는지, 알림이 가는지를
 * createSession·resumeSession·sendMessage(실행 중 재시작)로 실제로 확인한다.
 *
 * 진짜로 하는 것: 파일 시스템의 git 저장소·체크포인트·서비스 선택 상태 파일. 가짜로 바꾸는 것: 샌드박스
 * (Docker)와 모델(ScriptedModelClient) — 실제 GitHub·모델을 부르지 않고, :3000에 dev 서버를 띄우지 않는다.
 */
const fake = vi.hoisted(() => ({ root: '', ensureInfraCalls: [] as string[][] }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-addon-service-fake',
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
    async ensureInfra(services: readonly string[]) {
      fake.ensureInfraCalls.push([...services]);
      return { ok: true, recovered: [...services] };
    },
    async setServiceRunning() {},
  } as unknown as Sandbox;
  return { ...actual, providerFromEnv: () => ({ name: 'fake', isolation: undefined, create: async () => sandbox }) };
});

vi.mock('./projects', () => ({
  findProject: async () => (await import('@b-studio/spec')).loadProject(fake.root),
}));

import { createSession, listServiceSelection, resumeSession, sendMessage, setSessionServiceSelection, stopSession, subscribe } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
  projectsState: process.env.B_STUDIO_PROJECTS_STATE_DIR,
};

/** api(managed)는 처음엔 mysql에만 기댄다. mediamtx는 나중에 더한다 */
const studioYaml = `version: 1
name: addonproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
review:
  auto: false
`;
const composeWithoutAddon = 'services:\n  api: { build: ./api, depends_on: [mysql] }\n  mysql: { image: mysql:8 }\n';
// 실측(compose.b-studio.yaml)과 같이 mediamtx에는 아무도 depends_on을 걸지 않는다(MediaMTX가 commerce의 훅을
// 부르는 반대 방향이라서다) — depends_on 기준으로만 "새 서비스를 켤지" 판단하면 이 사례를 놓친다
const composeWithAddon = 'services:\n  api: { build: ./api, depends_on: [mysql] }\n  mysql: { image: mysql:8 }\n  mediamtx: { image: bluenviron/mediamtx:latest }\n';

async function setupProject(): Promise<string> {
  const projectRoot = path.join(root, 'project');
  await mkdir(path.join(projectRoot, 'api/src'), { recursive: true });
  await writeFile(path.join(projectRoot, 'studio.yaml'), studioYaml);
  await writeFile(path.join(projectRoot, 'compose.yaml'), composeWithoutAddon);
  await writeFile(path.join(projectRoot, 'api/src/Order.java'), 'class Order {}\n');
  fake.root = projectRoot;
  return projectRoot;
}

beforeEach(async () => {
  fake.ensureInfraCalls.length = 0;
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-addon-service-'));
  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  // 실제 ~/.cache/b-studio/projects를 건드리지 않도록 테스트 전용 폴더로 돌린다
  process.env.B_STUDIO_PROJECTS_STATE_DIR = path.join(root, 'projects-state');
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
  if (saved.mode === undefined) delete process.env.B_STUDIO_MODE;
  else process.env.B_STUDIO_MODE = saved.mode;
  if (saved.sessions === undefined) delete process.env.B_STUDIO_SESSIONS_DIR;
  else process.env.B_STUDIO_SESSIONS_DIR = saved.sessions;
  if (saved.projectsState === undefined) delete process.env.B_STUDIO_PROJECTS_STATE_DIR;
  else process.env.B_STUDIO_PROJECTS_STATE_DIR = saved.projectsState;
});

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('기대한 상태가 되지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForStatus(id: string, status: string, timeoutMs = 10_000): Promise<void> {
  const { getSnapshot } = await import('./sessions');
  const started = Date.now();
  for (;;) {
    if (getSnapshot(id)?.status === status) return;
    if (Date.now() - started > timeoutMs) throw new Error(`세션이 ${status} 상태가 되지 않았습니다`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('처음 폴더를 열 때는 known이 없어 ADR-083 기본값(managed + depends_on 닫힘)을 쓴다', () => {
  it('depends_on 없는 부가 서비스(mediamtx)는 compose에 이미 있어도 기본으로 켜지지 않는다', async () => {
    const projectRoot = await setupProject();
    // 저장된 선택이 전혀 없는 상태에서, 처음부터 mediamtx가 있는 compose로 연다
    await writeFile(path.join(projectRoot, 'compose.yaml'), composeWithAddon);
    const id = (await createSession('addonproj', 'kim', 'local')).id;
    await waitForStatus(id, 'ready');

    const selection = listServiceSelection(id);
    expect(selection.find((service) => service.name === 'mysql')?.selected).toBe(true); // depends_on으로 기댐
    expect(selection.find((service) => service.name === 'mediamtx')?.selected).toBe(false); // 기대는 곳이 없음

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('저장된 선택에 known이 없으면(이 기능이 생기기 전) 새로 생긴 서비스를 가리지 않는다 — 기본값 그대로 간다', async () => {
    await setupProject();
    const id = (await createSession('addonproj', 'kim', 'local')).id;
    await waitForStatus(id, 'ready');

    // 기본값(저장한 선택 없음)이면 mysql도 managed가 기대므로 이미 선택돼 있다
    expect(listServiceSelection(id).find((service) => service.name === 'mysql')?.selected).toBe(true);
    await stopSession(id).catch(() => {});
  }, 20_000);
});

describe('known 이후 세션 재개에서 compose에 새로 생긴 부가 서비스(도그푸딩 마찰 138, ADR-146)', () => {
  it('재개할 때 compose에 새로 생긴 부가 서비스는 아무도 depends_on으로 기대지 않아도 켜고 왜 켰는지 알린다', async () => {
    const projectRoot = await setupProject();
    const id = (await createSession('addonproj', 'kim', 'local')).id;
    await waitForStatus(id, 'ready');
    // 서비스 메뉴를 한 번 써서 known이 기록된 선택 파일을 만든다(사람이 이미 한 번 결정한 상태를 흉내 낸다)
    await setSessionServiceSelection(id, 'mysql', true);
    await stopSession(id).catch(() => {});
    await waitForStatus(id, 'stopped');

    // 에이전트가 이전 체크포인트 실행에서 mediamtx를 compose에 더했다(실측과 같이 depends_on은 없다)
    await writeFile(path.join(projectRoot, 'compose.yaml'), composeWithAddon);

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));
    await resumeSession(id);
    await waitForStatus(id, 'ready');

    const selection = listServiceSelection(id);
    expect(selection.find((service) => service.name === 'mediamtx')?.selected).toBe(true);
    const notice = await waitFor(() =>
      events.find((event): event is Extract<StudioEvent, { type: 'notice' }> => event.type === 'notice' && event.text.includes('mediamtx')),
    );
    expect(notice.text).toContain('새로 생긴 부가 서비스를 켰습니다');
    expect(notice.text).toContain('서비스 메뉴');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('사람이 꺼 둔 서비스는 재개해도 새로 생긴 서비스와 무관하게 그대로 꺼진 채로 둔다', async () => {
    const projectRoot = await setupProject();
    const id = (await createSession('addonproj', 'kim', 'local')).id;
    await waitForStatus(id, 'ready');
    // 사람이 mysql을 명시적으로 끈다(known에는 mysql이 들어간다)
    await setSessionServiceSelection(id, 'mysql', false);
    await stopSession(id).catch(() => {});
    await waitForStatus(id, 'stopped');

    await writeFile(path.join(projectRoot, 'compose.yaml'), composeWithAddon);
    await resumeSession(id);
    await waitForStatus(id, 'ready');

    const selection = listServiceSelection(id);
    expect(selection.find((service) => service.name === 'mysql')?.selected).toBe(false);
    // mediamtx는 known 이후에 새로 생긴 서비스라 depends_on과 무관하게 켜진다 — mysql을 끈 것과는 별개 판단이다
    expect(selection.find((service) => service.name === 'mediamtx')?.selected).toBe(true);

    await stopSession(id).catch(() => {});
  }, 20_000);
});

describe('실행 중 재시작에서 compose에 새로 생긴 부가 서비스(도그푸딩 마찰 138, ADR-146)', () => {
  it('에이전트가 실행 중 compose에 더한 새 부가 서비스(depends_on 없음)를 자동으로 올리고 알린다', async () => {
    await setupProject();
    const id = (await createSession('addonproj', 'kim', 'local')).id;
    await waitForStatus(id, 'ready');

    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));

    // 에이전트가 이번 요청에서 compose.yaml에 mediamtx를 더한다(실측과 같이 depends_on은 없다)
    sendMessage(id, '라이브 방송용 RTMP 서버를 더해 주세요', {
      allowBreaking: false,
      scriptedTurns: [
        { toolCalls: [{ name: 'write_file', input: { path: 'compose.yaml', content: composeWithAddon } }] },
        { text: 'mediamtx를 compose에 더했습니다.' },
      ],
    });
    await waitFor(() => events.find((event) => event.type === 'run_finished'));

    // ensureInfraCalls에는 요청 전 ensureReadySessionInfra(ADR-143, 이 세션의 기존 선택 ['api','mysql'])도
    // 섞여 들어온다. 재시작에서 새 부가 서비스를 올리려는 호출만 본다(mediamtx가 들어간 호출)
    expect(fake.ensureInfraCalls.some((call) => call.includes('mediamtx'))).toBe(true);
    const warning = await waitFor(() =>
      events.find(
        (event): event is Extract<StudioEvent, { type: 'agent' }> =>
          event.type === 'agent' && event.event.type === 'warning' && event.event.message.includes('mediamtx'),
      ),
    );
    expect(warning.event.type === 'warning' && warning.event.message).toContain('새로 생긴 부가 서비스를 켰습니다');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 20_000);
});
