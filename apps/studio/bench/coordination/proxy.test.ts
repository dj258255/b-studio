import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isPlannerRequest, startProxy, type ProxyHandle } from './proxy';

interface Upstream {
  baseUrl: string;
  calls: Array<{ authorization?: string; body: string }>;
  close(): Promise<void>;
}

async function fakeUpstream(reply: (call: { authorization?: string; body: string }, response: ServerResponse) => void): Promise<Upstream> {
  const calls: Array<{ authorization?: string; body: string }> = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
      const call = { authorization: request.headers.authorization, body: Buffer.concat(chunks).toString('utf8') };
      calls.push(call);
      reply(call, response);
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const plannerBody = JSON.stringify({
  model: 'm',
  messages: [
    { role: 'system', content: 'You split a web development request for project "orders".\nServices:' },
    { role: 'user', content: '주문 목록 화면을 만들어 줘' },
  ],
});
const workBody = JSON.stringify({
  model: 'm',
  messages: [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: '고쳐 줘' },
  ],
  tools: [{ type: 'function', function: { name: 'read_file' } }],
});

describe('계획 요청 판별', () => {
  it('도구가 없고 system이 작업 분해 프롬프트로 시작하면 계획 요청이다', () => {
    expect(isPlannerRequest(JSON.parse(plannerBody))).toBe(true);
    // tools를 빈 배열로 보내도 계획 요청이다
    expect(isPlannerRequest({ tools: [], messages: [{ role: 'system', content: 'You split a web development request for project' }] })).toBe(true);
  });

  it('도구가 있거나 system이 다르면 계획 요청이 아니다', () => {
    expect(isPlannerRequest(JSON.parse(workBody))).toBe(false);
    expect(isPlannerRequest({ messages: [{ role: 'system', content: 'You are a coding agent.' }] })).toBe(false);
    expect(isPlannerRequest(undefined)).toBe(false);
  });
});

describe('startProxy', () => {
  it('계획 요청은 상류로 가지 않고 설정한 계획을 돌려준다', async () => {
    const upstream = await fakeUpstream((_call, response) => response.end('{}'));
    const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl, upstreamApiKey: 'sk-upstream' });
    cleanups.push(() => proxy.close(), () => upstream.close());
    const plan = { tasks: [{ id: 'orders-list-api', paths: ['api'] }] };
    proxy.setPlan(plan);

    const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: plannerBody });
    const payload = (await response.json()) as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number } };

    expect(response.status).toBe(200);
    expect(JSON.parse(payload.choices[0]!.message.content)).toEqual(plan);
    expect(payload.usage.prompt_tokens).toBe(0);
    expect(upstream.calls).toHaveLength(0);
    expect(proxy.takeStats()).toMatchObject({ forwardedCalls: 0, plannerCalls: 1 });
  });

  it('일반 요청은 상류 키를 붙여 그대로 넘기고 본문을 그대로 돌려준다', async () => {
    const upstream = await fakeUpstream((_call, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"choices":[{"message":{"content":"ok"}}]}');
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl, upstreamApiKey: 'sk-upstream' });
    cleanups.push(() => proxy.close(), () => upstream.close());

    const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: workBody });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"choices":[{"message":{"content":"ok"}}]}');
    expect(upstream.calls).toHaveLength(1);
    expect(upstream.calls[0]!.authorization).toBe('Bearer sk-upstream');
    expect(upstream.calls[0]!.body).toBe(workBody);
  });

  it('상류가 500이면 500과 본문을 그대로 돌려준다', async () => {
    const upstream = await fakeUpstream((_call, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"upstream boom"}}');
    });
    const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl, upstreamApiKey: 'sk-upstream' });
    cleanups.push(() => proxy.close(), () => upstream.close());

    const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: workBody });

    expect(response.status).toBe(500);
    expect(await response.text()).toContain('upstream boom');
    const stats = proxy.takeStats();
    expect(stats).toMatchObject({ forwardedCalls: 1, upstreamErrors: 1 });
    expect(stats.requestBytes).toBe(Buffer.byteLength(workBody));
    expect(stats.responseBytes).toBeGreaterThan(0);
  });

  it('takeStats는 값을 돌려주고 0으로 되돌린다', async () => {
    const upstream = await fakeUpstream((_call, response) => response.end('{}'));
    const proxy = await startProxy({ upstreamBaseUrl: upstream.baseUrl, upstreamApiKey: 'k' });
    cleanups.push(() => proxy.close(), () => upstream.close());

    await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: plannerBody });
    expect(proxy.takeStats().plannerCalls).toBe(1);
    expect(proxy.takeStats()).toEqual({ forwardedCalls: 0, requestBytes: 0, responseBytes: 0, plannerCalls: 0, upstreamErrors: 0 });
  });

  it('상류 연결이 실패하면 502를 돌려주고 키를 넣지 않는다', async () => {
    const proxy: ProxyHandle = await startProxy({ upstreamBaseUrl: 'http://127.0.0.1:1/v1', upstreamApiKey: 'sk-secret-value' });
    cleanups.push(() => proxy.close());

    const response = await fetch(`${proxy.baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: workBody });
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).not.toContain('sk-secret-value');
    expect(proxy.takeStats().upstreamErrors).toBe(1);
  });
});
