/**
 * 외부 에이전트가 게시판 MCP 도구(post_note·read_notes)를 쓰는 HTTP 표면.
 *
 * mcp-http-server.ts와 같은 메커니즘(McpServer, 요청마다 새로 만드는 상태 없는 트랜스포트, zodShape로
 * 바꾼 입력 스키마)을 그대로 쓰지만, 그 파일은 실행기가 로컬 프로세스(codex·opencode)를 붙이려고 루프백에만
 * 여는 서버다. 이 파일은 반대로 루프백 밖(다른 세션·사용자 PC의 CLI)에서 네트워크로 닿아야 하므로 Node
 * http 서버 대신 Web Standard(Request/Response) 트랜스포트를 쓴다 — Next.js 라우트 핸들러가 그대로
 * 돌려줄 수 있다. 토큰 확인은 이 함수 밖(라우트)에서 끝내고, 여기는 이미 정해진 접근(BoardAccess)만 받는다.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { boardMcpToolSpecs, runBoardMcpTool } from './board-mcp';
import { zodShape } from './claude-code-runner';
import type { BoardAccess } from './tools';

/**
 * 게시판 MCP 요청 하나(POST·GET·DELETE)를 처리한다. 상태를 두지 않는다(stateless) — mcp-http-server.ts와
 * 같은 이유로, 외부 에이전트가 턴마다 새 연결로 붙을 수 있어 세션을 이어받는다는 보장이 없다.
 */
export async function handleBoardMcpRequest(req: Request, access: BoardAccess, name = 'b-studio-board'): Promise<Response> {
  const server = new McpServer({ name, version: '0.0.0' });
  for (const spec of boardMcpToolSpecs(access)) {
    server.registerTool(spec.name, { description: spec.description, inputSchema: zodShape(spec.input_schema) }, async (args: unknown) => {
      const outcome = await runBoardMcpTool(spec.name, (args ?? {}) as Record<string, unknown>, access);
      return { content: [{ type: 'text' as const, text: outcome.content }], isError: !outcome.ok };
    });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } finally {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  }
}
