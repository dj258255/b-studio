import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodShape } from './claude-code-runner';
import { fakeClaudeCli, type FakeCliLog } from './fake-claude-cli';
import { runClaudeCodeExploreQa } from './explore-qa-claude-code';
import { buildQaTools, type QaActionRecord } from './explore-qa';

/**
 * 세션 백엔드가 claude-code일 때 b-studio 도구를 MCP로 받는 경로를 재사용하는지 확인한다(claude-code-runner.test.ts와 같은 가짜 CLI 기법).
 * 실제 모델 호출은 하지 않고, 가짜 CLI가 사용자 메시지를 받을 때마다 미리 적어 둔 도구 호출을 --mcp-config의 HTTP MCP 서버에 실제로 보낸다.
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
 * 사용자 메시지(프롬프트)를 받을 때마다 미리 적어 둔 도구 호출을 가짜 CLI가 MCP 서버로 차례로 보낸다.
 * steps가 배열의 배열이면 i번째 프롬프트에 i번째 목록을 쓴다(마지막 보고 요청에 대한 답을 따로 적을 수 있다).
 * 실제 CLI처럼 도구 호출 뒤에 result가 온다 — qa_finish 뒤에도 result(사용량)를 읽는지 본다.
 * result의 modelUsage는 프로세스 누적값이라 차례마다 10·5·1·2씩 늘려 준다.
 */
function fakeClaudeCode(steps: Step[] | Step[][], options: { withResult?: boolean } = {}) {
  const turns: Step[][] = Array.isArray(steps[0]) || steps.length === 0 ? (steps as Step[][]) : [steps as Step[]];
  const fake = fakeClaudeCli({
    // result가 오지 못하는 경우의 사용량은 assistant 메시지에서 읽는다(마지막 도구 호출 메시지에 싣는다)
    turns: turns.map((list, turn) => list.map((step, index) => ({ tool: step.tool, input: step.input, ...(options.withResult === false && turn === turns.length - 1 && index === list.length - 1 ? { usage: { input_tokens: 3, output_tokens: 2 } } : {}) }))),
    modelUsages: Array.from({ length: Math.max(turns.length, 1) }, (_, index) => ({ 'test-model': { inputTokens: 10 * (index + 1), outputTokens: 5 * (index + 1), cacheReadInputTokens: index + 1, cacheCreationInputTokens: 2 * (index + 1) } })),
    ...(options.withResult === false ? { noResult: true } : {}),
  });
  const log = (): FakeCliLog => fake.logs()[0]!;
  return {
    cli: { ...fake.cli, stop: { termAfterMs: 50, killAfterMs: 500 } },
    fake,
    log,
    prompts: () => fake.prompts(),
    allowedTools: () => (fake.argOf(log(), '--allowedTools') ?? '').split(','),
    toolResults: () => log().tools.map((entry) => ({ tool: entry.name, isError: Boolean(entry.isError), text: entry.text })),
  };
}

type Fake = ReturnType<typeof fakeClaudeCode>;

const run = (fake: Fake, goal: Parameters<typeof runClaudeCodeExploreQa>[0]['goal'], extra: Partial<Parameters<typeof runClaudeCodeExploreQa>[0]> = {}) =>
  runClaudeCodeExploreQa({ goal, startUrl: `${base}${goal.startPath}`, allowedOrigins: [base], cwd: process.cwd(), ...fake.cli, ...extra });

describe('runClaudeCodeExploreQa', { timeout: 30_000 }, () => {
  it('MCP로 노출한 qa_* 도구를 호출해 목표를 수행하고, 확인 문구가 있으면 통과시킨다', async () => {
    const fake = fakeClaudeCode([
      { tool: 'qa_snapshot', input: {} },
      { tool: 'qa_fill', input: { ref: 'e1', text: '주문 목록' } },
      { tool: 'qa_click', input: { ref: 'e2' } },
      { tool: 'qa_wait', input: { forText: '주문 목록' } },
      { tool: 'qa_finish', input: { success: true, summary: '완료' } },
    ]);
    const actions: QaActionRecord[] = [];

    const result = await run(fake, { goal: '검색어를 채운다', startPath: '/start', confirmText: '주문 목록' }, {
      onEvent: (event) => {
        if (event.type === 'action') actions.push(event.record);
      },
    });

    expect(result.status).toBe('pass');
    expect(result.stoppedBy).toBe('finish');
    expect(result.modelDeclared).toMatchObject({ success: true });
    expect(result.findings).toEqual([]);
    expect(actions.map((action) => action.tool)).toEqual(['qa_snapshot', 'qa_fill', 'qa_click', 'qa_wait']);
    expect(fake.log().args).toContain('--mcp-config');
    expect(fake.allowedTools()).toContain('mcp__b-studio-qa__qa_finish');
    expect(fake.allowedTools()).toContain('mcp__b-studio-qa__qa_report_issue');
    expect(fake.log().stdinClosed).toBe(true);
  });

  it('usage를 결과에 싣는다: qa_finish로 interrupt한 뒤에도 result까지 읽어 modelUsage를 받는다', async () => {
    const fake = fakeClaudeCode([{ tool: 'qa_snapshot', input: {} }, { tool: 'qa_finish', input: { success: true, summary: '완료' } }]);
    const result = await run(fake, { goal: '관찰만 한다', startPath: '/start' });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 });
  });

  it('result가 오지 못해도 assistant 메시지의 사용량을 합쳐 싣는다', async () => {
    const fake = fakeClaudeCode([{ tool: 'qa_finish', input: { success: true, summary: '완료' } }], { withResult: false });
    const result = await run(fake, { goal: '관찰만 한다', startPath: '/start' });
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
  });

  it('모델이 보고한 blocker·major 발견을 싣고, 진단 신호가 깨끗해도 통과로 두지 않는다', async () => {
    const fake = fakeClaudeCode([
      { tool: 'qa_screenshot', input: {} },
      { tool: 'qa_report_issue', input: { severity: 'major', summary: '로그인 줄이 잘렸습니다', where: '화면 아래' } },
      { tool: 'qa_finish', input: { success: true, summary: '점검 끝' } },
    ]);
    const findings: string[] = [];
    const result = await run(fake, { goal: '화면을 점검한다', startPath: '/start' }, {
      onEvent: (event) => {
        if (event.type === 'finding') findings.push(event.finding.summary);
      },
    });
    expect(result.diagnostics.consoleErrors).toEqual([]);
    expect(result.findings).toEqual([{ severity: 'major', summary: '로그인 줄이 잘렸습니다', where: '화면 아래', observedAtAction: 1 }]);
    expect(findings).toEqual(['로그인 줄이 잘렸습니다']);
    expect(result.status).toBe('fail');
    expect(result.reason).toContain('잘렸습니다');
  });

  it('성공을 선언해도 진단 신호가 있으면 실패다(기존 동작 유지)', async () => {
    const fake = fakeClaudeCode([{ tool: 'qa_finish', input: { success: true, summary: '문제 없습니다' } }]);
    PAGES['/broken'] = `<html><body><script>console.error('깨짐')</script></body></html>`;
    const result = await run(fake, { goal: '점검', startPath: '/broken' });
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
    const fake = fakeClaudeCode(steps);
    const result = await run(fake, { goal: '점검', startPath: '/start', repeatLimit: 3 });
    expect(result.stoppedBy).toBe('finish');
    expect(result.actions).toHaveLength(8);
  });

  it('같은 화면에서 같은 조작을 되풀이하면 조작을 닫고 마지막 보고를 받는다', async () => {
    const fake = fakeClaudeCode([
      { tool: 'qa_snapshot', input: {} },
      ...Array.from({ length: 3 }, () => ({ tool: 'qa_click', input: { ref: 'e2' } })),
      { tool: 'qa_click', input: { ref: 'e2' } },
      { tool: 'qa_report_issue', input: { severity: 'blocker', summary: '버튼을 눌러도 반응이 없습니다' } },
      { tool: 'qa_finish', input: { success: false, summary: '버튼이 동작하지 않습니다' } },
    ]);
    const result = await run(fake, { goal: '버튼을 누른다', startPath: '/start', repeatLimit: 3 });
    expect(result.stoppedBy).toBe('repeated_screen');
    // 한도 뒤의 조작은 실행하지 않고 보고를 요청하는 오류로 돌려준다
    expect(result.actions).toHaveLength(4);
    const refused = fake.toolResults().find((entry) => entry.tool === 'qa_click' && entry.isError);
    expect(refused?.text).toContain('마지막 보고');
    expect(result.findings).toHaveLength(1);
    expect(result.modelDeclared?.summary).toContain('동작하지 않습니다');
    expect(result.status).toBe('fail');
  });

  it('최대 행동 수에 걸린 뒤 보고가 없으면 같은 대화에서 한 번 더 묻고, 그래도 없으면 통과로 두지 않는다', async () => {
    const steps: Step[] = Array.from({ length: 5 }, () => ({ tool: 'qa_snapshot', input: {} }));
    const fake = fakeClaudeCode([steps, []]);
    const result = await run(fake, { goal: '관찰만 한다', startPath: '/start', maxActions: 3 });
    expect(result.stoppedBy).toBe('max_actions');
    expect(result.actions).toHaveLength(3);
    // 목표 프롬프트 뒤에 마지막 보고 요청이 한 번 더 들어갔다
    expect(fake.prompts()).toHaveLength(2);
    expect(fake.prompts()[1]).toContain('마지막 보고');
    expect(result.modelDeclared).toBeUndefined();
    expect(result.status).toBe('inconclusive');
    expect(result.reason).toContain('마치지 못했습니다');
  });

  it('한 번 더 물은 답으로 보고가 오면 싣는다', async () => {
    const fake = fakeClaudeCode([
      [{ tool: 'qa_snapshot', input: {} }],
      [
        { tool: 'qa_report_issue', input: { severity: 'major', summary: '글자가 흐립니다' } },
        { tool: 'qa_finish', input: { success: true, summary: '보고' } },
      ],
    ]);
    const result = await run(fake, { goal: '점검', startPath: '/start' });
    expect(result.stoppedBy).toBe('no_tool_call');
    expect(result.findings).toHaveLength(1);
    expect(result.status).toBe('fail');
  });
});

describe('runClaudeCodeExploreQa: CLI 실행 방식', { timeout: 30_000 }, () => {
  it('공식 문서에 있는 플래그만 쓰고, 기본 도구를 모두 끄고 qa_* 도구만 허용한다', async () => {
    const fake = fakeClaudeCode([{ tool: 'qa_snapshot', input: {} }, { tool: 'qa_finish', input: { success: true, summary: '끝' } }]);
    await run(fake, { goal: '관찰만 한다', startPath: '/start' }, { model: 'sonnet' });
    const log = fake.log();
    // 내장 도구는 전부 끄고(Bash·Write·Read 등이 열리지 않는다), 허용 목록에는 qa_* 도구 이름만 있다
    expect(fake.fake.argOf(log, '--tools')).toBe('');
    expect(fake.allowedTools().length).toBeGreaterThan(5);
    expect(fake.allowedTools().every((name) => name.startsWith('mcp__b-studio-qa__qa_'))).toBe(true);
    expect(fake.fake.argOf(log, '--permission-mode')).toBe('dontAsk');
    expect(fake.fake.argOf(log, '--setting-sources')).toBe('');
    expect(log.args).toContain('--strict-mcp-config');
    expect(fake.fake.argOf(log, '--model')).toBe('sonnet');
    expect(log.args).not.toContain('--dangerously-skip-permissions');
    // SDK가 붙이던 문서에 없는 환경 변수는 넘기지 않는다
    expect(log.env.clientApp).toBeNull();
    // 토큰은 파일에 쓰지 않고 환경 변수로만 간다. MCP 설정 파일은 0600이고 이름만 적는다
    expect(log.env.hasMcpToken).toBe(true);
    expect(log.mcp?.mode).toBe(0o600);
    expect(log.mcp?.text).toContain('${B_STUDIO_MCP_TOKEN}');
    expect(log.systemPrompt?.mode).toBe(0o600);
    // 목표 글은 인자가 아니라 표준 입력으로 간다
    expect(fake.prompts()).toHaveLength(1);
    expect(log.args.some((arg) => arg.includes('관찰만 한다'))).toBe(false);
  });

  it('qa_screenshot의 이미지는 MCP 이미지 콘텐츠로 모델에 간다', async () => {
    const fake = fakeClaudeCode([{ tool: 'qa_screenshot', input: {} }, { tool: 'qa_finish', input: { success: true, summary: '끝' } }]);
    await run(fake, { goal: '화면을 본다', startPath: '/start' });
    expect(fake.log().tools[0]).toMatchObject({ name: 'qa_screenshot', images: 1 });
  });

  it('시간 제한: 제한 시간이 지나면 조작을 닫고 마지막 보고만 받는다(stoppedBy: max_time)', async () => {
    const fake = fakeClaudeCode([{ tool: 'qa_snapshot', input: {} }, { tool: 'qa_finish', input: { success: true, summary: '시간이 다 됐습니다' } }]);
    const result = await run(fake, { goal: '관찰만 한다', startPath: '/start', maxMs: 1 });
    expect(result.stoppedBy).toBe('max_time');
    expect(result.actions).toHaveLength(0);
    expect(fake.toolResults()[0]).toMatchObject({ tool: 'qa_snapshot', isError: true });
    expect(fake.toolResults()[0]!.text).toContain('마지막 보고');
    expect(result.modelDeclared?.summary).toContain('시간이 다 됐습니다');
  });

  it('취소하면 CLI를 끝내고 취소 이유를 던진다', async () => {
    // 멈춘 모델 응답을 흉내 낸다: 도구를 한 번 부른 뒤 다음 단계에서 멈춘다
    const hanging = fakeClaudeCli({ turns: [[{ tool: 'qa_snapshot', input: {} }, { hang: true }]] });
    const controller = new AbortController();
    const pending = runClaudeCodeExploreQa({ goal: { goal: '관찰', startPath: '/start' }, startUrl: `${base}/start`, allowedOrigins: [base], cwd: process.cwd(), ...hanging.cli, stop: { termAfterMs: 50, killAfterMs: 500 }, signal: controller.signal });
    for (let i = 0; i < 200 && !(hanging.logs()[0]?.tools.length ?? 0); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(new Error('사용자가 취소했습니다'));
    await expect(pending).rejects.toThrow('사용자가 취소했습니다');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hanging.logs()[0]!.signals).toContain('SIGTERM');
  });

  it('CLI가 도구 서버에 연결하지 못했다고 알리면 돌리지 않고 실패시킨다', async () => {
    const hanging = fakeClaudeCli({ turns: [[{ tool: 'qa_snapshot', input: {} }]], invocations: [{ initExtra: { mcp_servers: [{ name: 'b-studio-qa', status: 'failed' }] } }] });
    await expect(runClaudeCodeExploreQa({ goal: { goal: '관찰', startPath: '/start' }, startUrl: `${base}/start`, allowedOrigins: [base], cwd: process.cwd(), ...hanging.cli, stop: { termAfterMs: 50, killAfterMs: 500 } })).rejects.toThrow(/b-studio-qa 도구 서버에 연결하지 못했습니다/);
  });

  it('보고를 받기 전에 CLI가 결과 없이 끝나면 통과시키지 않고 던진다', async () => {
    const broken = fakeClaudeCli({ invocations: [{ exitWithoutResult: 3, stderr: '로그인이 필요합니다' }] });
    await expect(runClaudeCodeExploreQa({ goal: { goal: '관찰', startPath: '/start' }, startUrl: `${base}/start`, allowedOrigins: [base], cwd: process.cwd(), ...broken.cli, stop: { termAfterMs: 50, killAfterMs: 500 } })).rejects.toThrow(/결과를 보내지 않고 종료.*종료 코드 3.*로그인이 필요합니다/);
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
    const fake = fakeClaudeCode([
      { tool: 'qa_scroll', input: { direction: 'down', amount: 300 } },
      { tool: 'qa_scroll', input: { ref: '""', direction: 'down', amount: 300 } },
      { tool: 'qa_finish', input: { success: true, summary: '내렸습니다' } },
    ]);
    const result = await run(fake, { goal: '아래까지 내려 본다', startPath: '/tall' });
    expect(result.actions.map((action) => action.ok)).toEqual([true, true]);
    expect(fake.toolResults()[1]?.text).toContain('y=600');
  });
});
