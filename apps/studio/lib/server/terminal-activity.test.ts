import { describe, expect, it } from 'vitest';
import { activityView, newTerminalActivity, noteActivityHook, noteActivityPing, noteCliEnded, noteStatusline, noteToolDenied, noteToolUse, noteTurnEnded, noteTurnStarted, notificationMessage, permissionMessage, toolTarget } from './terminal-activity';

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

  it('새 요청이 오면 끝난 서브에이전트는 지운다', () => {
    const state = newTerminalActivity();
    noteActivityHook(state, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' }, AT);
    noteActivityHook(state, { hook_event_name: 'SubagentStop', agent_id: 'a1' }, AT);
    noteTurnStarted(state);
    expect(activityView(state)?.subagents).toBeUndefined();
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
