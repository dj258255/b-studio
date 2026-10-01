import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { IssueSummary, Requirement } from '@b-studio/agent';
import { serializeRequirementsMarkdown } from '@b-studio/agent';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * PR 초안의 기본 연결 이슈·제목 범위(ADR-113)를 실제 sessions.ts 코드로 끝까지 돌려 본다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 체크포인트, 요구사항 평가(getSessionRequirements).
 * 가짜로 바꾸는 것: 샌드박스(Docker)와 원격 이슈 목록 조회(listIssues). 실제 네트워크·Docker 호출은 없다.
 */
const fake = vi.hoisted(() => ({
  root: '',
  issues: [] as IssueSummary[],
  listIssues: vi.fn(async () => [] as IssueSummary[]),
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-pr-draft-scope-fake',
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
  return { ...actual, listIssues: (...args: unknown[]) => (fake.listIssues as (...a: unknown[]) => unknown)(...args) };
});

import { createSession, getSnapshot, previewExport, sendMessage, sessionRequirementIssueNumbers, stopSession, subscribe } from './sessions';

let root: string;
const saved = {
  mode: process.env.B_STUDIO_MODE,
  sessions: process.env.B_STUDIO_SESSIONS_DIR,
  token: process.env.B_STUDIO_GITHUB_TOKEN,
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
review:
  auto: false
`;
}

/** 요구사항 하나(사람이 직접 확인함 — ADR-103). rev·manualVerification만 있으면 gateChecks·testRun 없이도 검증됨으로 매겨진다 */
function verifiedRequirement(id: string): Requirement {
  return {
    id,
    title: `${id} 기능`,
    kind: 'api',
    priority: 'must',
    acceptance: ['동작한다'],
    rev: 1,
    manualVerification: { by: 'kim', at: '2026-01-01', sha: 'seed0001', note: '이전 세션에서 이미 확인했다' },
  };
}

const ISSUE_BY_ID: Record<string, number> = { R2: 101, R5: 102, R17: 103 };
const TRACKING_ISSUE = 999;

/**
 * "이전 세션이 이미 R2·R5·R17을 검증하고 이슈로 발행해 둔" 상태를 main에 미리 심어 둔다(docs/requirements.md·
 * docs/requirements.issues.json). 이 커밋이 각 세션의 시작점(start)이 되므로, 세션 자신의 커밋(sessionCommits,
 * start..HEAD)에는 들어가지 않는다 — 버그 리포트의 "머지돼 닫힌 이전 요구사항까지 새 세션이 다시 내세운다"를
 * 재현·검증하는 핵심 장치다.
 */
async function setupRepo(): Promise<void> {
  const remote = path.join(root, 'orders.git');
  const source = path.join(root, 'project');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await mkdir(path.join(source, 'api/src'), { recursive: true });
  await mkdir(path.join(source, 'docs'), { recursive: true });
  await writeFile(path.join(source, 'studio.yaml'), studioYaml());
  await writeFile(path.join(source, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(source, 'api/src/Order.java'), 'class Order {}\n');

  const requirements = [verifiedRequirement('R2'), verifiedRequirement('R5'), verifiedRequirement('R17')];
  const statusById = Object.fromEntries(requirements.map((requirement) => [requirement.id, '검증됨' as const]));
  await writeFile(path.join(source, 'docs/requirements.md'), serializeRequirementsMarkdown(requirements, statusById));
  await writeFile(
    path.join(source, 'docs/requirements.issues.json'),
    `${JSON.stringify(
      {
        tracking: { issue: TRACKING_ISSUE, url: `https://github.com/acme/verifyproj/issues/${TRACKING_ISSUE}` },
        byId: Object.fromEntries(
          Object.entries(ISSUE_BY_ID).map(([id, issue]) => [id, { issue, rev: 1, publishedHash: 'seed', publishedAt: '2026-01-01T00:00:00.000Z' }]),
        ),
      },
      null,
      2,
    )}\n`,
  );

  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init (R2·R5·R17 이미 검증·발행됨)');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  fake.root = source;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-pr-draft-scope-'));
  fake.listIssues.mockClear();
  fake.listIssues.mockImplementation(async () => fake.issues);

  process.env.B_STUDIO_MODE = 'api';
  process.env.B_STUDIO_AUTH = 'none';
  process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
  process.env.B_STUDIO_GITHUB_TOKEN = 'ghp_test';
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
    ['B_STUDIO_GITHUB_TOKEN', saved.token],
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

/**
 * 파일을 바꾸고 턴을 끝내는 대본으로 요청을 보내고, 그 실행이 끝나기를 기다린다(한 번에 체크포인트 하나).
 * subscribe는 구독 시점에 지금까지의 기록을 먼저 동기로 재생한다 — 같은 세션에서 두 번째로 부르면 앞선
 * run_finished가 바로 재생돼 버려, 구독 해지 함수가 아직 할당되기 전에 불리는 경합이 생긴다. `armed`로
 * subscribe가 끝난 뒤(재생이 끝난 뒤)부터만 진짜 끝남으로 본다
 */
async function runWrite(id: string, request: string, file: string, content: string): Promise<void> {
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
  sendMessage(id, request, { allowBreaking: false, scriptedTurns: [{ toolCalls: [{ name: 'write_file', input: { path: file, content } }] }, { text: '완료했습니다.' }] });
  await finished;
}

/** 세션의 원격 주소를 github.com 모양으로 바꿔 둔다 — lookupIssues가 listIssues(가짜)를 쓰게 하려면 remote.kind가 github이어야 한다.
 * 실제 clone·fetch는 이미 끝난 뒤(로컬 bare 원격으로) 호출하므로 이후 git 명령에는 영향이 없다 */
async function useGithubRemote(id: string): Promise<void> {
  const workDir = getSnapshot(id)!.workDir;
  await git(workDir, 'remote', 'set-url', 'origin', 'https://github.com/acme/verifyproj.git');
}

function issue(number: number, state: 'open' | 'closed'): IssueSummary {
  return { number, state, title: `이슈 #${number}`, author: 'kim', labels: [], updatedAt: '2026-01-01T00:00:00.000Z', url: `https://github.com/acme/verifyproj/issues/${number}` };
}

describe('PR 초안의 요구사항 범위(ADR-113)', () => {
  it('작업 분해 통합 세션(계획이 요구사항을 언급함)은 ADR-110대로 검증된 요구사항을 전부 기본 연결한다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    await useGithubRemote(id);
    // 레인을 하나로 합친 병합 커밋 — 어떤 요구사항 id도 제목에 다시 적지 않는다(ADR-110의 원래 버그 상황)
    await runWrite(id, '레인 결과를 하나로 합쳐서 반영해줘', 'api/src/Merge.java', 'class Merge {}\n');
    fake.issues = [issue(101, 'open'), issue(102, 'open'), issue(103, 'open')];

    const planRequirementIds = ['R2', 'R5', 'R17']; // 통합 세션 신호(task-plans.ts의 planRequirementIds)
    const defaultIssues = await sessionRequirementIssueNumbers(id, planRequirementIds);
    expect(new Set(defaultIssues)).toEqual(new Set([101, 102, 103]));

    const preview = await previewExport(id, { issues: defaultIssues, planRequirementIds });
    expect(preview.title).toBe('[b-studio] feat: 요구사항 3개 구현과 검증 (R2~R17)');
    expect(preview.body).toContain('Implements: R2@rev1');
    expect(preview.body).toContain('Implements: R5@rev1');
    expect(preview.body).toContain('Implements: R17@rev1');
    // 전부 열려 있으니 추적 이슈도 함께 닫는다(ADR-110 규칙을 이슈의 실제 열림 상태로 재평가)
    expect(preview.body).toContain(`Closes #${TRACKING_ISSUE}`);
    expect(preview.body).not.toContain('관련:');

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('후속 세션이 R17 하나만 커밋했으면, 머지돼 닫힌 이전 요구사항(R2·R5)은 기본 연결하지 않는다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    await useGithubRemote(id);
    await runWrite(id, '[R17] 상세 화면 댓글 입력칸에 남은 글자 수를 보여 준다', 'api/src/CommentForm.java', 'class CommentForm {}\n');
    // R17의 이슈는 이전 PR이 머지되며 이미 닫혔다. R2·R5의 이슈 상태는 이번 세션의 후보가 아니므로 확인조차 하지 않는다
    fake.issues = [issue(103, 'closed')];

    const defaultIssues = await sessionRequirementIssueNumbers(id, []);
    expect(defaultIssues).toEqual([]); // 닫힌 이슈는 기본으로 다시 연결하지 않는다

    const preview = await previewExport(id, { issues: defaultIssues, planRequirementIds: [] });
    // "요구사항 N개 구현과 검증"으로 뭉뚱그리지 않고, 이 세션의 유일한 커밋 제목을 그대로 요약해 쓴다
    expect(preview.title).toContain('[R17]');
    expect(preview.title).not.toContain('구현과 검증');
    expect(preview.body).not.toContain('Closes #103');
    expect(preview.body).toContain('관련: #103');
    expect(preview.body).toContain('Implements: R17@rev1');
    // R2·R5는 이번 세션이 건드리지 않았으므로 Implements에도, Closes·관련에도 나오지 않는다
    expect(preview.body).not.toContain('R2@rev');
    expect(preview.body).not.toContain('R5@rev');
    expect(preview.body).not.toContain('Closes #101');
    expect(preview.body).not.toContain('Closes #102');
    // 추적 이슈는 이번 PR이 "남은 마지막 열린 하위 이슈"를 닫는 게 아니므로 관련으로만 가리킨다
    expect(preview.body).toContain(`관련: #${TRACKING_ISSUE}`);
    expect(preview.body).not.toContain(`Closes #${TRACKING_ISSUE}`);

    await stopSession(id).catch(() => {});
  }, 20_000);

  it('이번 세션이 R2·R17을 커밋했고 R2 이슈만 닫혀 있으면, 열린 R17만 Closes로 R2는 관련으로 내린다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    await useGithubRemote(id);
    await runWrite(id, '[R2] 목록 화면에 정렬 옵션을 더한다', 'api/src/OrderSort.java', 'class OrderSort {}\n');
    await runWrite(id, '[R17] 상세 화면 댓글 입력칸에 남은 글자 수를 보여 준다', 'api/src/CommentForm.java', 'class CommentForm {}\n');
    fake.issues = [issue(101, 'closed'), issue(103, 'open')];

    const defaultIssues = await sessionRequirementIssueNumbers(id, []);
    expect(defaultIssues).toEqual([103]);

    const preview = await previewExport(id, { issues: defaultIssues, planRequirementIds: [] });
    expect(preview.body).toContain('Closes #103');
    expect(preview.body).not.toContain('Closes #101');
    expect(preview.body).toContain('관련: #101');
    expect(preview.body).toContain('Implements: R2@rev1');
    expect(preview.body).toContain('Implements: R17@rev1');
    expect(preview.body).not.toContain('R5@rev');
    // 커밋이 둘이라 "요구사항 2개 구현과 검증"으로 요약한다(한 커밋 재사용 규칙은 요구사항·커밋이 하나일 때만 쓴다)
    expect(preview.title).toBe('[b-studio] feat: 요구사항 2개 구현과 검증 (R2~R17)');

    await stopSession(id).catch(() => {});
  }, 20_000);
});
