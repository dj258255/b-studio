import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 게이트 보고서 수거(collectGateTestReports)가 "이번 게이트가 통과시킨 test 체크의 서비스"만 새 체크포인트의 근거로
 * 찍는지 실제 sessions.ts 코드로 본다. 디스크(서비스 컨테이너)에 보고서가 남아 있다고 그것이 이번 게이트의 것은 아니다 —
 * 에이전트가 실행 도중 run_in_service로 돌린 부분 테스트나 이전 실행이 남긴 보고서가 새 체크포인트의 근거로 올라가면 안 된다.
 *
 * 진짜로 하는 것: 임시 폴더의 git 저장소, 세션 수명, 사이드카(.git/b-studio/test-results.json), 점검 판정.
 * 가짜로 바꾸는 것: 샌드박스 exec — 보고서 수거 명령(sh/cat)에 서비스별로 미리 정한 보고서를 돌려준다(없으면 빈 출력).
 * 실제 Docker·모델·GitHub·네트워크 호출은 없다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  /** 서비스별로 "디스크에 남아 있는" 보고서. 없으면 보고서 파일이 없는 것 */
  reports: new Map<string, string>(),
  collected: [] as string[],
}));

const junitXml = (testName: string) => `
<testsuite name="com.example.api.OrderServiceTest" tests="1" failures="0" errors="0" skipped="0">
  <testcase name="${testName}" classname="com.example.api.OrderServiceTest" time="0.01"/>
</testsuite>
`;

const jestJson = (testName: string) =>
  JSON.stringify({
    testResults: [
      {
        name: '/workspace/web/src/app.test.ts',
        status: 'passed',
        assertionResults: [{ ancestorTitles: [], title: testName, fullName: testName, status: 'passed', duration: 3 }],
      },
    ],
  });

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-gate-report-evidence-fake',
    name: 'fake',
    async start(options?: { onStatus?: (event: { service: string; phase: string; endpoint?: unknown }) => void; services?: readonly string[] }) {
      for (const service of options?.services ?? []) {
        options?.onStatus?.({ service, phase: 'ready', endpoint: { service, containerPort: 8080, url: 'http://127.0.0.1:1' } });
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
    // 수거 명령(Gradle은 sh -c, Vitest는 cat)에만 그 서비스의 보고서를 돌려준다
    async exec(service: string, command: string[]) {
      if (command[0] === 'sh' || command[0] === 'cat') {
        fake.collected.push(service);
        return { exitCode: 0, stdout: fake.reports.get(service) ?? '', stderr: '' };
      }
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

import { buildChecklistTestEvidence, collectGateTestReports, createSession, getSessionTests, getSnapshot, stopSession } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  return stdout.trim();
}

/** api(Gradle)는 test 항목이 하나, web(Vitest)은 둘이다 — "한 서비스에 test 항목이 여럿"을 같이 본다 */
function studioYaml(): string {
  return `version: 1
name: verifyproj
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
  web: { source: managed, template: vite, path: web, port: 5173, preview: browser }
workflow:
  tests:
    - { name: api-test, service: api, command: [./gradlew, test] }
    - { name: web-unit, service: web, command: [npx, vitest, run] }
    - { name: web-smoke, service: web, command: [npx, vitest, run, smoke] }
`;
}

async function setupRepo(): Promise<void> {
  const remote = path.join(root, 'orders.git');
  const source = path.join(root, 'project');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await mkdir(path.join(source, 'api', 'src'), { recursive: true });
  await mkdir(path.join(source, 'web', 'src'), { recursive: true });
  await writeFile(path.join(source, 'studio.yaml'), studioYaml());
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  api: { build: ./api }\n  web: { build: ./web }\n');
  await writeFile(path.join(source, 'web/package.json'), JSON.stringify({ name: 'web', devDependencies: { vitest: '^1.0.0' } }));
  await writeFile(path.join(source, 'api/src/Main.java'), 'class Main {}\n');
  await writeFile(path.join(source, 'web/src/App.tsx'), 'export default function App() { return null; }\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  fake.root = source;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-gate-report-evidence-'));
  fake.reports = new Map();
  fake.collected = [];
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
  if (saved.mode === undefined) delete process.env.B_STUDIO_MODE;
  else process.env.B_STUDIO_MODE = saved.mode;
  if (saved.sessions === undefined) delete process.env.B_STUDIO_SESSIONS_DIR;
  else process.env.B_STUDIO_SESSIONS_DIR = saved.sessions;
});

afterEach(() => {
  vi.restoreAllMocks();
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

type GateSession = Parameters<typeof collectGateTestReports>[0];
type GateChecks = NonNullable<Parameters<typeof collectGateTestReports>[2]>;
const check = (name: string, ok: boolean, stage: GateChecks[number]['stage'] = 'test'): GateChecks[number] => ({ stage, name, ok, attempts: 1 });

/** 게이트가 실행을 시작할 때 쓴 선언(픽스처 studio.yaml의 workflow.tests와 같다) */
const DECLARED = [
  { name: 'api-test', service: 'api' },
  { name: 'web-unit', service: 'web' },
  { name: 'web-smoke', service: 'web' },
];

function internals(id: string): GateSession {
  const store = (globalThis as { __bStudio?: { sessions: Map<string, GateSession> } }).__bStudio;
  const session = store?.sessions.get(id);
  if (!session) throw new Error('세션을 찾을 수 없습니다');
  return session;
}

async function readySession(): Promise<string> {
  await setupRepo();
  const id = (await createSession('verifyproj', 'kim', 'copy')).id;
  expect(await waitForReady(id)).toBe('ready');
  return id;
}

async function lastRun(id: string, service: string) {
  return (await getSessionTests(id)).services.find((candidate) => candidate.service === service);
}

describe('게이트 보고서 수거는 이번 게이트가 통과시킨 test 체크의 서비스만 새 체크포인트의 근거로 찍는다', () => {
  it('통과한 test 체크가 가리키는 서비스의 보고서만 새 체크포인트 sha로 남는다', async () => {
    const id = await readySession();
    const sha = getSnapshot(id)!.checkpoints[0]!.sha;
    fake.reports.set('api', junitXml('R1: 주문이 만들어진다'));
    fake.reports.set('web', jestJson('R2: 화면이 뜬다'));

    // api는 통과했고, web은 test 체크 하나가 실패했다(체크포인트가 남는 awaiting_input 경로)
    await collectGateTestReports(internals(id), sha, [check('api-test', true), check('web-unit', true), check('web-smoke', false)], DECLARED);

    const api = await lastRun(id, 'api');
    expect(api?.lastRunSha).toBe(sha);
    expect(api?.lastRunSource).toBe('gate');
    const web = await lastRun(id, 'web');
    expect(web?.lastRunSha).toBeUndefined();
    expect(web?.lastRunAt).toBeUndefined();
    // 읽어서 버린 것이 아니라 수거 명령 자체를 보내지 않았다
    expect(fake.collected).toEqual(['api']);
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('게이트가 그 서비스의 test를 돌리지 않았으면 디스크에 보고서가 있어도(에이전트가 중간에 돌린 것) 근거가 되지 않는다', async () => {
    const id = await readySession();
    const sha = getSnapshot(id)!.checkpoints[0]!.sha;
    // 에이전트가 run_in_service로 돌려 두 서비스 모두에 보고서가 남아 있다
    fake.reports.set('api', junitXml('R1: 중간에 돌린 부분 테스트'));
    fake.reports.set('web', jestJson('R2: 고치는 중에 돌린 테스트'));

    // test 단계를 돌리지 못했거나 가볍게 확인(light)이었던 실행 — test 체크가 하나도 없다
    await collectGateTestReports(internals(id), sha, [check('/', true, 'browser_check'), check('리뷰', true, 'review')], DECLARED);

    for (const service of ['api', 'web']) {
      const view = await lastRun(id, service);
      expect(view?.lastRunSha, `${service}의 sha`).toBeUndefined();
      expect(view?.lastRunAt, `${service}의 기록`).toBeUndefined();
    }
    expect(fake.collected).toEqual([]);
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('test 체크가 실패(ok: false)했으면 체크포인트가 남아도 근거가 되지 않는다', async () => {
    const id = await readySession();
    const sha = getSnapshot(id)!.checkpoints[0]!.sha;
    fake.reports.set('api', junitXml('R1: 실패한 실행의 보고서'));

    await collectGateTestReports(internals(id), sha, [check('api-test', false)], DECLARED);

    expect((await lastRun(id, 'api'))?.lastRunSha).toBeUndefined();
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('한 서비스에 test 항목이 여럿이면 전부 통과해야 그 서비스의 보고서를 모은다', async () => {
    const id = await readySession();
    const sha = getSnapshot(id)!.checkpoints[0]!.sha;
    fake.reports.set('web', jestJson('R2: 화면이 뜬다'));

    await collectGateTestReports(internals(id), sha, [check('web-unit', true), check('web-smoke', false)], DECLARED);
    expect((await lastRun(id, 'web'))?.lastRunSha).toBeUndefined();

    await collectGateTestReports(internals(id), sha, [check('web-unit', true), check('web-smoke', true)], DECLARED);
    expect((await lastRun(id, 'web'))?.lastRunSha).toBe(sha);
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('게이트가 돌리지 않은 서비스의 이전 근거는 새 체크포인트로 넘기지 않고 닫는다', async () => {
    const id = await readySession();
    const oldSha = getSnapshot(id)!.checkpoints[0]!.sha;
    fake.reports.set('api', junitXml('R1: 주문이 만들어진다'));
    fake.reports.set('web', jestJson('R2: 화면이 뜬다'));
    await collectGateTestReports(internals(id), oldSha, [check('api-test', true), check('web-unit', true), check('web-smoke', true)], DECLARED);

    // 새 체크포인트가 생겼고, 이번 게이트는 api만 통과시켰다(web의 test 체크는 돌지 않았다)
    const newSha = 'f'.repeat(40);
    await collectGateTestReports(internals(id), newSha, [check('api-test', true)], DECLARED);

    const snapshot = await getSessionTests(id);
    const api = snapshot.services.find((service) => service.service === 'api')!;
    const web = snapshot.services.find((service) => service.service === 'web')!;
    expect(api.lastRunSha).toBe(newSha);
    // web의 기록은 지워지지 않고 "이전 실행"으로 남되, 새 체크포인트 sha로 바뀌거나 넘어가지 않는다
    expect(web.lastRunSha).toBe(oldSha);
    const evidence = buildChecklistTestEvidence(snapshot.services, newSha, 0);
    expect(evidence.find((entry) => entry.service === 'api')?.matchesHead).toBe(true);
    expect(evidence.find((entry) => entry.service === 'web')?.matchesHead).toBe(false);
    await stopSession(id).catch(() => {});
  }, 20_000);
  it('에이전트가 이번 실행에서 workflow.tests를 고쳐도, 체크는 게이트가 실제로 쓴 선언으로 서비스에 짝짓는다', async () => {
    const id = await readySession();
    const sha = getSnapshot(id)!.checkpoints[0]!.sha;
    fake.reports.set('api', junitXml('R1: 주문이 만들어진다'));
    fake.reports.set('web', jestJson('R2: 화면이 뜬다'));

    // 게이트는 api-test(api) 하나만 선언된 설정으로 돌았고 그것만 통과했다. 그 뒤 설정이 다시 읽혀(체크포인트 저장)
    // 지금 선언은 같은 이름을 web에 붙이고 있다 — 지금 선언으로 짝지으면 게이트가 돌리지 않은 web이 근거를 얻는다
    const session = internals(id) as unknown as { project: { spec: { workflow?: { tests?: Array<{ name: string; service: string; command: string[] }> } } } };
    session.project.spec.workflow = { ...session.project.spec.workflow, tests: [{ name: 'api-test', service: 'web', command: ['true'] }] };

    await collectGateTestReports(internals(id), sha, [check('api-test', true)], [{ name: 'api-test', service: 'api' }]);

    expect((await lastRun(id, 'api'))?.lastRunSha).toBe(sha);
    expect((await lastRun(id, 'web'))?.lastRunSha).toBeUndefined();
  }, 20_000);
});
