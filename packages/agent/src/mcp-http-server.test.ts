import { request as httpRequest } from 'node:http';
import type { LoadedProject } from '@b-studio/spec';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startToolServer, type ToolServer } from './mcp-http-server';
import { createOrdersProject } from './test-helpers';
import { buildTools, type ToolOutcome } from './tools';

let project: LoadedProject;
const opened: ToolServer[] = [];
const clients: Client[] = [];

beforeEach(async () => {
  project = await createOrdersProject('mcp-http-test-');
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of opened.splice(0)) await server.close();
});

async function start(run: (name: string, args: unknown) => Promise<ToolOutcome>) {
  const server = await startToolServer({ specs: buildTools(project), run });
  opened.push(server);
  return server;
}

/** null이면 Authorization 헤더를 아예 붙이지 않는다 */
async function connect(server: ToolServer, authorization: string | null = `Bearer ${server.token}`) {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: authorization === null ? {} : { headers: { authorization } },
  });
  const client = new Client({ name: 'mcp-http-test', version: '0.0.0' });
  clients.push(client);
  await client.connect(transport);
  return client;
}

describe('startToolServer', () => {
  it('buildTools의 도구를 그대로 노출하고, 호출을 run으로 넘겨 결과를 돌려준다', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const server = await start(async (name, args) => {
      calls.push({ name, args });
      return { ok: name !== 'list_files', content: `${name} 실행` };
    });
    const client = await connect(server);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(buildTools(project).map((tool) => tool.name));

    const ok = await client.callTool({ name: 'read_file', arguments: { path: 'api/src/Order.java' } });
    expect(ok).toMatchObject({ isError: false, content: [{ type: 'text', text: 'read_file 실행' }] });

    const failed = await client.callTool({ name: 'list_files', arguments: { path: '.', depth: 1 } });
    expect(failed).toMatchObject({ isError: true, content: [{ type: 'text', text: 'list_files 실행' }] });

    expect(calls).toEqual([
      { name: 'read_file', args: { path: 'api/src/Order.java' } },
      { name: 'list_files', args: { path: '.', depth: 1 } },
    ]);
  });

  it('토큰이 없거나 다르면 401로 거부한다', async () => {
    const server = await start(async () => ({ ok: true, content: 'ok' }));

    await expect(connect(server, null)).rejects.toThrow();
    await expect(connect(server, 'Bearer 다른토큰')).rejects.toThrow();
    // 맞는 토큰이면 붙는다
    await expect(connect(server)).resolves.toBeDefined();
  });

  it('루프백이 아닌 Host 헤더는 거부한다', async () => {
    const server = await start(async () => ({ ok: true, content: 'ok' }));
    const status = await rawPost(server, { host: 'evil.example', authorization: `Bearer ${server.token}` });
    expect(status).toBe(403);
  });

  it('close() 뒤에는 연결할 수 없다', async () => {
    const server = await start(async () => ({ ok: true, content: 'ok' }));
    const client = await connect(server);
    await server.close();
    opened.splice(opened.indexOf(server), 1);
    await expect(client.listTools()).rejects.toThrow();
  });
});

/** fetch가 금지하는 Host 헤더까지 실어 보내려고 raw 소켓 요청을 쓴다 */
function rawPost(server: ToolServer, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(server.url);
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }));
  });
}
