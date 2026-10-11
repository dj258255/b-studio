import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startHookServer, type HookInput, type HookServer } from './hook-server';

const opened: HookServer[] = [];

afterEach(async () => {
  for (const server of opened.splice(0)) await server.close();
});

async function start(options: Parameters<typeof startHookServer>[1] = {}) {
  const seen: Array<{ route: string; input: HookInput }> = [];
  const server = await startHookServer(
    {
      '/stop': async (input) => {
        seen.push({ route: '/stop', input });
        return { decision: 'block', reason: '검증 실패' };
      },
      '/boom': async () => {
        throw new Error('안에서 실패');
      },
    },
    options,
  );
  opened.push(server);
  return { server, seen };
}

/** fetch가 금지하는 Host 헤더까지 실어 보내려고 raw 요청을 쓴다 */
function post(server: HookServer, route: string, { host, authorization, body = '{}', method = 'POST' }: { host?: string; authorization?: string; body?: string; method?: string } = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port: server.port, path: route, method, headers: { host: host ?? `127.0.0.1:${server.port}`, 'content-type': 'application/json', ...(authorization === undefined ? { authorization: `Bearer ${server.token}` } : authorization ? { authorization } : {}) } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
      },
    );
    request.on('error', reject);
    // 본문이 있는 GET은 서버가 연결을 끊는다. 본문은 POST에만 싣는다
    request.end(method === 'POST' ? body : undefined);
  });
}

describe('훅 서버 (이슈 #670·#673)', () => {
  it('훅의 입력을 처리에 넘기고 그 답을 그대로 돌려준다', async () => {
    const { server, seen } = await start();
    const response = await post(server, '/stop', { body: JSON.stringify({ last_assistant_message: '끝났습니다', stop_hook_active: false }) });
    expect(response).toEqual({ status: 200, body: { decision: 'block', reason: '검증 실패' } });
    expect(seen).toEqual([{ route: '/stop', input: { last_assistant_message: '끝났습니다', stop_hook_active: false } }]);
  });

  it('토큰이 없거나 다르면 처리를 부르지 않는다', async () => {
    const { server, seen } = await start();
    expect((await post(server, '/stop', { authorization: '' })).status).toBe(401);
    expect((await post(server, '/stop', { authorization: 'Bearer nope' })).status).toBe(401);
    expect((await post(server, '/stop', { authorization: `Bearer ${'a'.repeat(server.token.length)}` })).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('루프백이 아닌 Host는 거부한다. 컨테이너가 호스트를 부르는 이름은 따로 허용했을 때만 받는다', async () => {
    const plain = await start();
    expect((await post(plain.server, '/stop', { host: 'evil.com' })).status).toBe(403);
    expect((await post(plain.server, '/stop', { host: 'host.docker.internal:80' })).status).toBe(403);
    expect((await post(plain.server, '/stop', { host: `localhost:${plain.server.port}` })).status).toBe(200);
    expect((await post(plain.server, '/stop', { host: `[::1]:${plain.server.port}` })).status).toBe(200);

    const container = await start({ allowedHosts: ['host.docker.internal'] });
    expect((await post(container.server, '/stop', { host: `host.docker.internal:${container.server.port}` })).status).toBe(200);
    expect((await post(container.server, '/stop', { host: 'host.docker.internal.evil.com' })).status).toBe(403);
    expect((await post(container.server, '/stop', { host: 'evil.com' })).status).toBe(403);
    // 이름을 허용해도 토큰은 그대로 본다
    expect((await post(container.server, '/stop', { host: `host.docker.internal:${container.server.port}`, authorization: 'Bearer nope' })).status).toBe(401);
    expect(container.seen).toHaveLength(1);
  });

  it('모르는 경로와 POST가 아닌 요청은 받지 않는다', async () => {
    const { server, seen } = await start();
    expect((await post(server, '/pre-tool')).status).toBe(404);
    expect((await post(server, '/stop', { method: 'GET' })).status).toBe(404);
    // 객체에 원래 있는 이름(생성자 등)을 경로로 불러도 처리가 아니다
    expect((await post(server, '/constructor')).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it('읽지 못한 입력은 빈 입력으로 넘긴다(검증은 입력 없이도 돈다). 객체가 아닌 JSON도 같다', async () => {
    const { server, seen } = await start();
    expect((await post(server, '/stop', { body: '{깨진 json' })).status).toBe(200);
    expect((await post(server, '/stop', { body: '[1,2]' })).status).toBe(200);
    expect((await post(server, '/stop', { body: '"글자"' })).status).toBe(200);
    expect(seen.map((entry) => entry.input)).toEqual([{}, {}, {}]);
  });

  it('처리가 실패하면 5xx로 답한다(성공한 답으로 보이지 않는다)', async () => {
    const { server } = await start();
    expect(await post(server, '/boom')).toEqual({ status: 500, body: { error: '안에서 실패' } });
  });

  it('너무 큰 입력은 받지 않는다', async () => {
    const { server, seen } = await start();
    expect((await post(server, '/stop', { body: JSON.stringify({ text: 'x'.repeat(4 * 1024 * 1024 + 10) }) })).status).toBe(413);
    expect(seen).toEqual([]);
  });

  it('close() 뒤에는 닿지 않는다', async () => {
    const { server } = await start();
    await server.close();
    await expect(post(server, '/stop')).rejects.toThrow();
  });
});
