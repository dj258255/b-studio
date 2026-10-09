import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import type { StudioEvent } from '@/lib/studio-events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 에이전트 실행이 docs/requirements.md에 "사람 확인" 기록을 직접 써넣어 스스로 "검증됨(사람 확인)"을 만드는 구멍을
 * 실제 sessions.ts 코드로 끝까지 돌려 본다(ADR-157). 모델은 대본(scriptedTurns)으로 흉내 낸다.
 * 진짜로 하는 것: 파일 시스템의 git 저장소, 체크포인트, 검증 게이트, 요구사항 상태 계산, 되돌리기 백업.
 * 가짜로 바꾸는 것: 샌드박스(Docker)와 findProject. 실제 모델·네트워크·GitHub 호출은 없다.
 */
const fake = vi.hoisted(() => ({ root: '' }));

vi.mock('@b-studio/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@b-studio/sandbox')>();
  const sandbox = {
    id: 'studio-manual-verification-forgery-fake',
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

import {
  applySessionRequirements,
  clearRequirementManualVerification,
  commitPendingWorkingCopyDocs,
  createSession,
  getSessionRequirements,
  getSnapshot,
  markRequirementManualVerification,
  resumeSession,
  sendMessage,
  stopSession,
  subscribe,
  writeSessionDoc,
} from './sessions';

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
workflow:
  required: [plan, implement, run, contract_check, checkpoint]
  releaseRequires: [checkpoint]
review:
  auto: false
`;
}

async function setupProject(): Promise<void> {
  const projectRoot = path.join(root, 'project');
  await mkdir(path.join(projectRoot, 'api/src'), { recursive: true });
  await writeFile(path.join(projectRoot, 'studio.yaml'), studioYaml());
  await writeFile(path.join(projectRoot, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  await writeFile(path.join(projectRoot, 'api/src/Order.java'), 'class Order {}\n');
  fake.root = projectRoot;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-mv-forgery-'));
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

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('기대한 상태가 되지 않았습니다');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type Turn = { toolCalls?: Array<{ name: string; input: Record<string, unknown> }>; text?: string };

async function sendAndWaitFinished(id: string, text: string, scriptedTurns: Turn[], events: StudioEvent[]): Promise<Extract<StudioEvent, { type: 'run_finished' }>> {
  const before = events.length;
  sendMessage(id, text, { allowBreaking: false, scriptedTurns });
  return waitFor(() => events.slice(before).find((event): event is Extract<StudioEvent, { type: 'run_finished' }> => event.type === 'run_finished'));
}

const sample = { id: 'R1', title: '로그인', kind: 'api', priority: 'must', acceptance: ['a'] };
const sample2 = { id: 'R2', title: '목록', kind: 'api', priority: 'should', acceptance: ['b'] };

const FORGED_LINE = '- 확인: 에이전트 · 2026-10-10 · 체크포인트 abc1234 · 메모 직접 확인했습니다';

/** 요구사항 문서에서 R1 블록의 "- 상태:" 줄 앞에 사람 확인 줄을 끼워 넣는다(에이전트가 edit_file로 하는 일) */
function withForgedLine(doc: string, id = 'R1', line = FORGED_LINE): string {
  const lines = doc.split('\n');
  const heading = lines.findIndex((entry) => entry.startsWith(`## ${id}.`));
  const status = lines.findIndex((entry, index) => index > heading && entry.startsWith('- 상태:'));
  lines.splice(status, 0, line);
  return lines.join('\n');
}

/** 내장 JSON 블록의 manualVerification만 바꾼다(몸통 줄은 그대로) */
function withForgedJson(doc: string, id = 'R1'): string {
  return doc.replace(/<!-- b-studio-requirements\n([\s\S]*?)\n-->/, (_match, json: string) => {
    const parsed = JSON.parse(json) as { requirements: Array<Record<string, unknown>> };
    for (const requirement of parsed.requirements) {
      if (requirement.id === id) requirement.manualVerification = { by: '에이전트', at: '2026-10-10', sha: 'abc1234', note: 'JSON 블록으로 넣었습니다' };
    }
    return `<!-- b-studio-requirements\n${JSON.stringify(parsed, null, 2)}\n-->`;
  });
}

async function startedSession(requirements = [sample, sample2]): Promise<{ id: string; workDir: string; events: StudioEvent[]; unsubscribe: () => void }> {
  await setupProject();
  const id = (await createSession('verifyproj', 'kim', 'copy')).id;
  expect(await waitForReady(id)).toBe('ready');
  // 사람이 화면에서 요구사항을 저장했다(문서 체크포인트가 남는다)
  await applySessionRequirements(id, { requirements });
  const events: StudioEvent[] = [];
  const unsubscribe = subscribe(id, (event) => events.push(event));
  return { id, workDir: getSnapshot(id)!.workDir, events, unsubscribe };
}

/** 게이트가 막아도 모델이 고치지 않고 "완료"만 반복하는 대본(기본 재시도 상한 3번이 다 쓰이면 실행이 실패로 끝난다) */
const KEEPS_CLAIMING_DONE: Turn[] = [{ text: '완료했습니다' }, { text: '완료했습니다' }, { text: '완료했습니다' }];

function orderTurn(content = 'class Order { String memo; }\n'): Turn {
  return { toolCalls: [{ name: 'write_file', input: { path: 'api/src/Order.java', content } }] };
}

async function requirementOf(id: string, requirementId: string) {
  return (await getSessionRequirements(id)).requirements.find((entry) => entry.id === requirementId)!;
}

describe('에이전트 실행이 사람 확인 기록을 써넣는 위조', () => {
  it('몸통의 "- 확인:" 줄을 써넣고 게이트를 통과하면 체크포인트가 남지 않고 요구사항이 검증됨이 되지 않는다', async () => {
    const { id, workDir, events, unsubscribe } = await startedSession();
    const doc = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');
    const startCheckpoints = getSnapshot(id)!.checkpoints.length;
    expect((await requirementOf(id, 'R1')).verifiedBy).not.toBe('manual');

    const finished = await sendAndWaitFinished(
      id,
      '로그인 구현',
      [orderTurn(), { toolCalls: [{ name: 'write_file', input: { path: 'docs/requirements.md', content: withForgedLine(doc) } }] }, ...KEEPS_CLAIMING_DONE],
      events,
    );

    // 게이트가 manual-verification 검사로 막고, 모델에게 되돌리라고 알린 뒤에도 못 고쳐 실패로 끝난다
    expect(finished.status).toBe('failed');
    const check = events
      .filter((event): event is Extract<StudioEvent, { type: 'agent' }> => event.type === 'agent')
      .map((event) => event.event)
      .find((event) => event.type === 'workflow_check' && event.check.name === 'manual-verification');
    expect(check).toMatchObject({ check: { ok: false, stage: 'review' } });
    expect(JSON.stringify(check)).toContain('R1');
    expect(JSON.stringify(check)).toContain('사람 확인은 화면에서 사람만 남길 수 있습니다');

    // 체크포인트가 늘지 않았고(코드 변경도 문서 변경도 남지 않았다), 요구사항은 검증됨(사람 확인)이 아니다
    expect(getSnapshot(id)!.checkpoints.length).toBe(startCheckpoints);
    expect(await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8')).toBe(doc);
    const requirement = await requirementOf(id, 'R1');
    expect(requirement.verifiedBy).not.toBe('manual');
    expect(requirement.manualVerification).toBeUndefined();

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('내장 JSON 블록의 manualVerification만 바꿔도 같은 방식으로 막힌다', async () => {
    const { id, workDir, events, unsubscribe } = await startedSession();
    const doc = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');
    const startCheckpoints = getSnapshot(id)!.checkpoints.length;

    const finished = await sendAndWaitFinished(
      id,
      '로그인 구현',
      [orderTurn(), { toolCalls: [{ name: 'write_file', input: { path: 'docs/requirements.md', content: withForgedJson(doc) } }] }, ...KEEPS_CLAIMING_DONE],
      events,
    );

    expect(finished.status).toBe('failed');
    expect(getSnapshot(id)!.checkpoints.length).toBe(startCheckpoints);
    expect((await requirementOf(id, 'R1')).verifiedBy).not.toBe('manual');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('모델이 게이트 안내를 보고 기록을 되돌리면 같은 실행 안에서 통과한다', async () => {
    const { id, workDir, events, unsubscribe } = await startedSession();
    const doc = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');
    const startCheckpoints = getSnapshot(id)!.checkpoints.length;

    const finished = await sendAndWaitFinished(
      id,
      '로그인 구현',
      [
        orderTurn(),
        { toolCalls: [{ name: 'write_file', input: { path: 'docs/requirements.md', content: withForgedLine(doc) } }] },
        { text: '완료했습니다' },
        { toolCalls: [{ name: 'write_file', input: { path: 'docs/requirements.md', content: doc } }] },
        { text: '사람 확인 기록을 되돌렸습니다' },
      ],
      events,
    );

    expect(finished.status).toBe('done');
    expect(getSnapshot(id)!.checkpoints.length).toBe(startCheckpoints + 1);
    expect((await requirementOf(id, 'R1')).verifiedBy).not.toBe('manual');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('요구사항 본문(시나리오·인수 조건)만 고친 실행은 정당한 편집이라 통과한다', async () => {
    const { id, workDir, events, unsubscribe } = await startedSession();
    const doc = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');
    const startCheckpoints = getSnapshot(id)!.checkpoints.length;

    const finished = await sendAndWaitFinished(
      id,
      '로그인 구현',
      [orderTurn(), { toolCalls: [{ name: 'write_file', input: { path: 'docs/requirements.md', content: doc.replace('로그인', '이메일 로그인') } }] }, { text: '완료했습니다' }],
      events,
    );

    expect(finished.status).toBe('done');
    expect(getSnapshot(id)!.checkpoints.length).toBe(startCheckpoints + 1);
    expect(await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8')).toContain('이메일 로그인');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('화면에서 남긴 사람 확인은 그대로 동작하고, 이미 있는 확인을 건드리지 않은 실행은 통과한다', async () => {
    const { id, workDir, events, unsubscribe } = await startedSession();
    const snapshot = await markRequirementManualVerification(id, 'R1', { note: '화면을 직접 눌러 확인했습니다' }, 'kim');
    expect(snapshot.requirements.find((entry) => entry.id === 'R1')).toMatchObject({ status: '검증됨', verifiedBy: 'manual' });
    expect(getSnapshot(id)!.checkpoints[0]).toMatchObject({ message: 'docs: R1 사람 확인을 남긴다', verify: 'docs' });
    const startCheckpoints = getSnapshot(id)!.checkpoints.length;
    const doc = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');

    // 다른 요구사항 R2의 본문만 고친 실행: R1의 사람 확인은 그대로라 통과한다
    const finished = await sendAndWaitFinished(
      id,
      '목록 구현',
      [orderTurn(), { toolCalls: [{ name: 'write_file', input: { path: 'docs/requirements.md', content: doc.replace('목록', '주문 목록') } }] }, { text: '완료했습니다' }],
      events,
    );
    expect(finished.status).toBe('done');
    expect(getSnapshot(id)!.checkpoints.length).toBe(startCheckpoints + 1);
    expect((await requirementOf(id, 'R1')).verifiedBy).toBe('manual');

    // 화면에서 취소하면 내려온다
    await clearRequirementManualVerification(id, 'R1');
    expect((await requirementOf(id, 'R1')).verifiedBy).not.toBe('manual');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('에이전트 실행이 도는 동안에는 화면의 사람 확인·취소를 받지 않는다(게이트가 실행이 넣은 기록으로 오인하지 않게)', async () => {
    const { id, events, unsubscribe } = await startedSession();
    await markRequirementManualVerification(id, 'R1', { note: '화면을 직접 눌러 확인했습니다' }, 'kim');

    sendMessage(id, '로그인 구현', { allowBreaking: false, scriptedTurns: [orderTurn(), { text: '완료했습니다' }] });
    expect(getSnapshot(id)!.running).toBe(true);
    await expect(markRequirementManualVerification(id, 'R2', { note: '실행 중에 누름' }, 'kim')).rejects.toMatchObject({ status: 409 });
    await expect(clearRequirementManualVerification(id, 'R1')).rejects.toMatchObject({ status: 409 });
    // 요구사항 저장(명세 탭)과 문서 탭의 요구사항 문서 저장도 같은 이유로 받지 않는다 — 받으면 재확인 판정 필드가 바뀌어
    // 게이트가 이 실행을 실패시킨다. 다른 문서는 실행 중에도 저장된다
    await expect(applySessionRequirements(id, { requirements: [] })).rejects.toMatchObject({ status: 409 });
    await expect(writeSessionDoc(id, 'docs/requirements.md', '# 요구사항\n')).rejects.toMatchObject({ status: 409 });
    await expect(writeSessionDoc(id, 'README.md', '# 메모\n')).resolves.toMatchObject({ path: 'README.md' });
    await waitFor(() => events.find((event) => event.type === 'run_finished'));

    // 실행이 끝난 뒤에는 다시 받는다
    const snapshot = await clearRequirementManualVerification(id, 'R1');
    expect(snapshot.requirements.find((entry) => entry.id === 'R1')!.verifiedBy).not.toBe('manual');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('에이전트가 사람 확인을 지우면 과대평가는 아니지만 조용히 사라지지 않도록 검사에 남긴다(실행은 통과한다)', async () => {
    const { id, workDir, events, unsubscribe } = await startedSession();
    await markRequirementManualVerification(id, 'R1', { note: '화면을 직접 눌러 확인했습니다' }, 'kim');
    const doc = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');
    const stripped = doc
      .split('\n')
      .filter((line) => !line.startsWith('- 확인:'))
      .join('\n')
      .replace(/,?\s*"manualVerification": \{[\s\S]*?\n {6}\}/, '');

    const finished = await sendAndWaitFinished(
      id,
      '로그인 구현',
      [orderTurn(), { toolCalls: [{ name: 'write_file', input: { path: 'docs/requirements.md', content: stripped } }] }, { text: '완료했습니다' }],
      events,
    );

    expect(finished.status).toBe('done');
    const removed = events
      .filter((event): event is Extract<StudioEvent, { type: 'agent' }> => event.type === 'agent')
      .map((event) => event.event)
      .find((event) => event.type === 'workflow_check' && event.check.name === 'manual-verification-removed');
    expect(removed).toMatchObject({ check: { ok: true } });
    expect(JSON.stringify(removed)).toContain('R1');
    expect((await requirementOf(id, 'R1')).verifiedBy).not.toBe('manual');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('요구사항 문서를 실행이 새로 만들면서 사람 확인 기록을 넣어도 위조로 본다', async () => {
    await setupProject();
    const id = (await createSession('verifyproj', 'kim', 'copy')).id;
    expect(await waitForReady(id)).toBe('ready');
    const events: StudioEvent[] = [];
    const unsubscribe = subscribe(id, (event) => events.push(event));
    const startCheckpoints = getSnapshot(id)!.checkpoints.length;
    const fresh = `# 요구사항\n\n## R1. 로그인\n- 종류: api · 우선순위: must\n- 인수 조건:\n  - a\n${FORGED_LINE}\n- 상태: 미착수\n`;

    const finished = await sendAndWaitFinished(
      id,
      '요구사항 문서를 만들어 줘',
      [orderTurn(), { toolCalls: [{ name: 'write_file', input: { path: 'docs/requirements.md', content: fresh } }] }, ...KEEPS_CLAIMING_DONE],
      events,
    );

    expect(finished.status).toBe('failed');
    // 코드 변경은 남지 않았다. 새로 만든 요구사항 문서는 되돌리기 전에 "문서를 지키는" 체크포인트로 남지만 사람 확인 줄은 빠져 있다
    expect(getSnapshot(id)!.checkpoints.length).toBe(startCheckpoints + 1);
    expect(getSnapshot(id)!.checkpoints[0]).toMatchObject({ verify: 'docs', files: ['docs/requirements.md'] });
    expect(await readFile(path.join(getSnapshot(id)!.workDir, 'docs/requirements.md'), 'utf8')).not.toContain('- 확인:');
    expect((await getSessionRequirements(id)).requirements.find((entry) => entry.id === 'R1')?.verifiedBy ?? 'none').not.toBe('manual');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);
});

describe('게이트 밖 경로로 위조 기록이 살아남지 못한다', () => {
  it('가볍게 확인(light) 실행도 같은 검사를 한다', async () => {
    const { id, workDir, events, unsubscribe } = await startedSession();
    const doc = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');
    const startCheckpoints = getSnapshot(id)!.checkpoints.length;
    const before = events.length;

    sendMessage(id, '로그인 구현', {
      allowBreaking: false,
      verify: 'light',
      scriptedTurns: [orderTurn(), { toolCalls: [{ name: 'write_file', input: { path: 'docs/requirements.md', content: withForgedLine(doc) } }] }, ...KEEPS_CLAIMING_DONE],
    });
    const finished = await waitFor(() => events.slice(before).find((event): event is Extract<StudioEvent, { type: 'run_finished' }> => event.type === 'run_finished'));

    expect(finished.status).toBe('failed');
    expect(getSnapshot(id)!.checkpoints.length).toBe(startCheckpoints);
    expect((await requirementOf(id, 'R1')).verifiedBy).not.toBe('manual');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('게이트가 막아 되돌릴 때 문서를 지키는 체크포인트에도 위조 기록은 실리지 않고, 대화에 되돌렸다고 남는다', async () => {
    const { id, workDir, events, unsubscribe } = await startedSession();
    const doc = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');

    await sendAndWaitFinished(
      id,
      '로그인 구현',
      [orderTurn(), { toolCalls: [{ name: 'write_file', input: { path: 'docs/requirements.md', content: withForgedLine(doc) } }] }, ...KEEPS_CLAIMING_DONE],
      events,
    );

    expect(events.some((event) => event.type === 'notice' && event.text.includes('사람 확인'))).toBe(true);
    // 같은 실행에서 본문도 바뀌었다면(여기서는 아니다) 문서 체크포인트가 남을 수 있지만, 사람 확인 기록은 실리지 않는다
    const head = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');
    expect(head).not.toContain('- 확인:');
    expect((await requirementOf(id, 'R1')).verifiedBy).not.toBe('manual');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('작업 분해 전 안전망(commitPendingWorkingCopyDocs)이 끊긴 실행의 위조 기록을 문서 체크포인트로 남기지 않고 되돌려 적는다', async () => {
    const { id, workDir, events, unsubscribe } = await startedSession();
    const doc = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');
    // 끊긴 실행이 남긴 상태를 흉내 낸다: 본문도 고치고(정당한 편집) 사람 확인 줄도 써넣은 채 커밋되지 않았다
    await writeFile(path.join(workDir, 'docs/requirements.md'), withForgedLine(doc).replace('로그인', '이메일 로그인'));

    const checkpoint = await commitPendingWorkingCopyDocs(id, '문서: 안전망');

    expect(checkpoint).toBeDefined();
    const committed = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');
    expect(committed).not.toContain('- 확인:');
    expect(committed).toContain('이메일 로그인');
    expect((await requirementOf(id, 'R1')).verifiedBy).not.toBe('manual');
    expect(events.some((event) => event.type === 'notice' && event.text.includes('사람 확인'))).toBe(true);

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('요구사항 문서 자리에 위조한 문서로 가는 링크를 놓아도, 안전망은 링크를 커밋하지 않고 마지막 체크포인트의 문서로 되돌린다', async () => {
    const { id, workDir, unsubscribe } = await startedSession();
    const file = path.join(workDir, 'docs/requirements.md');
    const original = await readFile(file, 'utf8');
    await writeFile(path.join(workDir, 'docs/elsewhere.md'), withForgedLine(original));
    await rm(file);
    await symlink(path.join(workDir, 'docs/elsewhere.md'), file);

    await commitPendingWorkingCopyDocs(id, '문서: 안전망');

    // 링크가 아니라 일반 파일이고, 내용은 마지막 체크포인트의 문서다
    expect((await lstat(file)).isFile()).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect((await requirementOf(id, 'R1')).verifiedBy).not.toBe('manual');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('문서 폴더를 위조한 문서가 든 폴더로 가는 링크로 바꿔도 그 내용은 요구사항으로 읽히지 않고, 안전망은 링크 너머에 쓰지 않는다', async () => {
    const { id, workDir, unsubscribe } = await startedSession();
    const original = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');
    await mkdir(path.join(workDir, 'elsewhere'), { recursive: true });
    await writeFile(path.join(workDir, 'elsewhere/requirements.md'), withForgedLine(original));
    await rm(path.join(workDir, 'docs'), { recursive: true });
    await symlink(path.join(workDir, 'elsewhere'), path.join(workDir, 'docs'));

    // 요구사항을 읽는 쪽은 링크 너머의 문서를 읽지 않는다(문서가 없는 것으로 본다)
    expect((await getSessionRequirements(id)).exists).toBe(false);

    await commitPendingWorkingCopyDocs(id, '문서: 안전망').catch(() => undefined);
    // 링크 너머의 파일은 건드리지 않았다(위조 내용이 그대로 남아 있을 뿐, 마지막 체크포인트의 문서로 덮어쓰지 않았다)
    expect(await readFile(path.join(workDir, 'elsewhere/requirements.md'), 'utf8')).toBe(withForgedLine(original));
    expect((await getSessionRequirements(id)).exists).toBe(false);

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('화면에서 남긴 사람 확인(이미 체크포인트에 있는 값)은 안전망이 건드리지 않는다', async () => {
    const { id, workDir, unsubscribe } = await startedSession();
    await markRequirementManualVerification(id, 'R1', { note: '화면을 직접 눌러 확인했습니다' }, 'kim');
    const doc = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');
    await writeFile(path.join(workDir, 'docs/requirements.md'), doc.replace('목록', '주문 목록'));

    await commitPendingWorkingCopyDocs(id, '문서: 안전망');

    expect(await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8')).toContain('- 확인: kim');
    expect((await requirementOf(id, 'R1')).verifiedBy).toBe('manual');

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);

  it('실행이 끊긴 세션을 이어받을 때(resumeSession) 작업 복사본에 남은 위조 기록은 보존 커밋에 실리지 않는다', async () => {
    const { id, workDir, unsubscribe } = await startedSession();
    const doc = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');
    await stopSession(id);
    // 끊긴 실행이 남긴 상태: 사람 확인 줄과 JSON 블록 기록을 둘 다 써넣고, 본문도 고친 채 커밋되지 않았다
    await writeFile(path.join(workDir, 'docs/requirements.md'), withForgedJson(withForgedLine(doc)).replace('목록', '주문 목록'));

    await resumeSession(id);
    expect(await waitForReady(id)).toBe('ready');

    const committed = await readFile(path.join(workDir, 'docs/requirements.md'), 'utf8');
    expect(committed).not.toContain('- 확인:');
    expect(committed).not.toContain('manualVerification');
    expect(committed).toContain('주문 목록');
    expect(getSnapshot(id)!.checkpoints[0]).toMatchObject({ files: ['docs/requirements.md'], verify: 'docs' });
    expect((await requirementOf(id, 'R1')).verifiedBy).not.toBe('manual');

    // 대화에 되돌렸다는 사실이 남는다(이어받은 세션의 기록을 다시 구독해 읽는다)
    const replayed: StudioEvent[] = [];
    const stop = subscribe(id, (event) => replayed.push(event));
    expect(replayed.some((event) => event.type === 'notice' && event.text.includes('사람 확인'))).toBe(true);
    stop();

    unsubscribe();
    await stopSession(id).catch(() => {});
  }, 30_000);
});
