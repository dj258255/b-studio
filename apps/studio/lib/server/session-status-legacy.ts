import type { SessionStatus } from '../studio-events';

/**
 * 옛 세션 상태 전이·멈추기 순서·이어받기 판정·폴더 점유(ADR-205 이전). 새 코드(`session-status.ts`, Rust `bstudio-session`의 `status`·`registry`)와 견주는 차등 시험의 기준으로만 남아 있다.
 * 4g에서 지운다. 옛 `sessions.ts`의 `setStatus`·`ensureBooted`·`startBoot`·`boot`·`stopSession`·`resumeSession` 머리·`claimFolder`를 그대로 옮겼다(부수 효과만 뺐다).
 */

export interface LegacyModel {
  status: SessionStatus;
  error?: string;
  /** 옛 `session.bootPromise`가 있다 */
  hasBoot: boolean;
  /** 옛 `session.stop.signal.aborted` */
  aborted: boolean;
}

export function legacyModel(initial: 'idle' | 'starting'): LegacyModel {
  return { status: initial, hasBoot: false, aborted: false };
}

export type LegacyBootAction = 'ready' | 'stopped' | 'wait' | 'start';

/** 옛 `ensureBooted`의 분기와 `startBoot`의 상태 바꾸기 */
export function legacyEnsureBooted(model: LegacyModel): LegacyBootAction {
  if (model.status === 'ready') return 'ready';
  if (model.status === 'stopped') return 'stopped';
  if (!model.hasBoot || model.status === 'failed') {
    // startBoot: starting이 아니면 setStatus('starting')(오류를 지운다)
    if (model.status !== 'starting') {
      model.status = 'starting';
      model.error = undefined;
    }
    model.hasBoot = true;
    return 'start';
  }
  return 'wait';
}

/** 옛 `boot`의 끝. 성공이면 `setStatus('ready')`, 실패하면 중지 신호가 올라가 있지 않을 때만 `setStatus('failed', …)`. 상태를 바꿨는가를 돌려준다 */
export function legacyBootFinished(model: LegacyModel, outcome: { ok: true } | { ok: false; error: string }): boolean {
  if (outcome.ok) {
    model.status = 'ready';
    model.error = undefined;
    return true;
  }
  if (model.aborted) return false;
  model.status = 'failed';
  model.error = outcome.error;
  return true;
}

/** 옛 `stopSession`의 머리: 이미 멈췄으면 돌아오고 아니면 중지 신호를 올린다 */
export function legacyBeginStop(model: LegacyModel): 'stopped' | 'started' {
  if (model.status === 'stopped') return 'stopped';
  model.aborted = true;
  return 'started';
}

export function legacyFinishStop(model: LegacyModel): void {
  model.status = 'stopped';
  model.error = undefined;
}

/** 옛 `stopSession`의 부수 효과 순서(첫 줄의 `session.stop.abort()` 뒤). `swallow`는 옛 코드가 `.catch(() => {})`로 삼키던 단계다 */
export const LEGACY_STOP_STEPS: readonly { name: string; swallow: boolean }[] = [
  { name: 'clear_violation', swallow: false },
  { name: 'clear_terminal_attention', swallow: false },
  { name: 'settle_terminal_run', swallow: false },
  { name: 'abort_log_follower', swallow: false },
  { name: 'clear_usage_timer', swallow: false },
  { name: 'stop_stall_watch', swallow: false },
  { name: 'close_file_watcher', swallow: false },
  { name: 'dispose_terminal', swallow: false },
  { name: 'close_gateway', swallow: true },
  { name: 'destroy_sandbox', swallow: true },
  { name: 'close_preview_proxies', swallow: true },
  { name: 'mark_services_stopped', swallow: false },
  { name: 'apply_status', swallow: false },
  { name: 'clear_sandbox_link', swallow: false },
  { name: 'flush_persist', swallow: false },
];

/** 옛 `stopSession`의 본문을 같은 순서로 돈다. 던지던 단계는 던지고(그 뒤 단계는 하지 않는다), 삼키던 단계는 삼킨다. `apply_status` 앞에서 상태가 `stopped`가 된다 */
export async function legacyStop(model: LegacyModel, call: (step: string) => void | Promise<void>): Promise<void> {
  for (const step of LEGACY_STOP_STEPS) {
    if (step.name === 'apply_status') legacyFinishStop(model);
    // 옛 코드는 async 함수를 불러 `.catch(() => {})`로 삼켰다: 동기로 던져도 약속의 실패가 된다
    if (step.swallow) await (async () => call(step.name))().catch(() => {});
    else await call(step.name);
  }
}

export interface LegacyFail {
  status: number;
  message: string;
}

/** 옛 `resumeSession` 머리의 판정(`live`는 실행 중 세션의 상태, 없으면 undefined) */
export function legacyResumeGate(live: SessionStatus | undefined, archived: boolean, resuming: ReadonlySet<string>, id: string): LegacyFail | undefined {
  if (live === undefined && !archived) return { status: 404, message: '세션을 찾을 수 없습니다' };
  if (live !== undefined && live !== 'stopped') return { status: 409, message: '샌드박스를 중지한 세션만 이어서 작업할 수 있습니다' };
  if (resuming.has(id)) return { status: 409, message: '이미 이어서 작업할 준비를 하는 중입니다' };
  return undefined;
}

export interface LegacySessionFolder {
  id: string;
  workspace: 'local' | 'copy';
  workDir: string;
  status: SessionStatus;
}

/** 옛 `claimFolder`: 폴더를 글자로만 비교한다 */
export class LegacyFolders {
  readonly sessions = new Map<string, LegacySessionFolder>();
  readonly claimed = new Set<string>();

  claim(root: string, sessionId?: string): { release: () => void } | LegacyFail {
    const busy = [...this.sessions.values()].find((session) => session.workspace === 'local' && session.workDir === root && session.status !== 'stopped' && session.id !== sessionId);
    if (busy) return { status: 409, message: `이 폴더는 세션 ${busy.id}에서 작업하고 있습니다. 그 세션의 샌드박스를 중지한 뒤 시작하세요` };
    if (this.claimed.has(root)) return { status: 409, message: '이 폴더로 다른 세션을 시작하는 중입니다. 끝난 뒤 다시 시도하세요' };
    this.claimed.add(root);
    return { release: () => void this.claimed.delete(root) };
  }
}
