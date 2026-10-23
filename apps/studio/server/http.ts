import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Node의 요청·응답과 Web 표준 Request·Response를 잇는다. 라우트는 Web 표준만 쓰므로(Next App Router와 같은 꼴)
 * 여기서 바꿔 넘기고 받은 응답을 그대로 쓴다. 스트림 응답(SSE)은 조각마다 바로 보내고, 손님이 끊으면 스트림을 취소한다
 */

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`요청 본문이 ${limit}바이트를 넘었습니다`);
  }
}

export interface ToWebRequestOptions {
  maxBodyBytes: number;
  /** 손님이 연결을 끊으면 꺼지는 신호. 라우트의 request.signal이 된다 */
  signal: AbortSignal;
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  return headers;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError(limit);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new BodyTooLargeError(limit);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Node 요청 → Web Request. 본문은 한도까지 읽어 담는다(API 본문은 작고, 한도를 넘으면 413으로 답하게 던진다) */
export async function toWebRequest(req: IncomingMessage, options: ToWebRequestOptions): Promise<Request> {
  const headers = toHeaders(req);
  const host = headers.get('host') ?? '127.0.0.1';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const method = (req.method ?? 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? await readBody(req, options.maxBodyBytes) : undefined;
  return new Request(url, { method, headers, body: body && body.length > 0 ? new Uint8Array(body) : undefined, signal: options.signal });
}

function waitDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

/** Web Response → Node 응답. set-cookie는 여러 줄 그대로, 스트림은 조각마다 바로 쓴다 */
export async function writeWebResponse(req: IncomingMessage, res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  if (response.statusText) res.statusMessage = response.statusText;
  const cookies = response.headers.getSetCookie();
  for (const [name, value] of response.headers) {
    if (name === 'set-cookie') continue;
    res.setHeader(name, value);
  }
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);

  const body = response.body;
  if (!body || req.method === 'HEAD') {
    await body?.cancel().catch(() => undefined);
    res.end();
    return;
  }

  // 헤더를 먼저 보내 SSE 손님이 첫 조각을 기다리지 않고 연결을 알게 한다
  res.flushHeaders();
  const reader = body.getReader();
  const onClose = () => {
    if (!res.writableEnded) void reader.cancel().catch(() => undefined);
  };
  res.once('close', onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) break;
      if (!res.write(value)) await waitDrain(res);
    }
  } catch {
    // 손님이 끊겨 스트림이 취소됐거나 라우트의 스트림이 오류로 끝났다. 응답은 아래에서 닫는다
  } finally {
    res.off('close', onClose);
    if (!res.destroyed) res.end();
    else void reader.cancel().catch(() => undefined);
  }
}
