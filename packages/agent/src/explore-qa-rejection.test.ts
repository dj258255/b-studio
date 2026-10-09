import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServerConfig, SDKMessage, SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClaudeCodeQuery, ClaudeCodeSdk } from './claude-code-runner';
import { runClaudeCodeExploreQa } from './explore-qa-claude-code';
import { buildQaSystemPrompt, buildQaTools, judge, runExploreQa, type QaDiagnostics, type QaFinding } from './explore-qa';
import { ScriptedModelClient } from './scripted-client';

/**
 * 예상된 거절의 사전 선언(qa_expect_rejection)과 발견의 관찰 시점(observedAtAction) 테스트.
 * 가짜 모델·가짜 SDK와 로컬 테스트 서버만 쓴다. 버튼 순서가 곧 ref다(snapshot 한 번 → e1~e5).
 * e1 로그인(401) · e2 주문(400) · e3 서버 오류(500) · e4 정상(200) · e5 요청 없음(화면만 바뀜)
 */
const PAGE = `<html><body>
  <button onclick="hit('/api/login')">로그인</button>
  <button onclick="hit('/api/order')">주문</button>
  <button onclick="hit('/api/boom')">서버오류</button>
  <button onclick="hit('/api/ok')">정상</button>
  <button onclick="document.getElementById('msg').textContent='막힘'">입력확인</button>
  <p id="msg"></p>
  <script>function hit(path){ fetch(path,{method:'POST'}).then(function(r){ document.getElementById('msg').textContent = path + ' ' + r.status; }); }</script>
</body></html>`;
const STATUS: Record<string, number> = { '/api/login': 401, '/api/order': 400, '/api/boom': 500, '/api/ok': 200 };

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? '';
    if (path === '/page') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(PAGE);
      return;
    }
    const status = STATUS[path];
    response.writeHead(status ?? 404, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

type Call = { name: string; input: Record<string, unknown> };
const click = (ref: string): Call => ({ name: 'qa_click', input: { ref } });
const snapshot: Call = { name: 'qa_snapshot', input: {} };
const expectRejection = (reason: string): Call => ({ name: 'qa_expect_rejection', input: { reason } });
const finish: Call = { name: 'qa_finish', input: { success: true, summary: '점검 끝' } };

async function runApi(calls: Call[], goalText = '로그인 없이 주문을 눌러 본다') {
  const client = new ScriptedModelClient(calls.map((call) => ({ toolCalls: [call] })));
  const result = await runExploreQa({ client, goal: { goal: goalText, startPath: '/page' }, startUrl: `${base}/page`, allowedOrigins: [base] });
  return { result, client };
}

describe('qa_expect_rejection: 도구와 지시문', () => {
  it('도구 목록에 있고 시스템 지시문이 사용법을 알려 준다', () => {
    const tool = buildQaTools().find((entry) => entry.name === 'qa_expect_rejection');
    expect(tool).toBeDefined();
    expect(tool?.input_schema.required).toEqual(['reason']);
    expect(buildQaSystemPrompt()).toContain('qa_expect_rejection');
  });
});

describe('예상된 거절 (api 백엔드)', { timeout: 60_000 }, () => {
  it('선언한 조작의 4xx는 예상된 거절로 옮기고 진단 신호로 세지 않아 통과한다', async () => {
    const { result } = await runApi([snapshot, expectRejection('로그인 없이 주문하면 거절돼야 한다'), click('e2'), finish]);
    expect(result.diagnostics.failedRequests).toEqual([]);
    expect(result.expectedRejections).toHaveLength(1);
    expect(result.expectedRejections[0]).toMatchObject({ actionIndex: 2, tool: 'qa_click', reason: '로그인 없이 주문하면 거절돼야 한다' });
    expect(result.expectedRejections[0]?.requests).toEqual([{ status: 400, url: `${base}/api/order` }]);
    expect(result.unmetRejections).toEqual([]);
    expect(result.status).toBe('pass');
    expect(result.reason).toContain('예상된 거절 1건');
    // 선언은 행동 수에 들지 않는다
    expect(result.actions.map((action) => action.tool)).toEqual(['qa_snapshot', 'qa_click']);
    expect(result.actions[1]?.newDiagnosticsCount).toBe(0);
  });

  it('선언하지 않은 실패는 지금처럼 fail 사유다(회귀 없음)', async () => {
    const { result } = await runApi([snapshot, click('e2'), finish]);
    expect(result.status).toBe('fail');
    expect(result.reason).toContain('실패한 요청 1건');
    expect(result.expectedRejections).toEqual([]);
  });

  it('선언은 다음 조작 하나에만 적용된다: 그 뒤의 4xx는 진단 신호로 남는다', async () => {
    const { result } = await runApi([snapshot, expectRejection('주문 거절'), click('e2'), click('e1'), { name: 'qa_wait', input: { ms: 500 } }, finish]);
    expect(result.expectedRejections).toHaveLength(1);
    expect(result.diagnostics.failedRequests).toHaveLength(1);
    expect(result.diagnostics.failedRequests[0]).toContain('/api/login');
    expect(result.status).toBe('fail');
    expect(result.reason).toContain('실패한 요청 1건');
    expect(result.reason).toContain('예상된 거절 1건');
  });

  it('5xx는 선언해도 예상된 거절이 아니다', async () => {
    const { result } = await runApi([snapshot, expectRejection('거절될 것이다'), click('e3'), finish]);
    expect(result.expectedRejections).toEqual([]);
    expect(result.diagnostics.failedRequests.join()).toContain('500');
    expect(result.status).toBe('fail');
    expect(result.unmetRejections).toHaveLength(1);
  });

  it('같은 조작 안의 4xx만 옮기고 5xx는 남긴다', async () => {
    const page = `<html><body><button id="b">둘다</button><script>document.getElementById('b').onclick=function(){fetch('/api/order',{method:'POST'});fetch('/api/boom',{method:'POST'});}</script></body></html>`;
    const mixed = createServer((request, response) => {
      if (request.url === '/mixed') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(page);
        return;
      }
      response.writeHead(STATUS[request.url ?? ''] ?? 404);
      response.end('{}');
    });
    await new Promise<void>((resolve) => mixed.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(mixed.address() as AddressInfo).port}`;
    try {
      const client = new ScriptedModelClient([snapshot, expectRejection('주문은 거절'), click('e1'), finish].map((call) => ({ toolCalls: [call] })));
      const result = await runExploreQa({ client, goal: { goal: '눌러 본다', startPath: '/mixed' }, startUrl: `${origin}/mixed`, allowedOrigins: [origin] });
      expect(result.expectedRejections[0]?.requests).toEqual([{ status: 400, url: `${origin}/api/order` }]);
      expect(result.diagnostics.failedRequests).toHaveLength(1);
      expect(result.diagnostics.failedRequests[0]).toContain('500');
      expect(result.status).toBe('fail');
    } finally {
      await new Promise<void>((resolve) => mixed.close(() => resolve()));
    }
  });

  it('관찰 동작은 선언을 소모하지 않는다', async () => {
    const { result } = await runApi([
      snapshot,
      expectRejection('로그인 없이 주문'),
      { name: 'qa_screenshot', input: {} },
      { name: 'qa_scroll', input: { direction: 'down' } },
      { name: 'qa_find', input: { query: '주문' } },
      { name: 'qa_wait', input: { ms: 50 } },
      click('e2'),
      finish,
    ]);
    expect(result.expectedRejections).toHaveLength(1);
    expect(result.expectedRejections[0]?.actionIndex).toBe(6);
    expect(result.status).toBe('pass');
  });

  it('이전에 선언 없이 같은 요청이 실패한 적이 있어도, 선언한 조작의 거절은 예상된 거절로 센다', async () => {
    const { result } = await runApi([snapshot, click('e2'), { name: 'qa_wait', input: { ms: 500 } }, expectRejection('다시 눌러도 거절'), click('e2'), finish]);
    expect(result.expectedRejections).toHaveLength(1);
    expect(result.expectedRejections[0]?.actionIndex).toBe(4);
    // 앞의 선언 없는 실패 1건은 그대로 남는다
    expect(result.diagnostics.failedRequests).toHaveLength(1);
    expect(result.status).toBe('fail');
  });

  it('선언했는데 거절 응답이 없으면 별도 목록에 남기고 모델에게 바로 알리되, 자동으로 fail 처리하지 않는다', async () => {
    const { result, client } = await runApi([snapshot, expectRejection('빈 값 제출은 막혀야 한다'), click('e4'), finish]);
    expect(result.status).toBe('pass');
    expect(result.expectedRejections).toEqual([]);
    expect(result.unmetRejections).toHaveLength(1);
    expect(result.unmetRejections[0]).toMatchObject({ actionIndex: 2, tool: 'qa_click', reason: '빈 값 제출은 막혀야 한다', requests: [] });
    expect(result.reason).toContain('거절 응답이 없던 조작 1건');
    // 모델이 받은 다음 요청(tool_result)에 그 사실이 들어 있다
    expect(JSON.stringify(client.requests.at(-1)!.messages)).toContain('거절될 것으로 선언한 조작에서 거절 응답이 없었습니다');
  });

  it('요청 없이 화면만 바뀌는 조작(클라이언트 검증)도 거절 없음으로 남는다', async () => {
    const { result } = await runApi([snapshot, expectRejection('빈 값은 막힌다'), click('e5'), finish]);
    expect(result.unmetRejections).toHaveLength(1);
    expect(result.status).toBe('pass');
  });

  it('조작이 실패하면 선언은 유지되어 다음 조작에 적용된다', async () => {
    const { result } = await runApi([snapshot, expectRejection('주문 거절'), click('e99'), click('e2'), finish]);
    expect(result.expectedRejections).toHaveLength(1);
    expect(result.expectedRejections[0]?.actionIndex).toBe(3);
  });

  it('조작 없이 끝난 선언은 거절 없음으로 남는다', async () => {
    const { result } = await runApi([snapshot, expectRejection('주문 거절'), finish]);
    expect(result.unmetRejections).toHaveLength(1);
    expect(result.unmetRejections[0]?.actionIndex).toBeUndefined();
  });

  it('reason이 비면 오류로 돌려준다', async () => {
    const { client } = await runApi([{ name: 'qa_expect_rejection', input: { reason: '  ' } }, finish]);
    expect(JSON.stringify(client.requests.at(-1)!.messages)).toContain('reason(왜 거절되는 것이 정상인지)');
  });
});

describe('발견의 관찰 시점', { timeout: 60_000 }, () => {
  it('qa_report_issue가 불릴 때 가장 최근 캡처·스냅샷이 몇 번째 동작이었는지 붙인다. 모델이 적은 evidence는 그대로 둔다', async () => {
    const found: QaFinding[] = [];
    const calls: Call[] = [
      { name: 'qa_report_issue', input: { severity: 'minor', summary: '아직 아무것도 못 봤는데 보고' } },
      snapshot,
      { name: 'qa_screenshot', input: {} },
      click('e5'),
      { name: 'qa_report_issue', input: { severity: 'major', summary: '버튼이 잘림', evidence: '두 번째 캡처 하단' } },
      finish,
    ];
    const client = new ScriptedModelClient(calls.map((call) => ({ toolCalls: [call] })));
    const result = await runExploreQa({
      client,
      goal: { goal: '화면을 점검한다', startPath: '/page' },
      startUrl: `${base}/page`,
      allowedOrigins: [base],
      onEvent: (event) => {
        if (event.type === 'finding') found.push(event.finding);
      },
    });
    expect(result.findings[0]?.observedAtAction).toBeUndefined();
    expect(result.findings[1]).toMatchObject({ evidence: '두 번째 캡처 하단', observedAtAction: 2 });
    expect(found[1]?.observedAtAction).toBe(2);
  });
});

describe('judge: 예상된 거절 건수', () => {
  const clean: QaDiagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 0, accessibilityViolations: [] };
  const declared = { success: true, summary: '끝' };

  it('통과 사유에 건수를 적는다', () => {
    const verdict = judge({}, clean, '', { findings: [], declared, stoppedBy: 'finish', expectedRejections: 1, unmetRejections: 0 });
    expect(verdict.status).toBe('pass');
    expect(verdict.reason).toContain('예상된 거절 1건은 목록 참고');
  });

  it('실패 사유에도 건수를 적고, 거절 없음은 판정을 바꾸지 않는다', () => {
    const failing = judge({}, { ...clean, failedRequests: ['500 http://x/api'] }, '', { findings: [], declared, stoppedBy: 'finish', expectedRejections: 2, unmetRejections: 1 });
    expect(failing.status).toBe('fail');
    expect(failing.reason).toContain('예상된 거절 2건은 목록 참고');
    expect(failing.reason).toContain('거절 응답이 없던 조작 1건');
    const passing = judge({}, clean, '', { findings: [], declared, stoppedBy: 'finish', expectedRejections: 0, unmetRejections: 1 });
    expect(passing.status).toBe('pass');
  });
});

// ───────────── 로컬 CLI 백엔드 ─────────────

type Step = { tool: string; input: Record<string, unknown> };

function fakeSdk(steps: Step[]) {
  let tools: Array<SdkMcpToolDefinition<any>> = [];
  const texts: string[] = [];
  const sdk: ClaudeCodeSdk = {
    createSdkMcpServer(config) {
      tools = config.tools ?? [];
      return { type: 'sdk', name: config.name, instance: {} } as unknown as McpServerConfig;
    },
    query({ prompt }) {
      async function* run(): AsyncGenerator<SDKMessage> {
        for await (const _user of prompt) {
          for (const step of steps) {
            const handler = tools.find((definition) => definition.name === step.tool);
            if (!handler) throw new Error(`등록되지 않은 도구: ${step.tool}`);
            const outcome = (await handler.handler(step.input, {})) as { content: Array<{ text?: string }> };
            texts.push(outcome.content.map((block) => block.text ?? '').join('\n'));
          }
          yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [], usage: { input_tokens: 1, output_tokens: 1 } } } as unknown as SDKMessage;
          yield { type: 'result', subtype: 'success', is_error: false, result: '', modelUsage: {} } as unknown as SDKMessage;
        }
      }
      return Object.assign(run(), { accountInfo: async () => ({}), supportedModels: async () => [], interrupt: async () => {}, close: () => {} }) as unknown as ClaudeCodeQuery;
    },
  };
  return { sdk, texts };
}

describe('예상된 거절 (로컬 CLI 백엔드)', { timeout: 60_000 }, () => {
  it('api 백엔드와 같은 규칙을 쓴다: 선언한 조작의 4xx는 목록으로 옮긴다', async () => {
    const { sdk } = fakeSdk([
      { tool: 'qa_snapshot', input: {} },
      { tool: 'qa_expect_rejection', input: { reason: '로그인 없이 주문' } },
      { tool: 'qa_click', input: { ref: 'e2' } },
      { tool: 'qa_report_issue', input: { severity: 'minor', summary: '여백' } },
      { tool: 'qa_finish', input: { success: true, summary: '끝' } },
    ]);
    const result = await runClaudeCodeExploreQa({ goal: { goal: '눌러 본다', startPath: '/page' }, startUrl: `${base}/page`, allowedOrigins: [base], cwd: process.cwd(), sdk });
    expect(result.status).toBe('pass');
    expect(result.expectedRejections[0]).toMatchObject({ actionIndex: 2, reason: '로그인 없이 주문', requests: [{ status: 400, url: `${base}/api/order` }] });
    expect(result.reason).toContain('예상된 거절 1건');
    expect(result.findings[0]?.observedAtAction).toBe(1);
  });

  it('선언하지 않은 실패는 fail 사유로 남고, 거절이 없으면 도구 결과로 바로 알린다', async () => {
    const { sdk, texts } = fakeSdk([
      { tool: 'qa_snapshot', input: {} },
      { tool: 'qa_click', input: { ref: 'e1' } },
      { tool: 'qa_wait', input: { ms: 500 } },
      { tool: 'qa_expect_rejection', input: { reason: '막혀야 한다' } },
      { tool: 'qa_click', input: { ref: 'e4' } },
      { tool: 'qa_finish', input: { success: true, summary: '끝' } },
    ]);
    const result = await runClaudeCodeExploreQa({ goal: { goal: '눌러 본다', startPath: '/page' }, startUrl: `${base}/page`, allowedOrigins: [base], cwd: process.cwd(), sdk });
    expect(result.unmetRejections).toHaveLength(1);
    expect(texts.join('\n')).toContain('거절될 것으로 선언한 조작에서 거절 응답이 없었습니다');
    expect(result.status).toBe('fail');
    expect(result.reason).toContain('실패한 요청 1건');
  });
});
