import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 문서 체크포인트(ADR-096)를 실제 sessions.ts 코드로 끝까지 돌려 본다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 체크포인트, 요구사항 저장(applySessionRequirements).
 * 가짜로 바꾸는 것: 샌드박스(Docker)와 findProject(파일을 읽어 그대로 쓴다). 실제 Docker 호출은 없다.
 */
const fake = vi.hoisted(() => ({
  root: '',
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-docs-checkpoint-fake',
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
    // 시크릿 거부 경로를 확인할 수 있게 "sk_live_"로 시작하는 텍스트를 시크릿으로 본다
    findSecrets: (text: string) => (text.includes('sk_live_') ? ['FAKE_TOKEN'] : []),
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

import {
  applySessionRequirements,
  clearRequirementManualVerification,
  commitPendingWorkingCopyDocs,
  commitWorkingCopyDocs,
  createSession,
  createSessionDoc,
  getSnapshot,
  isDocPath,
  markRequirementManualVerification,
  stopSession,
  writeSessionDoc,
} from './sessions';

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
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
workflow:
  required: [plan, implement, run, contract_check, checkpoint]
  releaseRequires: [checkpoint]
review:
  auto: false
`;
}

async function setupRepo(): Promise<void> {
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
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-docs-checkpoint-'));
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

async function waitForReady(id: string, timeoutMs = 10_000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const status = getSnapshot(id)?.status ?? 'missing';
    if (status === 'ready' || status === 'failed' || status === 'stopped') return status;
    if (Date.now() - started > timeoutMs) throw new Error(`세션이 준비되지 않았습니다 (${status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sample = { id: 'R1', title: '로그인', kind: 'api', priority: 'must', acceptance: ['a'] };

describe('isDocPath', () => {
  it('docs/** 전부, 루트의 *.md, PR 템플릿만 문서 경로로 인정한다', () => {
    expect(isDocPath('docs/requirements.md')).toBe(true);
    expect(isDocPath('docs/requirements.issues.json')).toBe(true);
    expect(isDocPath('docs/adr/ADR-096.md')).toBe(true);
    expect(isDocPath('README.md')).toBe(true);
    expect(isDocPath('CHANGELOG.md')).toBe(true);
    expect(isDocPath('.github/pull_request_template.md')).toBe(true);

    expect(isDocPath('api/src/Order.java')).toBe(false);
    expect(isDocPath('apps/studio/README.md')).toBe(false); // 루트가 아닌 하위 폴더의 *.md는 아니다
    expect(isDocPath('docs')).toBe(false);
  });
});

describe('문서 체크포인트(ADR-096)', () => {
  it('문서가 아닌 경로가 섞이면 거부하고 아무것도 커밋하지 않는다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;
    await mkdir(path.join(workDir, 'docs'), { recursive: true });
    await writeFile(path.join(workDir, 'docs/requirements.md'), '# 요구사항\n');
    await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String memo; }\n');

    await expect(commitWorkingCopyDocs(id, ['docs/requirements.md', 'api/src/Order.java'], '문서: 섞인 경로')).rejects.toThrow('문서 경로가 아니어서');

    const after = getSnapshot(id)!;
    expect(after.checkpoints).toHaveLength(1); // 세션 시작 체크포인트뿐, 새 체크포인트가 생기지 않았다
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('범위 안에 바뀐 파일이 없으면 커밋하지 않고 건너뛴다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    expect(await commitWorkingCopyDocs(id, ['docs/requirements.md'], '문서: 아무것도 안 바뀜')).toBeUndefined();
    expect(getSnapshot(id)!.checkpoints).toHaveLength(1);
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('문서만 바뀐 변경을 검증 게이트 없이 체크포인트로 남기고, 그 밖의 바뀐 파일은 손대지 않는다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;
    await mkdir(path.join(workDir, 'docs'), { recursive: true });
    await writeFile(path.join(workDir, 'docs/requirements.md'), '# 요구사항\n');
    await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String memo; }\n'); // 범위 밖 변경(진행 중인 코드 수정 흉내)

    const checkpoint = await commitWorkingCopyDocs(id, ['docs/requirements.md'], 'docs: 요구사항을 정리한다 (R1)');

    expect(checkpoint).toMatchObject({ message: 'docs: 요구사항을 정리한다 (R1)', files: ['docs/requirements.md'], verify: 'docs' });
    // 검증 게이트를 거치지 않았으므로 통과 기록(Workflow-Passed)이 없다 — 배포 조건·"검증됨" 판정의 증거가 되지 않는다
    expect(checkpoint!.passedStages).toBeUndefined();
    expect(getSnapshot(id)!.checkpoints[0]).toMatchObject({ sha: checkpoint!.sha, verify: 'docs' });

    // 범위 밖(api/src/Order.java)은 그대로 작업 복사본에 남아 있다(git status에 아직 반영 안 된 변경으로)
    expect(await git(workDir, 'status', '--porcelain', '--', 'api/src/Order.java')).toContain('Order.java');
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('시크릿 값이 든 문서는 커밋하지 않는다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;
    await mkdir(path.join(workDir, 'docs'), { recursive: true });
    await writeFile(path.join(workDir, 'docs/requirements.issues.json'), '{"token":"sk_live_1234567890"}\n');

    await expect(commitWorkingCopyDocs(id, ['docs/requirements.issues.json'], '문서: 이슈 발행 기록')).rejects.toThrow('시크릿 값');
    expect(getSnapshot(id)!.checkpoints).toHaveLength(1);
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('commitPendingWorkingCopyDocs는 지금 바뀐 문서 경로만 골라 커밋한다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;
    await mkdir(path.join(workDir, 'docs'), { recursive: true });
    await writeFile(path.join(workDir, 'docs/requirements.md'), '# 요구사항\n');
    await writeFile(path.join(workDir, 'README.md'), '# 변경\n');
    await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String memo; }\n');

    const checkpoint = await commitPendingWorkingCopyDocs(id, '문서: 남은 문서 변경을 정리한다');

    expect(checkpoint?.files.sort()).toEqual(['README.md', 'docs/requirements.md']);
    expect(checkpoint?.verify).toBe('docs');
    expect(await git(workDir, 'status', '--porcelain', '--', 'api/src/Order.java')).toContain('Order.java');
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('요구사항을 저장하면 docs/requirements.md를 작업 복사본에 쓰고 바로 문서 체크포인트로 남긴다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    const snapshot = await applySessionRequirements(id, { requirements: [sample] });

    expect(snapshot.requirements).toHaveLength(1);
    // 상태가 "검증됨"이 되지 않는다 — 게이트를 돌리지 않았으므로 gateChecks 증거가 없고, 문서 체크포인트만으로는 "작업 중"에 그친다
    expect(snapshot.requirements[0]!.status).not.toBe('검증됨');
    expect(['미착수', '작업 중']).toContain(snapshot.requirements[0]!.status);

    const checkpoints = getSnapshot(id)!.checkpoints;
    expect(checkpoints[0]).toMatchObject({ message: 'docs: 요구사항을 정리한다 (R1)', verify: 'docs', files: ['docs/requirements.md'] });
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('여러 요구사항을 저장하면 커밋 메시지에 id 범위를 남긴다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    await applySessionRequirements(id, {
      requirements: [sample, { id: 'R2', title: '목록', kind: 'api', priority: 'should', acceptance: ['b'] }, { id: 'R20', title: '검색', kind: 'api', priority: 'could', acceptance: ['c'] }],
    });

    const checkpoints = getSnapshot(id)!.checkpoints;
    expect(checkpoints[0]!.message).toBe('docs: 요구사항을 정리한다 (R1~R20)');
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('문서 탭에서 고치거나 새 문서를 만들면 바로 문서 체크포인트로 남긴다(레인·PR이 물려받는다)', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    await writeSessionDoc(id, 'README.md', '# 프로젝트\n\n실행 방법을 적는다.\n');
    expect(getSnapshot(id)!.checkpoints[0]).toMatchObject({ message: 'docs: README.md 내용을 고친다', verify: 'docs', files: ['README.md'] });

    const created = await createSessionDoc(id, { kind: 'adr', title: '결제 재시도 경계' });
    expect(getSnapshot(id)!.checkpoints[0]).toMatchObject({ message: 'docs: 결제 재시도 경계 문서를 더한다', verify: 'docs', files: [created.path] });
    await stopSession(id).catch(() => {});
  }, 20_000);
});

describe('사람이 "직접 확인함"(ADR-0XX)', () => {
  it('메모와 함께 남기면 docs/requirements.md에 확인 줄이 남고 검증됨으로 바뀐다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    await applySessionRequirements(id, { requirements: [sample] });

    const snapshot = await markRequirementManualVerification(id, 'R1', { note: '화면을 직접 눌러 확인했습니다' }, 'kim');

    const requirement = snapshot.requirements.find((entry) => entry.id === 'R1')!;
    expect(requirement.status).toBe('검증됨');
    expect(requirement.verifiedBy).toBe('manual');
    expect(requirement.manualVerification).toMatchObject({ by: 'kim', note: '화면을 직접 눌러 확인했습니다' });

    const workDir = getSnapshot(id)!.workDir;
    const doc = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');
    expect(doc).toContain('- 확인: kim ·');
    expect(doc).toContain('메모 화면을 직접 눌러 확인했습니다');

    const checkpoints = getSnapshot(id)!.checkpoints;
    expect(checkpoints[0]).toMatchObject({ message: 'docs: R1 사람 확인을 남긴다', verify: 'docs' });
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('메모 없이는 거부한다(그냥 누른 버튼과 구분한다)', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    await applySessionRequirements(id, { requirements: [sample] });

    await expect(markRequirementManualVerification(id, 'R1', { note: '   ' }, 'kim')).rejects.toThrow('메모');
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('"확인 취소"를 누르면 지워지고 검증됨에서 내려온다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    await applySessionRequirements(id, { requirements: [sample] });
    await markRequirementManualVerification(id, 'R1', { note: '확인함' }, 'kim');

    const snapshot = await clearRequirementManualVerification(id, 'R1');

    const requirement = snapshot.requirements.find((entry) => entry.id === 'R1')!;
    expect(requirement.manualVerification).toBeUndefined();
    expect(requirement.status).not.toBe('검증됨');

    const workDir = getSnapshot(id)!.workDir;
    const doc = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');
    expect(doc).not.toContain('- 확인:');
    await stopSession(id).catch(() => {});
  }, 20_000);
});
