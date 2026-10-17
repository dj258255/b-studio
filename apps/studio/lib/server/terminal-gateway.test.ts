import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSessionGateway, ensureSessionGateway, startTerminalGateway, terminalHookRoutes, type TerminalGateway, type TerminalGatewayHandlers } from './terminal-gateway';

const opened: TerminalGateway[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const gateway of opened.splice(0)) await gateway.close();
});

function handlers(overrides: Partial<TerminalGatewayHandlers> = {}): TerminalGatewayHandlers {
  return {
    note: async () => undefined,
    prompt: async () => ({}),
    preTool: async () => ({}),
    stop: async () => ({}),
    sessionEnd: async () => {},
    toolSpecs: () => [{ name: 'run_in_service', description: '서비스에서 명령 실행', input_schema: { type: 'object', properties: { service: { type: 'string', description: '서비스' } }, required: ['service'] } }] as never,
    runTool: async (name, args) => ({ ok: true, content: `${name} ${JSON.stringify(args)}` }),
    ...overrides,
  };
}

/** 컨테이너가 부르는 것처럼 Host를 host.docker.internal로 싣는다(fetch는 Host를 못 바꾼다) */
function post(url: string, token: string, body: unknown, host?: string): Promise<{ status: number; body: unknown }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port: target.port, path: target.pathname, method: 'POST', headers: { host: host ?? target.host, 'content-type': 'application/json', authorization: `Bearer ${token}` } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

describe('관문의 훅 답 (CLI의 규약으로 옮긴다, 이슈 #673)', () => {
  it('요청을 막을 때만 막는 꼴을 낸다. 알릴 것이 있으면 그 요청의 맥락에 덧붙인다', async () => {
    expect(await terminalHookRoutes(handlers())['/prompt']({ prompt: '고쳐줘' })).toEqual({});
    expect(await terminalHookRoutes(handlers({ prompt: async () => ({ note: '앞 요청의 변경을 되돌렸습니다' }) }))['/prompt']({})).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '앞 요청의 변경을 되돌렸습니다' },
    });
    // 막는 요청에는 덧붙이지 않는다(에이전트에게 가지 않는 요청이다)
    expect(await terminalHookRoutes(handlers({ prompt: async () => ({ blocked: '실행 중', note: '알림' }) }))['/prompt']({})).toEqual({ decision: 'block', reason: '실행 중' });
    expect(await terminalHookRoutes(handlers({ prompt: async () => ({ blocked: '대화 창의 요청이 실행 중입니다' }) }))['/prompt']({})).toEqual({ decision: 'block', reason: '대화 창의 요청이 실행 중입니다' });
  });

  it('턴의 끝: 검증 결과가 있으면 멈추지 못하게 하고 그 글을 돌려준다. 통과하면 사용자에게만 한 줄 알린다', async () => {
    expect(await terminalHookRoutes(handlers({ stop: async () => ({ feedback: '테스트 실패' }) }))['/stop']({})).toEqual({ decision: 'block', reason: '테스트 실패' });
    expect(await terminalHookRoutes(handlers({ stop: async () => ({ message: '검증 통과 — 체크포인트 abc1234' }) }))['/stop']({})).toEqual({ systemMessage: '검증 통과 — 체크포인트 abc1234' });
    expect(await terminalHookRoutes(handlers())['/stop']({})).toEqual({});
    // 둘 다 오면 막는 쪽이다. 실패한 검증을 "알림"으로 흘려보내지 않는다
    expect(await terminalHookRoutes(handlers({ stop: async () => ({ feedback: '실패', message: '통과' }) }))['/stop']({})).toEqual({ decision: 'block', reason: '실패' });
  });

  it('쓰기 직전: 거절은 CLI의 거절 꼴로, 알림은 막지 않는 한 줄로', async () => {
    expect(await terminalHookRoutes(handlers({ preTool: async () => ({ deny: '요청을 닫았습니다' }) }))['/pre-tool']({})).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '요청을 닫았습니다' },
    });
    expect(await terminalHookRoutes(handlers({ preTool: async () => ({ message: '기준 없이 진행합니다' }) }))['/pre-tool']({})).toEqual({ systemMessage: '기준 없이 진행합니다' });
    expect(await terminalHookRoutes(handlers())['/pre-tool']({})).toEqual({});
  });

  it('닿는지 묻는 요청에는 빈 답을 준다(처리를 부르지 않는다)', async () => {
    expect(await terminalHookRoutes(handlers())['/ping']({})).toEqual({});
  });

  it('대화의 시작: 안내 글이 있으면 맥락에 덧붙인다', async () => {
    expect(await terminalHookRoutes(handlers({ note: async () => '# b-studio\n안내' }))['/session-start']({})).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '# b-studio\n안내' } });
    expect(await terminalHookRoutes(handlers())['/session-start']({})).toEqual({});
  });
});

describe('관문 서버', () => {
  it('컨테이너가 부르는 이름으로 온 요청을 받는다. 주소는 컨테이너에서 호스트를 부르는 이름으로 내준다', async () => {
    // 기본 방식이 이 컴퓨터(host)로 바뀌어(ADR-173 덧붙임), 컨테이너 방식은 환경 변수로 명시한다
    vi.stubEnv('B_STUDIO_TERMINAL', 'container');
    const seen: unknown[] = [];
    const gateway = await startTerminalGateway(
      handlers({
        prompt: async (input) => {
          seen.push(input);
          return {};
        },
      }),
    );
    opened.push(gateway);
    expect(Object.keys(gateway.address).sort()).toEqual(['hookToken', 'hookUrl', 'mcpToken', 'mcpUrl']);
    expect(gateway.address.hookUrl).toMatch(/^http:\/\/host\.docker\.internal:\d+$/);
    expect(gateway.address.mcpUrl).toMatch(/^http:\/\/host\.docker\.internal:\d+\/mcp$/);
    // 두 서버의 토큰은 다르다
    expect(gateway.address.hookToken).not.toBe(gateway.address.mcpToken);

    const url = `${gateway.address.hookUrl}/prompt`;
    const host = new URL(url).host;
    expect(await post(url, gateway.address.hookToken!, { prompt: '고쳐줘' }, host)).toEqual({ status: 200, body: {} });
    expect(seen).toEqual([{ prompt: '고쳐줘' }]);
    // 다른 이름으로 부르면(브라우저가 이 포트를 다른 사이트의 이름으로 부르게 만든 경우) 받지 않는다
    expect((await post(url, gateway.address.hookToken!, {}, 'evil.example.com')).status).toBe(403);
    // 도구 서버의 토큰으로는 훅을 부를 수 없다
    expect((await post(url, gateway.address.mcpToken!, {}, host)).status).toBe(401);
    expect(seen).toHaveLength(1);
  });

  it('이 컴퓨터 방식이면 루프백 호스트로 열고, host.docker.internal로 온 요청은 받지 않는다', async () => {
    const gateway = await startTerminalGateway(handlers(), '127.0.0.1');
    opened.push(gateway);
    expect(gateway.address.hookUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(gateway.address.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

    const url = `${gateway.address.hookUrl}/prompt`;
    const port = new URL(url).port;
    // 루프백 이름(127.0.0.1)으로 온 요청은 받는다
    expect((await post(url, gateway.address.hookToken!, { prompt: '고쳐줘' }, `127.0.0.1:${port}`)).status).toBe(200);
    // 컨테이너 방식의 이름으로 온 요청은 받지 않는다(허용 목록에 넣지 않았다)
    expect((await post(url, gateway.address.hookToken!, {}, `host.docker.internal:${port}`)).status).toBe(403);
  });

  it('b-studio 도구를 MCP로 내주고 호출을 처리에 넘긴다', async () => {
    const gateway = await startTerminalGateway(handlers());
    opened.push(gateway);
    // MCP의 요청 하나(JSON-RPC)를 컨테이너가 부르는 이름으로 보낸다. 답은 JSON이거나 이벤트 한 줄이다
    const call = async (method: string, params: unknown, token = gateway.address.mcpToken!): Promise<{ status: number; result?: { tools?: Array<{ name: string }>; content?: unknown } }> => {
      const url = new URL(gateway.address.mcpUrl!);
      return new Promise((resolve, reject) => {
        const request = httpRequest(
          { host: '127.0.0.1', port: url.port, path: url.pathname, method: 'POST', headers: { host: url.host, 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` } },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              const data = text.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? text;
              resolve({ status: response.statusCode ?? 0, result: (JSON.parse(data || '{}') as { result?: never }).result });
            });
          },
        );
        request.on('error', reject);
        request.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
      });
    };
    const listed = await call('tools/list', {});
    expect(listed.status).toBe(200);
    expect(listed.result?.tools?.map((tool) => tool.name)).toEqual(['run_in_service']);
    const called = await call('tools/call', { name: 'run_in_service', arguments: { service: 'api' } });
    expect(called.result?.content).toEqual([{ type: 'text', text: 'run_in_service {"service":"api"}' }]);
    // 훅 서버의 토큰으로는 도구를 부를 수 없다
    expect((await call('tools/list', {}, gateway.address.hookToken!)).status).toBe(401);
  });

  it('처리가 던지면 5xx로 답한다. 훅 스크립트는 이것을 막는 답으로 읽지 않는다', async () => {
    const gateway = await startTerminalGateway(
      handlers({
        stop: async () => {
          throw new Error('멈춘 세션입니다');
        },
      }),
    );
    opened.push(gateway);
    const url = `${gateway.address.hookUrl}/stop`;
    expect(await post(url, gateway.address.hookToken!, {}, new URL(url).host)).toEqual({ status: 500, body: { error: '멈춘 세션입니다' } });
  });
});

describe('세션의 관문', () => {
  it('세션마다 하나만 띄운다. 동시에 불려도, 터미널을 다시 열어도 같은 것을 쓴다', async () => {
    let started = 0;
    const start = async (given: TerminalGatewayHandlers): Promise<TerminalGateway> => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const gateway = await startTerminalGateway(given);
      opened.push(gateway);
      return gateway;
    };
    const [first, second] = await Promise.all([ensureSessionGateway('s-one', handlers, start), ensureSessionGateway('s-one', handlers, start)]);
    expect(first).toBe(second);
    expect(await ensureSessionGateway('s-one', handlers, start)).toBe(first);
    expect(started).toBe(1);
    // 다른 세션은 다른 관문이다(다른 포트, 다른 토큰)
    const other = await ensureSessionGateway('s-two', handlers, start);
    expect(other.hookToken).not.toBe(first.hookToken);
    expect(started).toBe(2);
    await closeSessionGateway('s-one');
    await closeSessionGateway('s-two');
  });

  it('닫으면 그 주소로는 더 닿지 않고, 다시 열면 새 토큰을 쓴다', async () => {
    const env = await ensureSessionGateway('s-close', handlers);
    const url = `${env.hookUrl}/prompt`;
    expect((await post(url, env.hookToken!, {}, new URL(url).host)).status).toBe(200);
    await closeSessionGateway('s-close');
    await expect(post(url, env.hookToken!, {}, new URL(url).host)).rejects.toThrow();
    const again = await ensureSessionGateway('s-close', handlers);
    expect(again.hookToken).not.toBe(env.hookToken);
    await closeSessionGateway('s-close');
  });

  it('띄우지 못하면 자리를 비워 다음에 다시 해 본다', async () => {
    let attempts = 0;
    const failing = async (): Promise<TerminalGateway> => {
      attempts += 1;
      throw new Error('포트를 열지 못했습니다');
    };
    await expect(ensureSessionGateway('s-fail', handlers, failing)).rejects.toThrow('포트를 열지 못했습니다');
    await expect(ensureSessionGateway('s-fail', handlers, failing)).rejects.toThrow('포트를 열지 못했습니다');
    expect(attempts).toBe(2);
  });
});
