import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Board } from './coordination';
import { buildTools, executeTool, LOCAL_TOOLS, SANDBOX_TOOLS, type BoardAccess, type ToolContext } from './tools';
import { Workspace } from './workspace';

const project = {
  root: '/tmp/none',
  managed: [['api', { source: 'managed', template: 'spring-boot', path: 'api', port: 8080, preview: 'openapi' }]],
} as unknown as LoadedProject;

const context: ToolContext = {
  project,
  workspace: new Workspace('/tmp/none'),
  sandbox: {
    endpoint: async (service: string) => ({ service, containerPort: 8080, url: 'http://127.0.0.1:1' }),
    redact: (text: string) => text,
  } as unknown as Sandbox,
  fetcher: async () => ({}),
};

// 컨텍스트를 여러 테스트가 함께 쓰므로 도구 결과 캐시는 테스트마다 새로 시작한다(실제로는 러너가 실행마다 새로 만든다)
beforeEach(() => {
  context.toolResults = undefined;
});

describe('http_request', () => {
  it('"//" 경로로 서비스 밖 호스트에 요청하지 못한다', async () => {
    const outcome = await executeTool('http_request', { service: 'api', method: 'GET', path: '//evil.example/steal', body: '' }, context);
    expect(outcome).toEqual({ ok: false, content: 'path must stay on the service host' });
  });

  it('등록되지 않은 서비스 이름을 거부한다', async () => {
    const outcome = await executeTool('http_request', { service: 'db', method: 'GET', path: '/', body: '' }, context);
    expect(outcome).toEqual({ ok: false, content: 'Unknown service: db' });
  });
});

/** 도그푸딩 마찰 130: edge·서비스 컨테이너가 없어 compose가 "is not running"으로 알리면, 도구 결과에서
 * 자동 복구 시도와 그 결과를 분명히 알리는지 본다(ADR-142). 코드를 고쳐도 다시 뜨지 않는 문제라는 점을
 * 모델이 알아야 restart_service·service_logs를 반복하지 않는다 */
describe('샌드박스 인프라 부재(컨테이너가 지워짐) 자동 복구', () => {
  const infraError = new Error('docker compose port 실패 (test)\nservice "b-studio-edge" is not running');

  it('복구에 성공하면 복구 사실과 재시도 안내를 도구 결과에 남긴다', async () => {
    const ensureInfra = vi.fn().mockResolvedValue({ ok: true, recovered: ['b-studio-edge'] });
    const sandbox = { endpoint: vi.fn().mockRejectedValue(infraError), redact: (text: string) => text, ensureInfra } as unknown as ToolContext['sandbox'];

    const outcome = await executeTool('http_request', { service: 'api', method: 'GET', path: '/', body: '' }, { ...context, sandbox });

    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('is not running');
    expect(outcome.content).toContain('다시 올렸습니다');
    expect(outcome.content).toContain('b-studio-edge');
    expect(ensureInfra).toHaveBeenCalledWith(['api'], expect.anything());
  });

  it('복구에 실패하면 코드로 고칠 수 없는 인프라 문제라고 분명히 알린다', async () => {
    const ensureInfra = vi.fn().mockResolvedValue({ ok: false, recovered: [], missing: ['b-studio-edge'], reason: 'docker compose up 실패' });
    const sandbox = { endpoint: vi.fn().mockRejectedValue(infraError), redact: (text: string) => text, ensureInfra } as unknown as ToolContext['sandbox'];

    const outcome = await executeTool('http_request', { service: 'api', method: 'GET', path: '/', body: '' }, { ...context, sandbox });

    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('샌드박스 인프라 문제라 코드로 고칠 수 없습니다');
    expect(outcome.content).toContain('docker compose up 실패');
  });

  it('ensureInfra를 지원하지 않는 샌드박스면 원래 오류만 돌려준다(자동 복구를 시도하지 않는다)', async () => {
    const sandbox = { endpoint: vi.fn().mockRejectedValue(infraError), redact: (text: string) => text } as unknown as ToolContext['sandbox'];

    const outcome = await executeTool('http_request', { service: 'api', method: 'GET', path: '/', body: '' }, { ...context, sandbox });

    expect(outcome).toEqual({ ok: false, content: infraError.message });
  });

  it('"is not running"과 무관한 오류는 평소처럼 그대로 돌려준다', async () => {
    const ensureInfra = vi.fn();
    const sandbox = { endpoint: vi.fn().mockRejectedValue(new Error('무언가 다른 오류')), redact: (text: string) => text, ensureInfra } as unknown as ToolContext['sandbox'];

    const outcome = await executeTool('http_request', { service: 'api', method: 'GET', path: '/', body: '' }, { ...context, sandbox });

    expect(outcome).toEqual({ ok: false, content: '무언가 다른 오류' });
    expect(ensureInfra).not.toHaveBeenCalled();
  });
});

describe('delete_file', () => {
  it('도구 목록에 있고 실제로 파일을 지운다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tools-delete-'));
    await writeFile(path.join(root, 'a.md'), 'a');
    const workspace = new Workspace(root);

    expect(buildTools(project).map((candidate) => candidate.name)).toContain('delete_file');

    const outcome = await executeTool('delete_file', { path: 'a.md' }, { ...context, workspace });
    expect(outcome).toEqual({ ok: true, content: 'deleted a.md' });
    expect(workspace.deletedFiles()).toEqual(['a.md']);
    await expect(readFile(path.join(root, 'a.md'), 'utf8')).rejects.toThrow();
  });

  it('없는 파일이면 실패로 돌려준다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tools-delete-'));
    const outcome = await executeTool('delete_file', { path: 'missing.md' }, { ...context, workspace: new Workspace(root) });
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.content).toContain('파일이 없습니다');
  });
});

describe('질문 모드', () => {
  const readOnly: ToolContext = { ...context, readOnly: true };

  it('파일을 바꾸거나 명령을 실행하는 도구와 조회가 아닌 요청을 거부한다', async () => {
    const changing = [
      ['write_file', { path: 'a.txt', content: 'x' }],
      ['edit_file', { path: 'a.txt', old_text: 'a', new_text: 'b' }],
      ['delete_file', { path: 'a.txt' }],
      ['run_in_service', { service: 'api', command: ['ls'] }],
      ['restart_service', { service: 'api' }],
    ] as const;
    for (const [name, input] of changing) {
      const outcome = await executeTool(name, input, readOnly);
      expect(outcome.ok).toBe(false);
      expect(outcome.content).toContain('Question mode is read-only');
    }

    const post = await executeTool('http_request', { service: 'api', method: 'POST', path: '/api/orders', body: '{}' }, readOnly);
    expect(post).toEqual({ ok: false, content: 'Question mode allows only GET and HEAD requests. Describe the change as a plan instead.' });
  });
});

describe('디자인 도구', () => {
  const design = {
    frames: async () => [{ id: '1:2', name: 'Orders', page: 'Page 1', width: 375, height: 812 }],
    frame: async (id: string) => ({ summary: `frame ${id} summary`, png: Buffer.from([1, 2, 3]) }),
    saveArtifact: async (name: string, data: Buffer) => `artifact/${name}/${data.length}`,
  };

  it('design을 넘기면 도구 목록에 더하고, 넘기지 않으면 목록이 그대로다', () => {
    expect(buildTools(project).map((candidate) => candidate.name)).not.toContain('design_frames');
    expect(buildTools(project, { design: true }).map((candidate) => candidate.name)).toEqual(expect.arrayContaining(['design_frames', 'design_frame']));
  });

  it('design_frames는 페이지·id·이름·크기를 돌려준다', async () => {
    expect(await executeTool('design_frames', {}, { ...context, design })).toEqual({ ok: true, content: '1:2\tPage 1\tOrders\t375x812' });
  });

  it('design_frame은 요약과 저장한 산출물 경로를 돌려주고 이미지는 넘기지 않는다', async () => {
    const outcome = await executeTool('design_frame', { id: '1:2' }, { ...context, design });
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('frame 1:2 summary');
    expect(outcome.content).toContain('artifact/design 1:2/3');
    expect(outcome.content).toContain('not sent to the model');
  });

  it('질문 모드에서도 디자인 조회를 허용한다', async () => {
    expect((await executeTool('design_frames', {}, { ...context, design, readOnly: true })).ok).toBe(true);
  });

  it('design이 없으면 실행을 거부한다', async () => {
    expect(await executeTool('design_frames', {}, context)).toEqual({ ok: false, content: 'Design is not configured for this session' });
  });
});

describe('되묻기 도구(ask_user)', () => {
  it('interactive를 넘길 때만 도구 목록에 넣고, 없으면 목록이 그대로다', () => {
    expect(buildTools(project).map((candidate) => candidate.name)).not.toContain('ask_user');
    expect(buildTools(project, { interactive: true }).map((candidate) => candidate.name)).toContain('ask_user');
  });

  it('질문과 선택지를 좁게 검증하고, 통과하면 onQuestion으로 넘긴다', async () => {
    const asked: Array<{ question: string; options: string[]; allowOther: boolean }> = [];
    const askContext: ToolContext = { ...context, onQuestion: (question) => asked.push(question) };

    const outcome = await executeTool('ask_user', { question: '어떤 형태로 만들까요?', options: ['표', '카드 목록'], allowOther: true }, askContext);
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('End this run');
    expect(asked).toEqual([{ question: '어떤 형태로 만들까요?', options: ['표', '카드 목록'], allowOther: true }]);
  });

  it('질문 길이·선택지 개수·길이·중복을 거부한다', async () => {
    let asked = 0;
    const askContext: ToolContext = { ...context, onQuestion: () => (asked += 1) };
    const invalid = [
      { question: '', options: ['a', 'b'], allowOther: false },
      { question: 'q', options: ['a'], allowOther: false },
      { question: 'q', options: ['a', 'b', 'c', 'd', 'e'], allowOther: false },
      { question: 'q', options: ['a', 'a'], allowOther: false },
      { question: 'q'.repeat(301), options: ['a', 'b'], allowOther: false },
      { question: 'q', options: ['a'.repeat(81), 'b'], allowOther: false },
      { question: 'q', options: ['a', 'b'], allowOther: 'yes' },
    ];
    for (const input of invalid) expect((await executeTool('ask_user', input, askContext)).ok).toBe(false);
    expect(asked).toBe(0);
  });

  it('onQuestion이 없는 실행에서는 거부한다', async () => {
    const outcome = await executeTool('ask_user', { question: 'q', options: ['a', 'b'], allowOther: false }, context);
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.content).toContain('cannot ask the user');
  });
});

describe('방식 제안 도구(propose_mode)', () => {
  it('interactive일 때만 목록에 넣는다(ask_user와 같다)', () => {
    expect(buildTools(project).map((candidate) => candidate.name)).not.toContain('propose_mode');
    expect(buildTools(project, { interactive: true }).map((candidate) => candidate.name)).toContain('propose_mode');
  });

  it('제안을 질문으로 넘긴다. 첫 선택지는 넘기기, 둘째는 한 명으로 계속이다', async () => {
    const asked: unknown[] = [];
    const askContext: ToolContext = { ...context, onQuestion: (question) => asked.push(question) };

    const outcome = await executeTool('propose_mode', { mode: 'split', reason: 'API와 화면이 계약만 공유해 동시에 만들 수 있습니다', request: '주문 API와 화면을 만들어줘' }, askContext);

    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain('End this run');
    expect(asked).toEqual([
      {
        question: 'API와 화면이 계약만 공유해 동시에 만들 수 있습니다',
        options: ['나눠서 병렬로 하기', '한 명으로 계속'],
        allowOther: false,
        proposal: { mode: 'split', request: '주문 API와 화면을 만들어줘' },
      },
    ]);
  });

  it('방식·이유·요청을 검증하고, onQuestion이 없는 실행은 거부한다', async () => {
    let asked = 0;
    const askContext: ToolContext = { ...context, onQuestion: () => (asked += 1) };
    const invalid = [
      { mode: 'solo', reason: 'r', request: 'q' },
      { mode: 'fleet', reason: '', request: 'q' },
      { mode: 'fleet', reason: 'r'.repeat(301), request: 'q' },
      { mode: 'fleet', reason: 'r', request: '' },
      { mode: 'fleet', reason: 'r', request: 'q'.repeat(2_001) },
    ];
    for (const input of invalid) expect((await executeTool('propose_mode', input, askContext)).ok).toBe(false);
    expect(asked).toBe(0);
    expect((await executeTool('propose_mode', { mode: 'fleet', reason: 'r', request: 'q' }, context)).ok).toBe(false);
  });
});

describe('실행 정책', () => {
  it('샌드박스 실행 전에 위험 명령을 차단하고 실행하지 않는다', async () => {
    let called = false;
    const outcome = await executeTool(
      'run_in_service',
      { service: 'api', command: ['git', 'push', 'origin', 'main'] },
      { ...context, policy: {}, sandbox: { ...context.sandbox, exec: async () => { called = true; throw new Error('must not run'); } } as unknown as Sandbox },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('blocked by execution policy');
    expect(called).toBe(false);
  });

  it('승인 훅이 거부하면 변경 도구를 실행하지 않는다', async () => {
    let called = false;
    const outcome = await executeTool(
      'write_file',
      { path: 'a.txt', content: 'x' },
      {
        ...context,
        policy: { requireApprovalFor: ['write_file'] },
        requestApproval: async () => false,
        workspace: { ...context.workspace, write: async () => { called = true; throw new Error('must not write'); } } as unknown as Workspace,
      },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('approval was not granted');
    expect(called).toBe(false);
  });
});

describe('도구 결과 예산', () => {
  it('read_file 결과를 앞쪽 위주로 자르고 원래 글자 수를 남긴다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tools-budget-'));
    await writeFile(path.join(root, 'big.txt'), 'a'.repeat(20_000));
    const outcome = await executeTool('read_file', { path: 'big.txt' }, { ...context, workspace: new Workspace(root) });
    expect(outcome.ok).toBe(true);
    expect(outcome.rawChars).toBe(20_000);
    expect(outcome.content.length).toBeLessThan(20_000);
    expect(outcome.content).toContain('전체 20000자 중 8000자 생략');
  });

  it('명령 출력은 뒤쪽 위주로 잘라 실패 요약을 남긴다', async () => {
    const sandbox = {
      ...context.sandbox,
      exec: async () => ({ exitCode: 1, stdout: `${'a'.repeat(10_000)}\nFAILURE: cannot compile`, stderr: '' }),
    } as unknown as Sandbox;
    const outcome = await executeTool('run_in_service', { service: 'api', command: ['./gradlew', 'test'] }, { ...context, sandbox });
    expect(outcome.ok).toBe(false);
    // 긴 로그를 잘라도 뒤쪽의 실패 요약은 남는다
    expect(outcome.content).toContain('FAILURE: cannot compile');
    expect(outcome.content.length).toBeLessThan(6_100);
    expect(outcome.rawChars).toBeGreaterThan(6_000);
    expect(outcome.content).toContain('grep·tail로 좁혀 다시 실행');
  });

  it('lean이면 성공한 명령 출력은 짧게, 실패한 명령은 기본 예산 그대로 돌려준다', async () => {
    const log = `${'a'.repeat(10_000)}\nBUILD SUCCESSFUL`;
    const run = (exitCode: number, selfCheck?: 'full' | 'lean') => {
      const sandbox = { ...context.sandbox, exec: async () => ({ exitCode, stdout: log, stderr: '' }) } as unknown as Sandbox;
      return executeTool('run_in_service', { service: 'api', command: ['./gradlew', 'build'] }, { ...context, sandbox, ...(selfCheck ? { selfCheck } : {}) });
    };

    const leanSuccess = await run(0, 'lean');
    expect(leanSuccess.ok).toBe(true);
    // 끝부분(성공 문구)은 남고, 800자 예산에 생략 안내 한 줄만 더해진다
    expect(leanSuccess.content).toContain('BUILD SUCCESSFUL');
    expect(leanSuccess.content.length).toBeLessThan(900);
    expect(leanSuccess.rawChars).toBeGreaterThan(10_000);

    const leanFailure = await run(1, 'lean');
    expect(leanFailure.content.length).toBeGreaterThan(5_900);

    const fullSuccess = await run(0);
    expect(fullSuccess.content.length).toBeGreaterThan(5_900);
  });

  it('HTML 응답은 태그를 벗긴 보이는 글자만 남긴다', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('<html><head><script>var a = 1 < 2;</script></head><body><h1>주문</h1></body></html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
    try {
      const outcome = await executeTool('http_request', { service: 'api', method: 'GET', path: '/', body: '' }, context);
      expect(outcome.ok).toBe(true);
      expect(outcome.content).toContain('주문');
      expect(outcome.content).not.toContain('var a');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('같은 결과 반복 대체', () => {
  it('같은 도구·같은 입력의 결과가 같으면 참조로 바꾸고, 쓰기 뒤에는 다시 읽는다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'tools-dedupe-'));
    await writeFile(path.join(root, 'a.txt'), 'same');
    const runContext: ToolContext = { ...context, workspace: new Workspace(root) };

    expect((await executeTool('read_file', { path: 'a.txt' }, runContext)).content).toBe('same');
    expect((await executeTool('read_file', { path: 'a.txt' }, runContext)).content).toBe('(앞의 1번째 호출 결과와 같습니다)');

    // 쓰기가 성공하면 읽기 캐시를 비워, 같은 파일을 다시 읽으면 본문을 그대로 돌려준다
    expect((await executeTool('write_file', { path: 'a.txt', content: 'same' }, runContext)).ok).toBe(true);
    expect((await executeTool('read_file', { path: 'a.txt' }, runContext)).content).toBe('same');
  });
});

describe('조율 도구', () => {
  function boardContext(): ToolContext {
    const board = new Board({ topology: 'mesh' });
    return {
      ...context,
      board: {
        lane: 'web',
        post: (input) => board.post(input, { lane: 'web', by: 'model' }),
        read: (options) => board.read({ lane: 'web' }, options),
      },
    };
  }

  it('board가 없으면 도구 목록이 지금과 같다', () => {
    const names = buildTools(project).map((candidate) => candidate.name);
    expect(names).not.toContain('post_note');
    expect(names).not.toContain('read_notes');
  });

  it('board와 디자인을 함께 켜면 두 묶음이 모두 들어간다', () => {
    const names = buildTools(project, { board: boardContext().board, design: true }).map((candidate) => candidate.name);
    expect(names).toEqual(expect.arrayContaining(['post_note', 'read_notes', 'design_frames', 'design_frame']));
  });

  it('board가 있으면 두 도구를 더한다', () => {
    const names = buildTools(project, { board: boardContext().board }).map((candidate) => candidate.name);
    expect(names).toContain('post_note');
    expect(names).toContain('read_notes');
  });

  it('허용 목록에 없으면 그 도구를 목록에 넣지 않는다', () => {
    const board = boardContext().board;
    const none = buildTools(project, { board, allowedTools: [] }).map((candidate) => candidate.name);
    expect(none).not.toContain('post_note');
    expect(none).not.toContain('read_notes');

    const only = buildTools(project, { board, allowedTools: ['post_note'] }).map((candidate) => candidate.name);
    expect(only).toContain('post_note');
    expect(only).not.toContain('read_notes');
  });

  it('modelWrites가 false면 post_note를 넣지 않고 read_notes만 남긴다', () => {
    const board = { ...boardContext().board!, modelWrites: false };
    const names = buildTools(project, { board }).map((candidate) => candidate.name);
    expect(names).not.toContain('post_note');
    expect(names).toContain('read_notes');
  });

  it('post_note 스키마는 failure를 넣지 않는다', () => {
    const postNote = buildTools(project, { board: boardContext().board }).find((candidate) => candidate.name === 'post_note');
    const properties = (postNote?.input_schema as { properties?: Record<string, { enum?: string[] }> }).properties;
    expect(properties?.kind?.enum).toEqual(['contract', 'fact']);
  });

  it('post_note로 쓰고 read_notes로 읽는다', async () => {
    const ctx = boardContext();
    const posted = await executeTool('post_note', { kind: 'contract', body: 'OrderResponse.memo', refs: ['api/src/Order.java'] }, ctx);
    expect(posted).toEqual({ ok: true, content: 'posted note-1 (contract)' });

    await executeTool('post_note', { kind: 'fact', body: 'api listens on 8080', refs: [] }, ctx);
    const read = await executeTool('read_notes', { kinds: [] }, ctx);
    expect(read.ok).toBe(true);
    expect(read.content).toContain('[contract·2] web: OrderResponse.memo (api/src/Order.java)');

    const facts = await executeTool('read_notes', { kinds: ['fact'] }, ctx);
    expect(facts.content).toContain('[fact·1] web: api listens on 8080');
    expect(facts.content).not.toContain('OrderResponse.memo');
  });

  it('게시판이 notice를 돌려주면(엮인 레인 미게시 안내, 이슈 #393) read_notes 결과에 그대로 붙인다', async () => {
    const notice = '[조율] lane-2가 아직 계약을 게시하지 않았습니다. 작업을 시작하기 전에 잠시 뒤 read_notes를 한 번 더 호출하세요';
    const ctx: ToolContext = {
      ...context,
      board: {
        lane: 'lane-1',
        post: () => ({ ok: false, reason: 'unused' }),
        read: () => ({ notes: [], truncated: false, notice }),
      },
    };
    const outcome = await executeTool('read_notes', { kinds: [] }, ctx);
    expect(outcome.ok).toBe(true);
    // notes가 없어도 "(no notes)"가 아니라 안내 문구가 그대로 보인다
    expect(outcome.content).toBe(notice);
  });

  it('계약 메모에 refs가 없으면 게시판이 거부한 이유를 그대로 돌려준다', async () => {
    const outcome = await executeTool('post_note', { kind: 'contract', body: 'x', refs: [] }, boardContext());
    expect(outcome).toEqual({ ok: false, content: '계약 메모는 refs가 하나 이상 필요합니다' });
  });

  it('게시판이 없는 실행에서 조율 도구를 직접 부르면 실패한다', async () => {
    const outcome = await executeTool('post_note', { kind: 'fact', body: 'x', refs: [] }, context);
    expect(outcome.ok).toBe(false);
    expect(outcome.content).toContain('조율 게시판이 없습니다');
  });

  it('질문 모드에서 read_notes는 허용하고 post_note는 거부한다', async () => {
    const readOnly: ToolContext = { ...boardContext(), readOnly: true };
    const denied = await executeTool('post_note', { kind: 'fact', body: 'x', refs: [] }, readOnly);
    expect(denied.ok).toBe(false);
    expect(denied.content).toContain('Question mode is read-only');

    const read = await executeTool('read_notes', { kinds: [] }, readOnly);
    expect(read.ok).toBe(true);
  });
});

describe('도구 분류 (샌드박스 필요 여부)', () => {
  it('모든 도구가 SANDBOX_TOOLS나 LOCAL_TOOLS 중 하나에 들어 있다 (새 도구를 빠뜨리지 않게)', () => {
    // 모든 조건부 도구(외부 API·계약·게시판·디자인·되묻기)를 켠 프로젝트로 도구 목록을 만든다
    const full = {
      ...project,
      managed: [['api', { source: 'managed', template: 'spring-boot', path: 'api', port: 8080, preview: 'openapi', contract: { extract: '/v3/api-docs' } }]],
      external: [['users', { source: 'external', baseUrl: 'https://users.example.com', policy: { mask: [], maskPatterns: [] } }]],
    } as unknown as LoadedProject;
    const names = buildTools(full, { board: { modelWrites: true } as unknown as BoardAccess, design: true, interactive: true }).map((candidate) => candidate.name);

    for (const name of names) {
      expect(SANDBOX_TOOLS.has(name) || LOCAL_TOOLS.has(name), `분류가 없는 도구: ${name}`).toBe(true);
    }
    // 두 분류는 겹치지 않는다
    for (const name of SANDBOX_TOOLS) expect(LOCAL_TOOLS.has(name), name).toBe(false);
    // 분류표에만 있고 실제 도구 목록에 없는 이름도 없어야 한다(이름이 바뀌면 분류표도 고쳐야 한다)
    for (const name of [...SANDBOX_TOOLS, ...LOCAL_TOOLS]) expect(names, name).toContain(name);
  });

  it('샌드박스가 필요한 도구만 ensureSandbox를 부른다', async () => {
    let boots = 0;
    const ctx: ToolContext = { ...context, ensureSandbox: async () => void (boots += 1) };

    // 작업 공간 도구는 샌드박스를 켜지 않는다
    await executeTool('read_file', { path: 'missing.txt' }, ctx);
    expect(boots).toBe(0);
    // 샌드박스 도구는 실행 전에 부른다(세션 쪽에서 동시 호출에도 한 번만 켜도록 dedup한다)
    await executeTool('service_stats', {}, ctx);
    expect(boots).toBe(1);
  });
});
