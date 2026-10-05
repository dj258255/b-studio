import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { handleBoardMcpRequest } from './board-mcp-server';
import { Board } from './coordination';
import { externalBoardAccess } from './board-mcp';
import type { BoardAccess } from './tools';

/**
 * handleBoardMcpRequest는 Web Standard Request/Response만 주고받으므로(소켓 없음), 실제 MCP 클라이언트로
 * 프로토콜 전체(initialize → tools/list → tools/call)를 맞게 구현했는지 검증하려고 루프백(127.0.0.1,
 * 임의 포트)에 얇은 Node http 다리만 세운다. mcp-http-server.test.ts와 같은 방식이고, :3000은 쓰지 않는다.
 */
const servers: Server[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function serve(access: BoardAccess): Promise<string> {
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(', '));
      }
      const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body: body.length > 0 ? body : undefined });
      const response = await handleBoardMcpRequest(request, access);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    })();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('포트를 열지 못했습니다');
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function connect(url: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'board-mcp-test', version: '0.0.0' });
  clients.push(client);
  await client.connect(transport);
  return client;
}

describe('handleBoardMcpRequest', () => {
  it('고정 신원으로 post_note·read_notes를 노출하고, 모델이 신원을 바꿀 수 없다', async () => {
    const board = new Board({ topology: 'mesh' });
    const access = externalBoardAccess(board, { lane: 'guest-codex' });
    const url = await serve(access);
    const client = await connect(url);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(['post_note', 'read_notes']);

    const posted = await client.callTool({ name: 'post_note', arguments: { kind: 'fact', body: 'Node 22 사용', refs: [] } });
    expect(posted.isError).toBe(false);

    const note = board.snapshot()[0]!;
    // 도구 입력에 레인·작성자를 넣을 자리가 없다 — 토큰이 고정한 신원 그대로 기록된다
    expect(note.author).toEqual({ lane: 'guest-codex', by: 'model' });

    const read = await client.callTool({ name: 'read_notes', arguments: { kinds: [] } });
    expect(read).toMatchObject({ isError: false, content: [{ type: 'text', text: expect.stringContaining('Node 22 사용') }] });
  });

  it('modelWrites가 꺼져 있으면 post_note 자체를 도구 목록에서 뺀다', async () => {
    const board = new Board({ topology: 'mesh', modelWrites: false });
    const access = externalBoardAccess(board, { lane: 'guest-reader' });
    const url = await serve(access);
    const client = await connect(url);

    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual(['read_notes']);
  });
});
