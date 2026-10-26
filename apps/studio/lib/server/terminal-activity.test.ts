import { describe, expect, it } from 'vitest';
import { activityView, newTerminalActivity, noteActivityHook, noteStatusline, noteToolUse, noteTurnEnded, noteTurnStarted, toolTarget } from './terminal-activity';

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
    expect(view.subagents).toEqual([{ id: 'a1', type: 'Explore', state: 'working', tool: 'Grep' }]);
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
      { id: 'a1', type: 'Explore', description: '훅 찾기', state: 'done' },
      { id: 'a2', type: 'Explore', description: '테스트 찾기', state: 'working' },
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
