import type { AgentEvent, AgentUsage, Checkpoint, DatabaseState, DiscardBackup, Effort, GitHostKind, ServiceCheck, VerificationReport, WorkflowCompare, WorkflowStepCheck } from '@b-studio/agent';
import type { BootNetwork } from '@b-studio/sandbox';
import type { DeployAction, RemoteCommitView, SessionSnapshot, StudioEvent } from './studio-events';

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
  | { kind: 'boot'; network: BootNetwork }
  | { kind: 'request'; runId: string; text: string; by?: string; intent?: 'ask' }
  /** 실행 중 보낸 지시. queued: 아직 반영 전, applied: 대화에 들어감, dropped: 끝날 때까지 반영되지 못함 */
  | { kind: 'steer'; runId: string; text: string; status: 'queued' | 'applied' | 'dropped' }
  /** 러너가 무언가를 하지 못했다는 안내(예: 상태 폴더가 없어 이전 대화를 이어받지 못함). 실행은 계속된다 */
  | { kind: 'warning'; runId: string; text: string }
  /** 플랫폼이 대화에 남기는 한 줄 안내(예: 샌드박스를 켜는 중). 모델 발언이 아니다 */
  | { kind: 'notice'; text: string }
  /** 계획-실행 분리(ADR-075). 실행 전에 계획 모델이 쓴 짧은 계획. "계획(모델명)" 접기 블록으로 보여준다 */
  | { kind: 'planBrief'; runId: string; model: string; text: string }
  | {
      kind: 'route';
      runId: string;
      selectedId: string;
      reason: string;
      complexity: 'simple' | 'normal' | 'complex';
      risk: 'normal' | 'high';
      candidates: Array<{ id: string; label: string; eligible: boolean; score: number; estimatedCostUsd?: number }>;
      /** claude-code 자동 모델 선택(ADR-091)이면 true. 화면이 점수표 대신 한 줄 안내를 보여준다 */
      auto?: boolean;
    }
  | { kind: 'backend'; runId: string; backend: string; model: string; auth?: string; effort?: Effort }
  /** 게이트의 같은 실패 서명이 반복돼 더 비싼 모델로 올렸다 */
  | { kind: 'escalation'; runId: string; from: string; to: string; times: number; attempt: number }
  /** 로컬 CLI 러너가 대화가 길어져 앞부분을 요약했다. 압축 전후 토큰 수(후는 모를 수 있다) */
  | { kind: 'compacted'; runId: string; trigger: 'auto' | 'manual'; preTokens: number; postTokens?: number; durationMs?: number }
  /** 대화 앞부분을 요약하는 중. 요약이 끝나면(compacted) 또는 실행이 끝나면 사라진다 */
  | { kind: 'compacting'; runId: string }
  | { kind: 'stage'; runId: string; stage: string }
  /** 플랫폼이 직접 실행한 화면 확인·테스트·리뷰 결과. browser_check면 단계별 스크린샷 식별자(steps)와 디자인 비교(compare)가 함께 온다 */
  | { kind: 'check'; runId: string; stage: string; name: string; ok: boolean; attempts: number; detail?: string; steps?: WorkflowStepCheck[]; compare?: WorkflowCompare }
  | { kind: 'reply'; runId: string; text: string }
  | { kind: 'tools'; runId: string; calls: ToolCallView[] }
  /** interrupted: 결과가 오기 전에 요청이 끝났다 (서버가 멈췄거나 요청이 오류로 끝남) */
  | { kind: 'gate'; runId: string; files: string[]; report?: VerificationReport; interrupted?: boolean }
  | {
      kind: 'outcome';
      runId: string;
      status: 'done' | 'failed' | 'error' | 'cancelled' | 'awaiting_input';
      summary: string;
      turns?: number;
      usage?: AgentUsage;
      /** 질문 모드 요청의 결과 */
      intent?: 'ask';
      /** 가볍게 확인(light)으로 끝난 요청. 테스트·화면 확인·리뷰를 건너뛰었다 */
      verify?: 'light';
    }
  | { kind: 'checkpoint'; runId: string; checkpoint: Checkpoint }
  /** 에이전트의 제안을 받아 이 요청을 나눠서 병렬·여러 명 비교로 넘겼다(ADR-068) */
  | { kind: 'handoff'; runId: string; to: 'split' | 'fleet'; href: string }
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
      /** 버린 변경을 되살릴 수 있게 남긴 백업(ADR-099) */
      backup?: DiscardBackup;
    }
  | {
      kind: 'restore';
      checkpoint: Checkpoint;
      result?:
        | { ok: true; files: string[]; restarted: ServiceCheck[]; databases: DatabaseState[]; backup?: DiscardBackup }
        | { ok: false; error: string };
    }
  | {
      kind: 'resumed';
      checkpoint: Checkpoint;
      discarded: string[];
      databases: DatabaseState[];
      restarted: ServiceCheck[];
      backup?: DiscardBackup;
    }
  /** discard·revert·restore가 남긴 백업을 작업 복사본에 되살린 결과(ADR-099) */
  | { kind: 'backupRestored'; backupId: string; result: { ok: true; files: string[]; restarted: ServiceCheck[] } | { ok: false; error: string } }
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
            backup?: DiscardBackup;
          };
    }
  | {
      kind: 'deploy';
      action: DeployAction;
      target: string;
      by?: string;
      result?:
        | { ok: true; release: string; label: string; urls: Record<string, string>; previous?: string }
        | { ok: false; error: string; detail?: string };
    }
  | {
      kind: 'exported';
      branch: string;
      hostKind: GitHostKind;
      commits: number;
      forced: boolean;
      pullRequest?: { url: string; created: boolean };
      pullRequestError?: string;
      /** PR에 연결한 이슈 번호들 */
      issues?: number[];
      /** 요구사항 추적 이슈 본문 갱신 경고(PR 만들기 자체는 됐다) */
      requirementsTrackingWarning?: string;
    }
  /** main 따라잡기(ADR-076) */
  | {
      kind: 'baseSync';
      result?:
        | { ok: true; status: 'up-to-date' | 'merged'; commits: number; files: string[]; checkpoint?: Checkpoint; report?: VerificationReport }
        | {
            ok: false;
            error: string;
            conflicts?: string[];
            /** "에이전트에게 충돌 해결 맡기기"로 시도했을 때만 있다. 대화 입력창에 미리 채운다 */
            agentRequest?: string;
            files?: string[];
            report?: VerificationReport;
            restarted?: ServiceCheck[];
            backup?: DiscardBackup;
          };
    };

type ToolsItem = Extract<ChatItem, { kind: 'tools' }>;
type GateItem = Extract<ChatItem, { kind: 'gate' }>;
type RestoreItem = Extract<ChatItem, { kind: 'restore' }>;
type RemoteSyncItem = Extract<ChatItem, { kind: 'remoteSync' }>;
type BaseSyncItem = Extract<ChatItem, { kind: 'baseSync' }>;
type DeployItem = Extract<ChatItem, { kind: 'deploy' }>;

export interface SessionView {
  snapshot: SessionSnapshot;
  chat: ChatItem[];
  logs: LogEntry[];
  /** 끝난 요청 수. 미리보기와 계약을 새로 불러오는 기준으로 쓴다 */
  completedRuns: number;
  /** 처리 중인 요청이 지금까지 쓴 토큰 */
  runTokens?: { runId: string; usage: AgentUsage };
  /** 배포가 끝날 때마다 늘어난다. 배포 탭이 운영 상태를 다시 불러오는 기준이다 */
  deployRevision: number;
}

export const LOG_LIMIT = 1000;
/** 스냅샷에 두는 배포 진행 줄 수. 서버의 DEPLOY_LOG_LIMIT와 같다 */
export const DEPLOY_LINE_LIMIT = 200;

export function createView(snapshot: SessionSnapshot): SessionView {
  return { snapshot, chat: [], logs: [], completedRuns: 0, deployRevision: 0 };
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
    case 'notice':
      return { ...view, chat: [...view.chat, { kind: 'notice', text: event.text }] };
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
    case 'design':
      return patchSnapshot(view, { design: event.design });
    case 'model':
      return patchSnapshot(view, { modelId: event.modelId, effort: event.effort });
    case 'question':
      // 질문을 스냅샷에 남겨 화면이 카드로 그린다. 답을 보내면(run_started) 지운다.
      // 대화 항목으로는 넣지 않는다 — 답을 보내면 요청 줄에 질문과 답이 함께 남는다
      return patchSnapshot(view, {
        pendingQuestion: { runId: event.runId, question: event.question, options: event.options, allowOther: event.allowOther, ...(event.proposal ? { proposal: event.proposal } : {}) },
      });
    case 'question_dismissed':
      // 제안을 받아 다른 방식으로 넘겼다. 같은 질문이면 카드를 치운다(넘긴 곳은 대화 줄로 남긴다)
      return {
        ...(view.snapshot.pendingQuestion?.runId === event.runId ? patchSnapshot(view, { pendingQuestion: undefined }) : view),
        chat: [...view.chat, { kind: 'handoff', runId: event.runId, to: event.to, href: event.href }],
      };
    case 'boot_network':
      return {
        ...patchSnapshot(view, { bootNetwork: event.network }),
        chat: [...view.chat, { kind: 'boot', network: event.network }],
      };
    case 'log': {
      const logs = view.logs.length >= LOG_LIMIT ? view.logs.slice(view.logs.length - LOG_LIMIT + 1) : [...view.logs];
      logs.push({ service: event.service, text: event.text, at: event.at });
      return { ...view, logs };
    }
    case 'run_started':
      // PR 자동 리뷰(ADR-074)의 리뷰어 호출은 세션의 보통 요청이 아니라 토큰 보고서에 잡히려고 같은 이벤트를 빌려 쓴 것뿐이다.
      // 대화 줄이나 "작업 중" 표시를 만들지 않는다 — 그 진행은 AI 리뷰 카드가 따로 보여준다(runId는 review-로 시작한다)
      if (event.runId.startsWith('review-')) return view;
      return {
        ...patchSnapshot(view, { running: true, pendingQuestion: undefined }),
        chat: [...view.chat, { kind: 'request', runId: event.runId, text: event.request, by: event.by, intent: event.intent }],
      };
    case 'plan_brief':
      return { ...view, chat: [...view.chat, { kind: 'planBrief', runId: event.runId, model: event.model, text: event.text }] };
    case 'agent':
      return { ...view, chat: applyAgentEvent(view.chat, event.runId, event.event) };
    case 'steer_queued':
      return { ...view, chat: [...view.chat, { kind: 'steer', runId: event.runId, text: event.text, status: 'queued' }] };
    case 'steer_dropped':
      return { ...view, chat: settleSteering(view.chat, event.runId) };
    case 'tokens':
      // 합계를 더하지 않고 서버가 보낸 값으로 바꿔서, 다시 연결해 기록을 재생해도 두 번 세지 않는다
      return { ...patchSnapshot(view, { tokens: event.sessionTokens }), runTokens: { runId: event.runId, usage: event.usage } };
    case 'run_cancelling':
      return patchSnapshot(view, { cancelling: event.reason ?? 'user' });
    case 'run_finished': {
      // run_started와 같은 이유로 대화·"작업 중" 상태는 건드리지 않는다. 세션 토큰 합계만 반영한다
      if (event.runId.startsWith('review-')) return patchSnapshot(view, { tokens: event.sessionTokens ?? view.snapshot.tokens });
      const request = view.chat.find((item) => item.kind === 'request' && item.runId === event.runId);
      const intent = request?.kind === 'request' ? request.intent : undefined;
      return {
        ...patchSnapshot(view, {
          running: false,
          cancelling: undefined,
          // 되묻고 멈춘 실행만 질문을 남긴다. 끝난 실행이 남긴 질문은 지운다
          pendingQuestion: event.status === 'awaiting_input' ? view.snapshot.pendingQuestion : undefined,
          nextDemoRequest: event.nextDemoRequest,
          nextDemoQuestion: event.nextDemoQuestion,
          tokens: event.sessionTokens ?? view.snapshot.tokens,
        }),
        chat: [
          // 요약 도중에 끝난(취소·오류) 실행의 "요약 중" 줄은 남기지 않는다
          ...markInterrupted(withoutCompacting(view.chat, event.runId), event.runId),
          { kind: 'outcome', runId: event.runId, status: event.status, summary: event.summary, turns: event.turns, usage: event.usage, intent, verify: event.verify },
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

    case 'docs_checkpoint': {
      // 요청 밖(요구사항 저장 등)에서 남기므로 대화 줄은 더하지 않는다 — 체크포인트 목록(히스토리 패널)에만 반영한다
      const known = view.snapshot.checkpoints.some((checkpoint) => checkpoint.sha === event.checkpoint.sha);
      return known ? view : patchSnapshot(view, { checkpoints: [event.checkpoint, ...view.snapshot.checkpoints] });
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
            backup: event.backup,
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
          backup: event.backup,
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
          {
            kind: 'resumed',
            checkpoint: event.checkpoint,
            discarded: event.discarded,
            databases: event.databases,
            restarted: event.restarted,
            backup: event.backup,
          },
        ],
        // 새 샌드박스의 주소로 미리보기와 계약을 다시 불러오게 한다
        completedRuns: view.completedRuns + 1,
      };

    case 'backup_restore_started':
      return patchSnapshot(view, { running: true });

    case 'backup_restored':
      return {
        ...patchSnapshot(view, { running: false }),
        chat: [...view.chat, { kind: 'backupRestored', backupId: event.backupId, result: { ok: true, files: event.files, restarted: event.restarted } }],
        completedRuns: view.completedRuns + 1,
      };

    case 'backup_restore_failed':
      return {
        ...patchSnapshot(view, { running: false }),
        chat: [...view.chat, { kind: 'backupRestored', backupId: event.backupId, result: { ok: false, error: event.error } }],
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
          backup: event.backup,
        }),
        // 가져온 변경을 반영했다가 되돌렸으면 서비스가 다시 떴다
        completedRuns: event.restarted ? view.completedRuns + 1 : view.completedRuns,
      };

    case 'base_sync_started':
      return { ...patchSnapshot(view, { running: true }), chat: [...view.chat, { kind: 'baseSync' }] };

    case 'base_synced':
      return {
        ...patchSnapshot(view, { running: false, checkpoints: event.checkpoints, repository: event.repository }),
        chat: settleBaseSync(view.chat, { ok: true, status: event.status, commits: event.commits, files: event.files, checkpoint: event.checkpoint, report: event.report }),
        // 파일이 바뀌었으면 미리보기와 계약을 다시 불러오게 한다
        completedRuns: event.status === 'up-to-date' ? view.completedRuns : view.completedRuns + 1,
      };

    case 'base_sync_failed':
      return {
        ...patchSnapshot(view, { running: false, ...(event.checkpoints ? { checkpoints: event.checkpoints } : {}) }),
        chat: settleBaseSync(view.chat, {
          ok: false,
          error: event.error,
          conflicts: event.conflicts,
          agentRequest: event.agentRequest,
          files: event.files,
          report: event.report,
          restarted: event.restarted,
          backup: event.backup,
        }),
        // 병합한 변경을 반영했다가 되돌렸으면 서비스가 다시 떴다
        completedRuns: event.restarted ? view.completedRuns + 1 : view.completedRuns,
      };

    case 'deploy_started':
      return {
        ...patchSnapshot(view, { deploying: { action: event.action, target: event.target, startedAt: event.at, by: event.by, lines: [] } }),
        chat: [...view.chat, { kind: 'deploy', action: event.action, target: event.target, by: event.by }],
      };

    case 'deploy_log': {
      const deploying = view.snapshot.deploying;
      if (!deploying) return view;
      return patchSnapshot(view, { deploying: { ...deploying, lines: [...deploying.lines.slice(-(DEPLOY_LINE_LIMIT - 1)), event.line] } });
    }

    case 'deploy_finished':
    case 'deploy_failed': {
      const result: NonNullable<DeployItem['result']> =
        event.type === 'deploy_finished'
          ? { ok: true, release: event.release, label: event.label, urls: event.urls, previous: event.previous }
          : { ok: false, error: event.error, detail: event.detail };
      return {
        ...patchSnapshot(view, { deploying: undefined }),
        chat: settleDeploy(view.chat, event.action, result),
        deployRevision: view.deployRevision + 1,
      };
    }

    case 'usage':
      return patchSnapshot(view, { usage: { at: event.at, services: event.services } });

    case 'files_changed':
      return patchSnapshot(view, { fileRevision: event.revision });

    case 'tests_changed':
      return patchSnapshot(view, { testsRevision: event.revision, testsRunning: event.running });

    case 'exported':
      // 원격 상태(repository)는 통째로 바꾼다. 다만 그 순간 서버가 계산한 값(canCreatePullRequest 등)이라
      // 기록을 재생하면 지금 값보다 오래된 값일 수 있다 — snapshot_sync가 재생 끝에서 다시 맞춘다
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
            ...(event.issues?.length ? { issues: event.issues } : {}),
            ...(event.requirementsTrackingWarning ? { requirementsTrackingWarning: event.requirementsTrackingWarning } : {}),
          },
        ],
      };

    case 'review_round':
      // 리뷰 상태는 통째로 바꾼다(exported와 같은 규칙). 역시 그 순간 값이라 snapshot_sync가 재생 끝에서 다시 맞춘다
      return patchSnapshot(view, { review: event.review });

    case 'snapshot_sync':
      // 재연결 시 replay 맨 끝에서 온다. exported·remote_synced·base_synced·review_round 같은 기록 이벤트가
      // 그 순간 값으로 덮어쓴 repository·checkpoints·review를 지금 스냅샷 값으로 되돌린다(채팅은 건드리지 않는다)
      return patchSnapshot(view, { repository: event.repository, checkpoints: event.checkpoints, review: event.review });
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

/** 지시가 대화에 들어간 만큼 앞에서부터 반영됨으로 표시한다 */
function applySteerApplied(chat: ChatItem[], runId: string, count: number): ChatItem[] {
  let remaining = count;
  return chat.map((item) => {
    if (remaining > 0 && item.kind === 'steer' && item.runId === runId && item.status === 'queued') {
      remaining -= 1;
      return { ...item, status: 'applied' as const };
    }
    return item;
  });
}

/** 실행이 끝날 때까지 반영되지 못한 지시를 적용 실패로 표시한다 */
function settleSteering(chat: ChatItem[], runId: string): ChatItem[] {
  return chat.map((item) => (item.kind === 'steer' && item.runId === runId && item.status === 'queued' ? { ...item, status: 'dropped' as const } : item));
}

function settleRemoteSync(chat: ChatItem[], result: NonNullable<RemoteSyncItem['result']>): ChatItem[] {
  const index = chat.findLastIndex((item) => item.kind === 'remoteSync' && !item.result);
  // 기록이 잘려 시작 이벤트가 없으면 결과만 붙인다
  if (index === -1) return [...chat, { kind: 'remoteSync', result }];
  return chat.map((item, i) => (i === index ? { kind: 'remoteSync', result } : item));
}

function settleBaseSync(chat: ChatItem[], result: NonNullable<BaseSyncItem['result']>): ChatItem[] {
  const index = chat.findLastIndex((item) => item.kind === 'baseSync' && !item.result);
  // 기록이 잘려 시작 이벤트가 없으면 결과만 붙인다
  if (index === -1) return [...chat, { kind: 'baseSync', result }];
  return chat.map((item, i) => (i === index ? { kind: 'baseSync', result } : item));
}

function settleDeploy(chat: ChatItem[], action: DeployAction, result: NonNullable<DeployItem['result']>): ChatItem[] {
  const index = chat.findLastIndex((item) => item.kind === 'deploy' && !item.result);
  // 기록이 잘려 시작 이벤트가 없으면 결과만 붙인다
  if (index === -1) return [...chat, { kind: 'deploy', action, target: result.ok ? result.release : '', result }];
  return chat.map((item, i) => (i === index ? { ...(item as DeployItem), result } : item));
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
    case 'route':
      return [
        ...chat,
        {
          kind: 'route',
          runId,
          selectedId: event.selectedId,
          reason: event.reason,
          complexity: event.complexity,
          risk: event.risk,
          candidates: event.candidates,
          ...(event.auto ? { auto: true } : {}),
        },
      ];

    case 'session':
      return [...chat, { kind: 'backend', runId, backend: event.backend, model: event.model, auth: event.auth, effort: event.effort }];

    case 'steer_applied':
      return applySteerApplied(chat, runId, event.count);
    case 'model_escalated':
      return [...chat, { kind: 'escalation', runId, from: event.from, to: event.to, times: event.sameSignatureTimes, attempt: event.attempt }];

    case 'context_compacting':
      // 같은 실행의 "요약 중" 줄이 이미 있으면 또 쌓지 않는다
      return chat.some((item) => item.kind === 'compacting' && item.runId === runId) ? chat : [...chat, { kind: 'compacting', runId }];

    case 'context_compacted':
      return [
        ...withoutCompacting(chat, runId),
        {
          kind: 'compacted',
          runId,
          trigger: event.trigger,
          preTokens: event.preTokens,
          ...(event.postTokens !== undefined ? { postTokens: event.postTokens } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        },
      ];

    // 러너가 하지 못한 것을 조용히 넘기지 않고 대화에 남긴다(예: 상태 폴더가 없어 이어받지 못함)
    case 'warning':
      return [...chat, { kind: 'warning', runId, text: event.message }];

    case 'stage':
      return [...chat, { kind: 'stage', runId, stage: event.stage }];

    case 'workflow_check':
      return [...chat, { kind: 'check', runId, ...event.check }];

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

/**
 * 파일을 바꾼 실행 id들. 서버가 게이트를 돌렸다는 것은 바뀐 파일이 있었다는 뜻이고
 * (바뀐 파일이 없으면 게이트는 검증 없이 통과합니다), 체크포인트도 게이트를 통과한 변경에만 남습니다.
 * 입력이 하나로 합쳐진 뒤로는 "질문에 답만 한" 만들기 실행도 있으므로, 결과 줄을 가르는 데 씁니다
 */
export function runsWithChanges(chat: readonly ChatItem[]): Set<string> {
  const runs = new Set<string>();
  for (const item of chat) {
    if (item.kind === 'gate' || item.kind === 'checkpoint' || item.kind === 'reverted') runs.add(item.runId);
  }
  return runs;
}

/** 이번 실행이 파일을 바꿨는가 */
export function runHasChanges(chat: readonly ChatItem[], runId: string): boolean {
  return runsWithChanges(chat).has(runId);
}

type OutcomeItem = Extract<ChatItem, { kind: 'outcome' }>;

/** 실행 결과 한 줄. 바꾼 파일이 없으면 "답만 했습니다"로 알린다(대화 화면과 나란히 보기 칸이 같은 문구를 쓴다) */
export function outcomeText(item: OutcomeItem, hasChanges: boolean): string {
  if (item.status === 'done') return `${hasChanges ? '완료' : '답만 했습니다(바꾼 파일 없음)'}, ${item.turns ?? 0}턴`;
  if (item.status === 'awaiting_input') return '답을 기다립니다';
  if (item.status === 'cancelled') return item.summary;
  return `${item.status === 'failed' ? '완료하지 못함' : '오류'}: ${item.summary}`;
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

/** 그 실행의 "요약 중" 줄을 뺀다(요약이 끝났거나 실행이 끝났을 때) */
function withoutCompacting(chat: readonly ChatItem[], runId: string): ChatItem[] {
  return chat.filter((item) => !(item.kind === 'compacting' && item.runId === runId));
}
