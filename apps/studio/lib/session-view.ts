import type { AgentEvent, VerificationReport } from '@b-studio/agent';
import type { SessionSnapshot, StudioEvent } from './studio-events';

export interface LogEntry {
  service: string;
  text: string;
  at: string;
}

export interface ToolCallView {
  name: string;
  summary: string;
  ok?: boolean;
  output?: string;
}

export type ChatItem =
  | { kind: 'request'; runId: string; text: string }
  | { kind: 'reply'; runId: string; text: string }
  | { kind: 'tools'; runId: string; calls: ToolCallView[] }
  | { kind: 'gate'; runId: string; files: string[]; report?: VerificationReport }
  | { kind: 'outcome'; runId: string; status: 'done' | 'failed' | 'error'; summary: string; turns?: number };

type ToolsItem = Extract<ChatItem, { kind: 'tools' }>;
type GateItem = Extract<ChatItem, { kind: 'gate' }>;

export interface SessionView {
  snapshot: SessionSnapshot;
  chat: ChatItem[];
  logs: LogEntry[];
  /** 끝난 요청 수. 미리보기와 계약을 새로 불러오는 기준으로 쓴다 */
  completedRuns: number;
}

export const LOG_LIMIT = 1000;

export function createView(snapshot: SessionSnapshot): SessionView {
  return { snapshot, chat: [], logs: [], completedRuns: 0 };
}

/**
 * 서버 이벤트를 화면 상태로 접는다.
 * 다시 연결하면 서버가 snapshot부터 전체 기록을 다시 보내므로, snapshot에서 상태를 초기화해 중복을 막는다.
 */
export function reduceSession(view: SessionView, event: StudioEvent): SessionView {
  switch (event.type) {
    case 'snapshot':
      return createView(event.snapshot);
    case 'status':
      return patchSnapshot(view, { status: event.status, error: event.error });
    case 'service':
      return patchSnapshot(view, {
        services: view.snapshot.services.map((service) =>
          service.name === event.service
            ? { ...service, state: event.state, url: event.url ?? service.url, detail: event.detail }
            : service,
        ),
      });
    case 'log': {
      const logs = view.logs.length >= LOG_LIMIT ? view.logs.slice(view.logs.length - LOG_LIMIT + 1) : [...view.logs];
      logs.push({ service: event.service, text: event.text, at: event.at });
      return { ...view, logs };
    }
    case 'run_started':
      return {
        ...patchSnapshot(view, { running: true }),
        chat: [...view.chat, { kind: 'request', runId: event.runId, text: event.request }],
      };
    case 'agent':
      return { ...view, chat: applyAgentEvent(view.chat, event.runId, event.event) };
    case 'run_finished':
      return {
        ...patchSnapshot(view, { running: false, nextDemoRequest: event.nextDemoRequest }),
        chat: [
          ...view.chat,
          { kind: 'outcome', runId: event.runId, status: event.status, summary: event.summary, turns: event.turns },
        ],
        completedRuns: view.completedRuns + 1,
      };
  }
}

function patchSnapshot(view: SessionView, patch: Partial<SessionSnapshot>): SessionView {
  return { ...view, snapshot: { ...view.snapshot, ...patch } };
}

function applyAgentEvent(chat: ChatItem[], runId: string, event: AgentEvent): ChatItem[] {
  switch (event.type) {
    case 'text':
      return [...chat, { kind: 'reply', runId, text: event.text }];

    case 'tool_call': {
      const call: ToolCallView = { name: event.name, summary: describeToolCall(event.name, event.input) };
      const last = chat.at(-1);
      // 연속된 도구 호출은 한 묶음으로 보여준다
      if (last?.kind === 'tools' && last.runId === runId) {
        return [...chat.slice(0, -1), { ...last, calls: [...last.calls, call] }];
      }
      return [...chat, { kind: 'tools', runId, calls: [call] }];
    }

    case 'tool_result': {
      const index = chat.findLastIndex((item) => item.kind === 'tools' && item.runId === runId);
      if (index === -1) return chat;
      const item = chat[index] as ToolsItem;
      const callIndex = item.calls.findIndex((call) => call.ok === undefined && call.name === event.name);
      if (callIndex === -1) return chat;
      const calls = item.calls.map((call, i) => (i === callIndex ? { ...call, ok: event.ok, output: event.content } : call));
      return chat.map((entry, i) => (i === index ? { ...item, calls } : entry));
    }

    case 'verify_start':
      return [...chat, { kind: 'gate', runId, files: event.files }];

    case 'verify_result': {
      const index = chat.findLastIndex((item) => item.kind === 'gate' && item.runId === runId && !item.report);
      if (index === -1) return chat;
      return chat.map((entry, i) => (i === index ? { ...(entry as GateItem), report: event.report } : entry));
    }

    default:
      return chat;
  }
}

export function describeToolCall(name: string, input: unknown): string {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');

  switch (name) {
    case 'list_files':
      return `파일 목록 ${text(args.path)}`;
    case 'read_file':
      return `읽기 ${text(args.path)}`;
    case 'write_file':
      return `작성 ${text(args.path)}`;
    case 'edit_file':
      return `수정 ${text(args.path)}`;
    case 'run_in_service':
      return `실행 ${text(args.service)}: ${Array.isArray(args.command) ? args.command.join(' ') : ''}`;
    case 'restart_service':
      return `재시작 ${text(args.service)}`;
    case 'service_logs':
      return `로그 확인 ${text(args.service)}`;
    case 'http_request':
      return `요청 ${text(args.service)} ${text(args.method)} ${text(args.path)}`;
    case 'get_contract':
      return `계약 확인 ${text(args.service)}`;
    default:
      return name;
  }
}
