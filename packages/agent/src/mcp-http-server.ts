import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { decodeNative, encodeLoneSurrogates, native } from '@b-studio/sandbox';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { zodShape } from './tool-schema';
import type { buildTools, ToolOutcome } from './tools';

/** 모델이 b-studio 도구만 부르게 하려고 러너가 띄우는 로컬 MCP 서버. 끝나면 반드시 close()를 부른다 */
export interface ToolServer {
  url: string;
  port: number;
  /** 이 실행에서만 쓰는 bearer 토큰. 로그에 남기지 않는다 */
  token: string;
  close(): Promise<void>;
}

export interface ToolServerOptions {
  /**
   * buildTools가 만든 도구 목록. 스키마는 여기 한 곳에서만 정의한다.
   * 함수로 주면 요청마다 부른다 — 서버가 오래 살아 있는 동안 프로젝트 설정(서비스 이름)이 바뀌는 자리(세션 터미널)에서 쓴다
   */
  specs: ReturnType<typeof buildTools> | (() => ReturnType<typeof buildTools>);
  /** 도구 실행을 러너에 넘긴다. 순서 보장과 이벤트 알림은 부르는 쪽이 맡는다 */
  run: (name: string, args: unknown) => Promise<ToolOutcome>;
  name?: string;
  /** 스키마의 required에 없는 인자를 선택으로 연다(zodShape의 honorRequired). 선택 인자가 있는 도구(탐색형 QA)가 쓴다 */
  honorRequired?: boolean;
  /**
   * 루프백 말고도 받을 Host 이름. 컨테이너 안의 CLI는 호스트를 `host.docker.internal`로 부르므로 그 이름을 여기에 넣는다.
   * 넣지 않으면 루프백 이름만 받는다
   */
  allowedHosts?: readonly string[];
}

/**
 * b-studio 도구를 로컬 streamable HTTP MCP 서버로 노출한다.
 * Codex CLI는 `-c mcp_servers.<이름>.url=...`로 이 주소를 받고, 토큰은 환경 변수로만 넘긴다(파일에 쓰지 않는다).
 * 127.0.0.1의 임의 포트에만 열고, 실행마다 새 bearer 토큰을 만들어 그 토큰이 맞는 요청만 받는다.
 */
export async function startToolServer({ specs, run, name = 'b-studio', allowedHosts = [], honorRequired = false }: ToolServerOptions): Promise<ToolServer> {
  const token = randomBytes(24).toString('hex');
  const http = createServer((req, res) => {
    void handle(req, res, { specs, run, name, token, allowedHosts, honorRequired });
  });
  http.on('clientError', (_error, socket) => socket.destroy());

  await listen(http);
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('MCP 서버가 포트를 열지 못했습니다');

  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    port: address.port,
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
  const denied = authorize(req.headers.host, req.headers.authorization, options.token, options.allowedHosts);
  if (denied !== undefined) {
    res.writeHead(denied.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: denied.status * -100, message: denied.message }, id: null }));
    return;
  }

  // 상태를 두지 않는다(stateless). SDK는 stateless에서 트랜스포트 재사용을 금지하므로 요청마다 새로 만든다.
  // 턴마다 codex가 새 프로세스로 붙고 세션을 이어받지 않으므로 세션 관리가 필요 없다
  const server = new McpServer({ name: options.name, version: '0.0.0' });
  for (const spec of typeof options.specs === 'function' ? options.specs() : options.specs) {
    server.registerTool(
      spec.name,
      { description: spec.description, inputSchema: zodShape(spec.input_schema as { properties?: unknown; required?: unknown }, { honorRequired: options.honorRequired }) },
      async (args: unknown) => {
        const outcome = await options.run(spec.name, args);
        const images = (outcome.images ?? []).map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType }));
        return { content: [{ type: 'text' as const, text: outcome.content }, ...images], isError: !outcome.ok };
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

/** 호스트·토큰은 견주는 값이라(여는 쪽) 짝 없는 서로게이트가 경계에서 U+FFFD로 합쳐지지 않게 단사로 바꿔 보낸다. 없는 값은 그대로 없다 */
function encodeOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : encodeLoneSurrogates(value);
}

/** 통과하면 undefined, 막으면 응답할 상태와 이유. 판정은 Rust(crates/bstudio-guard/src/connection_judge.rs) */
export function authorize(host: string | undefined, authorization: string | undefined, token: string, allowedHosts: readonly string[]): { status: number; message: string } | undefined {
  const denied = native.connAuthorize(encodeOptional(host), encodeOptional(authorization), encodeLoneSurrogates(token), allowedHosts.map(encodeLoneSurrogates));
  return denied === null || denied === undefined ? undefined : decodeNative<{ status: number; message: string }>(denied);
}

/** Host 헤더가 루프백 이름이거나 따로 허용한 이름인가(여는 쪽). 이름은 대소문자를 가리지 않는다 */
export function hostAllowed(host: string | undefined, allowedHosts: readonly string[] = []): boolean {
  return native.connHostAllowed(encodeOptional(host), allowedHosts.map(encodeLoneSurrogates));
}

/**
 * bearer 토큰을 값의 위치와 길이에 따라 시간이 달라지지 않게 비교한다(Rust, 여는 쪽). 빈 토큰은 맞지 않는다.
 * 게시판 MCP 라우트(board-mcp-server.ts를 부르는 쪽)도 같은 비교가 필요해 밖으로 연다.
 */
export function tokenMatches(authorization: string | undefined, token: string): boolean {
  return native.connTokenMatches(encodeOptional(authorization), encodeLoneSurrogates(token));
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
