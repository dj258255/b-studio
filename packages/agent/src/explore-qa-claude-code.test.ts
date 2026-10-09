import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServerConfig, Options, SDKMessage, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeCodeQuery, ClaudeCodeSdk } from './claude-code-runner';
import { z } from 'zod';
import { zodShape } from './claude-code-runner';
import { runClaudeCodeExploreQa } from './explore-qa-claude-code';
import { buildQaTools, type QaActionRecord } from './explore-qa';

/**
 * 세션 백엔드가 claude-code일 때 b-studio 도구를 MCP로 받는 경로를 재사용하는지 확인한다(claude-code-runner.test.ts와 같은 가짜 SDK 기법).
 * 실제 모델 호출은 하지 않고, 가짜 SDK가 프롬프트를 받을 때마다 미리 적어 둔 도구 호출을 등록된 핸들러로 직접 실행한다.
 */

const PAGES: Record<string, string> = {
  '/tall': `<html><body style="margin:0"><div style="height:3000px">긴 화면</div></body></html>`,
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

/**
 * 사용자 메시지(프롬프트)를 받을 때마다 미리 적어 둔 도구 호출을 등록된 핸들러로 차례로 실행하는 가짜 SDK.
 * steps가 배열의 배열이면 i번째 프롬프트에 i번째 목록을 쓴다(마지막 보고 요청에 대한 답을 따로 적을 수 있다).
 * 실제 CLI처럼 도구 호출 뒤에 assistant 메시지가 오고 그 다음에야 result가 온다 — interrupt 뒤에도 result(사용량)를 읽는지 본다.
 */
function fakeClaudeCode(steps: Step[] | Step[][], options: { withResult?: boolean } = {}) {
  const turns: Step[][] = Array.isArray(steps[0]) || steps.length === 0 ? (steps as Step[][]) : [steps as Step[]];
  const state = { prompts: [] as string[], options: undefined as Options | undefined, closed: false, interrupted: 0, toolResults: [] as Array<{ tool: string; isError: boolean; text: string }> };
  let tools: Array<SdkMcpToolDefinition<any>> = [];

  const sdk: ClaudeCodeSdk = {
    createSdkMcpServer(config) {
      tools = config.tools ?? [];
      return { type: 'sdk', name: config.name, instance: {} } as unknown as McpServerConfig;
    },
    query({ prompt, options: queryOptions }) {
      state.options = queryOptions;
      async function* run(): AsyncGenerator<SDKMessage> {
        let turn = 0;
        for await (const user of prompt) {
          state.prompts.push(String(user.message.content));
          for (const step of turns[turn] ?? []) {
            const handler = tools.find((definition) => definition.name === step.tool);
            if (!handler) throw new Error(`등록되지 않은 도구: ${step.tool}`);
            const outcome = (await handler.handler(step.input, {})) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
            state.toolResults.push({ tool: step.tool, isError: Boolean(outcome.isError), text: outcome.content.map((block) => block.text ?? '').join('\n') });
          }
          turn += 1;
          yield { type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${turn}`, content: [{ type: 'text', text: `${turn}번째 차례의 글` }], usage: { input_tokens: 3, output_tokens: 2 } } } as unknown as SDKMessage;
          if (options.withResult === false) return;
          yield { type: 'result', subtype: 'success', is_error: false, result: '', modelUsage: { 'test-model': { inputTokens: 10 * turn, outputTokens: 5 * turn, cacheReadInputTokens: turn, cacheCreationInputTokens: 2 * turn } } } as unknown as SDKMessage;
        }
      }
      const query: ClaudeCodeQuery = Object.assign(run(), {
        accountInfo: async () => ({}),
        supportedModels: async () => [],
        interrupt: async () => {
          state.interrupted += 1;
        },
        close: () => {
          state.closed = true;
        },
      });
      return query;
    },
  };
  return { sdk, state };
}

const run = (sdk: ClaudeCodeSdk, goal: Parameters<typeof runClaudeCodeExploreQa>[0]['goal'], extra: Partial<Parameters<typeof runClaudeCodeExploreQa>[0]> = {}) =>
  runClaudeCodeExploreQa({ goal, startUrl: `${base}${goal.startPath}`, allowedOrigins: [base], cwd: process.cwd(), sdk, ...extra });

describe('runClaudeCodeExploreQa', { timeout: 30_000 }, () => {
  it('MCP로 노출한 qa_* 도구를 호출해 목표를 수행하고, 확인 문구가 있으면 통과시킨다', async () => {
    const { sdk, state } = fakeClaudeCode([
      { tool: 'qa_snapshot', input: {} },
      { tool: 'qa_fill', input: { ref: 'e1', text: '주문 목록' } },
      { tool: 'qa_click', input: { ref: 'e2' } },
      { tool: 'qa_wait', input: { forText: '주문 목록' } },
      { tool: 'qa_finish', input: { success: true, summary: '완료' } },
    ]);
    const actions: QaActionRecord[] = [];

    const result = await run(sdk, { goal: '검색어를 채운다', startPath: '/start', confirmText: '주문 목록' }, {
      onEvent: (event) => {
        if (event.type === 'action') actions.push(event.record);
      },
    });

    expect(result.status).toBe('pass');
    expect(result.stoppedBy).toBe('finish');
    expect(result.modelDeclared).toMatchObject({ success: true });
    expect(result.findings).toEqual([]);
    expect(actions.map((action) => action.tool)).toEqual(['qa_snapshot', 'qa_fill', 'qa_click', 'qa_wait']);
    expect(state.options?.mcpServers).toBeDefined();
    expect(state.options?.allowedTools?.some((name) => name.includes('qa_finish'))).toBe(true);
    expect(state.options?.allowedTools?.some((name) => name.includes('qa_report_issue'))).toBe(true);
    expect(state.closed).toBe(true);
  });

  it('usage를 결과에 싣는다: qa_finish로 interrupt한 뒤에도 result까지 읽어 modelUsage를 받는다', async () => {
    const { sdk } = fakeClaudeCode([{ tool: 'qa_snapshot', input: {} }, { tool: 'qa_finish', input: { success: true, summary: '완료' } }]);
    const result = await run(sdk, { goal: '관찰만 한다', startPath: '/start' });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 });
  });

  it('result가 오지 못해도 assistant 메시지의 사용량을 합쳐 싣는다', async () => {
    const { sdk } = fakeClaudeCode([{ tool: 'qa_finish', input: { success: true, summary: '완료' } }], { withResult: false });
    const result = await run(sdk, { goal: '관찰만 한다', startPath: '/start' });
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
  });

  it('모델이 보고한 blocker·major 발견을 싣고, 진단 신호가 깨끗해도 통과로 두지 않는다', async () => {
    const { sdk } = fakeClaudeCode([
      { tool: 'qa_screenshot', input: {} },
      { tool: 'qa_report_issue', input: { severity: 'major', summary: '로그인 줄이 잘렸습니다', where: '화면 아래' } },
      { tool: 'qa_finish', input: { success: true, summary: '점검 끝' } },
    ]);
    const findings: string[] = [];
    const result = await run(sdk, { goal: '화면을 점검한다', startPath: '/start' }, {
      onEvent: (event) => {
        if (event.type === 'finding') findings.push(event.finding.summary);
      },
    });
    expect(result.diagnostics.consoleErrors).toEqual([]);
    expect(result.findings).toEqual([{ severity: 'major', summary: '로그인 줄이 잘렸습니다', where: '화면 아래' }]);
    expect(findings).toEqual(['로그인 줄이 잘렸습니다']);
    expect(result.status).toBe('fail');
    expect(result.reason).toContain('잘렸습니다');
  });

  it('성공을 선언해도 진단 신호가 있으면 실패다(기존 동작 유지)', async () => {
    const { sdk } = fakeClaudeCode([{ tool: 'qa_finish', input: { success: true, summary: '문제 없습니다' } }]);
    PAGES['/broken'] = `<html><body><script>console.error('깨짐')</script></body></html>`;
    const result = await run(sdk, { goal: '점검', startPath: '/broken' });
    expect(result.modelDeclared?.success).toBe(true);
    expect(result.status).toBe('fail');
  });

  it('관찰 동작이 repeatLimit보다 많이 이어져도 같은 화면 반복으로 끊지 않는다', async () => {
    const steps: Step[] = [
      ...Array.from({ length: 6 }, () => ({ tool: 'qa_snapshot', input: {} })),
      { tool: 'qa_wait', input: { ms: 10 } },
      { tool: 'qa_screenshot', input: {} },
      { tool: 'qa_finish', input: { success: true, summary: '관찰만 했습니다' } },
    ];
    const { sdk } = fakeClaudeCode(steps);
    const result = await run(sdk, { goal: '점검', startPath: '/start', repeatLimit: 3 });
    expect(result.stoppedBy).toBe('finish');
    expect(result.actions).toHaveLength(8);
  });

  it('같은 화면에서 같은 조작을 되풀이하면 조작을 닫고 마지막 보고를 받는다', async () => {
    const { sdk, state } = fakeClaudeCode([
      { tool: 'qa_snapshot', input: {} },
      ...Array.from({ length: 3 }, () => ({ tool: 'qa_click', input: { ref: 'e2' } })),
      { tool: 'qa_click', input: { ref: 'e2' } },
      { tool: 'qa_report_issue', input: { severity: 'blocker', summary: '버튼을 눌러도 반응이 없습니다' } },
      { tool: 'qa_finish', input: { success: false, summary: '버튼이 동작하지 않습니다' } },
    ]);
    const result = await run(sdk, { goal: '버튼을 누른다', startPath: '/start', repeatLimit: 3 });
    expect(result.stoppedBy).toBe('repeated_screen');
    // 한도 뒤의 조작은 실행하지 않고 보고를 요청하는 오류로 돌려준다
    expect(result.actions).toHaveLength(4);
    const refused = state.toolResults.find((entry) => entry.tool === 'qa_click' && entry.isError);
    expect(refused?.text).toContain('마지막 보고');
    expect(result.findings).toHaveLength(1);
    expect(result.modelDeclared?.summary).toContain('동작하지 않습니다');
    expect(result.status).toBe('fail');
  });

  it('최대 행동 수에 걸린 뒤 보고가 없으면 같은 대화에서 한 번 더 묻고, 그래도 없으면 통과로 두지 않는다', async () => {
    const steps: Step[] = Array.from({ length: 5 }, () => ({ tool: 'qa_snapshot', input: {} }));
    const { sdk, state } = fakeClaudeCode([steps, []]);
    const result = await run(sdk, { goal: '관찰만 한다', startPath: '/start', maxActions: 3 });
    expect(result.stoppedBy).toBe('max_actions');
    expect(result.actions).toHaveLength(3);
    // 목표 프롬프트 뒤에 마지막 보고 요청이 한 번 더 들어갔다
    expect(state.prompts).toHaveLength(2);
    expect(state.prompts[1]).toContain('마지막 보고');
    expect(result.modelDeclared).toBeUndefined();
    expect(result.status).toBe('inconclusive');
    expect(result.reason).toContain('마치지 못했습니다');
  });

  it('한 번 더 물은 답으로 보고가 오면 싣는다', async () => {
    const { sdk } = fakeClaudeCode([
      [{ tool: 'qa_snapshot', input: {} }],
      [
        { tool: 'qa_report_issue', input: { severity: 'major', summary: '글자가 흐립니다' } },
        { tool: 'qa_finish', input: { success: true, summary: '보고' } },
      ],
    ]);
    const result = await run(sdk, { goal: '점검', startPath: '/start' });
    expect(result.stoppedBy).toBe('no_tool_call');
    expect(result.findings).toHaveLength(1);
    expect(result.status).toBe('fail');
  });
});

describe('탐색형 QA 도구의 MCP 스키마', () => {
  it('선택 인자(ref·direction·amount)는 생략할 수 있고, 필수 인자는 그대로 필수다', () => {
    const scroll = buildQaTools().find((entry) => entry.name === 'qa_scroll')!;
    const schema = z.object(zodShape(scroll.input_schema as { properties?: unknown; required?: unknown }, { honorRequired: true }));
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ direction: 'down' }).success).toBe(true);
    expect(z.object(zodShape(scroll.input_schema)).safeParse({ direction: 'down' }).success).toBe(false);

    const report = buildQaTools().find((entry) => entry.name === 'qa_report_issue')!;
    const reportSchema = z.object(zodShape(report.input_schema as { properties?: unknown; required?: unknown }, { honorRequired: true }));
    expect(reportSchema.safeParse({ severity: 'minor', summary: '여백' }).success).toBe(true);
    expect(reportSchema.safeParse({ severity: 'minor' }).success).toBe(false);
    expect(reportSchema.safeParse({ severity: 'critical', summary: 'x' }).success).toBe(false);
  });

  it('qa_scroll은 ref 없이 불러도 페이지를 스크롤한다', async () => {
    const { sdk, state } = fakeClaudeCode([
      { tool: 'qa_scroll', input: { direction: 'down', amount: 300 } },
      { tool: 'qa_scroll', input: { ref: '""', direction: 'down', amount: 300 } },
      { tool: 'qa_finish', input: { success: true, summary: '내렸습니다' } },
    ]);
    const result = await run(sdk, { goal: '아래까지 내려 본다', startPath: '/tall' });
    expect(result.actions.map((action) => action.ok)).toEqual([true, true]);
    expect(state.toolResults[1]?.text).toContain('y=600');
  });
});
