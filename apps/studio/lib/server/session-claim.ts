import type { NativeSessionState } from '@b-studio/sandbox';
import { StudioError } from './errors';

/**
 * 세션의 바쁨(ADR-207, 4f B3a). 판정과 점유는 Rust `crates/bstudio-session`의 `claim`이 하고, 여기는 그 결과를 `StudioError`로 바꾸는 껍데기다.
 * 옛 TS 판정(`snapshot.running`·`session.run`·`session.exporting`을 읽던 것)은 `session-claim-legacy.ts`에 차등 시험의 기준으로만 남아 있다.
 *
 * 잡으면 **표**(`Ticket`)를 받고, 풀 때는 그 표를 낸다. 표가 지금 점유의 표가 아니면 아무것도 하지 않는다(`release`가 `false`).
 * `snapshot.running`·`snapshot.cancelling`은 화면용 거울이다: 판정은 거울이 아니라 여기에 묻는다.
 */
export type Ticket = number;

/** 실행의 단계. 진행 → 취소 중 → 저장 중 */
export type RunPhase = 'running' | 'cancelling' | 'saving';

/** 보조 작업의 종류(`catch_up_base`는 `beginCatchUp`이 건너뛰기로 다룬다) */
export type TaskKind = 'restore' | 'restore_backup' | 'sync_remote' | 'reverify';

/** `running`을 보고 거절하던 곳 */
export type BusyOp = 'set_model' | 'save_requirements' | 'manual_verify' | 'manual_clear' | 'write_requirements_doc';

function failure(result: { status: number; message: string } | null | undefined): void {
  if (result) throw new StudioError(result.status, result.message);
}

export interface ClaimView {
  kind?: string;
  runId?: string;
  phase?: RunPhase;
  terminal: boolean;
  exporting: boolean;
}

export class SessionClaims {
  constructor(private readonly native: NativeSessionState) {}

  /** 요청(대화 창)을 받을 수 있는가. 못 받으면 `StudioError` */
  checkRun(): void {
    failure(this.native.checkRun());
  }

  /** 요청 하나를 연다. 못 열면 `StudioError`(409) */
  beginRun(runId: string): Ticket {
    const result = this.native.beginRun(runId);
    failure(result.fail);
    return result.token;
  }

  /** 터미널의 실행을 받을 수 없으면 그 이유(글) */
  terminalBusy(): string | undefined {
    return this.native.terminalBusy() ?? undefined;
  }

  /** 터미널의 실행 하나를 연다. 못 열면 `{ busy }`(그 이유 글) */
  beginTerminalRun(runId: string): Ticket | { busy: string } {
    const result = this.native.beginTerminalRun(runId);
    if (result.fail) return { busy: result.fail.message };
    return result.token;
  }

  /** 실행의 단계를 바꾼다. 표가 맞지 않거나 허용하지 않는 전이면 바꾸지 않고 `false` */
  setPhase(ticket: Ticket, phase: RunPhase): boolean {
    return this.native.setPhase(ticket, phase);
  }

  /** 사용자의 취소 요청. 거절하면 `StudioError`, 이미 취소 중이면 `'already'`, 취소를 시작하면 `'started'` */
  cancelRun(runId: string): 'started' | 'already' {
    const result = this.native.cancelRun(runId);
    failure(result.fail);
    return result.outcome === 'already' ? 'already' : 'started';
  }

  /** 진행 중 지시를 받을 실행의 id. 없으면 `StudioError` */
  steerTarget(): string {
    const result = this.native.steerTarget();
    failure(result.fail);
    return result.runId ?? '';
  }

  /** 열린 실행(진행·취소 중)의 id */
  openRun(): string | undefined {
    return this.native.openRun() ?? undefined;
  }

  checkTask(kind: TaskKind): void {
    failure(this.native.checkTask(kind));
  }

  beginTask(kind: TaskKind): Ticket {
    const result = this.native.beginTask(kind);
    failure(result.fail);
    return result.token;
  }

  /** 기준 브랜치 따라잡기를 연다. 건너뛰면 `undefined`(오류가 아니다) */
  beginCatchUp(): Ticket | undefined {
    const ticket = this.native.beginCatchUp();
    return ticket === 0 ? undefined : ticket;
  }

  /** 표로 점유를 푼다. 지금 점유의 표일 때만 풀고 `true` */
  release(ticket: Ticket): boolean {
    return this.native.release(ticket);
  }

  /** 이 표가 지금 점유인가(기다리는 사이에 멈추기가 비웠는지 볼 때) */
  holds(ticket: Ticket): boolean {
    return this.native.holds(ticket);
  }

  /** 바쁜가(`snapshot.running`의 원본) */
  get busy(): boolean {
    return this.native.busy;
  }

  rejectBusy(op: BusyOp): void {
    failure(this.native.rejectBusy(op));
  }

  beginExport(): Ticket {
    const result = this.native.beginExport();
    failure(result.fail);
    return result.token;
  }

  releaseExport(ticket: Ticket): boolean {
    return this.native.releaseExport(ticket);
  }

  get exporting(): boolean {
    return this.native.exporting;
  }

  /** 지우기 전의 점유 판정. 점유 중이면 `StudioError`(409) */
  checkDelete(): void {
    failure(this.native.deleteBusy());
  }

  view(): ClaimView {
    const view = this.native.claimView();
    return {
      ...(view.kind ? { kind: view.kind } : {}),
      ...(view.runId ? { runId: view.runId } : {}),
      ...(view.phase ? { phase: view.phase as RunPhase } : {}),
      terminal: view.terminal,
      exporting: view.exporting,
    };
  }
}
