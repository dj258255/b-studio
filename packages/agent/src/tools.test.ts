import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
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
