import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { zodShape } from './claude-code-runner';
import type { buildTools, ToolOutcome } from './tools';

/** 모델이 b-studio 도구만 부르게 하려고 러너가 띄우는 로컬 MCP 서버. 끝나면 반드시 close()를 부른다 */
export interface ToolServer {
  url: string;
  /** 이 실행에서만 쓰는 bearer 토큰. 로그에 남기지 않는다 */
  token: string;
  close(): Promise<void>;
}

export interface ToolServerOptions {
  /** buildTools가 만든 도구 목록. 스키마는 여기 한 곳에서만 정의한다 */
  specs: ReturnType<typeof buildTools>;
  /** 도구 실행을 러너에 넘긴다. 순서 보장과 이벤트 알림은 부르는 쪽이 맡는다 */
  run: (name: string, args: unknown) => Promise<ToolOutcome>;
  name?: string;
}

/** 루프백 밖에서 온 요청을 거부한다. 서버를 127.0.0.1에만 열어 두어도 Host 헤더 위조(DNS 재바인딩)는 따로 막아야 한다 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * b-studio 도구를 로컬 streamable HTTP MCP 서버로 노출한다.
 * Codex CLI는 `-c mcp_servers.<이름>.url=...`로 이 주소를 받고, 토큰은 환경 변수로만 넘긴다(파일에 쓰지 않는다).
 * 127.0.0.1의 임의 포트에만 열고, 실행마다 새 bearer 토큰을 만들어 그 토큰이 맞는 요청만 받는다.
 */
export async function startToolServer({ specs, run, name = 'b-studio' }: ToolServerOptions): Promise<ToolServer> {
  const token = randomBytes(24).toString('hex');
  const http = createServer((req, res) => {
    void handle(req, res, { specs, run, name, token });
  });
  http.on('clientError', (_error, socket) => socket.destroy());

  await listen(http);
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('MCP 서버가 포트를 열지 못했습니다');

  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    async close() {
      if (closed) return;
      closed = true;
      // 열려 있는 keep-alive 연결이 남아 있으면 close()가 늦게 끝난다. 먼저 끊어 새 연결도 거부한다
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, options: Required<ToolServerOptions> & { token: string }): Promise<void> {
  const denied = authorize(req.headers.host, req.headers.authorization, options.token);
  if (denied !== undefined) {
    res.writeHead(denied.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: denied.status * -100, message: denied.message }, id: null }));
    return;
  }

  // 상태를 두지 않는다(stateless). SDK는 stateless에서 트랜스포트 재사용을 금지하므로 요청마다 새로 만든다.
  // 턴마다 codex가 새 프로세스로 붙고 세션을 이어받지 않으므로 세션 관리가 필요 없다
  const server = new McpServer({ name: options.name, version: '0.0.0' });
  for (const spec of options.specs) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: zodShape(spec.input_schema as { properties?: unknown }) },
      async (args: unknown) => {
        const outcome = await options.run(spec.name, args);
        return { content: [{ type: 'text' as const, text: outcome.content }], isError: !outcome.ok };
      },
    );
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const cleanup = () => {
    void transport.close().catch(() => {});
    void server.close().catch(() => {});
  };
  res.on('close', cleanup);

  try {
    await server.connect(transport);
    // GET(SSE)·POST·DELETE를 모두 같은 핸들러로 넘긴다. 본문 파싱은 SDK가 한다
    await transport.handleRequest(req, res);
  } catch (error) {
    cleanup();
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    if (!res.writableEnded) res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: describe(error) }, id: null }));
  }
}

/** 통과하면 undefined, 막으면 응답할 상태와 이유 */
function authorize(host: string | undefined, authorization: string | undefined, token: string): { status: number; message: string } | undefined {
  const hostname = (host ?? '').split(':')[0]!.replace(/^\[|\]$/g, '');
  if (!LOOPBACK_HOSTS.has(hostname)) return { status: 403, message: 'MCP 서버는 루프백에서만 접근할 수 있습니다' };
  if (authorization !== `Bearer ${token}`) return { status: 401, message: 'unauthorized' };
  return undefined;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
