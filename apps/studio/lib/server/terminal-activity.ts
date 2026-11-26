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
 *  - 에이전트별 최근 활동 기록(#1411, ADR-232): 메인과 서브에이전트마다 최근 도구 호출과 코드 조각(고치기·쓰기의 diff, Bash의 명령과 결과 끝 줄).
 *    화면용 보기(activityView)에는 싣지 않고 따로(activityLog) 내놓는다. 기억에만 두며 세션 기록에 저장하지 않는다
 *
 * 문서에 적힌 훅 입력과 상태 줄 입력만 읽는다. 대화 기록 파일(JSONL)처럼 문서에 없는 꼴은 읽지 않는다.
 * 값은 바깥(CLI)에서 온 것이라 꼴을 확인하고 길이를 자른다. 판정에 쓰지 않는다 — 화면용이다.
 * 기억에만 둔다(스튜디오를 다시 띄우면 비어 있다가 다음 훅에서 다시 찬다). 이 파일은 순수 함수만 둔다.
 */
import path from 'node:path';
import { native, stripAnsi } from '@b-studio/sandbox';

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

/**
 * 에이전트별 활동 기록의 상한(#1411). 모두 읽기·저장 전에 건다. 근거: 화면 한 칸(80칸 터미널)이 한눈에 보는 양이 스무 항목 안팎이고,
 * 서브에이전트 서른 개가 모두 가득 차도 세션 전체는 totalBytes를 넘지 않는다(넘으면 가장 오래된 항목부터 버린다)
 */
export const ACTIVITY_LIMITS = {
  /** 에이전트마다 남기는 항목 수 */
  entriesPerAgent: 20,
  /** 기록을 갖는 서브에이전트 수(위 SUBAGENT_LIMIT과 같다). 메인은 따로 센다 */
  agents: SUBAGENT_LIMIT,
  /** 항목 하나의 코드 조각 수(MultiEdit의 편집 수) */
  changes: 5,
  /** 조각 하나의 줄 수(지운 쪽·쓴 쪽 각각) */
  codeLines: 30,
  /** 줄 하나의 글자 수 */
  lineChars: 160,
  /** Bash 명령에서 남기는 줄 수 */
  commandLines: 6,
  /** Bash 결과에서 남기는 끝 줄 수 */
  outputLines: 10,
  /** 가림이 읽는 원문 한 덩어리의 글자 수. 넘으면 가림이 끝까지 읽지 못하므로 코드 조각은 남기지 않고, 결과는 끝쪽만 읽는다 */
  rawChars: 100_000,
  /** 세션 전체 기록의 크기 어림(JSON 바이트) */
  totalBytes: 400_000,
} as const;

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
  /** 에이전트별 최근 활동 기록(#1411). 기억에만 둔다. 화면용 보기(activityView)에는 싣지 않는다 */
  log?: ActivityLogState;
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
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return relative;
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

/** apply_patch 입력의 패치 본문. 글이거나, Codex의 명령 배열(`['apply_patch', 본문]`)의 마지막 글이다 */
function patchText(args: Record<string, unknown>): string | undefined {
  const direct = text(args.command) ?? text(args.patch) ?? text(args.input);
  if (direct) return direct;
  if (Array.isArray(args.command)) {
    const last = args.command.at(-1);
    return typeof last === 'string' && last ? last : undefined;
  }
  return undefined;
}

/** 도구의 대상(자르기 전). 활동 기록은 이 글을 가린 다음에 자른다 */
function rawTarget(tool: string, input: unknown, cwd?: string): string | undefined {
  const args = isObject(input) ? input : {};
  const file = text(args.file_path) ?? text(args.notebook_path) ?? text(args.path);
  if (tool === 'apply_patch') return patchPath(patchText(args));
  if (text(args.command)) return firstLine(text(args.command));
  if (Array.isArray(args.command)) return args.command.filter((part): part is string => typeof part === 'string').join(' ');
  if (file) return shortPath(file, cwd);
  return text(args.description) ?? text(args.pattern) ?? text(args.url) ?? text(args.query) ?? text(args.subagent_type);
}

/** 도구의 대상 한 줄. 도구마다 사람이 알아볼 값을 고른다. 고를 것이 없으면 undefined */
export function toolTarget(tool: string, input: unknown, cwd?: string): string | undefined {
  return clean(rawTarget(tool, input, cwd), TARGET_CHARS);
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
export function noteToolUse(state: TerminalActivity, input: Input, at: number, redact?: Redact): void {
  const tool = clean(text(input.tool_name), LABEL_CHARS);
  if (!tool) return;
  const iso = new Date(at).toISOString();
  state.lastAt = iso;
  recordStart(state, input, tool, iso, redact);
  const agentId = text(input.agent_id);
  if (agentId) {
    const subagent = state.subagents.get(agentId);
    if (subagent) {
      subagent.tool = tool;
      subagent.lastAt = iso;
    }
    return;
  }
  // 카드에 보이는 한 줄도 활동 기록과 같은 가림을 거친다. 가리지 못하면 대상 없이 도구 이름만 남긴다
  const target = logTarget(tool, input.tool_input, text(input.cwd), redact);
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
  recordDenied(state, input, reason, new Date(at).toISOString());
  // 거절은 지금 하는 일이 아닌 도구여도 이번 요청의 거절로 센다(#955)
  state.turnDenied = (state.turnDenied ?? 0) + 1;
  state.lastAt = new Date(at).toISOString();
  if (!state.now || !endsNow(state, input)) return;
  const why = errorLine(reason.replace(/^\[b-studio\]\s*/, ''));
  state.now = { ...state.now, running: false, ...(why ? { error: `거절됨: ${why}` } : {}) };
  state.lastAt = new Date(at).toISOString();
}

/** 지켜보는 훅 하나(도구의 끝, 서브에이전트의 시작·끝, 할 일의 생김·끝남). 모르는 훅은 무시한다 */
export function noteActivityHook(state: TerminalActivity, input: Input, at: number, redact?: Redact): void {
  const iso = new Date(at).toISOString();
  switch (input.hook_event_name) {
    case 'PreToolUse':
      noteToolUse(state, input, at, redact);
      return;
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      recordEnd(state, input, iso, redact);
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
      closeOpenEntries(state, subagent.id);
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
  pruneSubagentLogs(state);
}

/** 턴이 끝났다(Stop). 지금 하는 일을 지우고 마지막 답을 남긴다 */
export function noteTurnEnded(state: TerminalActivity, input: Input, at: number = Date.now()): void {
  closeOpenEntries(state);
  delete state.now;
  delete state.nowId;
  delete state.workingSince;
  state.lastAt = new Date(at).toISOString();
  const message = clean(text(input.last_assistant_message), MESSAGE_CHARS);
  if (message) state.lastMessage = message;
}

/** CLI가 끝났다. 지금 하는 일을 지운다(할 일·마지막 답은 남긴다) */
export function noteCliEnded(state: TerminalActivity): void {
  closeOpenEntries(state);
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

// ───────────────────────────────────────────────────────────────────────────
// 에이전트별 최근 활동 기록(#1411, ADR-232)
//
// 기록에 들어가는 글은 바깥(CLI의 훅)에서 온 코드와 명령 결과라 비밀이 섞일 수 있다. 규칙:
//  - 가림은 자르기 전에 한다. 자른 뒤에 가리면 잘린 값이 가림 대상과 일치하지 않아 남는다(scrub → cutLines 순서)
//  - 상한은 읽기·저장 전에 건다(원문이 rawChars를 넘으면 코드 조각은 남기지 않는다)
//  - 판정을 끝까지 못 하면(가림 함수가 던짐, 모르는 모양, 경로 없음) 조각을 남기지 않는다. 대상 이름만 남는다
//  - 비밀 파일(숨긴 경로)의 Edit·Write 조각과, 비밀 파일을 읽거나 환경을 찍는 Bash의 결과는 남기지 않는다. 거부 목록이라 넓게 맞춘다
// ───────────────────────────────────────────────────────────────────────────

/** 비밀 값을 가리는 함수(세션이 아는 비밀 값 목록 기준). 던지면 그 글은 남기지 않는다 */
export type Redact = (text: string) => string;

export type ActivityKind = 'read' | 'search' | 'edit' | 'write' | 'run' | 'other';
/** running: 도는 중, unknown: 끝 훅을 받지 못한 채 턴·CLI·서브에이전트가 끝났다 */
export type ActivityEntryState = 'running' | 'done' | 'failed' | 'denied' | 'unknown';
/** 코드 조각을 남기지 않은 까닭: secret 비밀 파일, unknown 판정 못 함, large 원문이 상한을 넘음 */
export type ActivityWithheld = 'secret' | 'unknown' | 'large';

export interface ActivityChange {
  file?: string;
  /** 지운 쪽(Edit의 old_string) */
  removed?: string;
  /** 쓴 쪽(Edit의 new_string, Write의 내용 앞부분) */
  added?: string;
  /** apply_patch 본문 */
  patch?: string;
  /** 줄 수·줄 길이 상한으로 잘렸다 */
  truncated?: true;
}
export interface ActivityEntry {
  /** 훅의 tool_use_id. 없으면 없다 */
  id?: string;
  /** 도구를 쓰기 시작한 시각(ISO) */
  at: string;
  /** 끝난 시각(ISO) */
  endedAt?: string;
  tool: string;
  kind: ActivityKind;
  state: ActivityEntryState;
  target?: string;
  changes?: ActivityChange[];
  /** Bash 명령(앞 몇 줄) */
  command?: string;
  /** Bash 결과의 끝 몇 줄 */
  output?: string;
  /** 실패·중단·거절의 까닭 한 줄 */
  error?: string;
  withheld?: ActivityWithheld;
  /** 어느 자리든 상한으로 잘렸다 */
  truncated?: true;
}
export interface AgentActivityLog {
  /** 메인은 'main', 서브에이전트는 인스턴스 id */
  id: string;
  main?: true;
  type?: string;
  description?: string;
  state?: 'working' | 'done';
  entries: ActivityEntry[];
}
export interface ActivityLogView {
  agents: AgentActivityLog[];
}

interface LogSlot {
  entry: ActivityEntry;
  seq: number;
  bytes: number;
}
interface AgentLogState {
  slots: LogSlot[];
  /** 끝 훅을 먼저 받아 이미 닫은 호출 id. 늦은 시작 훅이 열린 항목을 만들지 않게 한다 */
  closedIds: string[];
}
export interface ActivityLogState {
  main: AgentLogState;
  subs: Map<string, AgentLogState>;
  bytes: number;
  seq: number;
}

/** 조각을 남기지 않기로 한 까닭을 알리는 내부 신호 */
class Withhold extends Error {
  constructor(readonly reason: ActivityWithheld) {
    super(reason);
  }
}

const READ_TOOLS = new Set(['read', 'notebookread', 'read_file', 'view_image']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'ls', 'websearch', 'toolsearch', 'list_dir']);
const EDIT_TOOLS = new Set(['edit', 'multiedit', 'notebookedit', 'apply_patch']);
const WRITE_TOOLS = new Set(['write']);
const RUN_TOOLS = new Set(['bash', 'shell', 'local_shell', 'exec_command', 'container.exec']);

function kindOf(tool: string): ActivityKind {
  const name = tool.toLowerCase();
  if (READ_TOOLS.has(name)) return 'read';
  if (SEARCH_TOOLS.has(name)) return 'search';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (WRITE_TOOLS.has(name)) return 'write';
  if (RUN_TOOLS.has(name)) return 'run';
  return 'other';
}

// ── 비밀 파일 판정(거부 목록: 넓게 맞춘다. 모르는 입력은 걸린 것으로 본다) ──

/** 이름이 아니라 모양으로 비밀인 파일 이름(기본 판정은 .env 계열만 안다). 거부 목록이라 넓게 맞춘다 */
const SECRET_BASENAME = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|credentials(?:\.[a-z]+)?|secrets?\.(?:json|ya?ml|toml|env)|service[-_]account.*\.json|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk))$/;
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker']);

/** 보이지 않는 글자·끝의 점과 빈칸·대소문자·전각을 접어 비교한다(파일 시스템은 이것들을 달리 읽는다) */
function foldSegment(segment: string): string {
  return segment
    .normalize('NFKC')
    .replace(/[­​-‏‪-‮⁠-⁤﻿]/g, '')
    .replace(/[. ]+$/, '')
    .toLowerCase();
}

/** 이 경로가 비밀 파일(숨긴 경로)인가. 저장소의 기본 판정(.env 계열, Rust)에 모양 판정을 더한다. 역슬래시도 구분자로 읽는다 */
export function isSecretPath(file: string): boolean {
  try {
    if (native.workspaceIsSecretFile(file)) return true;
    for (const raw of file.replace(/\\/g, '/').split('/')) {
      const segment = foldSegment(raw);
      if (!segment) continue;
      if (SECRET_DIRS.has(segment) || SECRET_BASENAME.test(segment)) return true;
      // 접은 이름으로 한 번 더(전각·보이지 않는 글자를 넣은 .env)
      if (segment !== raw && native.workspaceIsSecretFile(segment)) return true;
    }
    return false;
  } catch {
    // 판정을 못 하면 걸린 것으로 본다
    return true;
  }
}

/** 환경 변수 값을 그대로 찍는 명령 낱말 */
const ENV_DUMP_COMMANDS = new Set(['env', 'printenv', 'set', 'export', 'declare', 'typeset', 'compgen']);
const COMMAND_PREFIXES = new Set(['sudo', 'command', 'exec', 'builtin', 'time', 'nohup', 'nice', 'xargs']);

/** 이 명령의 결과에 비밀이 실릴 수 있는가: 비밀 파일 이름이 낱말에 있거나, 환경을 찍는 명령이 있다 */
function commandMayExposeSecrets(command: string): boolean {
  for (const token of command.split(/[\s'"`|;&<>()=,:{}[\]]+/)) if (token && isSecretPath(token)) return true;
  for (const part of command.split(/&&|\|\||[;&|\n]/)) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    let at = 0;
    while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!) || COMMAND_PREFIXES.has(words[at]!))) at += 1;
    if (ENV_DUMP_COMMANDS.has(words[at] ?? '')) return true;
  }
  return false;
}

// ── 가림과 자르기 ──

/** 모양으로 아는 자격 증명. 저장소의 기본 가림(주소 속 계정 정보)과 세션이 아는 비밀 값 가림에 더해, 값의 모양이 뚜렷한 것을 가린다 */
const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[개인 키 가림]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '***'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '***'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '***'],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{12,}/g, '***'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '***'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '***'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***'],
  [/\b(authorization|x-api-key|api-key|proxy-authorization)(\s*[:=]\s*)[^\r\n]+/gi, '$1$2***'],
];

/** 비밀을 뜻하는 낱말이 든 이름(넓게 맞춘다) */
const SECRET_NAME = /password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth/i;
/** 이름 하나와 구분자. 이름의 첫 글자에서만 시작한다(뒤돌아보기) — 이름 한가운데에서 다시 시작하면 긴 이름에서 제곱 시간이 된다 */
const ASSIGN_HEAD = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)["']?[ \t]*[:=][ \t]*/g;
const ASSIGN_VALUE = /"[^"\n]*"|'[^'\n]*'|[^\s,;&)"']+/y;

/**
 * password: "값"·API_KEY=값 같은 대입의 값을 가린다. 이름과 빈칸의 길이에 상한이 없다(상한은 그 길이를 넘겨 쓰는 것으로 비켜 갈 수 있다).
 * 정규식 하나로 하지 않고 "이름+구분자"를 차례로 찾아 이름에 비밀 낱말이 있을 때만 값을 읽는다: 글자마다 한 번씩만 읽어 글 길이에 비례한다.
 * 비밀 이름이 아닌 대입은 값을 건너뛰지 않으므로 `x=token=값`의 안쪽 대입도 본다
 */
function redactAssignments(value: string): string {
  let out = '';
  let from = 0;
  ASSIGN_HEAD.lastIndex = 0;
  for (let head = ASSIGN_HEAD.exec(value); head; head = ASSIGN_HEAD.exec(value)) {
    if (!SECRET_NAME.test(head[1]!)) continue;
    ASSIGN_VALUE.lastIndex = ASSIGN_HEAD.lastIndex;
    const found = ASSIGN_VALUE.exec(value);
    if (!found) continue;
    out += `${value.slice(from, ASSIGN_HEAD.lastIndex)}***`;
    from = ASSIGN_VALUE.lastIndex;
    ASSIGN_HEAD.lastIndex = from;
  }
  return out + value.slice(from);
}

/**
 * 글 한 덩어리를 가린다(자르기 전에). 순서: 색 코드·제어 글자 → 세션이 아는 비밀 값 → 주소 속 계정 정보(저장소의 기본 가림) → 모양으로 아는 자격 증명.
 * 가림 함수가 던지거나 끝 표시만 남은 개인 키 조각이 보이면 이 글은 남기지 않는다(Withhold)
 */
function scrub(raw: string, redact: Redact | undefined): string {
  let result = stripAnsi(raw).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  try {
    if (redact) result = redact(result);
    result = native.checkpointRedactCredentials(result);
  } catch {
    throw new Withhold('unknown');
  }
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) result = result.replace(pattern, replacement);
  result = redactAssignments(result);
  // 앞이 잘려 끝 표시만 남은 키 본문은 모양으로 가릴 수 없다
  if (/PRIVATE KEY-----/.test(result)) throw new Withhold('secret');
  return result;
}

/** 줄 수·줄 길이로 자른다. side가 tail이면 끝 줄을 남긴다. 뒤쪽 빈 줄은 센 줄이 아니다 */
function cutLines(value: string, maxLines: number, side: 'head' | 'tail'): { text: string; truncated: boolean } {
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
  let truncated = lines.length > maxLines;
  const kept = side === 'head' ? lines.slice(0, maxLines) : lines.slice(-maxLines);
  const text = kept
    .map((line) => {
      if (line.length <= ACTIVITY_LIMITS.lineChars) return line;
      truncated = true;
      return `${line.slice(0, ACTIVITY_LIMITS.lineChars - 1).trimEnd()}…`;
    })
    .join('\n');
  return { text, truncated };
}

/** 가리고 자른 글 하나와 잘렸는지. 원문이 rawChars를 넘으면 가림이 끝까지 읽지 못하므로 던진다 */
function snippet(raw: string, redact: Redact | undefined, maxLines: number, side: 'head' | 'tail'): { text: string; truncated: boolean } {
  if (raw.length > ACTIVITY_LIMITS.rawChars) throw new Withhold('large');
  return cutLines(scrub(raw, redact), maxLines, side);
}

// ── 기록하기 ──

const cleanId = (value: unknown): string | undefined => clean(text(value), LABEL_CHARS);

function logState(state: TerminalActivity): ActivityLogState {
  return (state.log ??= { main: { slots: [], closedIds: [] }, subs: new Map(), bytes: 0, seq: 0 });
}

/** 입력이 속한 에이전트의 기록. 서브에이전트가 상한을 넘으면 없다 */
function agentLog(state: TerminalActivity, input: Input, create: boolean): AgentLogState | undefined {
  const log = state.log;
  const agent = cleanId(input.agent_id);
  if (!agent) return create ? logState(state).main : log?.main;
  const found = log?.subs.get(agent);
  if (found || !create) return found;
  const created = logState(state);
  if (created.subs.size >= ACTIVITY_LIMITS.agents) return undefined;
  const fresh: AgentLogState = { slots: [], closedIds: [] };
  created.subs.set(agent, fresh);
  return fresh;
}

const sizeOf = (entry: ActivityEntry): number => Buffer.byteLength(JSON.stringify(entry));

function dropSlot(log: ActivityLogState, agent: AgentLogState, index: number): void {
  const [slot] = agent.slots.splice(index, 1);
  if (slot) log.bytes -= slot.bytes;
}

/** 항목 수와 세션 전체 크기의 상한을 지킨다: 오래된 것부터 버린다 */
function enforceLimits(log: ActivityLogState): void {
  for (const agent of [log.main, ...log.subs.values()]) while (agent.slots.length > ACTIVITY_LIMITS.entriesPerAgent) dropSlot(log, agent, 0);
  while (log.bytes > ACTIVITY_LIMITS.totalBytes) {
    let oldest: AgentLogState | undefined;
    for (const agent of [log.main, ...log.subs.values()]) {
      const first = agent.slots[0];
      if (first && (!oldest || first.seq < oldest.slots[0]!.seq)) oldest = agent;
    }
    if (!oldest) return;
    dropSlot(log, oldest, 0);
  }
}

function addSlot(state: TerminalActivity, agent: AgentLogState, entry: ActivityEntry): LogSlot {
  const log = logState(state);
  const slot: LogSlot = { entry, seq: (log.seq += 1), bytes: sizeOf(entry) };
  agent.slots.push(slot);
  log.bytes += slot.bytes;
  enforceLimits(log);
  return slot;
}

function resize(state: TerminalActivity, slot: LogSlot): void {
  const log = state.log;
  if (!log) return;
  const bytes = sizeOf(slot.entry);
  log.bytes += bytes - slot.bytes;
  slot.bytes = bytes;
  enforceLimits(log);
}

/** 도구 대상 한 줄을 가린 다음 자른다. 가림을 못 하면 대상을 비운다 */
function logTarget(tool: string, input: unknown, cwd: string | undefined, redact: Redact | undefined): string | undefined {
  const raw = rawTarget(tool, input, cwd);
  if (!raw) return undefined;
  try {
    return clean(scrub(raw.length > ACTIVITY_LIMITS.rawChars ? raw.slice(0, ACTIVITY_LIMITS.rawChars) : raw, redact), TARGET_CHARS);
  } catch {
    return undefined;
  }
}

/** 비밀 파일 판정이 끝난 경로의 표시 이름(작업 폴더 기준). 가림을 거친다 */
function shownFile(file: string, cwd: string | undefined, redact: Redact | undefined): string | undefined {
  try {
    return clean(scrub(shortPath(file, cwd), redact), TARGET_CHARS);
  } catch {
    return undefined;
  }
}

interface ChangeSource {
  file?: string;
  removed?: string;
  added?: string;
  patch?: string;
}

/** 이 도구 입력의 코드 조각 원문들. 모르는 모양이면 빈 목록. 거름은 여기서 하지 않는다(가림 전의 원문) */
function changeSources(tool: string, args: Record<string, unknown>): { sources: ChangeSource[]; more: boolean } {
  const name = tool.toLowerCase();
  const sources: ChangeSource[] = [];
  let more = false;
  if (name === 'write') {
    const added = typeof args.content === 'string' ? args.content : undefined;
    if (added !== undefined) sources.push({ added });
  } else if (name === 'edit') {
    const removed = typeof args.old_string === 'string' ? args.old_string : undefined;
    const added = typeof args.new_string === 'string' ? args.new_string : undefined;
    if (removed !== undefined || added !== undefined) sources.push({ ...(removed !== undefined ? { removed } : {}), ...(added !== undefined ? { added } : {}) });
  } else if (name === 'multiedit') {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    for (const edit of edits) {
      if (!isObject(edit)) continue;
      const removed = typeof edit.old_string === 'string' ? edit.old_string : undefined;
      const added = typeof edit.new_string === 'string' ? edit.new_string : undefined;
      if (removed === undefined && added === undefined) continue;
      if (sources.length >= ACTIVITY_LIMITS.changes) {
        more = true;
        break;
      }
      sources.push({ ...(removed !== undefined ? { removed } : {}), ...(added !== undefined ? { added } : {}) });
    }
  } else if (name === 'notebookedit') {
    const added = typeof args.new_source === 'string' ? args.new_source : undefined;
    if (added !== undefined) sources.push({ added });
  }
  return { sources, more };
}

/** apply_patch 본문이 건드리는 모든 파일 경로(헤더 줄). 하나도 못 읽으면 빈 목록 */
function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const header = /^\s*\*\*\* (?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/.exec(line) ?? /^(?:\+\+\+|---) (?:[ab]\/)?(\S.*?)\s*$/.exec(line) ?? /^diff --git a\/(.+?) b\/(.+?)\s*$/.exec(line);
    if (!header) continue;
    for (const file of header.slice(1)) if (file && file !== '/dev/null') files.push(file);
  }
  return files;
}

/** 고치기·쓰기 항목의 코드 조각. 비밀 파일·모르는 경로·모르는 모양이면 조각 없이 까닭만 정한다 */
function fillChanges(entry: ActivityEntry, tool: string, args: Record<string, unknown>, cwd: string | undefined, redact: Redact | undefined): void {
  if (tool.toLowerCase() === 'apply_patch') {
    const patch = patchText(args);
    if (patch === undefined) return;
    if (patch.length > ACTIVITY_LIMITS.rawChars) throw new Withhold('large');
    const files = patchFiles(patch);
    if (files.length === 0) throw new Withhold('unknown');
    if (files.some((file) => isSecretPath(file))) throw new Withhold('secret');
    const cut = snippet(patch, redact, ACTIVITY_LIMITS.codeLines, 'head');
    const file = shownFile(files[0]!, cwd, redact);
    entry.changes = [{ ...(file ? { file } : {}), patch: cut.text, ...(cut.truncated ? { truncated: true as const } : {}) }];
    if (cut.truncated) entry.truncated = true;
    return;
  }
  const file = text(args.file_path) ?? text(args.notebook_path) ?? text(args.path);
  if (!file) throw new Withhold('unknown');
  if (isSecretPath(file)) throw new Withhold('secret');
  const { sources, more } = changeSources(tool, args);
  if (sources.length === 0) return;
  const shown = shownFile(file, cwd, redact);
  // 모든 조각을 먼저 가리고(snippet이 던지면 하나도 남기지 않는다) 그다음에 붙인다
  const changes = sources.map((source): ActivityChange => {
    const removed = source.removed === undefined ? undefined : snippet(source.removed, redact, ACTIVITY_LIMITS.codeLines, 'head');
    const added = source.added === undefined ? undefined : snippet(source.added, redact, ACTIVITY_LIMITS.codeLines, 'head');
    const truncated = Boolean(removed?.truncated || added?.truncated);
    return { ...(shown ? { file: shown } : {}), ...(removed ? { removed: removed.text } : {}), ...(added ? { added: added.text } : {}), ...(truncated ? { truncated: true as const } : {}) };
  });
  entry.changes = changes;
  if (more || changes.some((change) => change.truncated)) entry.truncated = true;
}

/** Bash 명령 글(자르기 전). 배열이면 낱말을 이어 붙인다 */
function commandText(args: Record<string, unknown>): string | undefined {
  if (typeof args.command === 'string' && args.command) return args.command;
  if (Array.isArray(args.command)) {
    const joined = args.command.filter((part): part is string => typeof part === 'string').join(' ');
    return joined || undefined;
  }
  return undefined;
}

function fillCommand(entry: ActivityEntry, args: Record<string, unknown>, redact: Redact | undefined): void {
  const command = commandText(args);
  if (command === undefined) throw new Withhold('unknown');
  if (command.length > ACTIVITY_LIMITS.rawChars) throw new Withhold('large');
  // 결과를 남길지는 명령으로 정한다. 이 판정은 가림이 실패해도 한다
  const exposes = commandMayExposeSecrets(command);
  try {
    const cut = snippet(command, redact, ACTIVITY_LIMITS.commandLines, 'head');
    entry.command = cut.text;
    if (cut.truncated) entry.truncated = true;
  } catch (error) {
    if (!(error instanceof Withhold)) throw error;
    entry.withheld = exposes ? 'secret' : error.reason;
    return;
  }
  if (exposes) entry.withheld = 'secret';
}

/** 시작 훅 하나로 만드는 항목. 던지지 않는다 */
function buildEntry(tool: string, input: unknown, at: string, id: string | undefined, entryState: ActivityEntryState, cwd: string | undefined, redact: Redact | undefined): ActivityEntry {
  const kind = kindOf(tool);
  const entry: ActivityEntry = { at, tool, kind, state: entryState, ...(id ? { id } : {}) };
  const target = logTarget(tool, input, cwd, redact);
  if (target) entry.target = target;
  const args = isObject(input) ? input : {};
  try {
    if (kind === 'edit' || kind === 'write') fillChanges(entry, tool, args, cwd, redact);
    else if (kind === 'run') fillCommand(entry, args, redact);
  } catch (error) {
    // 조각은 하나도 남기지 않는다
    delete entry.changes;
    delete entry.command;
    entry.withheld = error instanceof Withhold ? error.reason : 'unknown';
    if (entry.withheld === 'large') entry.truncated = true;
  }
  return entry;
}

/** 시작 훅: 항목을 만든다. 같은 호출 id가 이미 있거나 이미 닫혔으면 만들지 않는다 */
function recordStart(state: TerminalActivity, input: Input, tool: string, at: string, redact: Redact | undefined): void {
  const agent = agentLog(state, input, true);
  if (!agent) return;
  const id = cleanId(input.tool_use_id);
  if (id && (agent.closedIds.includes(id) || agent.slots.some((slot) => slot.entry.id === id))) return;
  addSlot(state, agent, buildEntry(tool, input.tool_input, at, id, 'running', text(input.cwd), redact));
}

/** 같은 호출의 항목. id가 있으면 id로, 없으면 이 에이전트의 마지막 열린 같은 도구 항목 */
function findOpen(agent: AgentLogState, input: Input, tool: string | undefined, states: readonly ActivityEntryState[]): LogSlot | undefined {
  const id = cleanId(input.tool_use_id);
  if (id) {
    const slot = agent.slots.findLast((candidate) => candidate.entry.id === id);
    return slot && states.includes(slot.entry.state) ? slot : undefined;
  }
  return agent.slots.findLast((candidate) => candidate.entry.state === 'running' && (!tool || candidate.entry.tool === tool));
}

/** Bash 결과 글. 글 하나이거나 stdout·stderr(·output)를 이어 붙인다. 모르는 모양이면 undefined */
function responseText(response: unknown): string | undefined {
  if (typeof response === 'string') return response || undefined;
  if (!isObject(response)) return undefined;
  const parts = [response.stdout, response.stderr, response.output].filter((part): part is string => typeof part === 'string' && part.length > 0);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** 결과의 끝쪽만 읽는다: 원문이 상한을 넘으면 끝 rawChars 글자에서 첫 줄바꿈 뒤부터(한 줄이 둘로 쪼개져 가림에서 빠지지 않게) */
function outputTail(raw: string): { text: string; clipped: boolean } {
  if (raw.length <= ACTIVITY_LIMITS.rawChars) return { text: raw, clipped: false };
  const tail = raw.slice(-ACTIVITY_LIMITS.rawChars);
  const newline = tail.indexOf('\n');
  return { text: newline >= 0 ? tail.slice(newline + 1) : '', clipped: true };
}

function fillOutput(entry: ActivityEntry, response: unknown, redact: Redact | undefined): void {
  const raw = responseText(response);
  if (raw === undefined) return;
  try {
    const { text: body, clipped } = outputTail(raw);
    const cut = cutLines(scrub(body, redact), ACTIVITY_LIMITS.outputLines, 'tail');
    if (cut.text) entry.output = cut.text;
    if (cut.truncated || clipped) entry.truncated = true;
  } catch (error) {
    delete entry.output;
    entry.withheld = error instanceof Withhold ? error.reason : 'unknown';
  }
}

/** 실패의 까닭 한 줄(가린 다음 첫 줄). 가림을 못 하면 까닭을 비운다 */
function failureReason(input: Input, redact: Redact | undefined): string | undefined {
  if (input.is_interrupt === true) return '중단됨';
  const error = text(input.error);
  if (!error) return undefined;
  try {
    return clean(firstLine(scrub(error.length > ACTIVITY_LIMITS.rawChars ? error.slice(0, ACTIVITY_LIMITS.rawChars) : error, redact)), TARGET_CHARS);
  } catch {
    return undefined;
  }
}

/** 끝 훅(PostToolUse·PostToolUseFailure): 같은 호출의 항목을 닫는다. 시작 훅보다 먼저 왔으면 닫힌 항목을 바로 만든다 */
function recordEnd(state: TerminalActivity, input: Input, at: string, redact: Redact | undefined): void {
  const tool = clean(text(input.tool_name), LABEL_CHARS);
  const agent = agentLog(state, input, true);
  if (!agent) return;
  const failed = input.hook_event_name === 'PostToolUseFailure';
  const id = cleanId(input.tool_use_id);
  let slot = findOpen(agent, input, tool, ['running', 'unknown']);
  if (!slot) {
    // 이미 닫힌 호출이거나 모르는 호출. id가 있고 도구 이름도 있으면 먼저 온 끝으로 보고 닫힌 항목을 만든다
    if (!id || !tool || agent.closedIds.includes(id) || agent.slots.some((candidate) => candidate.entry.id === id)) return;
    slot = addSlot(state, agent, buildEntry(tool, input.tool_input, at, id, 'running', text(input.cwd), redact));
    agent.closedIds = [...agent.closedIds, id].slice(-ENDED_LIMIT);
  }
  const entry = slot.entry;
  entry.state = failed ? 'failed' : 'done';
  entry.endedAt = at;
  if (failed) {
    const why = failureReason(input, redact);
    if (why) entry.error = why;
  } else if (entry.kind === 'run' && !entry.withheld) {
    fillOutput(entry, input.tool_response, redact);
  }
  resize(state, slot);
}

/** 쓰기 직전 훅이 거절했다: 그 항목에 거절 까닭을 남긴다 */
function recordDenied(state: TerminalActivity, input: Input, reason: string, at: string): void {
  const agent = agentLog(state, input, false);
  if (!agent) return;
  const slot = findOpen(agent, input, clean(text(input.tool_name), LABEL_CHARS), ['running']);
  if (!slot) return;
  slot.entry.state = 'denied';
  slot.entry.endedAt = at;
  try {
    const why = clean(firstLine(scrub(reason.replace(/^\[b-studio\]\s*/, ''), undefined)), TARGET_CHARS);
    if (why) slot.entry.error = `거절됨: ${why}`;
  } catch {
    // 까닭을 못 가리면 까닭 없이 거절됨만 남긴다
  }
  resize(state, slot);
}

/** 끝 훅을 받지 못한 열린 항목을 unknown으로 닫는다. agentId가 있으면 그 서브에이전트만 */
function closeOpenEntries(state: TerminalActivity, agentId?: string): void {
  const log = state.log;
  if (!log) return;
  const targets = agentId === undefined ? [log.main, ...log.subs.values()] : [log.subs.get(agentId)];
  for (const agent of targets) {
    for (const slot of agent?.slots ?? []) {
      if (slot.entry.state !== 'running') continue;
      slot.entry.state = 'unknown';
      resize(state, slot);
    }
  }
}

/** 새 요청이 왔다: 끝난 서브에이전트와 서브에이전트 목록에 없는 기록을 지운다(메인의 기록은 남긴다) */
function pruneSubagentLogs(state: TerminalActivity): void {
  const log = state.log;
  if (!log) return;
  for (const [id, agent] of log.subs) {
    if (state.subagents.has(id)) continue;
    log.bytes -= agent.slots.reduce((sum, slot) => sum + slot.bytes, 0);
    log.subs.delete(id);
  }
}

/** 활동 기록을 모두 지운다(세션이 멈출 때) */
export function clearActivityLog(state: TerminalActivity): void {
  delete state.log;
}

function entryView(entry: ActivityEntry): ActivityEntry {
  return { ...entry, ...(entry.changes ? { changes: entry.changes.map((change) => ({ ...change })) } : {}) };
}

/**
 * 에이전트별 활동 기록. agent가 'main'이면 메인만, 그 밖의 값이면 그 id의 서브에이전트만 준다.
 * 기록을 한 번도 남기지 않았거나 지웠으면 undefined. 크기는 ACTIVITY_LIMITS.totalBytes 안이다(저장할 때 이미 지켰다)
 */
export function activityLog(state: TerminalActivity | undefined, options: { agent?: string } = {}): ActivityLogView | undefined {
  const log = state?.log;
  if (!state || !log) return undefined;
  const agents: AgentActivityLog[] = [];
  if (log.main.slots.length > 0 && (options.agent === undefined || options.agent === 'main')) {
    agents.push({ id: 'main', main: true, entries: log.main.slots.map((slot) => entryView(slot.entry)) });
  }
  if (options.agent !== 'main') {
    for (const [id, agent] of log.subs) {
      if (agent.slots.length === 0 || (options.agent !== undefined && options.agent !== id)) continue;
      const subagent = state.subagents.get(id);
      agents.push({
        id,
        ...(subagent?.type ? { type: subagent.type } : {}),
        ...(subagent?.description ? { description: subagent.description } : {}),
        ...(subagent ? { state: subagent.state } : {}),
        entries: agent.slots.map((slot) => entryView(slot.entry)),
      });
    }
  }
  return { agents };
}
