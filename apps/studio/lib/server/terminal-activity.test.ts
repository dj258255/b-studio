import { describe, expect, it } from 'vitest';
import { ACTIVITY_LIMITS, DONE_SUBAGENT_KEEP_MS, activityLog, activityView, clearActivityLog, newTerminalActivity, noteActivityHook, noteActivityPing, noteCliEnded, noteStatusline, noteToolDenied, noteToolUse, noteTurnEnded, noteTurnStarted, notificationMessage, permissionMessage, toolTarget } from './terminal-activity';

// 에이전트가 지금 하는 일·할 일·문맥 창·마지막 답·서브에이전트(#920). 훅 입력에서 만든다

const AT = Date.parse('2026-10-26T10:00:00.000Z');

describe('지금 하는 일(now)', () => {
  it('도구 이름과 대상: Bash는 명령 첫 줄, 파일 도구는 작업 폴더 기준 경로, Grep은 패턴, Agent는 설명', () => {
    expect(toolTarget('Bash', { command: 'pnpm test\necho done' })).toBe('pnpm test');
    expect(toolTarget('Edit', { file_path: '/work/apps/cli/src/desk/cards.ts' }, '/work')).toBe('apps/cli/src/desk/cards.ts');
    expect(toolTarget('Read', { file_path: '/elsewhere/a.ts' }, '/work')).toBe('/elsewhere/a.ts');
    expect(toolTarget('Grep', { pattern: 'TODO' })).toBe('TODO');
    expect(toolTarget('Agent', { description: '테스트 고치기', subagent_type: 'general-purpose' })).toBe('테스트 고치기');
    expect(toolTarget('WebFetch', { url: 'https://example.com/a' })).toBe('https://example.com/a');
    expect(toolTarget('apply_patch', { command: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n' })).toBe('src/a.ts');
    expect(toolTarget('mcp__b-studio__run', {})).toBeUndefined();
  });

  it('대상의 색 코드·제어 글자는 지우고 길면 자른다', () => {
    expect(toolTarget('Bash', { command: '\u001b[31mecho\u001b[0m hi\u0007' })).toBe('echo hi');
    expect(toolTarget('Bash', { command: 'x'.repeat(300) })!.length).toBeLessThanOrEqual(120);
  });

  it('쓰기 직전 훅이 지금 하는 일을 정하고, 턴이 끝나면 지운다', () => {
    const state = newTerminalActivity();
    noteToolUse(state, { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }, AT);
    expect(activityView(state)?.now).toEqual({ tool: 'Bash', target: 'pnpm test', at: '2026-10-26T10:00:00.000Z' });
    noteTurnEnded(state, { last_assistant_message: '끝났습니다' });
    expect(activityView(state)?.now).toBeUndefined();
  });

  it('서브에이전트 안에서 쓴 도구는 메인의 지금 하는 일이 아니라 그 서브에이전트의 도구다', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, AT);
    noteToolUse(state, { agent_id: 'a1', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'x' } }, AT + 1);
    const view = activityView(state)!;
    expect(view.now).toBeUndefined();
    expect(view.subagents).toEqual([{ id: 'a1', type: 'Explore', state: 'working', tool: 'Grep', startedAt: '2026-10-26T10:00:00.000Z', lastAt: '2026-10-26T10:00:00.001Z' }]);
  });

  it('도구 이름이 없거나 문자열이 아니면 무시한다(바깥에서 온 값)', () => {
    const state = newTerminalActivity();
    noteToolUse(state, { tool_name: 3 }, AT);
    expect(activityView(state)).toBeUndefined();
  });
});

describe('할 일(todos)', () => {
  it('TodoWrite의 목록: 끝낸 수·전체 수·지금 하는 항목(activeForm 우선)', () => {
    const state = newTerminalActivity();
    noteToolUse(state, { tool_name: 'TodoWrite', tool_input: { todos: [
      { content: '테스트 쓰기', status: 'completed', activeForm: '테스트 쓰는 중' },
      { content: '구현', status: 'in_progress', activeForm: '구현하는 중' },
      { content: '문서', status: 'pending', activeForm: '문서 쓰는 중' },
    ] } }, AT);
    expect(activityView(state)?.todos).toEqual({ done: 1, total: 3, current: '구현하는 중' });
  });

  it('Codex update_plan의 plan[]{step,status}', () => {
    const state = newTerminalActivity();
    noteToolUse(state, { tool_name: 'update_plan', tool_input: { plan: [{ step: '읽기', status: 'completed' }, { step: '고치기', status: 'in_progress' }] } }, AT);
    expect(activityView(state)?.todos).toEqual({ done: 1, total: 2, current: '고치기' });
  });

  it('TaskCreated·TaskCompleted 훅으로 쌓는다', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'TaskCreated', task_id: '1', task_subject: '테스트' }, AT);
    noteActivityHook(state, { hook_event_name: 'TaskCreated', task_id: '2', task_subject: '구현' }, AT);
    noteActivityHook(state, { hook_event_name: 'TaskCompleted', task_id: '1' }, AT);
    expect(activityView(state)?.todos).toEqual({ done: 1, total: 2 });
  });

  it('새 요청이 오면 다 끝낸 목록은 지우고, 덜 끝낸 목록은 남긴다', () => {
    const done = newTerminalActivity();
    noteToolUse(done, { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'a', status: 'completed' }] } }, AT);
    noteTurnStarted(done);
    expect(activityView(done)?.todos).toBeUndefined();
    const open = newTerminalActivity();
    noteToolUse(open, { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'a', status: 'pending' }] } }, AT);
    noteTurnStarted(open);
    expect(activityView(open)?.todos).toEqual({ done: 0, total: 1 });
  });

  it('모양이 틀린 항목은 버리고, 목록이 너무 길면 앞부분만 센다', () => {
    const state = newTerminalActivity();
    noteToolUse(state, { tool_name: 'TodoWrite', tool_input: { todos: [{ content: 'a', status: 'weird' }, 'x', { status: 'pending' }] } }, AT);
    expect(activityView(state)?.todos).toBeUndefined();
    noteToolUse(state, { tool_name: 'TodoWrite', tool_input: { todos: Array.from({ length: 500 }, (_, i) => ({ content: `t${i}`, status: 'pending' })) } }, AT);
    expect(activityView(state)?.todos?.total).toBe(100);
  });
});

describe('문맥 창(context)', () => {
  it('statusline 입력의 used_percentage·창 크기·지금 쓴 양', () => {
    const state = newTerminalActivity();
    noteStatusline(state, { context_window: { used_percentage: 42.5, context_window_size: 200000, current_usage: { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 82000, output_tokens: 500 } } });
    expect(activityView(state)?.context).toEqual({ usedPct: 42.5, used: 85000, size: 200000 });
  });

  it('퍼센트가 없거나 범위 밖이면 남기지 않는다(앞 값은 그대로)', () => {
    const state = newTerminalActivity();
    noteStatusline(state, { context_window: { used_percentage: 10 } });
    noteStatusline(state, { context_window: { used_percentage: 'x' } });
    noteStatusline(state, { context_window: { used_percentage: 250 } });
    noteStatusline(state, {});
    expect(activityView(state)?.context).toEqual({ usedPct: 10 });
  });
});

describe('마지막 답(lastMessage)', () => {
  it('턴 끝의 last_assistant_message를 한 줄로 200자 안에', () => {
    const state = newTerminalActivity();
    noteTurnEnded(state, { last_assistant_message: '고쳤습니다.\n\n테스트도   통과합니다.' });
    expect(activityView(state)?.lastMessage).toBe('고쳤습니다. 테스트도 통과합니다.');
    noteTurnEnded(state, { last_assistant_message: '가'.repeat(500) });
    expect(activityView(state)!.lastMessage!.length).toBeLessThanOrEqual(200);
  });
});

describe('서브에이전트', () => {
  it('인스턴스마다 한 행: Agent 도구의 설명을 같은 종류의 다음 시작에 붙이고, 끝나면 done', () => {
    const state = newTerminalActivity();
    noteToolUse(state, { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', description: '훅 찾기' } }, AT);
    noteToolUse(state, { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', description: '테스트 찾기' } }, AT);
    noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, AT);
    noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: 'a2', agent_type: 'Explore' }, AT);
    noteActivityHook(state, { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore' }, AT);
    expect(activityView(state)?.subagents).toEqual([
      { id: 'a1', type: 'Explore', description: '훅 찾기', state: 'done', startedAt: '2026-10-26T10:00:00.000Z', lastAt: '2026-10-26T10:00:00.000Z' },
      { id: 'a2', type: 'Explore', description: '테스트 찾기', state: 'working', startedAt: '2026-10-26T10:00:00.000Z', lastAt: '2026-10-26T10:00:00.000Z' },
    ]);
  });

  it('끝난 서브에이전트는 새 요청이 와도 한동안 남고, 끝난 지 오래된 것만 지운다(#1421)', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, AT);
    noteActivityHook(state, { hook_event_name: 'SubagentStop', agent_id: 'a1', last_assistant_message: '세 곳' }, AT + 1_000);
    // 백그라운드 서브에이전트가 끝났다는 알림은 새 요청처럼 들어온다. 그때 지우면 무엇을 했는지 볼 틈이 없다
    noteTurnStarted(state, AT + 2_000);
    expect(activityView(state)?.subagents).toMatchObject([{ id: 'a1', state: 'done', result: '세 곳' }]);
    noteTurnStarted(state, AT + 1_000 + DONE_SUBAGENT_KEEP_MS);
    expect(activityView(state)?.subagents).toHaveLength(1);
    noteTurnStarted(state, AT + 1_000 + DONE_SUBAGENT_KEEP_MS + 1);
    expect(activityView(state)?.subagents).toBeUndefined();
  });

  it('작업 중인 서브에이전트는 아무리 오래돼도 새 요청에서 지우지 않는다', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, AT);
    noteTurnStarted(state, AT + DONE_SUBAGENT_KEEP_MS * 10);
    expect(activityView(state)?.subagents).toHaveLength(1);
  });

  it('30개가 찼을 때 새 서브에이전트가 오면 가장 오래전에 끝난 것을 밀어내고, 모두 작업 중이면 받지 않는다', () => {
    const state = newTerminalActivity();
    for (let i = 0; i < 30; i += 1) noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: `a${i}`, agent_type: 'Explore' }, AT + i);
    noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: 'full', agent_type: 'Explore' }, AT + 100);
    expect(activityView(state)?.subagents?.some((agent) => agent.id === 'full')).toBe(false);
    noteToolUse(state, { tool_name: 'Grep', tool_input: { pattern: 'x' }, agent_id: 'a7' }, AT + 150);
    expect(activityLog(state, { agent: 'a7' })!.agents).toHaveLength(1);
    // a7이 먼저, a3이 나중에 끝났다: 밀려나는 것은 a7
    noteActivityHook(state, { hook_event_name: 'SubagentStop', agent_id: 'a7' }, AT + 200);
    noteActivityHook(state, { hook_event_name: 'SubagentStop', agent_id: 'a3' }, AT + 300);
    noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: 'new1', agent_type: 'Plan' }, AT + 400);
    const ids = activityView(state)!.subagents!.map((agent) => agent.id);
    expect(ids).toHaveLength(30);
    expect(ids).toContain('new1');
    expect(ids).not.toContain('a7');
    expect(ids).toContain('a3');
    // 밀려난 서브에이전트의 활동 기록도 함께 없어진다
    expect(activityLog(state, { agent: 'a7' })?.agents ?? []).toEqual([]);
  });

  it('30개를 넘으면 더 기억하지 않는다', () => {
    const state = newTerminalActivity();
    for (let i = 0; i < 40; i += 1) noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: `a${i}`, agent_type: 'Explore' }, AT);
    expect(activityView(state)?.subagents).toHaveLength(30);
  });
});

describe('시각(#933): 몇 분째, 도구가 도는 중, 마지막 소식', () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  it('요청이 시작되면 workingSince, 턴이 끝나거나 CLI가 내려가면 지운다', () => {
    const state = newTerminalActivity();
    noteTurnStarted(state, AT);
    expect(activityView(state)?.workingSince).toBe(iso(AT));
    noteTurnEnded(state, {}, AT + 60_000);
    expect(activityView(state)?.workingSince).toBeUndefined();
    noteTurnStarted(state, AT + 120_000);
    noteCliEnded(state);
    expect(activityView(state)?.workingSince).toBeUndefined();
  });

  it('도구 끝 훅(PostToolUse)을 받는 CLI에서는 now.running이 시작에 true, 끝에 false다', () => {
    const state = newTerminalActivity();
    // 끝 훅을 한 번도 받지 않은 CLI(Codex 등)는 도는 중인지 모르므로 running을 싣지 않는다
    noteToolUse(state, { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }, AT);
    expect(activityView(state)?.now).not.toHaveProperty('running');
    noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash' }, AT + 1000);
    expect(activityView(state)?.now).toMatchObject({ tool: 'Bash', running: false });
    noteToolUse(state, { tool_name: 'Bash', tool_input: { command: 'pnpm build' } }, AT + 2000);
    expect(activityView(state)?.now).toMatchObject({ target: 'pnpm build', running: true, at: iso(AT + 2000) });
    noteActivityHook(state, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' }, AT + 3000);
    expect(activityView(state)?.now).toMatchObject({ running: false });
  });

  it('다른 도구의 끝 훅은 지금 도는 도구를 끝내지 않는다', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Read' }, AT);
    noteToolUse(state, { tool_name: 'Bash', tool_input: { command: 'pnpm test' } }, AT + 1000);
    noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Read' }, AT + 2000);
    expect(activityView(state)?.now).toMatchObject({ tool: 'Bash', running: true });
  });

  it('lastAt은 훅마다 갱신되고 상태 줄 갱신은 활동으로 치지 않는다', () => {
    const state = newTerminalActivity();
    noteTurnStarted(state, AT);
    noteToolUse(state, { tool_name: 'Read', tool_input: { file_path: 'a.ts' } }, AT + 5000);
    expect(activityView(state)?.lastAt).toBe(iso(AT + 5000));
    noteStatusline(state, { context_window: { used_percentage: 10 } });
    expect(activityView(state)?.lastAt).toBe(iso(AT + 5000));
    noteActivityHook(state, { hook_event_name: 'TaskCreated', task_id: 't1', task_subject: '테스트' }, AT + 9000);
    expect(activityView(state)?.lastAt).toBe(iso(AT + 9000));
  });

  it('서브에이전트 행의 startedAt·lastAt: 시작, 그 안의 도구, 도구 끝, 멈춤에서 갱신', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, AT);
    expect(activityView(state)?.subagents?.[0]).toMatchObject({ startedAt: iso(AT), lastAt: iso(AT) });
    noteToolUse(state, { agent_id: 'a1', tool_name: 'Grep', tool_input: { pattern: 'x' } }, AT + 4000);
    expect(activityView(state)?.subagents?.[0]).toMatchObject({ startedAt: iso(AT), lastAt: iso(AT + 4000), tool: 'Grep' });
    noteActivityHook(state, { hook_event_name: 'PostToolUse', agent_id: 'a1', tool_name: 'Grep' }, AT + 6000);
    expect(activityView(state)?.subagents?.[0]).toMatchObject({ lastAt: iso(AT + 6000) });
    // 서브에이전트 안의 도구 끝은 메인의 지금 하는 일을 건드리지 않는다
    expect(activityView(state)?.now).toBeUndefined();
    noteActivityHook(state, { hook_event_name: 'SubagentStop', agent_id: 'a1' }, AT + 8000);
    expect(activityView(state)?.subagents?.[0]).toMatchObject({ state: 'done', lastAt: iso(AT + 8000) });
  });
});

// 실사용 점검과 설치된 CLI 번들 대조(#942)에서 나온 것
describe('도구 끝·거절·권한 문구·서브에이전트·Task 도구(#942)', () => {
  it('도구 끝은 이름이 아니라 tool_use_id로 맞춘다: 같은 이름 도구가 겹쳐도 앞 도구의 끝이 뒤 도구의 도는 중을 끄지 않는다', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'pnpm lint' } }, AT);
    noteActivityHook(state, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'u2', tool_input: { command: 'pnpm test' } }, AT + 1);
    noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'u1' }, AT + 2);
    expect(activityView(state)?.now).toMatchObject({ tool: 'Bash', target: 'pnpm test', running: true });
    noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'u2' }, AT + 3);
    expect(activityView(state)?.now).toMatchObject({ target: 'pnpm test', running: false });
  });

  it('id가 없는 CLI는 전처럼 이름으로 맞춘다', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a' } }, AT);
    noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Read' }, AT + 1);
    expect(activityView(state)?.now?.running).toBe(false);
  });

  it('도구가 실패하면 도는 중을 끄고 까닭 한 줄을 싣는다. 사람이 끊었으면 "중단됨"', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'pnpm test' } }, AT);
    noteActivityHook(state, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'u1', error: 'Exit code 1\nFAIL src/a.test.ts' }, AT + 1);
    expect(activityView(state)?.now).toMatchObject({ running: false, error: 'Exit code 1' });
    noteActivityHook(state, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'u2', tool_input: { command: 'sleep 9' } }, AT + 2);
    expect(activityView(state)?.now?.error).toBeUndefined();
    noteActivityHook(state, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'u2', error: 'x', is_interrupt: true }, AT + 3);
    expect(activityView(state)?.now?.error).toBe('중단됨');
  });

  it('관문이 거절한 도구는 도는 중이 아니고 거절 까닭을 싣는다(끝 훅이 오지 않아도)', () => {
    const state = newTerminalActivity();
    noteToolUse(state, { tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: 'pnpm test' } }, AT);
    noteToolDenied(state, { tool_name: 'Bash', tool_use_id: 'u1' }, '[b-studio] 샌드박스를 준비하지 못해 파일을 바꿀 수 있는 도구를 막았습니다: 준비 판정 404\n원인을 고친 뒤 다시 시도하세요.', AT + 1);
    expect(activityView(state)?.now).toMatchObject({ tool: 'Bash', target: 'pnpm test', running: false, error: '거절됨: 샌드박스를 준비하지 못해 파일을 바꿀 수 있는 도구를 막았습니다: 준비 판정 404' });
    // 끝 훅을 한 번도 받지 않은 CLI여도 거절은 싣는다
    const codex = newTerminalActivity();
    noteToolUse(codex, { tool_name: 'apply_patch', tool_input: {} }, AT);
    noteToolDenied(codex, { tool_name: 'apply_patch' }, '읽기만 요청입니다', AT + 1);
    expect(activityView(codex)?.now).toMatchObject({ running: false, error: '거절됨: 읽기만 요청입니다' });
  });

  it('Agent 도구의 설명은 SubagentStart가 먼저 와도(지켜보기 훅은 순서가 없다) 그 서브에이전트에 붙는다', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, AT);
    noteActivityHook(state, { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'u1', tool_input: { subagent_type: 'Explore', description: '주문 호출부 찾기' } }, AT + 1);
    expect(activityView(state)?.subagents?.[0]).toMatchObject({ id: 'a1', description: '주문 호출부 찾기' });
    // 다음 같은 종류는 새 설명을 기다린다(앞 설명을 두 번 쓰지 않는다)
    noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: 'a2', agent_type: 'Explore' }, AT + 2);
    expect(activityView(state)?.subagents?.[1]?.description).toBeUndefined();
  });

  it('서브에이전트가 끝나며 남긴 마지막 답을 결과 한 줄로 싣는다', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, AT);
    noteActivityHook(state, { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'Explore', last_assistant_message: '호출부 3곳:\nsrc/a.ts, src/b.ts' }, AT + 1);
    expect(activityView(state)?.subagents?.[0]).toMatchObject({ state: 'done', result: '호출부 3곳: src/a.ts, src/b.ts' });
  });

  it('Task 도구: TaskUpdate의 진행 중이 지금 하는 항목이 되고, 끝냄·지움을 센다', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'TaskCreated', task_id: '1', task_subject: '요구 읽기' }, AT);
    noteActivityHook(state, { hook_event_name: 'TaskCreated', task_id: '2', task_subject: '테스트 쓰기' }, AT);
    noteActivityHook(state, { hook_event_name: 'TaskCreated', task_id: '3', task_subject: '버릴 일' }, AT);
    noteToolUse(state, { tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'in_progress', activeForm: '요구 읽는 중' } }, AT + 1);
    expect(activityView(state)?.todos).toEqual({ done: 0, total: 3, current: '요구 읽는 중' });
    noteToolUse(state, { tool_name: 'TaskUpdate', tool_input: { taskId: '1', status: 'completed' } }, AT + 2);
    noteToolUse(state, { tool_name: 'TaskUpdate', tool_input: { task_id: '2', status: 'in_progress' } }, AT + 3);
    noteToolUse(state, { tool_name: 'TaskUpdate', tool_input: { taskId: '3', status: 'deleted' } }, AT + 4);
    expect(activityView(state)?.todos).toEqual({ done: 1, total: 2, current: '테스트 쓰기' });
  });
});

describe('권한을 묻는 문구(#942)', () => {
  it('PermissionRequest는 무엇을 묻는지(도구와 대상)를 우리말로 적는다', () => {
    expect(permissionMessage({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } })).toBe('Bash 허락 필요: rm -rf build');
    expect(permissionMessage({ tool_name: 'Edit', tool_input: { file_path: '/w/src/a.ts' }, cwd: '/w' })).toBe('Edit 허락 필요: src/a.ts');
    expect(permissionMessage({ tool_name: 'exec_command', tool_input: {} })).toBe('exec_command 허락 필요');
    expect(permissionMessage({})).toBe('');
  });

  it('Claude의 영어 권한 알림 문구는 우리말로 바꾼다. 모르는 문구는 그대로 둔다', () => {
    expect(notificationMessage('Claude needs your permission to use Bash')).toBe('Bash 허락 필요');
    expect(notificationMessage('Claude is waiting for your input')).toBe('입력을 기다립니다');
    expect(notificationMessage('무엇을 할까요?')).toBe('무엇을 할까요?');
  });
});

describe('2차 실사용 점검(#955)', () => {
  it('비동기 훅이 뒤바뀌어 끝(Post)이 시작(Pre)보다 먼저 와도 그 도구를 도는 중으로 남기지 않는다', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'TodoWrite', tool_use_id: 't1' }, AT);
    noteActivityHook(state, { hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_use_id: 't1', tool_input: { todos: [] } }, AT - 5);
    expect(activityView(state)?.now?.running).not.toBe(true);
    // 끝을 받지 않은 다른 도구는 그대로 도는 중이다
    noteActivityHook(state, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 't2', tool_input: { file_path: 'a.ts' } }, AT + 1);
    expect(activityView(state)?.now).toMatchObject({ tool: 'Read', running: true });
  });

  it('요청마다 관문이 거절한 쓰기 수(turnDenied)를 세고, 새 요청에서 다시 센다. 요청이 끝나도 남는다', () => {
    const state = newTerminalActivity();
    noteTurnStarted(state, AT);
    noteToolUse(state, { tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: 'a.ts' } }, AT + 1);
    noteToolDenied(state, { tool_name: 'Edit', tool_use_id: 'e1' }, '샌드박스를 준비하지 못했습니다', AT + 2);
    noteToolUse(state, { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'pnpm test' } }, AT + 3);
    // 지금 하는 일이 아닌 도구의 거절도 센다
    noteToolDenied(state, { tool_name: 'Edit', tool_use_id: 'e0' }, '쓰기 범위 밖입니다', AT + 4);
    expect(activityView(state)?.turnDenied).toBe(2);
    noteTurnEnded(state, { last_assistant_message: '묶었습니다' }, AT + 5);
    expect(activityView(state)?.turnDenied).toBe(2);
    noteTurnStarted(state, AT + 6);
    expect(activityView(state)?.turnDenied).toBeUndefined();
  });

  it('모델 요청(텔레메트리)도 CLI의 소식이다: 마지막 소식 시각을 옮긴다', () => {
    const state = newTerminalActivity();
    noteTurnStarted(state, AT);
    noteActivityPing(state, AT + 90_000);
    expect(activityView(state)?.lastAt).toBe(new Date(AT + 90_000).toISOString());
  });
});

describe('toolTarget 경로 줄이기: ..로 시작하는 이름 (#1004)', () => {
  it('작업 폴더 안의 ..로 시작하는 이름도 작업 폴더 기준으로 줄이고, 밖의 경로는 그대로 둔다', () => {
    expect(toolTarget('Edit', { file_path: '/work/..docs/a.md' }, '/work')).toBe('..docs/a.md');
    expect(toolTarget('Read', { file_path: '/other/a.ts' }, '/work')).toBe('/other/a.ts');
    expect(toolTarget('Read', { file_path: '/a.ts' }, '/work')).toBe('/a.ts');
  });
});

// 에이전트별 최근 활동 기록(#1411). 메인과 서브에이전트마다 최근 도구 호출과 코드 조각을 기억에만 남긴다
describe('에이전트별 활동 기록(activityLog)', () => {
  const L = ACTIVITY_LIMITS;
  const SECRET = 'zq9-very-secret-value-4711';
  const known = (text: string): string => text.split(SECRET).join('[가림]');
  const mainLog = (state: ReturnType<typeof newTerminalActivity>) => activityLog(state)?.agents.find((agent) => agent.main);
  const start = (state: ReturnType<typeof newTerminalActivity>, tool: string, tool_input: unknown, extra: Record<string, unknown> = {}, at = AT, redact?: (text: string) => string) =>
    noteToolUse(state, { tool_name: tool, tool_input, ...extra }, at, redact);

  it('Edit은 old/new를 고치기 항목으로 남기고, 끝 훅이 같은 호출(tool_use_id)을 닫는다', () => {
    const state = newTerminalActivity();
    start(state, 'Edit', { file_path: '/work/src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;\nconst b = 3;' }, { tool_use_id: 't1', cwd: '/work' });
    start(state, 'Read', { file_path: '/work/src/b.ts' }, { tool_use_id: 't2', cwd: '/work' }, AT + 1);
    expect(mainLog(state)?.entries.map((entry) => [entry.tool, entry.state])).toEqual([['Edit', 'running'], ['Read', 'running']]);
    // 먼저 시작한 Edit을 id로 닫는다(마지막 열린 항목인 Read가 아니라)
    noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 't1' }, AT + 2);
    const [edit, read] = mainLog(state)!.entries;
    expect(edit).toMatchObject({ id: 't1', at: '2026-10-26T10:00:00.000Z', tool: 'Edit', kind: 'edit', target: 'src/a.ts', state: 'done', changes: [{ file: 'src/a.ts', removed: 'const a = 1;', added: 'const a = 2;\nconst b = 3;' }] });
    expect(read).toMatchObject({ tool: 'Read', kind: 'read', state: 'running' });
    expect(read!.changes).toBeUndefined();
  });

  it('id가 없는 훅은 그 에이전트의 마지막 열린 같은 도구 항목을 닫는다', () => {
    const state = newTerminalActivity();
    start(state, 'Bash', { command: 'echo 1' });
    start(state, 'Bash', { command: 'echo 2' }, {}, AT + 1);
    noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: { stdout: 'two' } }, AT + 2);
    expect(mainLog(state)!.entries.map((entry) => [entry.command, entry.state, entry.output])).toEqual([['echo 1', 'running', undefined], ['echo 2', 'done', 'two']]);
  });

  it('서브에이전트 안의 도구는 그 서브에이전트의 기록에 들어가고 메인의 기록에는 들어가지 않는다', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, AT);
    start(state, 'Grep', { pattern: 'TODO' }, { agent_id: 'a1', tool_use_id: 'g1' }, AT + 1);
    start(state, 'Write', { file_path: 'x.ts', content: 'export {};' }, { tool_use_id: 'w1' }, AT + 2);
    noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Grep', agent_id: 'a1', tool_use_id: 'g1' }, AT + 3);
    const log = activityLog(state)!;
    expect(log.agents.map((agent) => [agent.id, agent.main === true, agent.type, agent.entries.map((entry) => `${entry.tool}:${entry.state}`)])).toEqual([
      ['main', true, undefined, ['Write:running']],
      ['a1', false, 'Explore', ['Grep:done']],
    ]);
    // 에이전트 하나만 달라고 할 수 있다
    expect(activityLog(state, { agent: 'a1' })!.agents.map((agent) => agent.id)).toEqual(['a1']);
    expect(activityLog(state, { agent: 'main' })!.agents.map((agent) => agent.id)).toEqual(['main']);
    expect(activityLog(state, { agent: 'nobody' })!.agents).toEqual([]);
  });

  it('끝난 서브에이전트의 기록은 새 요청이 와도 한동안 남고, 서브에이전트가 지워질 때 함께 사라진다. 메인의 기록은 남는다(#1421)', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, AT);
    start(state, 'Grep', { pattern: 'x' }, { agent_id: 'a1' }, AT + 1);
    start(state, 'Read', { file_path: 'a.ts' }, {}, AT + 2);
    noteActivityHook(state, { hook_event_name: 'SubagentStop', agent_id: 'a1' }, AT + 3);
    // 멈춘 서브에이전트의 열린 항목은 끝 훅을 못 받은 채로 닫는다
    expect(activityLog(state, { agent: 'a1' })!.agents[0]!.entries[0]!.state).toBe('unknown');
    noteTurnStarted(state, AT + 4);
    expect(activityLog(state)!.agents.map((agent) => [agent.id, agent.state])).toEqual([['main', undefined], ['a1', 'done']]);
    noteTurnStarted(state, AT + 4 + DONE_SUBAGENT_KEEP_MS);
    expect(activityLog(state)!.agents.map((agent) => agent.id)).toEqual(['main']);
  });

  it('쓰기 직전 훅이 거절하면 그 항목에 거절 까닭을 남긴다', () => {
    const state = newTerminalActivity();
    start(state, 'Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, { tool_use_id: 'e1' });
    noteToolDenied(state, { tool_name: 'Edit', tool_use_id: 'e1' }, '[b-studio] 쓰기 범위 밖입니다', AT + 1);
    expect(mainLog(state)!.entries[0]).toMatchObject({ state: 'denied', error: '거절됨: 쓰기 범위 밖입니다' });
  });

  it('도구가 실패하면 까닭 한 줄을 남기고, 중단은 중단됨이다', () => {
    const state = newTerminalActivity();
    start(state, 'Bash', { command: 'false' }, { tool_use_id: 'b1' });
    noteActivityHook(state, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'b1', error: 'Exit code 1\nboom' }, AT + 1);
    start(state, 'Bash', { command: 'sleep 99' }, { tool_use_id: 'b2' }, AT + 2);
    noteActivityHook(state, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'b2', is_interrupt: true }, AT + 3);
    expect(mainLog(state)!.entries.map((entry) => [entry.state, entry.error])).toEqual([['failed', 'Exit code 1'], ['failed', '중단됨']]);
  });

  it('턴이 끝나거나 CLI가 끝나면 끝 훅을 못 받은 항목은 unknown으로 닫는다', () => {
    const state = newTerminalActivity();
    start(state, 'Bash', { command: 'a' });
    noteTurnEnded(state, {}, AT + 1);
    start(state, 'Bash', { command: 'b' }, {}, AT + 2);
    noteCliEnded(state);
    expect(mainLog(state)!.entries.map((entry) => entry.state)).toEqual(['unknown', 'unknown']);
  });

  it('끝 훅이 시작 훅보다 먼저 와도 열린 채 남지 않는다', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'late', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' } }, AT);
    start(state, 'Bash', { command: 'ls' }, { tool_use_id: 'late' }, AT + 1);
    expect(mainLog(state)!.entries.map((entry) => [entry.id, entry.state])).toEqual([['late', 'done']]);
  });

  it('같은 tool_use_id의 시작 훅이 두 번 와도 항목은 하나다', () => {
    const state = newTerminalActivity();
    start(state, 'Bash', { command: 'ls' }, { tool_use_id: 'dup' });
    start(state, 'Bash', { command: 'ls' }, { tool_use_id: 'dup' }, AT + 1);
    expect(mainLog(state)!.entries).toHaveLength(1);
  });

  describe('코드 조각', () => {
    it('Write는 내용의 앞부분을 쓰기 항목으로 남기고, 줄 수·줄 길이 상한을 넘으면 잘렸다고 표시한다', () => {
      const state = newTerminalActivity();
      const lines = Array.from({ length: L.codeLines + 10 }, (_, index) => `line ${index} ${'x'.repeat(L.lineChars + 50)}`);
      start(state, 'Write', { file_path: 'big.ts', content: lines.join('\n') });
      const entry = mainLog(state)!.entries[0]!;
      expect(entry.kind).toBe('write');
      const added = entry.changes![0]!.added!.split('\n');
      expect(added).toHaveLength(L.codeLines);
      expect(added.every((line) => line.length <= L.lineChars)).toBe(true);
      expect(added[0]).toMatch(/^line 0 x+…$/);
      expect(entry.changes![0]!.truncated).toBe(true);
      expect(entry.truncated).toBe(true);
    });

    it('MultiEdit은 편집마다 한 조각, 개수 상한을 넘으면 앞의 것만 남기고 잘렸다고 표시한다', () => {
      const state = newTerminalActivity();
      const edits = Array.from({ length: L.changes + 3 }, (_, index) => ({ old_string: `o${index}`, new_string: `n${index}` }));
      start(state, 'MultiEdit', { file_path: 'm.ts', edits });
      const entry = mainLog(state)!.entries[0]!;
      expect(entry.kind).toBe('edit');
      expect(entry.changes).toHaveLength(L.changes);
      expect(entry.changes![1]).toMatchObject({ file: 'm.ts', removed: 'o1', added: 'n1' });
      expect(entry.truncated).toBe(true);
    });

    it('apply_patch는 패치 본문 줄을 남긴다(Codex의 명령 배열 모양도 읽는다)', () => {
      const state = newTerminalActivity();
      const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch';
      start(state, 'apply_patch', { command: patch });
      start(state, 'apply_patch', { command: ['apply_patch', patch] }, {}, AT + 1);
      const [one, two] = mainLog(state)!.entries;
      for (const entry of [one, two]) expect(entry).toMatchObject({ kind: 'edit', target: 'src/a.ts', changes: [{ file: 'src/a.ts', patch: expect.stringContaining('+new') }] });
    });

    it('apply_patch의 어느 파일이든 비밀 파일이면 조각 전체를 남기지 않는다', () => {
      const state = newTerminalActivity();
      start(state, 'apply_patch', { command: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: deploy/.env\n+KEY=1\n*** End Patch' });
      start(state, 'apply_patch', { command: '*** Begin Patch\n+no header\n*** End Patch' }, {}, AT + 1);
      const [secret, unknown] = mainLog(state)!.entries;
      expect(secret).toMatchObject({ withheld: 'secret' });
      expect(unknown).toMatchObject({ withheld: 'unknown' });
      expect(JSON.stringify(mainLog(state))).not.toContain('KEY=1');
    });

    it('비밀 파일의 Edit·Write·MultiEdit·NotebookEdit는 대상 이름만 남기고 조각은 남기지 않는다(꼴은 거부 목록이라 넓게 맞춘다)', () => {
      for (const file of ['.env', 'config/.env.production', 'a\\.env', '.ENV', 'apps/web/.Env.Local', 'deploy/id_rsa', 'cert/server.pem', '/home/u/.ssh/config', '.npmrc', 'aws/credentials']) {
        const state = newTerminalActivity();
        start(state, 'Write', { file_path: file, content: `TOKEN=${SECRET}` });
        start(state, 'Edit', { file_path: file, old_string: `A=${SECRET}`, new_string: 'A=2' }, {}, AT + 1);
        start(state, 'MultiEdit', { file_path: file, edits: [{ old_string: SECRET, new_string: 'x' }] }, {}, AT + 2);
        start(state, 'NotebookEdit', { notebook_path: file, new_source: SECRET }, {}, AT + 3);
        const entries = mainLog(state)!.entries;
        expect(entries, file).toHaveLength(4);
        for (const entry of entries) {
          expect(entry.withheld, file).toBe('secret');
          expect(entry.changes, file).toBeUndefined();
          expect(entry.target, file).toBeTruthy();
        }
        expect(JSON.stringify(activityLog(state)), file).not.toContain(SECRET);
      }
    });

    it('예시 파일(.env.example)은 비밀 파일이 아니라 조각을 남긴다', () => {
      const state = newTerminalActivity();
      start(state, 'Write', { file_path: '.env.example', content: 'API_URL=http://localhost' });
      expect(mainLog(state)!.entries[0]!.changes![0]!.added).toBe('API_URL=http://localhost');
    });

    it('모르는 입력(경로가 없거나 글이 아닌 값)은 던지지 않고 도구 이름만 남긴다', () => {
      const state = newTerminalActivity();
      for (const input of [undefined, null, 'x', 7, [], { file_path: 3, content: 'x' }, { content: 'x' }, { file_path: 'a.ts', content: 5 }, { file_path: 'a.ts', old_string: {}, new_string: [] }, { file_path: 'a.ts', edits: 'no' }, { file_path: 'a.ts', edits: [null, 3, { old_string: 1 }] }]) {
        expect(() => start(state, 'Write', input), JSON.stringify(input)).not.toThrow();
        expect(() => start(state, 'Edit', input), JSON.stringify(input)).not.toThrow();
        expect(() => start(state, 'MultiEdit', input), JSON.stringify(input)).not.toThrow();
      }
      for (const entry of mainLog(state)!.entries) {
        expect(entry.tool).toBeTruthy();
        // 조각이 있다면 글이었던 값에서만 나온다
        for (const change of entry.changes ?? []) for (const value of [change.added, change.removed, change.patch]) expect(value === undefined || typeof value === 'string').toBe(true);
      }
      expect(mainLog(state)!.entries.filter((entry) => entry.changes === undefined).length).toBeGreaterThan(10);
    });

    it('경로를 알 수 없는 쓰기(경로 없음)는 조각을 남기지 않고 unknown으로 표시한다', () => {
      const state = newTerminalActivity();
      start(state, 'Write', { content: `TOKEN=${SECRET}` });
      expect(mainLog(state)!.entries[0]).toMatchObject({ withheld: 'unknown' });
      expect(mainLog(state)!.entries[0]!.changes).toBeUndefined();
    });

    it('상한을 넘는 원문은 가림이 끝까지 읽지 못하므로 조각을 남기지 않는다', () => {
      const state = newTerminalActivity();
      start(state, 'Write', { file_path: 'huge.ts', content: `${'a\n'.repeat(L.rawChars)}${SECRET}` });
      const entry = mainLog(state)!.entries[0]!;
      expect(entry).toMatchObject({ withheld: 'large', truncated: true });
      expect(entry.changes).toBeUndefined();
    });
  });

  describe('Bash 명령과 결과', () => {
    it('명령(여러 줄 상한)과 PostToolUse 결과의 끝 몇 줄을 남긴다', () => {
      const state = newTerminalActivity();
      start(state, 'Bash', { command: Array.from({ length: L.commandLines + 4 }, (_, index) => `echo ${index}`).join('\n') }, { tool_use_id: 'b1' });
      const stdout = Array.from({ length: L.outputLines + 20 }, (_, index) => `out ${index}`).join('\n');
      noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_response: { stdout, stderr: 'warn: x' } }, AT + 1);
      const entry = mainLog(state)!.entries[0]!;
      expect(entry.kind).toBe('run');
      expect(entry.command!.split('\n')).toHaveLength(L.commandLines);
      const output = entry.output!.split('\n');
      expect(output).toHaveLength(L.outputLines);
      // 끝 줄을 남긴다(stderr가 stdout 뒤에 붙는다)
      expect(output.at(-1)).toBe('warn: x');
      expect(output.at(-2)).toBe(`out ${L.outputLines + 19}`);
      expect(entry.truncated).toBe(true);
    });

    it('결과가 글 하나이거나 모르는 모양이면 글만 읽고, 모르는 모양은 결과 없이 둔다', () => {
      const state = newTerminalActivity();
      start(state, 'Bash', { command: 'a' }, { tool_use_id: '1' });
      noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: '1', tool_response: 'plain text' }, AT + 1);
      start(state, 'Bash', { command: 'b' }, { tool_use_id: '2' }, AT + 2);
      noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: '2', tool_response: { stdout: 5, weird: [1] } }, AT + 3);
      start(state, 'Bash', { command: 'c' }, { tool_use_id: '3' }, AT + 4);
      expect(() => noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: '3', tool_response: null }, AT + 5)).not.toThrow();
      expect(mainLog(state)!.entries.map((entry) => entry.output)).toEqual(['plain text', undefined, undefined]);
    });

    it('비밀 파일을 읽는 명령이나 환경을 찍는 명령은 결과를 남기지 않는다', () => {
      for (const command of ['cat .env', 'cat apps/web/.env.local | head', 'grep KEY "config/.ENV"', 'env', 'printenv', 'FOO=1 printenv HOME', 'set', 'export', 'echo hi && env', 'cat .ssh/id_rsa', 'cat server.pem', 'type .env']) {
        const state = newTerminalActivity();
        start(state, 'Bash', { command }, { tool_use_id: 'b' });
        noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_response: { stdout: `TOKEN=${SECRET}\nHOME=/root` } }, AT + 1);
        const entry = mainLog(state)!.entries[0]!;
        expect(entry.output, command).toBeUndefined();
        expect(entry.withheld, command).toBe('secret');
        expect(JSON.stringify(activityLog(state)), command).not.toContain(SECRET);
      }
    });

    it('평범한 명령의 결과는 남긴다(env로 시작하는 낱말이나 .env 모양이 아닌 이름은 거르지 않는다)', () => {
      const state = newTerminalActivity();
      start(state, 'Bash', { command: 'cat environment.md && echo setup' }, { tool_use_id: 'b' });
      noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_response: { stdout: 'ok' } }, AT + 1);
      expect(mainLog(state)!.entries[0]).toMatchObject({ output: 'ok' });
    });
  });

  describe('가림', () => {
    it('조각·명령·결과·대상·오류에서 알려진 비밀 값(세션이 아는 값)과 자격 증명 모양을 가린다', () => {
      const state = newTerminalActivity();
      const redact = known;
      start(state, 'Edit', { file_path: 'a.ts', old_string: `const k = '${SECRET}';`, new_string: "const k = process.env.K;\nconst url = 'https://user:hunter2@host.example/x';" }, { tool_use_id: 'e' }, AT, redact);
      start(state, 'Bash', { command: `curl -H "Authorization: Bearer abcdef1234567890" -u me:${SECRET} https://api.example` }, { tool_use_id: 'b' }, AT + 1, redact);
      noteActivityHook(
        state,
        { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_response: { stdout: `ok ${SECRET}\nghp_abcdefghijklmnopqrstuvwxyz0123456789\nsk-ant-api03-abcdefghijklmnopqrstuvwx\nAPI_KEY=hunter2hunter2\nAKIAIOSFODNN7EXAMPLE` } },
        AT + 2,
        redact,
      );
      start(state, 'Bash', { command: 'false' }, { tool_use_id: 'f' }, AT + 3, redact);
      noteActivityHook(state, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'f', error: `failed with ${SECRET}` }, AT + 4, redact);
      const text = JSON.stringify(activityLog(state));
      for (const leak of [SECRET, 'hunter2', 'abcdef1234567890', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'sk-ant-api03-abcdefghijklmnopqrstuvwx', 'AKIAIOSFODNN7EXAMPLE']) expect(text, leak).not.toContain(leak);
      expect(text).toContain('process.env.K');
    });

    it('개인 키 블록은 통째로 가리고, 끝 표시만 남은(잘린) 키 조각이 보이면 결과를 남기지 않는다', () => {
      const state = newTerminalActivity();
      start(state, 'Bash', { command: 'cat key' }, { tool_use_id: 'b' });
      noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_response: { stdout: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1\n-----END OPENSSH PRIVATE KEY-----\ndone' } }, AT + 1);
      start(state, 'Bash', { command: 'cat key2' }, { tool_use_id: 'c' }, AT + 2);
      noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'c', tool_response: { stdout: 'AAAAB3NzaC1kc3MAAACB\n-----END RSA PRIVATE KEY-----' } }, AT + 3);
      const [whole, tail] = mainLog(state)!.entries;
      expect(whole!.output).not.toContain('AAAAB3NzaC1');
      expect(tail!.output).toBeUndefined();
      expect(tail!.withheld).toBe('secret');
    });

    it('가림은 자르기 전에 한다: 줄 길이 상한에 걸쳐 잘리는 자리에 비밀 값이 있어도 앞 조각이 남지 않는다', () => {
      const state = newTerminalActivity();
      const line = `${'x'.repeat(L.lineChars - 10)}${SECRET}`;
      start(state, 'Write', { file_path: 'a.ts', content: line }, {}, AT, known);
      start(state, 'Bash', { command: 'cat a' }, { tool_use_id: 'b' }, AT + 1, known);
      noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_response: { stdout: line } }, AT + 2, known);
      // 줄 수 상한에 걸쳐 앞 줄이 잘리는 자리도 같다
      const many = [`${SECRET}`, ...Array.from({ length: L.outputLines }, (_, index) => `l${index}`)].join('\n');
      start(state, 'Bash', { command: 'cat b' }, { tool_use_id: 'c' }, AT + 3, known);
      noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'c', tool_response: { stdout: many } }, AT + 4, known);
      const text = JSON.stringify(activityLog(state));
      expect(text).not.toContain(SECRET.slice(0, 6));
      expect(text).toContain('[가림]');
    });

    it('가림 함수가 던지면 조각과 결과를 남기지 않는다(모르면 통과가 아니다)', () => {
      const state = newTerminalActivity();
      const broken = (): string => {
        throw new Error('redactor down');
      };
      start(state, 'Edit', { file_path: 'a.ts', old_string: SECRET, new_string: 'b' }, { tool_use_id: 'e' }, AT, broken);
      start(state, 'Bash', { command: `echo ${SECRET}` }, { tool_use_id: 'b' }, AT + 1, broken);
      noteActivityHook(state, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b', tool_response: { stdout: SECRET } }, AT + 2, broken);
      const [edit, bash] = mainLog(state)!.entries;
      expect(edit!.changes).toBeUndefined();
      expect(edit!.withheld).toBe('unknown');
      expect(bash!.command).toBeUndefined();
      expect(bash!.output).toBeUndefined();
      expect(JSON.stringify(activityLog(state))).not.toContain(SECRET);
    });
  });

  describe('상한', () => {
    it('에이전트당 항목 수를 넘으면 오래된 것부터 버린다', () => {
      const state = newTerminalActivity();
      for (let index = 0; index < L.entriesPerAgent + 7; index += 1) start(state, 'Read', { file_path: `f${index}.ts` }, { tool_use_id: `t${index}` }, AT + index);
      const entries = mainLog(state)!.entries;
      expect(entries).toHaveLength(L.entriesPerAgent);
      expect(entries[0]!.target).toBe('f7.ts');
      expect(entries.at(-1)!.target).toBe(`f${L.entriesPerAgent + 6}.ts`);
    });

    it('기록을 갖는 에이전트 수는 서브에이전트 상한을 넘지 않는다', () => {
      const state = newTerminalActivity();
      for (let index = 0; index < L.agents + 10; index += 1) start(state, 'Read', { file_path: 'a.ts' }, { agent_id: `a${index}` }, AT + index);
      start(state, 'Read', { file_path: 'main.ts' }, {}, AT + 1000);
      const agents = activityLog(state)!.agents;
      expect(agents.filter((agent) => !agent.main)).toHaveLength(L.agents);
      // 메인은 서브에이전트가 가득 차도 기록한다
      expect(agents.find((agent) => agent.main)!.entries).toHaveLength(1);
    });

    it('세션 전체 크기 어림을 넘으면 가장 오래된 항목부터 버린다', () => {
      const state = newTerminalActivity();
      const line = 'y'.repeat(L.lineChars);
      const big = Array.from({ length: L.codeLines }, () => line).join('\n');
      for (let index = 0; index < 400; index += 1) start(state, 'Write', { file_path: `f${index}.ts`, content: big }, { agent_id: `a${index % 20}`, tool_use_id: `t${index}` }, AT + index);
      const view = activityLog(state)!;
      const bytes = Buffer.byteLength(JSON.stringify(view));
      expect(bytes).toBeLessThanOrEqual(L.totalBytes + 20_000);
      // 가장 새 항목은 남고 가장 오래된 항목은 없다
      const targets = view.agents.flatMap((agent) => agent.entries.map((entry) => entry.target));
      expect(targets).toContain('f399.ts');
      expect(targets).not.toContain('f0.ts');
    });

    it('내놓는 응답에 총 크기 상한이 있다(요청한 에이전트 하나만 달라고 해도 같다)', () => {
      const state = newTerminalActivity();
      const big = Array.from({ length: L.codeLines }, () => 'z'.repeat(L.lineChars)).join('\n');
      for (let index = 0; index < 100; index += 1) start(state, 'Write', { file_path: `f${index}.ts`, content: big }, { tool_use_id: `t${index}` }, AT + index);
      expect(Buffer.byteLength(JSON.stringify(activityLog(state, { agent: 'main' })))).toBeLessThanOrEqual(L.totalBytes + 20_000);
    });
  });

  it('기록이 없으면 undefined, 지우면 비운다. 화면용 보기(activityView)에는 조각을 싣지 않는다', () => {
    const state = newTerminalActivity();
    expect(activityLog(state)).toBeUndefined();
    expect(activityLog(undefined)).toBeUndefined();
    start(state, 'Edit', { file_path: 'a.ts', old_string: 'CODE_MARKER_OLD', new_string: 'CODE_MARKER_NEW' });
    expect(JSON.stringify(activityView(state))).not.toContain('CODE_MARKER');
    clearActivityLog(state);
    expect(activityLog(state)).toBeUndefined();
    // 지운 뒤에도 화면용 보기는 그대로다
    expect(activityView(state)?.now?.tool).toBe('Edit');
  });
});

describe('가림이 긴 글에서 서버를 세우지 않는다(#1411)', () => {
  // 고치기 전 대입 꼴 정규식은 열쇠말이 되풀이되는 글에서 세제곱 시간이었다(6천 자에 십여 초, 상한인 10만 자면 끝나지 않는다)
  const timed = (content: string): number => {
    const state = newTerminalActivity();
    const started = performance.now();
    noteToolUse(state, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: '/w/a.txt', content } }, AT, (value) => value);
    return performance.now() - started;
  };

  it('열쇠말이 되풀이되는 글·끊김 없는 글·열쇠말 뒤가 긴 글', () => {
    expect(timed('token'.repeat(1_200))).toBeLessThan(2_000);
    expect(timed('a'.repeat(6_000))).toBeLessThan(2_000);
    expect(timed(`secret${'_x'.repeat(3_000)}`)).toBeLessThan(2_000);
    expect(timed('token'.repeat(Math.floor(ACTIVITY_LIMITS.rawChars / 5) - 1))).toBeLessThan(5_000);
  }, 120_000);

  it('대입 꼴은 그대로 가린다(이름 앞뒤에 글자가 붙어도, 따옴표 값도)', () => {
    const state = newTerminalActivity();
    const content = ['MY_API_KEY=abcd1234efgh', 'db.password: "p@ss w0rd"', "const authToken = 'zzz999'", 'plain = keep'].join('\n');
    noteToolUse(state, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: '/w/a.txt', content } }, AT, (value) => value);
    const added = activityLog(state)!.agents[0]!.entries[0]!.changes![0]!.added!;
    expect(added).not.toMatch(/abcd1234efgh|p@ss|zzz999/);
    expect(added).toContain('MY_API_KEY=***');
    expect(added).toContain('plain = keep');
  });
});

describe('대입 꼴 가림에 길이로 비켜 갈 틈이 없다(#1411)', () => {
  const addedOf = (content: string): string => {
    const state = newTerminalActivity();
    noteToolUse(state, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 't1', tool_input: { file_path: '/w/a.txt', content } }, AT, (value) => value);
    return activityLog(state)!.agents[0]!.entries[0]!.changes![0]!.added!;
  };

  it('구분자 둘레의 빈칸이 길어도, 열쇠말 뒤 이름이 길어도 값을 가린다', () => {
    expect(addedOf(`token${' '.repeat(40)}=${' '.repeat(40)}LEAK_ONE`)).not.toContain('LEAK_ONE');
    expect(addedOf(`token\t\t\t\t\t\t\t\t\t\t:\tLEAK_TWO`)).not.toContain('LEAK_TWO');
    expect(addedOf(`secret_${'x'.repeat(100)}=LEAK_THREE`)).not.toContain('LEAK_THREE');
    expect(addedOf(`${'x'.repeat(100)}_password = "LEAK FOUR"`)).not.toContain('LEAK FOUR');
  });

  it('구분자 둘레에 줄바꿈·CR·NBSP·전각 빈칸이 있어도 값을 가린다', () => {
    expect(addedOf('"password":\n  "LEAK_NL"')).not.toContain('LEAK_NL');
    expect(addedOf('token\n=\nLEAK_NL2')).not.toContain('LEAK_NL2');
    expect(addedOf('token =\r\nLEAK_CR')).not.toContain('LEAK_CR');
    expect(addedOf('token\u00a0=\u00a0LEAK_NBSP')).not.toContain('LEAK_NBSP');
    expect(addedOf('token\u3000:\u3000LEAK_WIDE')).not.toContain('LEAK_WIDE');
  });

  it('값 자리에 다시 대입이 와도 안쪽 값을 가린다', () => {
    expect(addedOf('x=token=LEAK_FIVE')).not.toContain('LEAK_FIVE');
    expect(addedOf('url: password=LEAK_SIX')).not.toContain('LEAK_SIX');
  });

  it('열쇠말이 없는 대입과 보통 코드는 그대로 둔다', () => {
    expect(addedOf('const value = compute(input);\nname: "kim"')).toBe('const value = compute(input);\nname: "kim"');
  });

  it('상한 크기의 글에서도 오래 걸리지 않는다', () => {
    const size = ACTIVITY_LIMITS.rawChars - 10;
    for (const content of ['a'.repeat(size), 'a='.repeat(size / 2), 'token '.repeat(Math.floor(size / 6)), `token${' '.repeat(size - 5)}`, `token${'\n'.repeat(size - 5)}`, 'token\n'.repeat(Math.floor(size / 6)), 'token='.repeat(Math.floor(size / 6))]) {
      const started = performance.now();
      addedOf(content);
      expect(performance.now() - started).toBeLessThan(5_000);
    }
  }, 120_000);
});

describe('지금 하는 일 한 줄도 가린다(#1411)', () => {
  it('명령 첫 줄의 자격 증명과 세션이 아는 비밀 값이 카드에 그대로 나가지 않는다', () => {
    const state = newTerminalActivity();
    noteToolUse(state, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'curl -H "Authorization: Bearer abcdefgh12345678" https://x.test/KNOWN_SECRET_VALUE' } }, AT, (value) => value.replaceAll('KNOWN_SECRET_VALUE', '***'));
    const target = activityView(state)?.now?.target ?? '';
    expect(target).toContain('curl');
    expect(target).not.toContain('abcdefgh12345678');
    expect(target).not.toContain('KNOWN_SECRET_VALUE');
  });

  it('가림 함수가 던지면 대상을 비운다(도구 이름은 남는다)', () => {
    const state = newTerminalActivity();
    noteToolUse(state, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'echo hi' } }, AT, () => {
      throw new Error('가림 실패');
    });
    expect(activityView(state)?.now).toMatchObject({ tool: 'Bash' });
    expect(activityView(state)?.now?.target).toBeUndefined();
  });
});
