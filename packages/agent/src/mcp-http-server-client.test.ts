import { connect } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { startToolServer, type ToolServer, type ToolServerOptions } from './mcp-http-server';
import type { ToolOutcome } from './tools';

/**
 * Rust로 옮긴 MCP 서버(ADR-201, 4f A7b)에 **실제 MCP 클라이언트**(SDK의 `Client` + `StreamableHTTPClientTransport`)로 붙어 본다.
 * 차등 시험은 원시 요청으로 응답을 견주고, 여기는 클라이언트가 협상·목록·호출·닫기를 끝까지 해내는지, 그리고 동시성·연결 끊김·글자 보존을 본다.
 */

const SPECS = [
  { name: 'echo', description: '그대로 돌려준다', input_schema: { type: 'object', properties: { text: { type: 'string', description: '글' }, times: { type: 'integer' }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['text', 'times', 'mode'] } },
  { name: 'shot', description: '이미지', input_schema: { type: 'object', properties: {} } },
  { name: 'slow', description: '느림', input_schema: { type: 'object', properties: { ms: { type: 'integer' } }, required: ['ms'] } },
  { name: 'boom', description: '던짐', input_schema: { type: 'object', properties: {} } },
] as never;

const opened: ToolServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of opened.splice(0)) await server.close();
});

async function start(run: (name: string, args: unknown) => Promise<ToolOutcome>, options: Partial<ToolServerOptions> = {}): Promise<ToolServer> {
  const server = await startToolServer({ specs: SPECS, run, ...options });
  opened.push(server);
  return server;
}

async function connectClient(server: ToolServer): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${server.token}` } } });
  const client = new Client({ name: 'mcp-client-test', version: '0.0.0' });
  clients.push(client);
  await client.connect(transport);
  return client;
}

const post = (server: ToolServer, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(server.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });

describe('Rust MCP 서버에 SDK 클라이언트로 붙는다', () => {
  it('협상·도구 목록·호출(성공·실패·이미지·던짐)이 끝까지 된다', async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const server = await start(async (name, args) => {
      calls.push({ name, args });
      if (name === 'boom') throw new Error('처리가 던졌다');
      if (name === 'shot') return { ok: true, content: '화면', images: [{ data: 'QUJD', mimeType: 'image/png' }] };
      return { ok: true, content: JSON.stringify(args) };
    });
    const client = await connectClient(server);
    expect(client.getServerVersion()).toEqual({ name: 'b-studio', version: '0.0.0' });
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: true } });

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(['echo', 'shot', 'slow', 'boom']);
    const echo = listed.tools[0];
    expect(echo?.description).toBe('그대로 돌려준다');
    expect(echo?.inputSchema).toMatchObject({ type: 'object', properties: { text: { type: 'string', description: '글' }, mode: { type: 'string', enum: ['a', 'b'] } }, required: ['text', 'times', 'mode'] });

    const ok = await client.callTool({ name: 'echo', arguments: { text: '안녕', times: 2, mode: 'a', 모르는: 1 } });
    expect(ok).toMatchObject({ isError: false, content: [{ type: 'text', text: JSON.stringify({ text: '안녕', times: 2, mode: 'a' }) }] });
    expect(calls).toEqual([{ name: 'echo', args: { text: '안녕', times: 2, mode: 'a' } }]);

    const invalid = await client.callTool({ name: 'echo', arguments: { text: 1, times: 1.5, mode: 'c' } });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid.content)).toContain('Input validation error: Invalid arguments for tool echo');
    expect(calls).toHaveLength(1);

    expect(await client.callTool({ name: 'nope', arguments: {} })).toMatchObject({ isError: true, content: [{ type: 'text', text: 'MCP error -32602: Tool nope not found' }] });
    expect(await client.callTool({ name: 'boom', arguments: {} })).toMatchObject({ isError: true, content: [{ type: 'text', text: '처리가 던졌다' }] });
    expect(await client.callTool({ name: 'shot', arguments: {} })).toMatchObject({ isError: false, content: [{ type: 'text', text: '화면' }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }] });

    await client.ping();
    await client.close();
  });

  it('도구 인자의 짝 없는 서로게이트와 -0은 run까지 손실 없이 간다', async () => {
    const seen: unknown[] = [];
    const server = await start(async (_name, args) => {
      seen.push(args);
      return { ok: true, content: 'ok' };
    });
    // 원시 JSON으로 보낸다(SDK 클라이언트의 JSON.stringify는 짝 없는 서로게이트를 이스케이프로 쓰지만 -0은 0으로 쓴다)
    const body = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"text":"a\\ud800b\\udc00\\ud83d\\ude00\\ue010","times":-0,"mode":"a"}}}';
    const response = await fetch(server.url, { method: 'POST', headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body });
    expect(response.status).toBe(200);
    await response.text();
    const args = seen[0] as { text: string; times: number };
    expect(args.text).toBe('a\ud800b\udc00😀');
    expect(Object.is(args.times, -0)).toBe(true);
  });

  it('도구 결과의 짝 없는 서로게이트와 예약 글자는 그대로 JSON 이스케이프로 나간다', async () => {
    const server = await start(async () => ({ ok: true, content: 'x\ud800yz' }));
    const response = await post(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'boom', arguments: {} } });
    const text = await response.text();
    // 응답 글자 그대로: 짝 없는 서로게이트는 `\ud800` 이스케이프, 글자 그대로의 U+E010은 그 글자
    expect(text).toContain('"text":"x\\ud800yz"');
  });

  it('느린 도구 호출이 다른 요청을 막지 않는다(요청마다 독립)', async () => {
    const server = await start(async (name, args) => {
      if (name === 'slow') await new Promise((resolve) => setTimeout(resolve, (args as { ms: number }).ms));
      return { ok: true, content: name };
    });
    const started = Date.now();
    const slow = post(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: { ms: 1500 } } }).then(async (r) => {
      await r.text();
      return Date.now() - started;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const fastStarted = Date.now();
    const pings = await Promise.all(Array.from({ length: 5 }, (_, id) => post(server, { jsonrpc: '2.0', id, method: 'ping' }).then((r) => r.text())));
    const fastElapsed = Date.now() - fastStarted;
    expect(pings.every((text) => text.includes('"result":{}'))).toBe(true);
    expect(fastElapsed).toBeLessThan(1000);
    expect(await slow).toBeGreaterThanOrEqual(1400);
  });

  it('배치 안에서 먼저 끝난 응답부터 나온다', async () => {
    const server = await start(async (name, args) => {
      if (name === 'slow') await new Promise((resolve) => setTimeout(resolve, (args as { ms: number }).ms));
      return { ok: true, content: name };
    });
    const response = await post(server, [
      { jsonrpc: '2.0', id: 'slow', method: 'tools/call', params: { name: 'slow', arguments: { ms: 400 } } },
      { jsonrpc: '2.0', id: 'ping', method: 'ping' },
    ]);
    const ids = [...(await response.text()).matchAll(/"id":"(\w+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(['ping', 'slow']);
  });

  it('연결이 끊겨도 이미 시작한 도구 실행은 끝까지 돈다(옛 서버와 같다)', async () => {
    let finished = false;
    let started = false;
    const server = await start(async () => {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
      finished = true;
      return { ok: true, content: 'x' };
    });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: { ms: 1 } } });
    const socket = connect(server.port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.on('connect', resolve));
    socket.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nAuthorization: Bearer ${server.token}\r\nAccept: application/json, text/event-stream\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(started).toBe(true);
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(finished).toBe(true);
  });

  it('도구 목록을 함수로 주면 요청마다 부르고, 던지면 그 요청만 500이다', async () => {
    let calls = 0;
    let fail = false;
    const server = await start(async () => ({ ok: true, content: 'ok' }), {
      specs: () => {
        calls += 1;
        if (fail) throw new Error('설정을 읽지 못했다');
        return (SPECS as unknown as Array<{ name: string }>).slice(0, calls) as never;
      },
    });
    const list = async (): Promise<string[]> => {
      const text = await (await post(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).text();
      return [...text.matchAll(/"name":"(\w+)","description"/g)].map((match) => match[1] as string);
    };
    expect(await list()).toEqual(['echo']);
    expect(await list()).toEqual(['echo', 'shot']);
    fail = true;
    const broken = await post(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ jsonrpc: '2.0', error: { code: -32603, message: '설정을 읽지 못했다' }, id: null });
    fail = false;
    expect(await list()).toHaveLength(4);
  });

  it('지원하지 않는 입력 형식의 도구가 있으면 그 요청은 500이다(처리되지 않은 거절로 죽지 않는다)', async () => {
    const server = await start(async () => ({ ok: true, content: 'ok' }), { specs: [{ name: 'weird', description: 'x', input_schema: { type: 'object', properties: { a: { type: 'object' } } } }] as never });
    const response = await post(server, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).toContain('지원하지 않는 도구 입력 형식입니다');
    // 서버는 살아 있다
    expect((await post(server, { jsonrpc: '2.0', id: 2, method: 'ping' })).status).toBe(200);
  });

  it('close()는 처리 중인 요청이 있어도 끝나고, 두 번 불러도 된다', async () => {
    const server = await start(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return { ok: true, content: 'x' };
    });
    // 응답 머리(SSE)는 이미 와 있고 본문을 읽는 중에 끊긴다
    const pending = post(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow', arguments: { ms: 1 } } })
      .then((response) => response.text())
      .catch(() => 'cut');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    await server.close();
    await server.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await pending).toBe('cut');
  });

  it('GET은 SSE 스트림을 열어 두고, 클라이언트가 끊으면 끝난다', async () => {
    const server = await start(async () => ({ ok: true, content: 'ok' }));
    const controller = new AbortController();
    const response = await fetch(server.url, { headers: { authorization: `Bearer ${server.token}`, accept: 'text/event-stream' }, signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    controller.abort();
    await response.body?.cancel().catch(() => {});
  });
});
