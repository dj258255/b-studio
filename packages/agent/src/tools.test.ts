import type { Sandbox } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { executeTool, type ToolContext } from './tools';
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
