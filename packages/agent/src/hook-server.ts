import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostAllowed, tokenMatches } from './mcp-http-server';

/**
 * 에이전트 CLI의 훅 명령이 부르는 서버(이슈 #670·#673).
 * 요청 본문은 CLI가 훅에 준 JSON이고, 응답은 CLI가 훅의 출력으로 읽을 JSON이다. 127.0.0.1의 임의 포트에만 열고,
 * 서버마다 새로 만든 bearer 토큰이 맞는 요청만 받는다.
 */

/** CLI가 훅에 준 입력. 필드는 훅 종류마다 달라 쓰는 쪽이 꺼내 확인한다(바깥에서 온 값이다) */
export type HookInput = Readonly<Record<string, unknown>>;
export type HookHandler = (input: HookInput) => Promise<Record<string, unknown>>;

export interface HookServer {
  /** 뒤에 경로(/stop 등)를 붙여 부른다 */
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export interface HookServerOptions {
  /**
   * 루프백 말고도 받을 Host 이름. 컨테이너 안의 CLI는 호스트를 `host.docker.internal`로 부르므로 그 이름을 여기에 넣는다.
   * 넣지 않으면 루프백 이름만 받는다(브라우저가 다른 이름으로 이 포트를 부르게 만드는 DNS 재바인딩을 막는다)
   */
  allowedHosts?: readonly string[];
}

const MAX_HOOK_BODY_BYTES = 4 * 1024 * 1024;

export async function startHookServer(routes: Readonly<Record<string, HookHandler>>, { allowedHosts = [] }: HookServerOptions = {}): Promise<HookServer> {
  const token = randomBytes(24).toString('hex');
  const http = createServer((req, res) => {
    void handleHook(req, res, token, routes, allowedHosts);
  });
  http.on('clientError', (_error, socket) => socket.destroy());
  // 게이트가 도는 동안 연결을 끊지 않는다
  http.requestTimeout = 0;
  http.headersTimeout = 0;
  await listen(http);
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('게이트 훅 서버가 포트를 열지 못했습니다');
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    port: address.port,
    token,
    async close() {
      if (closed) return;
      closed = true;
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function handleHook(req: IncomingMessage, res: ServerResponse, token: string, routes: Readonly<Record<string, HookHandler>>, allowedHosts: readonly string[]): Promise<void> {
  const reply = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!hostAllowed(req.headers.host, allowedHosts)) return reply(403, { error: '루프백에서만 접근할 수 있습니다' });
  if (!tokenMatches(req.headers.authorization, token)) return reply(401, { error: 'unauthorized' });
  const handler = req.method === 'POST' && req.url && Object.hasOwn(routes, req.url) ? routes[req.url] : undefined;
  if (!handler) return reply(404, { error: 'not found' });
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_HOOK_BODY_BYTES) return reply(413, { error: 'too large' });
      chunks.push(chunk);
    }
    let input: HookInput = {};
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) input = parsed as HookInput;
    } catch {
      // 훅 입력을 읽지 못해도 검증은 돈다. 입력은 요약에만 쓴다
    }
    reply(200, await handler(input));
  } catch (error) {
    // 5xx로 답한다. 훅 명령이 이것을 어떻게 다룰지는 쓰는 쪽이 정한다(관문 러너의 PreToolUse는 거절로 바꾼다)
    reply(500, { error: error instanceof Error ? error.message : String(error) });
  }
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
