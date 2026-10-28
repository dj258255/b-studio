/**
 * 터미널 CLI가 지금 하는 일(#920, ADR-189). 훅 입력에서 desk 카드에 보일 것을 모은다:
 *  - now: 지금(또는 방금) 쓴 도구와 그 대상. 턴이 끝나면 지운다
 *  - todos: 에이전트의 할 일 목록(Claude TodoWrite·TaskCreated/TaskCompleted, Codex update_plan)
 *  - context: 문맥 창을 얼마나 썼는가(Claude 상태 줄 입력의 context_window, Codex는 codex-rollout-context.ts, #978)
 *  - lastMessage: 턴 끝의 마지막 답 한 줄
 *  - subagents: 서브에이전트 인스턴스마다 한 행(SubagentStart/SubagentStop)
 *  - workingSince·lastAt·now.running·서브에이전트의 startedAt·lastAt(#933): 몇 분째 일하는지, 도구가 도는 중인지, 마지막 소식
 *  - turnDenied(#955): 이번(끝났으면 마지막) 요청에서 관문이 거절한 쓰기 수
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
/** 끝 훅을 먼저 받은 도구 호출 id를 기억하는 수(#955). 비동기 훅은 끝이 시작보다 먼저 닿을 수 있다 */
const ENDED_LIMIT = 50;

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
  /** 도구가 실패했거나 관문이 거절한 까닭 한 줄(#942). 없으면 실패를 모른다 */
  error?: string;
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
  /** 끝나며 남긴 마지막 답 한 줄(SubagentStop의 last_assistant_message, #942) */
  result?: string;
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
  /** 이번(끝났으면 마지막) 요청에서 관문이 거절한 쓰기 수(#955). 없으면 0번 */
  turnDenied?: number;
}

type TodoStatus = 'pending' | 'in_progress' | 'completed';
interface TodoItem {
  id?: string;
  label: string;
  status: TodoStatus;
  /** 진행 중일 때 보일 말(Task 도구의 activeForm, #942) */
  active?: string;
}

export interface TerminalActivity {
  now?: ActivityNow;
  /** 지금 하는 일의 도구 호출 id(tool_use_id, #942). 도구 끝을 이 id로 맞춘다. 화면에는 싣지 않는다 */
  nowId?: string;
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
  /** 끝 훅을 받은 메인의 도구 호출 id(#955). 시작 훅이 뒤늦게 와도 그 도구를 도는 중으로 두지 않는다 */
  ended: string[];
  /** 이번 요청에서 관문이 거절한 쓰기 수(#955) */
  turnDenied: number;
}

export function newTerminalActivity(): TerminalActivity {
  return { todos: [], subagents: new Map(), pending: [], ended: [], turnDenied: 0 };
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
  } else if (tool === 'TaskUpdate') {
    noteTaskUpdate(state, input);
  }
}

/**
 * Claude의 Task 도구(TaskUpdate, #942). 할 일은 TaskCreated 훅의 task_id로 알고, 진행 중·끝냄·지움은 이 도구의 입력으로 안다.
 * 입력 이름은 CLI가 받아 주는 별칭(id·task_id, active_form)도 읽는다. 모르는 id는 무시한다
 */
function noteTaskUpdate(state: TerminalActivity, input: Record<string, unknown>): void {
  const id = text(input.taskId) ?? text(input.task_id) ?? text(input.id);
  const index = id ? state.todos.findIndex((todo) => todo.id === id) : -1;
  if (index < 0) return;
  const todo = state.todos[index]!;
  const status = input.status;
  if (status === 'deleted') {
    state.todos = state.todos.filter((_, at) => at !== index);
    return;
  }
  const subject = clean(text(input.subject), LABEL_CHARS);
  const active = clean(text(input.activeForm) ?? text(input.active_form), LABEL_CHARS);
  state.todos[index] = {
    ...todo,
    ...(subject ? { label: subject } : {}),
    ...(active ? { active } : {}),
    ...(TODO_STATUS.has(status as TodoStatus) ? { status: status as TodoStatus } : {}),
  };
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
  const id = text(input.tool_use_id);
  // 비동기 훅은 끝이 시작보다 먼저 닿을 수 있다(#955). 이미 끝난 도구는 도는 중으로 두지 않는다
  const over = id !== undefined && (state.ended ?? []).includes(id);
  state.now = { tool, ...(target ? { target } : {}), at: iso, running: !over };
  if (id) state.nowId = id;
  else delete state.nowId;
  noteTodoTool(state, tool, input.tool_input);
  if (tool === 'Agent' || tool === 'Task') {
    const args = isObject(input.tool_input) ? input.tool_input : {};
    const type = text(args.subagent_type) ?? 'general-purpose';
    const description = clean(text(args.description), LABEL_CHARS);
    if (!description) return;
    // 지켜보기 훅은 따로(async) 돌아 SubagentStart가 먼저 닿을 수 있다. 설명을 아직 못 받은 같은 종류가 있으면 거기 붙인다(#942)
    const waiting = [...state.subagents.values()].find((subagent) => subagent.type === type && !subagent.description && subagent.state === 'working');
    if (waiting) waiting.description = description;
    else state.pending = [...state.pending, { type, description }].slice(-PENDING_LIMIT);
  }
}

/** 이 끝 훅이 지금 하는 일의 도구인가: 둘 다 id가 있으면 id로, 아니면 이름으로 맞춘다(#942) */
function endsNow(state: TerminalActivity, input: Input): boolean {
  if (!state.now) return false;
  const id = text(input.tool_use_id);
  if (id && state.nowId) return id === state.nowId;
  return state.now.tool === clean(text(input.tool_name), LABEL_CHARS);
}

/** 오류 글의 비어 있지 않은 첫 줄 */
function errorLine(value: unknown): string | undefined {
  return clean(firstLine(text(value)), TARGET_CHARS);
}

/**
 * 관문(쓰기 직전의 훅)이 도구를 거절했다(#942). CLI는 거절된 도구의 끝 훅을 보내지 않을 수 있으므로 여기서 도는 중을 끄고 까닭을 남긴다.
 * 끝 훅을 한 번도 받지 않은 CLI여도 거절은 확실히 아는 것이라 싣는다
 */
export function noteToolDenied(state: TerminalActivity, input: Input, reason: string, at: number): void {
  // 거절은 지금 하는 일이 아닌 도구여도 이번 요청의 거절로 센다(#955)
  state.turnDenied = (state.turnDenied ?? 0) + 1;
  state.lastAt = new Date(at).toISOString();
  if (!state.now || !endsNow(state, input)) return;
  const why = errorLine(reason.replace(/^\[b-studio\]\s*/, ''));
  state.now = { ...state.now, running: false, ...(why ? { error: `거절됨: ${why}` } : {}) };
  state.lastAt = new Date(at).toISOString();
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
      const endedId = text(input.tool_use_id);
      if (endedId) state.ended = [...(state.ended ?? []), endedId].slice(-ENDED_LIMIT);
      if (!endsNow(state, input)) return;
      state.now!.running = false;
      if (input.hook_event_name === 'PostToolUseFailure') {
        const why = input.is_interrupt === true ? '중단됨' : errorLine(input.error);
        if (why) state.now!.error = why;
      }
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
      const result = clean(text(input.last_assistant_message), LABEL_CHARS);
      if (result) subagent.result = result;
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

/** CLI가 모델에 요청했다(텔레메트리, #955). 도구 훅이 없는 긴 생각도 CLI의 소식이다 — 마지막 소식 시각만 옮긴다 */
export function noteActivityPing(state: TerminalActivity, at: number): void {
  state.lastAt = new Date(at).toISOString();
}

/** 새 요청이 왔다. 지금 하는 일을 지우고, 다 끝낸 할 일 목록과 끝난 서브에이전트를 비운다. 이때부터 몇 분째인지 센다(#933) */
export function noteTurnStarted(state: TerminalActivity, at: number = Date.now()): void {
  delete state.now;
  delete state.nowId;
  state.workingSince = new Date(at).toISOString();
  state.lastAt = state.workingSince;
  state.turnDenied = 0;
  state.ended = [];
  if (state.todos.length > 0 && state.todos.every((todo) => todo.status === 'completed')) state.todos = [];
  for (const [id, subagent] of state.subagents) if (subagent.state === 'done') state.subagents.delete(id);
  state.pending = [];
}

/** 턴이 끝났다(Stop). 지금 하는 일을 지우고 마지막 답을 남긴다 */
export function noteTurnEnded(state: TerminalActivity, input: Input, at: number = Date.now()): void {
  delete state.now;
  delete state.nowId;
  delete state.workingSince;
  state.lastAt = new Date(at).toISOString();
  const message = clean(text(input.last_assistant_message), MESSAGE_CHARS);
  if (message) state.lastMessage = message;
}

/** CLI가 끝났다. 지금 하는 일을 지운다(할 일·마지막 답은 남긴다) */
export function noteCliEnded(state: TerminalActivity): void {
  delete state.now;
  delete state.nowId;
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
    ...(state.turnDenied ? { turnDenied: state.turnDenied } : {}),
  };
  return Object.keys(view).length > 0 ? view : undefined;
}

/** 도구 끝 훅을 받은 적이 없는 CLI에서는 running을 싣지 않는다(#933) */
function nowView(now: ActivityNow, seesToolEnd: boolean): ActivityNow {
  const { running, ...rest } = now;
  // 거절·실패는 확실히 끝난 것이라 끝 훅을 모르는 CLI에서도 싣는다(#942)
  return (seesToolEnd || now.error) && running !== undefined ? { ...rest, running } : rest;
}

function todoSummary(todos: readonly TodoItem[]): ActivityTodos {
  const doing = todos.find((todo) => todo.status === 'in_progress');
  const current = doing?.active ?? doing?.label;
  return { done: todos.filter((todo) => todo.status === 'completed').length, total: todos.length, ...(current ? { current } : {}) };
}

/**
 * 권한을 묻는 문구(PermissionRequest, #942): 무엇을 묻는지(도구와 대상)를 적는다. 도구 이름이 없으면 빈 글
 * 예: "Bash 허락 필요: rm -rf build"
 */
export function permissionMessage(input: Input): string {
  const tool = clean(text(input.tool_name), LABEL_CHARS);
  if (!tool) return '';
  const target = toolTarget(tool, input.tool_input, text(input.cwd));
  return target ? `${tool} 허락 필요: ${target}` : `${tool} 허락 필요`;
}

/** Claude 알림(Notification)의 알려진 영어 문구를 우리말로(#942). 모르는 문구는 그대로 둔다 */
export function notificationMessage(message: string): string {
  const permission = /needs your permission to use (.+?)\.?$/i.exec(message.trim());
  if (permission?.[1]) return `${permission[1]} 허락 필요`;
  if (/waiting for your input/i.test(message)) return '입력을 기다립니다';
  return message;
}
