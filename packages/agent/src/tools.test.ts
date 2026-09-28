import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { Board } from './coordination';
import { buildTools, executeTool, type ToolContext } from './tools';
import { Workspace } from './workspace';

const project = {
  root: '/tmp/none',
  managed: [['api', { source: 'managed', template: 'spring-boot', path: 'api', port: 8080, preview: 'openapi' }]],
} as unknown as LoadedProject;

const context: ToolContext = {
  project,
  workspace: new Workspace('/tmp/none'),
  sandbox: { endpoint: async (service: string) => ({ service, containerPort: 8080, url: 'http://127.0.0.1:1' }) } as unknown as Sandbox,
  fetcher: async () => ({}),
};

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
