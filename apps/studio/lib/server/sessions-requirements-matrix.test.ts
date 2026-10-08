import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 추적 매트릭스가 "명세" 탭 목록과 똑같은 요구사항 평가를 쓰는지(ADR-106) 실제 sessions.ts 코드로 끝까지 돌려 본다 —
 * 테스트 탭 실행(testRun)·문서 확인(docEvidence)·사람 확인(manualVerification) 세 증거를 모두 갖춘 요구사항을
 * 두고, getSessionRequirements(목록)와 getSessionRequirementsMatrix(매트릭스)가 똑같은 상태·검증 출처를 내는지
 * 확인한다. 이 버그 전에는 매트릭스가 체크포인트·테스트 파일 이름·게이트만 보고 따로 계산해, 목록은 "검증됨"인데
 * 매트릭스는 "작업 중"·"재확인 필요"로 보여주는 모순이 있었다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 요구사항 저장(applySessionRequirements), 사람 확인
 * (markRequirementManualVerification), 테스트 탭 실행(runSessionTests), getSessionRequirements·
 * getSessionRequirementsMatrix.
 * 가짜로 바꾸는 것: 샌드박스(Docker) exec — 실제 vitest를 돌리지 않고 미리 정해 둔 JSON 리포트를 돌려준다.
 */
const fake = vi.hoisted(() => ({
  root: '',
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-requirements-matrix-fake',
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
    async exec() {
      // vitest --reporter=json 보고서 하나를 흉내 낸다: R3를 언급하는 테스트가 통과했다고 본다
      const report = JSON.stringify({ testResults: [{ name: 'web/src/payment.test.ts', assertionResults: [{ title: '[R3] 결제를 완료 처리한다', status: 'passed' }] }] });
      return { exitCode: 0, stdout: report, stderr: '' };
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

import { applySessionRequirements, createSession, getSessionRequirements, getSessionRequirementsMatrix, getSnapshot, markRequirementManualVerification, runSessionTests, stopSession } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  return stdout.trim();
}

function studioYaml(): string {
  return `version: 1
name: verifyproj
services:
  web: { source: managed, template: vite, path: web, port: 5173, preview: browser }
workflow:
  required: [plan, implement, run, contract_check, checkpoint]
  releaseRequires: [checkpoint]
review:
  auto: false
`;
}

function readmeWithDeploySection(): string {
  return `# 프로젝트

## 배포 절차

운영 환경 배포 절차와 체크리스트를 안내한다.
`;
}

async function setupRepo(): Promise<void> {
  const remote = path.join(root, 'orders.git');
  const source = path.join(root, 'project');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await mkdir(path.join(source, 'web/src'), { recursive: true });
  await writeFile(path.join(source, 'studio.yaml'), studioYaml());
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  web: { build: ./web }\n');
  await writeFile(path.join(source, 'README.md'), readmeWithDeploySection());
  await writeFile(path.join(source, 'web/package.json'), JSON.stringify({ name: 'web', devDependencies: { vitest: '^1.0.0' } }));
  await writeFile(path.join(source, 'web/src/App.tsx'), 'export default function App() { return null; }\n');
  await writeFile(path.join(source, 'web/src/payment.test.ts'), "import { test } from 'vitest';\ntest('[R3] 결제를 완료 처리한다', () => {});\n");
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  fake.root = source;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-requirements-matrix-'));
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

describe('추적 매트릭스는 "명세" 탭 목록과 같은 평가를 쓴다(ADR-106)', () => {
  it('테스트 탭 실행·문서 확인·사람 확인으로 검증된 요구사항을 목록·매트릭스가 똑같은 상태로 보여준다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    await applySessionRequirements(id, {
      requirements: [
        { id: 'R1', title: '사람이 직접 확인하는 화면', kind: 'ui', priority: 'must', acceptance: ['화면을 눈으로 보고 확인한다'] },
        { id: 'R2', title: '배포 절차 문서화', kind: 'docs', priority: 'must', acceptance: ['배포 절차를 README에 안내한다'] },
        { id: 'R3', title: '결제 완료 처리', kind: 'api', priority: 'must', acceptance: ['결제를 완료 처리한다'] },
        { id: 'R4', title: '아직 손 안 댄 요구사항', kind: 'api', priority: 'must', acceptance: ['아직 아무 증거도 없다'] },
      ],
    });
    await markRequirementManualVerification(id, 'R1', { note: '화면을 직접 눌러 확인했습니다' }, 'kim');
    await runSessionTests(id, { service: 'web' });

    const list = await getSessionRequirements(id);
    const matrix = await getSessionRequirementsMatrix(id);

    // 핵심 회귀 방지: 요구사항 하나하나마다 목록 상태 === 매트릭스 상태
    for (const requirementId of ['R1', 'R2', 'R3', 'R4']) {
      const listStatus = list.requirements.find((requirement) => requirement.id === requirementId)!.status;
      const matrixStatus = matrix.rows.find((row) => row.id === requirementId)!.status;
      expect(matrixStatus).toBe(listStatus);
    }

    expect(list.requirements.find((requirement) => requirement.id === 'R1')!.status).toBe('검증됨');
    expect(list.requirements.find((requirement) => requirement.id === 'R2')!.status).toBe('검증됨');
    expect(list.requirements.find((requirement) => requirement.id === 'R3')!.status).toBe('검증됨');
    // R4는 증거가 없다. 네 요구사항을 한 번에 저장한 문서 체크포인트 메시지는 "R1~R4" 범위 라벨만 남기는데,
    // 그 범위 표기의 양 끝 id는 개별 언급으로 치지 않으므로(findMentionedIds, 다그푸딩 마찰 136) "미착수"로 남는다
    expect(list.requirements.find((requirement) => requirement.id === 'R4')!.status).toBe('미착수');

    // 검증 출처 배지도 목록의 verifiedBy를 더 자세히 가른 값과 맞는다
    expect(matrix.rows.find((row) => row.id === 'R1')!.verifiedBy).toBe('사람 확인');
    expect(matrix.rows.find((row) => row.id === 'R2')!.verifiedBy).toBe('문서 확인');
    expect(matrix.rows.find((row) => row.id === 'R3')!.verifiedBy).toBe('테스트 탭');
    expect(matrix.rows.find((row) => row.id === 'R4')!.verifiedBy).toBe('none');

    // 테스트 열이 지금 체크포인트의 테스트 탭 실행 결과(통과)를 테스트 단위로 보여준다
    const r3Row = matrix.rows.find((row) => row.id === 'R3')!;
    expect(r3Row.tests.some((test) => test.result === 'pass')).toBe(true);

    // 역방향 목록: R4만 "테스트 없는 필수 요구사항"(진짜 공백), R1·R2는 테스트는 없지만 이미 검증됐으니 따로 담긴다
    expect(matrix.mustHavesWithoutTests.map((requirement) => requirement.id)).toEqual(['R4']);
    expect(matrix.mustHavesVerifiedWithoutTests.map((requirement) => requirement.id).sort()).toEqual(['R1', 'R2']);

    await stopSession(id).catch(() => {});
  }, 20_000);
});
