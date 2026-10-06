import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServerConfig, Options, SDKMessage, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeCodeQuery, ClaudeCodeSdk } from './claude-code-runner';
import { runClaudeCodeExploreQa } from './explore-qa-claude-code';
import type { QaActionRecord } from './explore-qa';

/**
 * 세션 백엔드가 claude-code일 때 b-studio 도구를 MCP로 받는 경로를 재사용하는지 확인한다(claude-code-runner.test.ts와 같은 가짜 SDK 기법).
 * 실제 모델 호출은 하지 않고, 가짜 SDK가 프롬프트를 받을 때마다 미리 적어 둔 도구 호출을 등록된 핸들러로 직접 실행한다.
 */

const PAGES: Record<string, string> = {
  '/start': `<html><body>
    <label for="q">검색어</label><input id="q">
    <button id="go" onclick="document.getElementById('out').textContent = document.getElementById('q').value">검색</button>
    <p id="out"></p>
  </body></html>`,
};

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    const body = PAGES[request.url ?? ''];
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

type Step = { tool: string; input: Record<string, unknown> };

/** 사용자 메시지(프롬프트 하나)를 받으면 미리 적어 둔 도구 호출을 등록된 핸들러로 차례로 실행하는 가짜 SDK */
function fakeClaudeCode(steps: Step[]) {
  const state = { prompt: '', options: undefined as Options | undefined, closed: false };
  let tools: Array<SdkMcpToolDefinition<any>> = [];

  const sdk: ClaudeCodeSdk = {
    createSdkMcpServer(config) {
      tools = config.tools ?? [];
      return { type: 'sdk', name: config.name, instance: {} } as unknown as McpServerConfig;
    },
    query({ prompt, options }) {
      state.options = options;
      async function* run(): AsyncGenerator<SDKMessage> {
        for await (const user of prompt) {
          state.prompt = String(user.message.content);
          for (const step of steps) {
            const handler = tools.find((definition) => definition.name === step.tool);
            if (!handler) throw new Error(`등록되지 않은 도구: ${step.tool}`);
            await handler.handler(step.input, {});
          }
          yield { type: 'result', subtype: 'success', is_error: false, result: '', modelUsage: { 'test-model': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 1, cacheCreationInputTokens: 2 } } } as unknown as SDKMessage;
        }
      }
      const query: ClaudeCodeQuery = Object.assign(run(), {
        accountInfo: async () => ({}),
        supportedModels: async () => [],
        interrupt: async () => {},
        close: () => {
          state.closed = true;
        },
      });
      return query;
    },
  };
  return { sdk, state };
}

describe('runClaudeCodeExploreQa', { timeout: 20_000 }, () => {
  it('MCP로 노출한 qa_* 도구를 호출해 목표를 수행하고, 확인 문구가 있으면 통과시킨다', async () => {
    const { sdk, state } = fakeClaudeCode([
      { tool: 'qa_snapshot', input: {} },
      { tool: 'qa_fill', input: { ref: 'e1', text: '주문 목록' } },
      { tool: 'qa_click', input: { ref: 'e2' } },
      { tool: 'qa_wait', input: { forText: '주문 목록' } },
      { tool: 'qa_finish', input: { success: true, summary: '완료' } },
    ]);
    const actions: QaActionRecord[] = [];

    const result = await runClaudeCodeExploreQa({
      goal: { goal: '검색어를 채운다', startPath: '/start', confirmText: '주문 목록' },
      startUrl: `${base}/start`,
      allowedOrigins: [base],
      cwd: process.cwd(),
      sdk,
      onEvent: (event) => {
        if (event.type === 'action') actions.push(event.record);
      },
    });

    expect(result.status).toBe('pass');
    expect(result.stoppedBy).toBe('finish');
    expect(result.modelDeclared).toMatchObject({ success: true });
    expect(actions.map((action) => action.tool)).toEqual(['qa_snapshot', 'qa_fill', 'qa_click', 'qa_wait']);
    expect(result.usage.inputTokens).toBe(10);
    expect(state.options?.mcpServers).toBeDefined();
    expect(state.options?.allowedTools?.some((name) => name.includes('qa_finish'))).toBe(true);
    expect(state.closed).toBe(true);
  });

  it('최대 행동 수에 도달하면 interrupt를 불러 멈춘다', async () => {
    const steps: Step[] = Array.from({ length: 5 }, () => ({ tool: 'qa_snapshot', input: {} }));
    const { sdk } = fakeClaudeCode(steps);
    const result = await runClaudeCodeExploreQa({
      goal: { goal: '관찰만 한다', startPath: '/start', maxActions: 3 },
      startUrl: `${base}/start`,
      allowedOrigins: [base],
      cwd: process.cwd(),
      sdk,
    });
    expect(result.stoppedBy).toBe('max_actions');
    // 4·5번째 호출은 stopping 가드에 막혀 행동으로 기록되지 않는다
    expect(result.actions).toHaveLength(3);
  });
});
