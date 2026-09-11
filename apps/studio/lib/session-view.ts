import type { AgentEvent, AgentUsage, Checkpoint, DatabaseState, GitHostKind, ServiceCheck, VerificationReport } from '@b-studio/agent';
import type { RemoteCommitView, SessionSnapshot, StudioEvent } from './studio-events';

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
  /** 파일을 쓰거나 고친 도구의 대상 경로. 코드 화면이 에이전트가 방금 고친 파일을 따라갈 때 쓴다 */
  path?: string;
  /** 결과가 오기 전에 요청이 끝났다 */
  interrupted?: boolean;
}

export type ChatItem =
  | { kind: 'request'; runId: string; text: string; by?: string; intent?: 'ask' }
  | { kind: 'backend'; runId: string; backend: string; model: string; auth?: string }
  | { kind: 'reply'; runId: string; text: string }
  | { kind: 'tools'; runId: string; calls: ToolCallView[] }
  /** interrupted: 결과가 오기 전에 요청이 끝났다 (서버가 멈췄거나 요청이 오류로 끝남) */
  | { kind: 'gate'; runId: string; files: string[]; report?: VerificationReport; interrupted?: boolean }
  | {
      kind: 'outcome';
      runId: string;
      status: 'done' | 'failed' | 'error' | 'cancelled';
      summary: string;
      turns?: number;
      usage?: AgentUsage;
      /** 질문 모드 요청의 결과 */
      intent?: 'ask';
    }
  | { kind: 'checkpoint'; runId: string; checkpoint: Checkpoint }
  /** 로컬 폴더 세션에서 스튜디오 밖에서 바꾼 파일을 남긴 체크포인트 */
  | { kind: 'localEdits'; checkpoint: Checkpoint; reason: 'request' | 'resume' }
  | {
      kind: 'reverted';
      runId: string;
      /** 게이트 실패가 아니라 사용자가 취소해서 되돌렸다 */
      cancelled?: boolean;
      files: string[];
      patch: string;
      restarted: ServiceCheck[];
      databases: DatabaseState[];
    }
  | {
      kind: 'restore';
      checkpoint: Checkpoint;
      result?: { ok: true; files: string[]; restarted: ServiceCheck[]; databases: DatabaseState[] } | { ok: false; error: string };
    }
  | { kind: 'resumed'; checkpoint: Checkpoint; discarded: string[]; databases: DatabaseState[]; restarted: ServiceCheck[] }
  | {
      kind: 'remoteSync';
      result?:
        | {
            ok: true;
            status: 'up-to-date' | 'merged' | 'picked';
            commits: RemoteCommitView[];
            files: string[];
            checkpoint?: Checkpoint;
            report?: VerificationReport;
          }
        | {
            ok: false;
            error: string;
            conflicts?: string[];
            commits?: RemoteCommitView[];
            files?: string[];
            report?: VerificationReport;
            restarted?: ServiceCheck[];
          };
    }
  | {
      kind: 'exported';
      branch: string;
      hostKind: GitHostKind;
      commits: number;
      forced: boolean;
      pullRequest?: { url: string; created: boolean };
      pullRequestError?: string;
    };

type ToolsItem = Extract<ChatItem, { kind: 'tools' }>;
type GateItem = Extract<ChatItem, { kind: 'gate' }>;
type RestoreItem = Extract<ChatItem, { kind: 'restore' }>;
type RemoteSyncItem = Extract<ChatItem, { kind: 'remoteSync' }>;

export interface SessionView {
  snapshot: SessionSnapshot;
  chat: ChatItem[];
  logs: LogEntry[];
  /** 끝난 요청 수. 미리보기와 계약을 새로 불러오는 기준으로 쓴다 */
  completedRuns: number;
  /** 처리 중인 요청이 지금까지 쓴 토큰 */
  runTokens?: { runId: string; usage: AgentUsage };
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
            ? // 재시작 중에는 이전 주소로 미리보기를 유지하고, 중지하면 주소를 지운다
              {
                ...service,
                state: event.state,
                url: event.state === 'stopped' ? undefined : (event.url ?? service.url),
                previewUrl: event.state === 'stopped' ? undefined : (event.previewUrl ?? service.previewUrl),
                detail: event.detail,
              }
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
        chat: [...view.chat, { kind: 'request', runId: event.runId, text: event.request, by: event.by, intent: event.intent }],
      };
    case 'agent':
      return { ...view, chat: applyAgentEvent(view.chat, event.runId, event.event) };
    case 'tokens':
      // 합계를 더하지 않고 서버가 보낸 값으로 바꿔서, 다시 연결해 기록을 재생해도 두 번 세지 않는다
      return { ...patchSnapshot(view, { tokens: event.sessionTokens }), runTokens: { runId: event.runId, usage: event.usage } };
    case 'run_cancelling':
      return patchSnapshot(view, { cancelling: event.reason ?? 'user' });
    case 'run_finished': {
      const request = view.chat.find((item) => item.kind === 'request' && item.runId === event.runId);
      const intent = request?.kind === 'request' ? request.intent : undefined;
      return {
        ...patchSnapshot(view, {
          running: false,
          cancelling: undefined,
          nextDemoRequest: event.nextDemoRequest,
          nextDemoQuestion: event.nextDemoQuestion,
          tokens: event.sessionTokens ?? view.snapshot.tokens,
        }),
        chat: [
          ...markInterrupted(view.chat, event.runId),
          { kind: 'outcome', runId: event.runId, status: event.status, summary: event.summary, turns: event.turns, usage: event.usage, intent },
        ],
        completedRuns: view.completedRuns + 1,
        runTokens: undefined,
      };
    }

    case 'checkpoint': {
      // 다시 연결하면 서버가 이미 체크포인트가 반영된 스냅샷을 보낸 뒤 기록을 재생하므로, 같은 체크포인트는 한 번만 쌓는다
      const known = view.snapshot.checkpoints.some((checkpoint) => checkpoint.sha === event.checkpoint.sha);
      return {
        ...(known ? view : patchSnapshot(view, { checkpoints: [event.checkpoint, ...view.snapshot.checkpoints] })),
        chat: [...view.chat, { kind: 'checkpoint', runId: event.runId, checkpoint: event.checkpoint }],
      };
    }

    case 'local_edits_saved': {
      const known = view.snapshot.checkpoints.some((checkpoint) => checkpoint.sha === event.checkpoint.sha);
      return {
        ...(known ? view : patchSnapshot(view, { checkpoints: [event.checkpoint, ...view.snapshot.checkpoints] })),
        chat: [...view.chat, { kind: 'localEdits', checkpoint: event.checkpoint, reason: event.reason }],
      };
    }

    case 'reverted':
      return {
        ...view,
        chat: [
          ...view.chat,
          {
            kind: 'reverted',
            runId: event.runId,
            cancelled: event.cancelled,
            files: event.files,
            patch: event.patch,
            restarted: event.restarted,
            databases: event.databases,
          },
        ],
      };

    case 'restore_started':
      return { ...patchSnapshot(view, { running: true }), chat: [...view.chat, { kind: 'restore', checkpoint: event.checkpoint }] };

    case 'restored':
      return {
        ...patchSnapshot(view, {
          running: false,
          checkpoints: event.checkpoints,
          nextDemoRequest: event.nextDemoRequest,
          nextDemoQuestion: event.nextDemoQuestion,
        }),
        chat: settleRestore(view.chat, event.checkpoint.sha, {
          ok: true,
          files: event.files,
          restarted: event.restarted,
          databases: event.databases,
        }),
        // 파일이 바뀌었으므로 미리보기와 계약을 다시 불러오게 한다
        completedRuns: view.completedRuns + 1,
      };

    case 'restore_failed':
      return {
        ...patchSnapshot(view, { running: false }),
        chat: settleRestore(view.chat, event.checkpoint.sha, { ok: false, error: event.error }),
      };

    case 'resumed':
      return {
        ...view,
        chat: [
          ...view.chat,
          { kind: 'resumed', checkpoint: event.checkpoint, discarded: event.discarded, databases: event.databases, restarted: event.restarted },
        ],
        // 새 샌드박스의 주소로 미리보기와 계약을 다시 불러오게 한다
        completedRuns: view.completedRuns + 1,
      };

    case 'remote_sync_started':
      return { ...patchSnapshot(view, { running: true }), chat: [...view.chat, { kind: 'remoteSync' }] };

    case 'remote_synced':
      return {
        ...patchSnapshot(view, { running: false, checkpoints: event.checkpoints, repository: event.repository }),
        chat: settleRemoteSync(view.chat, {
          ok: true,
          status: event.status,
          commits: event.commits,
          files: event.files,
          checkpoint: event.checkpoint,
          report: event.report,
        }),
        // 파일이 바뀌었으면 미리보기와 계약을 다시 불러오게 한다
        completedRuns: event.status === 'up-to-date' ? view.completedRuns : view.completedRuns + 1,
      };

    case 'remote_sync_failed':
      return {
        ...patchSnapshot(view, { running: false, ...(event.checkpoints ? { checkpoints: event.checkpoints } : {}) }),
        chat: settleRemoteSync(view.chat, {
          ok: false,
          error: event.error,
          conflicts: event.conflicts,
          commits: event.commits,
          files: event.files,
          report: event.report,
          restarted: event.restarted,
        }),
        // 가져온 변경을 반영했다가 되돌렸으면 서비스가 다시 떴다
        completedRuns: event.restarted ? view.completedRuns + 1 : view.completedRuns,
      };

    case 'usage':
      return patchSnapshot(view, { usage: { at: event.at, services: event.services } });

    case 'files_changed':
      return patchSnapshot(view, { fileRevision: event.revision });

    case 'exported':
      // 원격 상태는 통째로 바꾸므로 기록을 다시 재생해도 결과가 같다
      return {
        ...patchSnapshot(view, { repository: event.repository }),
        chat: [
          ...view.chat,
          {
            kind: 'exported',
            branch: event.repository.branch,
            hostKind: event.repository.kind,
            commits: event.commits,
            forced: event.forced,
            pullRequest: event.pullRequest,
            pullRequestError: event.pullRequestError,
          },
        ],
      };
  }
}

/** 요청이 끝났는데 결과가 오지 않은 게이트와 도구 호출을 중단으로 확정한다. 그대로 두면 "확인 중"에 멈춰 보인다 */
function markInterrupted(chat: ChatItem[], runId: string): ChatItem[] {
  return chat.map((item) => {
    if (item.kind === 'gate' && item.runId === runId && !item.report) return { ...item, interrupted: true };
    if (item.kind === 'tools' && item.runId === runId && item.calls.some((call) => call.ok === undefined)) {
      return { ...item, calls: item.calls.map((call) => (call.ok === undefined ? { ...call, interrupted: true } : call)) };
    }
    return item;
  });
}

function settleRemoteSync(chat: ChatItem[], result: NonNullable<RemoteSyncItem['result']>): ChatItem[] {
  const index = chat.findLastIndex((item) => item.kind === 'remoteSync' && !item.result);
  // 기록이 잘려 시작 이벤트가 없으면 결과만 붙인다
  if (index === -1) return [...chat, { kind: 'remoteSync', result }];
  return chat.map((item, i) => (i === index ? { kind: 'remoteSync', result } : item));
}

function settleRestore(chat: ChatItem[], sha: string, result: NonNullable<RestoreItem['result']>): ChatItem[] {
  const index = chat.findLastIndex((item) => item.kind === 'restore' && item.checkpoint.sha === sha && !item.result);
  if (index === -1) return chat;
  return chat.map((item, i) => (i === index ? { ...(item as RestoreItem), result } : item));
}

function patchSnapshot(view: SessionView, patch: Partial<SessionSnapshot>): SessionView {
  return { ...view, snapshot: { ...view.snapshot, ...patch } };
}

function applyAgentEvent(chat: ChatItem[], runId: string, event: AgentEvent): ChatItem[] {
  switch (event.type) {
    case 'session':
      return [...chat, { kind: 'backend', runId, backend: event.backend, model: event.model, auth: event.auth }];

    case 'text':
      return [...chat, { kind: 'reply', runId, text: event.text }];

    case 'tool_call': {
      const call: ToolCallView = { name: event.name, summary: describeToolCall(event.name, event.input), path: writtenPath(event.name, event.input) };
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

function writtenPath(name: string, input: unknown): string | undefined {
  if (name !== 'write_file' && name !== 'edit_file') return undefined;
  const value = (typeof input === 'object' && input !== null ? (input as Record<string, unknown>).path : undefined);
  return typeof value === 'string' ? value.replace(/^\.\//, '') : undefined;
}

/** 에이전트가 성공적으로 쓰거나 고친 파일 중 가장 최근 것과, 지금까지 성공한 쓰기 수. 코드 화면을 다시 불러오는 기준이다 */
export function latestWrite(chat: readonly ChatItem[]): { path?: string; count: number } {
  let count = 0;
  let latest: string | undefined;
  for (const item of chat) {
    if (item.kind !== 'tools') continue;
    for (const call of item.calls) {
      if (call.path && call.ok === true) {
        count += 1;
        latest = call.path;
      }
    }
  }
  return { path: latest, count };
}

/** 처리 중인 에이전트 요청. 체크포인트 복원이나 원격 가져오기처럼 요청이 아닌 작업 중이면 없다 */
export function activeRun({ snapshot, chat }: Pick<SessionView, 'snapshot' | 'chat'>): string | undefined {
  if (!snapshot.running) return undefined;
  const request = chat.findLast((item): item is Extract<ChatItem, { kind: 'request' }> => item.kind === 'request');
  if (!request) return undefined;
  return chat.some((item) => item.kind === 'outcome' && item.runId === request.runId) ? undefined : request.runId;
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
    case 'service_stats':
      return '리소스 확인';
    case 'http_request':
      return `요청 ${text(args.service)} ${text(args.method)} ${text(args.path)}`;
    case 'get_contract':
      return `계약 확인 ${text(args.service)}`;
    default:
      return name;
  }
}
