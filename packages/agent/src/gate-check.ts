import { setTimeout as sleep } from 'node:timers/promises';
import { decodeNative, encodeNative, native, type Sandbox } from '@b-studio/sandbox';
import { SPEC_FILE, type LoadedProject, type WorkflowStage } from '@b-studio/spec';
import type { GateOutcome } from './gate';
import type { AgentEvent } from './loop';
import { MANUAL_VERIFICATION_CHECK } from './requirement-integrity';
import { decodeStrings, encodeStrings, failure, verifyChangesSetup, type HookHandler, type HookRequest, type VerificationReport, type VerifyOptions } from './verify';
import type { WorkflowCheck } from './workflow';

/**
 * 게이트 check의 상태 기계(순서·분기·결과 조립)는 Rust(`crates/bstudio-io/src/gate_check.rs`, ADR-195 4f A5b-1)가 한다.
 * 상태(시도 횟수·보고서·검사 목록·통과한 단계 등)와 sandbox·workspace·project는 TS 게이트 객체가 들고, Rust는 옛 코드가 그 필드를 바꾸던 자리마다 `setState`로,
 * 이벤트를 내던 자리마다 `emit`으로, 하위 단계를 부르던 자리마다 콜백으로 TS를 부른다. 이 파일은 그 콜백을 `GateHost`로 잇는 껍데기다.
 *
 * 콜백 응답은 `{ ok: true, ... }` 또는 `{ ok: false, error: { message, aborted? }, ... }`(남은 프로세스 조회 실패만 값으로 읽는다)다. 그 밖의 실패는 처리기가 던지면
 * 오류를 저장하고 `{ fatal: true }`를 돌려준다 — Rust는 그 뒤 단계를 하지 않고, 여기서 저장한 오류를 그대로 다시 던진다(`verifyChanges`·`onEvent`·`sleep`이 던지던 것과 같다).
 */

/** 게이트 객체의 필드 가운데 check가 읽고 쓰는 것. 옛 코드가 `this.…`로 바꾸던 그것이다 */
export interface GateState {
  attempts: number;
  readonly maxAttempts: number;
  report: VerificationReport | undefined;
  checks: WorkflowCheck[];
  passedStages: Set<WorkflowStage>;
  skippedStages: WorkflowStage[];
  verified: boolean;
  platformFailure: string | undefined;
  failedServices: Set<string>;
  /** 이번 검증에 쓰는 프로젝트. `reviewDeclaredChecks`가 바꾼다 */
  readonly project: LoadedProject;
  /** `reviewDeclaredChecks`가 정한, 허용되지 않아 쓰지 않은 선언 변경의 요약 */
  readonly unadoptedChange: string | undefined;
  /** `runDeclaredChecks`가 남긴, 부하 확인을 b-studio 쪽 문제로 재지 못한 사유 */
  readonly loadPlatformFailure: string | undefined;
}

export interface GateHost {
  readonly sandbox: Sandbox;
  readonly signal: AbortSignal | undefined;
  readonly onEvent: (event: AgentEvent) => void;
  readonly recheck: boolean;
  readonly light: boolean;
  readonly allowBreaking: boolean;
  /** 플랫폼 실패 뒤 다시 하기 전에 기다리는 시간(ms) */
  readonly platformRetryDelayMs: number;
  readonly state: GateState;
  /** `verifyChanges`에 넘길 옵션. project는 부르는 때의 `state.project`다 */
  verifyOptions(files: string[], alsoRestart: readonly string[]): VerifyOptions;
  /** 도구 밖 변경을 작업 공간에 옮기고, 게이트가 다룰 수 없어 거절한 경로를 돌려준다 */
  outsideSync(): Promise<readonly string[]>;
  reviewDeclaredChecks(): Promise<WorkflowCheck[]>;
  requirementRecordChecks(): Promise<WorkflowCheck[]>;
  evaluationAssetChecks(): Promise<WorkflowCheck[]>;
  changedFiles(): string[];
  filesToVerify(): string[];
  /** `#verifiedVersion = workspace.version` */
  markVerifiedVersion(): void;
  runDeclaredChecks(): Promise<WorkflowCheck[]>;
  /** 배열을 그 자리에서 바꾼다 */
  recheckEvaluationAssets(recordChecks: WorkflowCheck[]): Promise<void>;
  recheckOutsideChanges(recordChecks: WorkflowCheck[]): Promise<void>;
  /** 변경 리뷰(보호 경로·변경 크기 등) */
  reviewChecks(): WorkflowCheck[];
  /** 통과한 단계를 뺀 필수 단계 */
  missingStages(passed: ReadonlySet<WorkflowStage>): WorkflowStage[];
}

/** 차등 시험이 옛 구현(`gate-legacy.ts`)에 같은 하위 단계를 넘기려고 게이트에서 `GateHost`를 꺼내는 열쇠. 제품 코드는 쓰지 않는다 */
export const GATE_HOST = Symbol('gate-host');

type Handlers = Record<string, HookHandler>;

const stages = (value: unknown): WorkflowStage[] => value as WorkflowStage[];

export async function runGateCheck(host: GateHost): Promise<GateOutcome> {
  const { state, signal } = host;
  let thrown: { error: unknown } | undefined;
  /** 서비스 확인(`verifyChanges`) 한 번의 콜백 처리기. Rust가 `verifyBegin`을 부를 때마다 새로 만든다 */
  let verifyHandlers: Handlers = {};

  const handlers: Handlers = {
    outsideSync: async () => ({ ok: true, rejected: [...(await host.outsideSync())] }),
    reviewDeclared: async () => {
      const checks = await host.reviewDeclaredChecks();
      return { ok: true, checks, unadoptedChange: state.unadoptedChange ?? null };
    },
    requirementRecords: async () => ({ ok: true, checks: await host.requirementRecordChecks() }),
    evaluationAssets: async () => ({ ok: true, checks: await host.evaluationAssetChecks() }),
    changedCount: () => ({ ok: true, count: host.changedFiles().length }),
    filesToVerify: () => ({ ok: true, files: host.filesToVerify() }),
    markVersion: () => {
      host.markVerifiedVersion();
      return { ok: true };
    },
    strayProcesses: async () => {
      if (!host.sandbox.strayProcesses) return { ok: true, unsupported: true };
      try {
        const reports = await host.sandbox.strayProcesses({ signal });
        return { ok: true, reports };
      } catch (error) {
        // 취소로 끊겼는지는 여기서 알리고(`signal.aborted`), 던질지는 Rust가 정한다. 그 밖의 실패는 managed 서비스 전부를 다시 띄우는 쪽으로 읽는다
        return failure(error, { managed: state.project.managed.map(([name]) => name) }, signal?.aborted === true);
      }
    },
    verifyBegin: ({ files }) => {
      const setup = verifyChangesSetup(host.verifyOptions(files as string[], []));
      verifyHandlers = setup.handlers;
      return { ok: true, input: setup.input };
    },
    throwIfAborted: () => {
      signal?.throwIfAborted();
      return { ok: true };
    },
    retrySleep: async ({ ms }) => {
      await sleep(Number(ms), undefined, { signal });
      return { ok: true };
    },
    setState: (request) => {
      if ('attempts' in request) state.attempts = Number(request.attempts);
      if ('report' in request) state.report = request.report as VerificationReport;
      if ('failedServices' in request) state.failedServices = new Set(request.failedServices as string[]);
      if ('passedStages' in request) state.passedStages = new Set(stages(request.passedStages));
      if ('skippedStages' in request) state.skippedStages = stages(request.skippedStages);
      if ('checks' in request) state.checks = request.checks as WorkflowCheck[];
      if ('verified' in request) state.verified = request.verified === true;
      if ('platformFailure' in request) state.platformFailure = typeof request.platformFailure === 'string' ? request.platformFailure : undefined;
      return { ok: true };
    },
    emit: ({ event }) => {
      host.onEvent(event as AgentEvent);
      return { ok: true };
    },
    runDeclared: async () => {
      const checks = await host.runDeclaredChecks();
      return { ok: true, checks, loadPlatformFailure: state.loadPlatformFailure ?? null };
    },
    recheckEvaluationAssets: async ({ recordChecks }) => {
      const checks = recordChecks as WorkflowCheck[];
      await host.recheckEvaluationAssets(checks);
      return { ok: true, checks };
    },
    recheckOutsideChanges: async ({ recordChecks }) => {
      const checks = recordChecks as WorkflowCheck[];
      await host.recheckOutsideChanges(checks);
      return { ok: true, checks };
    },
    reviewChecks: () => ({ ok: true, checks: host.reviewChecks() }),
    missingStages: ({ passed }) => ({ ok: true, missing: host.missingStages(new Set(stages(passed))) }),
  };

  const hook = async (text: string): Promise<string> => {
    try {
      const request = decodeStrings(decodeNative<HookRequest>(text));
      const handler = handlers[String(request.op)] ?? verifyHandlers[String(request.op)];
      if (!handler) throw new Error(`알 수 없는 게이트 콜백입니다: ${String(request.op)}`);
      return encodeNative(encodeStrings(await handler(request)));
    } catch (error) {
      thrown ??= { error };
      return JSON.stringify({ fatal: true });
    }
  };

  const input = {
    recheck: host.recheck,
    light: host.light,
    allowBreaking: host.allowBreaking,
    retryDelayMs: host.platformRetryDelayMs,
    attempts: state.attempts,
    maxAttempts: state.maxAttempts,
    specFile: SPEC_FILE,
    manualVerificationCheck: MANUAL_VERIFICATION_CHECK,
  };
  const text = await native.gateCheckRun(encodeNative(encodeStrings(input)), hook);
  const result = decodeStrings(decodeNative<{ ok: boolean; value?: GateOutcome; kind?: string; message?: string }>(text));
  if (result.ok) return result.value as GateOutcome;
  if (result.kind === 'aborted') throw signal?.reason;
  if (result.kind === 'hook') throw thrown?.error ?? new Error('게이트 콜백이 실패했습니다');
  throw new Error(result.message ?? '게이트 입력을 읽지 못했습니다');
}
