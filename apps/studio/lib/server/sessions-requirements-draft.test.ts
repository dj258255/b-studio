import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Sandbox } from '@b-studio/sandbox';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * 추출 결과(요구사항 탭의 "추출 결과" 하위 화면, ADR-097 개정)를 실제 sessions.ts 코드로 끝까지 돌려 본다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 추출 결과 사이드카 파일(.git/b-studio/requirements-draft.json), 요구사항 저장(applySessionRequirements).
 * 가짜로 바꾸는 것: 샌드박스(Docker)와 findProject. 추출 모델 호출 자체(previewSessionRequirementsExtraction의 ask 경로)는
 * 돌리지 않는다 — 이미 끝난 추출 결과를 사이드카 파일에 직접 남겨(실제 저장 모양 그대로) 그 뒤의 읽기·자동 저장·apply·지우기만 확인한다.
 */
const fake = vi.hoisted(() => ({
  root: '',
}));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-requirements-draft-fake',
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

import { applySessionRequirements, createSession, discardSessionRequirementExtractionDraft, getSessionRequirementExtractionDraft, getSnapshot, stopSession, updateSessionRequirementExtractionDraft } from './sessions';

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
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-requirements-draft-'));
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

/** 이미 끝난 추출 결과를 사이드카 파일에 직접 남긴다(실제 저장 모양 그대로 — previewSessionRequirementsExtraction의 모델 호출은 돌리지 않는다) */
async function seedDraft(workDir: string, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const draft = {
    requirements: [{ id: 'R1', title: '로그인 API', kind: 'api', priority: 'must', acceptance: ['a'] }],
    questions: ['동시 접속자 규모는?'],
    source: 'model',
    referencedFiles: [],
    outOfScope: [],
    assumptions: [],
    manualSteps: [],
    sourceInput: { specText: '로그인 API를 만든다' },
    savedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
  const file = path.join(workDir, '.git', 'b-studio', 'requirements-draft.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(draft, null, 2)}\n`);
  return draft;
}

describe('추출 결과 사이드카(요구사항 탭 "추출 결과" 하위 화면, ADR-097 개정)', () => {
  it('저장된 모양 그대로 읽는다(questions·source·sourceInput까지 round-trip)', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;
    const seeded = await seedDraft(workDir);

    const draft = await getSessionRequirementExtractionDraft(id);

    expect(draft).toMatchObject(seeded);
    expect(draft!.appliedAt).toBeUndefined();
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('자동 저장(PATCH)이 답변·추천·편집을 덮어쓰지 않고 합치고 updatedAt을 갱신한다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;
    await seedDraft(workDir);

    const recommendation = {
      question: '동시 접속자 규모는?',
      answer: '100명',
      rationale: '업계 관례',
      sources: [{ url: 'https://example.com', title: '참고' }],
      basis: 'practice' as const,
    };
    const updated = await updateSessionRequirementExtractionDraft(id, {
      answers: { '0': '100명' },
      recommendations: { '0': recommendation },
      recommendationSource: 'web',
      assumptions: ['동시 접속자 100명'],
    });

    expect(updated.answers).toEqual({ '0': '100명' });
    expect(updated.recommendations).toEqual({ '0': recommendation });
    expect(updated.recommendationSource).toBe('web');
    expect(updated.assumptions).toEqual(['동시 접속자 100명']);
    // 건드리지 않은 필드는 그대로 남는다
    expect(updated.questions).toEqual(['동시 접속자 규모는?']);
    expect(updated.source).toBe('model');
    expect(updated.sourceInput).toEqual({ specText: '로그인 API를 만든다' });
    expect(updated.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');

    const reread = await getSessionRequirementExtractionDraft(id);
    expect(reread).toEqual(updated);
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('저장 안 한 추출 결과가 없으면 자동 저장이 404를 던진다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    await expect(updateSessionRequirementExtractionDraft(id, { assumptions: ['a'] })).rejects.toThrow('저장 안 한 추출 결과가 없습니다');
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('docs/requirements.md로 저장(apply)해도 추출 결과를 지우지 않고 appliedAt만 남긴다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;
    await seedDraft(workDir, { answers: { '0': '100명' } });

    await applySessionRequirements(id, {
      requirements: [{ id: 'R1', title: '로그인 API(수정)', kind: 'api', priority: 'must', acceptance: ['수정된 인수 조건'] }],
      assumptions: ['동시 접속자 100명'],
      manualSteps: [],
    });

    const draft = await getSessionRequirementExtractionDraft(id);
    expect(draft).toBeDefined();
    expect(draft!.appliedAt).toBeDefined();
    expect(draft!.requirements[0]).toMatchObject({ id: 'R1', title: '로그인 API(수정)' });
    expect(draft!.assumptions).toEqual(['동시 접속자 100명']);
    // apply 이전에 남겨 둔 답변처럼, apply가 직접 건드리지 않는 필드는 그대로 남는다
    expect(draft!.answers).toEqual({ '0': '100명' });
    expect(draft!.questions).toEqual(['동시 접속자 규모는?']);
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('"지우기"(DELETE)를 부르면 추출 결과가 사라진다(저장한 docs/requirements.md는 건드리지 않는다)', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const workDir = getSnapshot(id)!.workDir;
    await seedDraft(workDir);
    await applySessionRequirements(id, { requirements: [{ id: 'R1', title: '로그인 API', kind: 'api', priority: 'must', acceptance: ['a'] }] });

    await discardSessionRequirementExtractionDraft(id);

    expect(await getSessionRequirementExtractionDraft(id)).toBeUndefined();
    expect(await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8')).toContain('로그인 API');
    await stopSession(id).catch(() => {});
  }, 20_000);
});

describe('applySessionRequirements — 첫 저장은 개정이 아니다(버그 리포트 33, 통합 세션에서 R3·R4가 즉시 "재확인 필요"로 보이던 문제)', () => {
  it('docs/requirements.md에 저장된 적이 없는 id가 rev·hash·revisedAt을 들고 와도(다른 세션의 추출 결과를 이어받은 경우 등) 첫 저장은 개정 1·revisedAt 없음으로 본다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    // docs/requirements.md는 이 세션에 한 번도 저장된 적이 없다 — 그런데 화면이 보낸 요구사항 중 하나(R3)가
    // 이미 rev·hash·revisedAt을 들고 있다(다른 세션의 추출 결과 사이드카를 이어받았거나, 재추출 미리보기가
    // 붙여 둔 값일 수 있다 — 이 파일 입장에서는 "본 적 없는" 값이다)
    const snapshot = await applySessionRequirements(id, {
      requirements: [
        { id: 'R1', title: '로그인 API', kind: 'api', priority: 'must', acceptance: ['로그인하면 토큰을 돌려준다'] },
        {
          id: 'R3',
          title: '주문 목록 API',
          kind: 'api',
          priority: 'must',
          acceptance: ['주문 목록을 돌려준다'],
          rev: 5,
          hash: '다른-세션에서-온-해시',
          revisedAt: '2020-01-01T00:00:00.000Z',
        },
      ],
      assumptions: [],
      manualSteps: [],
    });

    const r1 = snapshot.requirements.find((requirement) => requirement.id === 'R1')!;
    const r3 = snapshot.requirements.find((requirement) => requirement.id === 'R3')!;
    expect(r1.rev).toBe(1);
    expect(r1.revisedAt).toBeUndefined();
    expect(r1.status).not.toBe('재확인 필요');
    // 고쳤으면(discardRevisionIfNeverSaved) R3도 R1과 똑같이 첫 저장으로 본다 — 고치기 전에는
    // 들고 온 hash가 방금 계산한 해시와 달라 rev가 6으로 오르고 revisedAt이 찍혀 "재확인 필요"가 됐다
    expect(r3.rev).toBe(1);
    expect(r3.revisedAt).toBeUndefined();
    expect(r3.status).not.toBe('재확인 필요');
    await stopSession(id).catch(() => {});
  }, 20_000);

  it('이미 저장된 적이 있는 id는(진짜 재저장) 내용이 바뀌면 그대로 개정이 오르고 revisedAt이 찍힌다', async () => {
    await setupRepo();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');

    await applySessionRequirements(id, {
      requirements: [{ id: 'R1', title: '로그인 API', kind: 'api', priority: 'must', acceptance: ['로그인하면 토큰을 돌려준다'] }],
      assumptions: [],
      manualSteps: [],
    });
    const second = await applySessionRequirements(id, {
      requirements: [{ id: 'R1', title: '로그인 API(이메일)', kind: 'api', priority: 'must', acceptance: ['로그인하면 토큰을 돌려준다'] }],
      assumptions: [],
      manualSteps: [],
    });

    const r1 = second.requirements.find((requirement) => requirement.id === 'R1')!;
    expect(r1.rev).toBe(2);
    expect(r1.revisedAt).toBeDefined();
    await stopSession(id).catch(() => {});
  }, 20_000);
});
