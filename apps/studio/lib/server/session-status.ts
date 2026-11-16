import { native, type NativeSessionRegistry, type NativeSessionState } from '@b-studio/sandbox';
import type { SessionStatus } from '../studio-events';
import { StudioError } from './errors';

/**
 * 세션 상태 전이·멈추기·이어받기 판정·폴더 점유(ADR-205, 4f B2b). 판정은 Rust `crates/bstudio-session`의 `status`·`registry`가 하고, 여기는 그 결과를 `StudioError`와
 * 콜백으로 바꾸는 껍데기다. 옛 TS 판정은 `session-status-legacy.ts`에 차등 시험의 기준으로만 남아 있다.
 *
 * `snapshot.status`는 `SessionLife.status`의 거울이다: 바뀔 때마다 이 모듈이 돌려주는 `StatusChange`를 `sessions.ts`의 `applyStatus`가 옮기고 `status` 이벤트를 낸다.
 */

export interface StatusChange {
  status: SessionStatus;
  error?: string;
}

export type BootAction =
  | { action: 'ready' | 'stopped' | 'wait' }
  /** 켜기를 시작한다. `change`가 있으면 상태가 `starting`으로 바뀐 것이다(`starting`이었으면 없다) */
  | { action: 'start'; generation: number; change?: StatusChange };

/** 멈추기의 단계 이름. 순서와 실패 처리(삼킴·던짐)는 Rust `STOP_STEPS`가 정한다 */
export type StopStep =
  | 'clear_violation'
  | 'clear_terminal_attention'
  | 'settle_terminal_run'
  | 'abort_log_follower'
  | 'clear_usage_timer'
  | 'stop_stall_watch'
  | 'close_file_watcher'
  | 'dispose_terminal'
  | 'close_gateway'
  | 'destroy_sandbox'
  | 'close_preview_proxies'
  | 'mark_services_stopped'
  | 'apply_status'
  | 'clear_sandbox_link'
  | 'flush_persist';

export type StopActions = Record<StopStep, () => void | Promise<void>>;

function failure(result: { status: number; message: string } | null | undefined): void {
  if (result) throw new StudioError(result.status, result.message);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 세션 하나의 상태. `Session`이 하나씩 쥔다 */
export class SessionLife {
  readonly native: NativeSessionState;

  /** `initial`: 지연 기동이면 `idle`, 만들자마자 켜면 `starting` */
  constructor(initial: 'idle' | 'starting') {
    this.native = new native.SessionState(initial);
  }

  get status(): SessionStatus {
    return this.native.status as SessionStatus;
  }

  get error(): string | undefined {
    return this.native.error ?? undefined;
  }

  /** 멈추는 중이다(상태는 아직 `stopped`가 아니다) */
  get stopping(): boolean {
    return this.native.stopping;
  }

  /** 지금 상태. 멈추기의 `apply_status`가 거울에 옮길 때 쓴다 */
  current(): StatusChange {
    return { status: this.status, ...(this.error !== undefined ? { error: this.error } : {}) };
  }

  /** 켜기 `generation`이 지금도 이 세션의 켜기인가(멈추는 중이거나 세대가 지났거나 멈췄으면 거짓) */
  live(generation: number): boolean {
    return this.native.live(generation);
  }

  /** 샌드박스를 켜야 하는가(옛 `ensureBooted`의 분기). `start`면 부른 쪽이 켜기를 시작하고 그 세대로 `bootFinished`를 알린다 */
  requestBoot(): BootAction {
    const request = this.native.requestBoot();
    if (request.action !== 'start') return { action: request.action };
    return {
      action: 'start',
      generation: request.generation,
      ...(request.changed ? { change: { status: request.status as SessionStatus, ...(request.error ? { error: request.error } : {}) } } : {}),
    };
  }

  /** 켜기가 끝났다. 지금 세대의 켜기이고 멈추는 중이 아니면 바뀐 상태를, 아니면(늦은 결과) undefined를 돌려준다 */
  bootFinished(generation: number, outcome: { ok: true } | { ok: false; error: string }): StatusChange | undefined {
    const result = this.native.bootFinished(generation, outcome.ok, outcome.ok ? null : outcome.error);
    if (!result.applied) return undefined;
    return { status: result.status as SessionStatus, ...(result.error ? { error: result.error } : {}) };
  }

  /** 멈추기를 시작한다. `started`를 받은 호출이 `runStop`을 부른다 */
  beginStop(): 'stopped' | 'joined' | 'started' {
    return this.native.beginStop();
  }

  /**
   * 단계마다 `actions[이름]`을 부른다(순서와 실패 처리는 Rust가 정한다). 삼키는 단계는 던져도 이어 가고, 던지는 단계는 그 원래 오류를 그대로 던진다.
   * 콜백은 던지지 않고 이유를 돌려준다(Rust가 부르는 콜백이 던지면 Node가 경고한다, 트러블슈팅 210)
   */
  async runStop(actions: StopActions): Promise<void> {
    const errors = new Map<string, unknown>();
    const result = await this.native.stop(async (step) => {
      try {
        const action = actions[step as StopStep];
        if (!action) throw new Error(`알 수 없는 멈추기 단계입니다: ${step}`);
        await action();
        return null;
      } catch (error) {
        errors.set(step, error);
        return describeError(error);
      }
    });
    if (!result.ok) throw errors.get(result.step ?? '') ?? new Error(result.message ?? '멈추지 못했습니다');
  }

  /** 다른 호출이 멈추는 중일 때 그 끝을 기다린다. 그 호출이 던졌으면 같은 이유로 던진다 */
  async joinStop(): Promise<void> {
    const result = await this.native.joinStop();
    if (!result.ok) throw new Error(result.message ?? '멈추지 못했습니다');
  }
}

/** 세션 맵 수준의 상태: 이어받는 중인 세션과 내 폴더 세션의 폴더 점유. 프로세스마다 하나(HMR로 모듈이 다시 로드돼도 전역에 두어 잃지 않는다) */
export class SessionRegistry {
  private readonly native: NativeSessionRegistry = new native.SessionRegistry();

  register(id: string, life: SessionLife, local: boolean, workDir: string): void {
    this.native.register(id, life.native, local, workDir);
  }

  unregister(id: string): void {
    this.native.unregister(id);
  }

  /** 이어받기를 시작한다. 거절하면 `StudioError`(404·409). 끝나면(성공이든 실패든) `endResume`을 부른다 */
  beginResume(id: string, archived: boolean): void {
    failure(this.native.beginResume(id, archived));
  }

  endResume(id: string): void {
    this.native.endResume(id);
  }

  /** 내 폴더 세션이 쓸 폴더를 잡는다. 같은 폴더(글자나 폴더의 정체가 같다)를 다른 세션이 쓰거나 다른 시작이 잡고 있으면 `StudioError`(409). 돌려준 함수로 푼다 */
  claimFolder(root: string, sessionId?: string): () => void {
    const result = this.native.claimFolder(root, sessionId ?? null);
    failure(result.fail);
    const token = result.token;
    return () => this.native.releaseClaim(token);
  }

  /** 시험용: 잡고 있는 폴더 수 */
  claimedCount(): number {
    return this.native.claimed();
  }
}
