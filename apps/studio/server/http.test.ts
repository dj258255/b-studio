import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { BodyTooLargeError, toWebRequest, writeWebResponse } from './http';

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

/** 핸들러 하나로 임시 포트에 서버를 띄우고 주소를 준다 */
async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('Node 요청 → Web Request', () => {
  it('메서드·주소·헤더·본문을 옮긴다', async () => {
    let seen: { method: string; url: string; header: string | null; body: string } | undefined;
    const origin = await serve(async (req, res) => {
      const request = await toWebRequest(req, { maxBodyBytes: 1024, signal: new AbortController().signal });
      seen = { method: request.method, url: request.url, header: request.headers.get('x-test'), body: await request.text() };
      res.end('ok');
    });
    await fetch(`${origin}/api/x?a=1`, { method: 'POST', headers: { 'x-test': 'v', 'content-type': 'text/plain' }, body: '본문' });
    expect(seen).toEqual({ method: 'POST', url: `${origin}/api/x?a=1`, header: 'v', body: '본문' });
  });

  it('본문이 한도를 넘으면 BodyTooLargeError', async () => {
    let error: unknown;
    const origin = await serve(async (req, res) => {
      try {
        await toWebRequest(req, { maxBodyBytes: 4, signal: new AbortController().signal });
      } catch (caught) {
        error = caught;
      }
      res.end();
    });
    await fetch(`${origin}/`, { method: 'POST', body: '12345' }).catch(() => undefined);
    expect(error).toBeInstanceOf(BodyTooLargeError);
  });
});

describe('Web Response → Node 응답', () => {
  it('상태·헤더·여러 set-cookie·본문을 쓴다', async () => {
    const origin = await serve(async (req, res) => {
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.append('set-cookie', 'a=1; Path=/');
      headers.append('set-cookie', 'b=2; Path=/');
      await writeWebResponse(req, res, new Response('{"ok":true}', { status: 201, headers }));
    });
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(201);
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('스트림 응답은 조각마다 바로 보낸다(SSE가 모였다가 가지 않는다)', async () => {
    let push: ((text: string) => void) | undefined;
    const origin = await serve(async (req, res) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (text) => controller.enqueue(new TextEncoder().encode(text));
          push('data: 1\n\n');
        },
      });
      await writeWebResponse(req, res, new Response(stream, { headers: { 'content-type': 'text/event-stream' } }));
    });
    const response = await fetch(`${origin}/`);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 1\n\n');
    push!('data: 2\n\n');
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: 2\n\n');
    await reader.cancel();
  });

  it('손님이 연결을 끊으면 요청 신호가 꺼지고 응답 스트림도 취소된다', async () => {
    let aborted = false;
    let cancelled = false;
    let gotRequest: () => void;
    const requested = new Promise<void>((resolve) => (gotRequest = resolve));
    const origin = await serve(async (req, res) => {
      const controller = new AbortController();
      req.socket.on('close', () => controller.abort());
      const request = await toWebRequest(req, { maxBodyBytes: 1024, signal: controller.signal });
      request.signal.addEventListener('abort', () => (aborted = true));
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(': ping\n\n'));
          gotRequest();
        },
        cancel() {
          cancelled = true;
        },
      });
      await writeWebResponse(req, res, new Response(stream));
    });
    await new Promise<void>((resolve) => {
      const client = httpRequest(`${origin}/`, (response: IncomingMessage) => {
        response.once('data', () => {
          client.destroy();
          resolve();
        });
      });
      client.end();
    });
    await requested;
    for (let i = 0; i < 50 && !(aborted && cancelled); i++) await new Promise((r) => setTimeout(r, 20));
    expect({ aborted, cancelled }).toEqual({ aborted: true, cancelled: true });
  });

  it('HEAD 요청에는 본문을 쓰지 않는다', async () => {
    const origin = await serve(async (req, res) => {
      await writeWebResponse(req, res, new Response('보이면 안 됨', { headers: { 'x-a': '1' } }));
    });
    const response = await fetch(`${origin}/`, { method: 'HEAD' });
    expect(response.headers.get('x-a')).toBe('1');
    expect(await response.text()).toBe('');
  });
});
