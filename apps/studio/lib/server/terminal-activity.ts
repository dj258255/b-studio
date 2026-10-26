/**
 * 터미널 CLI가 지금 하는 일(#920, ADR-189). 훅 입력에서 desk 카드에 보일 것을 모은다:
 *  - now: 지금(또는 방금) 쓴 도구와 그 대상. 턴이 끝나면 지운다
 *  - todos: 에이전트의 할 일 목록(Claude TodoWrite·TaskCreated/TaskCompleted, Codex update_plan)
 *  - context: 문맥 창을 얼마나 썼는가(Claude 상태 줄 입력의 context_window)
 *  - lastMessage: 턴 끝의 마지막 답 한 줄
 *  - subagents: 서브에이전트 인스턴스마다 한 행(SubagentStart/SubagentStop)
 *  - workingSince·lastAt·now.running·서브에이전트의 startedAt·lastAt(#933): 몇 분째 일하는지, 도구가 도는 중인지, 마지막 소식
 *
 * 문서에 적힌 훅 입력과 상태 줄 입력만 읽는다. 대화 기록 파일(JSONL)처럼 문서에 없는 꼴은 읽지 않는다.
 * 값은 바깥(CLI)에서 온 것이라 꼴을 확인하고 길이를 자른다. 판정에 쓰지 않는다 — 화면용이다.
 * 기억에만 둔다(스튜디오를 다시 띄우면 비어 있다가 다음 훅에서 다시 찬다). 이 파일은 순수 함수만 둔다.
 */
import path from 'node:path';
import { stripAnsi } from '@b-studio/sandbox';

/** 대상 한 줄의 상한 */
const TARGET_CHARS = 120;
/** 마지막 답의 상한 */
const MESSAGE_CHARS = 200;
/** 할 일·설명 한 줄의 상한 */
const LABEL_CHARS = 80;
/** 세는 할 일의 상한. 넘는 것은 세지 않는다 */
const TODO_LIMIT = 100;
/** 기억하는 서브에이전트 수의 상한(terminal-agents.ts의 장부와 같다) */
const SUBAGENT_LIMIT = 30;
/** Agent 도구 호출에서 받아 두는 설명의 상한 */
const PENDING_LIMIT = 30;

export interface ActivityNow {
  tool: string;
  target?: string;
  /** 도구를 쓰기 시작한 시각(ISO) */
  at: string;
  /**
   * 도구가 아직 끝나지 않았다(#933). 도구 끝 훅(PostToolUse)을 한 번이라도 받은 CLI에서만 싣는다 —
   * 끝 훅을 보내지 않는 CLI는 도는 중인지 알 수 없다
   */
  running?: boolean;
}
export interface ActivityTodos {
  done: number;
  total: number;
  /** 지금 하는 항목. 없으면 없다 */
  current?: string;
}
export interface ActivityContext {
  /** 0~100 */
  usedPct: number;
  used?: number;
  size?: number;
}
export interface ActivitySubagent {
  id: string;
  type: string;
  description?: string;
  state: 'working' | 'done';
  tool?: string;
  /** 시작한 시각(ISO, #933) */
  startedAt?: string;
  /** 마지막 소식(시작, 그 안의 도구, 도구 끝, 멈춤)의 시각(ISO, #933) */
  lastAt?: string;
}
/** `/api/agents` 항목에 싣는 꼴 */
export interface TerminalActivityView {
  now?: ActivityNow;
  todos?: ActivityTodos;
  context?: ActivityContext;
  lastMessage?: string;
  subagents?: ActivitySubagent[];
  /** 지금 요청(턴)을 시작한 시각(#933). 작업 중일 때만 */
  workingSince?: string;
  /** 마지막 훅의 시각(#933). 상태 줄 갱신은 치지 않는다 */
  lastAt?: string;
}

type TodoStatus = 'pending' | 'in_progress' | 'completed';
interface TodoItem {
  id?: string;
  label: string;
  status: TodoStatus;
}

export interface TerminalActivity {
  now?: ActivityNow;
  todos: TodoItem[];
  context?: ActivityContext;
  lastMessage?: string;
  subagents: Map<string, ActivitySubagent>;
  /** 메인이 Agent 도구로 띄운 서브에이전트의 설명. SubagentStart가 같은 종류의 것을 앞에서부터 가져간다 */
  pending: Array<{ type: string; description: string }>;
  workingSince?: string;
  lastAt?: string;
  /** 도구 끝 훅을 받은 적이 있다. 그때부터 now.running을 싣는다(#933) */
  seesToolEnd?: boolean;
}

export function newTerminalActivity(): TerminalActivity {
  return { todos: [], subagents: new Map(), pending: [] };
}

type Input = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

/** 색 코드와 제어 글자를 지우고 빈칸을 하나로 줄여 limit 글자로 자른다. 남는 것이 없으면 undefined */
function clean(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  const flat = stripAnsi(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat;
}

/** 여러 줄 글의 비어 있지 않은 첫 줄 */
function firstLine(value: string | undefined): string | undefined {
  return value
    ?.split('\n')
    .map((line) => line.trim())
    .find(Boolean);
}

/** 작업 폴더 안의 경로는 작업 폴더 기준으로 줄인다 */
function shortPath(file: string, cwd: string | undefined): string {
  if (cwd && path.isAbsolute(file)) {
    const relative = path.relative(cwd, file);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative;
  }
  return file;
}

/** Codex apply_patch 본문의 첫 파일 경로 */
function patchPath(patch: string | undefined): string | undefined {
  for (const line of patch?.split(/\r?\n/) ?? []) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File): (.+)$/.exec(line);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

/** 도구의 대상 한 줄. 도구마다 사람이 알아볼 값을 고른다. 고를 것이 없으면 undefined */
export function toolTarget(tool: string, input: unknown, cwd?: string): string | undefined {
  const args = isObject(input) ? input : {};
  const file = text(args.file_path) ?? text(args.notebook_path) ?? text(args.path);
  let target: string | undefined;
  if (tool === 'apply_patch') target = patchPath(text(args.command) ?? text(args.patch) ?? text(args.input));
  else if (text(args.command)) target = firstLine(text(args.command));
  else if (Array.isArray(args.command)) target = args.command.filter((part): part is string => typeof part === 'string').join(' ');
  else if (file) target = shortPath(file, cwd);
  else target = text(args.description) ?? text(args.pattern) ?? text(args.url) ?? text(args.query) ?? text(args.subagent_type);
  return clean(target, TARGET_CHARS);
}

const TODO_STATUS = new Set<TodoStatus>(['pending', 'in_progress', 'completed']);

/** 목록 하나를 할 일로 바꾼다. 꼴이 틀린 항목은 버린다 */
function todoList(items: unknown, label: (item: Record<string, unknown>) => string | undefined): TodoItem[] | undefined {
  if (!Array.isArray(items)) return undefined;
  const list: TodoItem[] = [];
  for (const item of items.slice(0, TODO_LIMIT)) {
    if (!isObject(item) || !TODO_STATUS.has(item.status as TodoStatus)) continue;
    const name = clean(label(item), LABEL_CHARS);
    if (name) list.push({ label: name, status: item.status as TodoStatus });
  }
  return list;
}

/** 할 일을 바꾸는 도구면 목록을 갈아 끼운다 */
function noteTodoTool(state: TerminalActivity, tool: string, input: unknown): void {
  if (!isObject(input)) return;
  if (tool === 'TodoWrite') {
    const list = todoList(input.todos, (item) => (item.status === 'in_progress' ? text(item.activeForm) : undefined) ?? text(item.content));
    if (list) state.todos = list;
  } else if (tool === 'update_plan') {
    const list = todoList(input.plan, (item) => text(item.step));
    if (list) state.todos = list;
  }
}

/** 메인이 도구를 쓰기 시작했다(PreToolUse). 서브에이전트 안의 도구면 그 서브에이전트의 도구로 남긴다 */
export function noteToolUse(state: TerminalActivity, input: Input, at: number): void {
  const tool = clean(text(input.tool_name), LABEL_CHARS);
  if (!tool) return;
  const iso = new Date(at).toISOString();
  state.lastAt = iso;
  const agentId = text(input.agent_id);
  if (agentId) {
    const subagent = state.subagents.get(agentId);
    if (subagent) {
      subagent.tool = tool;
      subagent.lastAt = iso;
    }
    return;
  }
  const target = toolTarget(tool, input.tool_input, text(input.cwd));
  state.now = { tool, ...(target ? { target } : {}), at: iso, running: true };
  noteTodoTool(state, tool, input.tool_input);
  if (tool === 'Agent' || tool === 'Task') {
    const args = isObject(input.tool_input) ? input.tool_input : {};
    const type = text(args.subagent_type) ?? 'general-purpose';
    const description = clean(text(args.description), LABEL_CHARS);
    if (description) state.pending = [...state.pending, { type, description }].slice(-PENDING_LIMIT);
  }
}

/** 지켜보는 훅 하나(도구의 끝, 서브에이전트의 시작·끝, 할 일의 생김·끝남). 모르는 훅은 무시한다 */
export function noteActivityHook(state: TerminalActivity, input: Input, at: number): void {
  const iso = new Date(at).toISOString();
  switch (input.hook_event_name) {
    case 'PreToolUse':
      noteToolUse(state, input, at);
      return;
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      // 도구가 끝났다(#933). 서브에이전트 안의 도구면 그 서브에이전트의 소식, 메인이면 지금 도는 같은 도구를 끝낸다
      state.lastAt = iso;
      state.seesToolEnd = true;
      const agentId = text(input.agent_id);
      if (agentId) {
        const subagent = state.subagents.get(agentId);
        if (subagent) subagent.lastAt = iso;
        return;
      }
      if (state.now && state.now.tool === clean(text(input.tool_name), LABEL_CHARS)) state.now.running = false;
      return;
    }
    case 'SubagentStart': {
      const id = clean(text(input.agent_id), LABEL_CHARS);
      if (!id || state.subagents.has(id) || state.subagents.size >= SUBAGENT_LIMIT) return;
      const type = clean(text(input.agent_type), LABEL_CHARS) ?? 'subagent';
      const index = state.pending.findIndex((entry) => entry.type === type);
      const description = index >= 0 ? state.pending.splice(index, 1)[0]!.description : undefined;
      state.subagents.set(id, { id, type, ...(description ? { description } : {}), state: 'working', startedAt: iso, lastAt: iso });
      state.lastAt = iso;
      return;
    }
    case 'SubagentStop': {
      const subagent = state.subagents.get(text(input.agent_id) ?? '');
      if (!subagent) return;
      subagent.state = 'done';
      subagent.lastAt = iso;
      state.lastAt = iso;
      delete subagent.tool;
      return;
    }
    case 'TaskCreated': {
      const id = text(input.task_id);
      const label = clean(text(input.task_subject), LABEL_CHARS);
      if (!label || state.todos.length >= TODO_LIMIT || (id && state.todos.some((todo) => todo.id === id))) return;
      state.lastAt = iso;
      state.todos = [...state.todos, { ...(id ? { id } : {}), label, status: 'pending' }];
      return;
    }
    case 'TaskCompleted': {
      const id = text(input.task_id);
      const todo = id ? state.todos.find((candidate) => candidate.id === id) : undefined;
      if (todo) todo.status = 'completed';
      state.lastAt = iso;
      return;
    }
    default:
      return;
  }
}

/** 상태 줄 입력(Claude statusLine). 문맥 창만 꺼낸다. 퍼센트가 없거나 범위 밖이면 앞 값을 그대로 둔다 */
export function noteStatusline(state: TerminalActivity, input: Input): void {
  const window = isObject(input.context_window) ? input.context_window : undefined;
  const usedPct = number(window?.used_percentage);
  if (usedPct === undefined || usedPct > 100) return;
  const size = number(window?.context_window_size);
  const current = isObject(window?.current_usage) ? window.current_usage : undefined;
  const parts = current ? [current.input_tokens, current.cache_creation_input_tokens, current.cache_read_input_tokens].map(number) : [];
  const used = parts.length > 0 && parts.every((part) => part !== undefined) ? parts.reduce((sum: number, part) => sum + part!, 0) : undefined;
  state.context = { usedPct, ...(used !== undefined ? { used } : {}), ...(size !== undefined ? { size } : {}) };
}

/** 새 요청이 왔다. 지금 하는 일을 지우고, 다 끝낸 할 일 목록과 끝난 서브에이전트를 비운다. 이때부터 몇 분째인지 센다(#933) */
export function noteTurnStarted(state: TerminalActivity, at: number = Date.now()): void {
  delete state.now;
  state.workingSince = new Date(at).toISOString();
  state.lastAt = state.workingSince;
  if (state.todos.length > 0 && state.todos.every((todo) => todo.status === 'completed')) state.todos = [];
  for (const [id, subagent] of state.subagents) if (subagent.state === 'done') state.subagents.delete(id);
  state.pending = [];
}

/** 턴이 끝났다(Stop). 지금 하는 일을 지우고 마지막 답을 남긴다 */
export function noteTurnEnded(state: TerminalActivity, input: Input, at: number = Date.now()): void {
  delete state.now;
  delete state.workingSince;
  state.lastAt = new Date(at).toISOString();
  const message = clean(text(input.last_assistant_message), MESSAGE_CHARS);
  if (message) state.lastMessage = message;
}

/** CLI가 끝났다. 지금 하는 일을 지운다(할 일·마지막 답은 남긴다) */
export function noteCliEnded(state: TerminalActivity): void {
  delete state.now;
  delete state.workingSince;
  for (const subagent of state.subagents.values()) subagent.state = 'done';
}

/** 화면에 싣는 꼴. 실을 것이 하나도 없으면 undefined */
export function activityView(state: TerminalActivity | undefined): TerminalActivityView | undefined {
  if (!state) return undefined;
  const todos = state.todos.length > 0 ? todoSummary(state.todos) : undefined;
  const subagents = [...state.subagents.values()].map((subagent) => ({ ...subagent }));
  const view: TerminalActivityView = {
    ...(state.now ? { now: nowView(state.now, state.seesToolEnd === true) } : {}),
    ...(todos ? { todos } : {}),
    ...(state.context ? { context: { ...state.context } } : {}),
    ...(state.lastMessage ? { lastMessage: state.lastMessage } : {}),
    ...(subagents.length > 0 ? { subagents } : {}),
    ...(state.workingSince ? { workingSince: state.workingSince } : {}),
    ...(state.lastAt ? { lastAt: state.lastAt } : {}),
  };
  return Object.keys(view).length > 0 ? view : undefined;
}

/** 도구 끝 훅을 받은 적이 없는 CLI에서는 running을 싣지 않는다(#933) */
function nowView(now: ActivityNow, seesToolEnd: boolean): ActivityNow {
  const { running, ...rest } = now;
  return seesToolEnd && running !== undefined ? { ...rest, running } : rest;
}

function todoSummary(todos: readonly TodoItem[]): ActivityTodos {
  const current = todos.find((todo) => todo.status === 'in_progress')?.label;
  return { done: todos.filter((todo) => todo.status === 'completed').length, total: todos.length, ...(current ? { current } : {}) };
}
