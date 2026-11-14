import { setTimeout as sleep } from 'node:timers/promises';
import { decodeNative, encodeNative, native, type LoadRequest, type Sandbox } from '@b-studio/sandbox';
import { SPEC_FILE, type LoadedProject, type WorkflowPageCheck, type WorkflowStage } from '@b-studio/spec';
import { TEST_TIMEOUT_MS, type GateOutcome, type ServiceRequest } from './gate';
import type { AgentEvent } from './loop';
import { MANUAL_VERIFICATION_CHECK } from './requirement-integrity';
import { TaskGraphError } from './task-graph';
import { clearTestReportsCommand, reportRootsForIncludes } from './test-run';
import { decodeStrings, encodeStrings, failure, verifyChangesSetup, type HookHandler, type HookRequest, type VerificationReport, type VerifyOptions } from './verify';
import type { WorkflowCheck, WorkflowCompare, WorkflowStepCheck } from './workflow';

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
}

/** 자동으로 연 화면 확인 하나. `name`은 이름 짓기 전의 이름이다 */
export interface AutoPageEntry {
  page: WorkflowPageCheck;
  name: string;
  probedId?: string;
  sampled?: string;
}

/**
 * 선언한 검사 실행(`runDeclaredChecks` 아래)이 쓰는 TS 쪽 값과 동작. 조율·판정·글 조립은 Rust(`gate_declared.rs`, ADR-195 4f A5b-2)가 하고,
 * 화면 확인(`autoPages`·`checkPage`와 그 부산물)과 sandbox·HTTP 요청은 여기로 부른다. 옛 구현(`declared-legacy.ts`)도 같은 값을 쓴다
 */
export interface DeclaredHost {
  readonly sandbox: Sandbox;
  readonly signal: AbortSignal | undefined;
  readonly onEvent: (event: AgentEvent) => void;
  /** 이번 검증에 쓰는 프로젝트(부르는 때의 것) */
  readonly project: LoadedProject;
  readonly requestService: ServiceRequest;
  autoPages(declared: readonly WorkflowPageCheck[]): Promise<{ pages: AutoPageEntry[]; skipped: WorkflowCheck[] }>;
  checkPage(page: WorkflowPageCheck, name: string, signal: AbortSignal, options?: { auto?: boolean; probedId?: string; sampled?: string }): Promise<string[]>;
  /** 화면 확인이 이름별로 모으는 부산물 */
  readonly pageMaps: {
    readonly steps: Map<string, WorkflowStepCheck[]>;
    readonly compares: Map<string, WorkflowCompare>;
    readonly blocked: Map<string, string[]>;
    readonly loadMs: Map<string, number>;
    readonly warnings: Map<string, string[]>;
  };
}

export interface GateHost {
  /** 선언한 검사 실행이 쓰는 TS 쪽 값과 동작 */
  readonly declared: DeclaredHost;
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
  const { state, signal, declared } = host;
  /** 작업 그래프가 노드에 넘기던 신호. 취소 신호가 없으면 취소되지 않는 신호다(`runTaskGraph`와 같다) */
  const graphSignal = signal ?? new AbortController().signal;
  /** `declaredBegin`이 읽은 선언과 자동 페이지. `checkPage`가 번호로 꺼낸다 */
  let declaredPlan: { pages: WorkflowPageCheck[]; auto: Awaited<ReturnType<DeclaredHost['autoPages']>> } | undefined;
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
    // ── 선언한 검사 실행(ADR-195 4f A5b-2): 조율·판정·글 조립은 Rust(`gate_declared.rs`), 아래는 그 Rust가 부르는 바깥 동작이다 ──
    declaredBegin: async () => {
      const workflow = declared.project.spec.workflow;
      const pages = workflow?.pageChecks ?? [];
      const tests = workflow?.tests ?? [];
      const concurrency = workflow?.concurrencyChecks ?? [];
      const loads = workflow?.loadChecks ?? [];
      // 이번 실행에서 바뀐 Next.js 페이지를 스스로 찾아 선언한 pageChecks와 같은 경로로 확인한다(autoPageChecks)
      const auto = await declared.autoPages(pages);
      declaredPlan = { pages, auto };
      if (pages.length > 0 || tests.length > 0 || concurrency.length > 0 || loads.length > 0 || auto.pages.length > 0 || auto.skipped.length > 0) {
        for (const map of Object.values(declared.pageMaps)) map.clear();
      }
      return {
        ok: true,
        pages: pages.map((page) => ({ service: page.service, path: page.path, mode: page.mode, viewport: page.viewport ?? null, stepCount: page.steps?.length ?? 0 })),
        tests: tests.map((test) => ({ name: test.name, service: test.service, command: test.command, ...(test.maxAttempts !== undefined ? { maxAttempts: test.maxAttempts } : {}) })),
        concurrency,
        loads,
        autoNames: auto.pages.map((entry) => entry.name),
        autoSkipped: auto.skipped,
      };
    },
    declaredCheckPage: async ({ auto, index, name }) => {
      try {
        const plan = declaredPlan!;
        if (auto === true) {
          const entry = plan.auto.pages[Number(index)]!;
          const options = { auto: true, ...(entry.probedId !== undefined ? { probedId: entry.probedId } : {}), ...(entry.sampled ? { sampled: entry.sampled } : {}) };
          return { ok: true, evidence: await declared.checkPage(entry.page, String(name), graphSignal, options) };
        }
        return { ok: true, evidence: await declared.checkPage(plan.pages[Number(index)]!, String(name), graphSignal) };
      } catch (error) {
        return failure(error);
      }
    },
    declaredClearReports: async ({ service }) => {
      const spec = declared.project.managed.find(([name]) => name === service)?.[1];
      if (!spec) return { ok: true };
      const command = clearTestReportsCommand(reportRootsForIncludes(spec.includes));
      try {
        await declared.sandbox.exec(String(service), command, signal ? { signal } : {});
        return { ok: true };
      } catch (error) {
        // 지우지 못해도 테스트는 돌린다 — 삼킬지는 Rust가 정한다
        return failure(error);
      }
    },
    declaredExec: async ({ service, command }) => {
      // 시간 상한(`TEST_TIMEOUT_MS`)은 이 콜백이 연 신호로 둔다. 취소 신호와 합친다
      const timeout = AbortSignal.timeout(TEST_TIMEOUT_MS);
      try {
        // exec는 기본으로 출력의 시크릿 값을 가려서 돌려준다. 실패 출력이 모델에게 그대로 들어가므로 가린 결과만 쓴다
        const result = await declared.sandbox.exec(String(service), command as string[], { signal: AbortSignal.any([graphSignal, timeout]) });
        return { ok: true, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        return failure(error);
      }
    },
    declaredStats: async () => {
      try {
        const usage = await declared.sandbox.stats();
        return { ok: true, usage: usage.map((entry) => ({ service: entry.service, oomKilled: entry.oomKilled, memoryLimitBytes: entry.memoryLimitBytes })) };
      } catch (error) {
        return failure(error);
      }
    },
    declaredRestart: async ({ service }) => {
      try {
        await declared.sandbox.restart(String(service), { signal: graphSignal });
        return { ok: true };
      } catch (error) {
        return failure(error);
      }
    },
    declaredEndpoint: async ({ service }) => {
      try {
        return { ok: true, url: (await declared.sandbox.endpoint(String(service))).url };
      } catch (error) {
        return failure(error);
      }
    },
    // 출처 제한과 실제 요청이 같은 해석에서 나오게 한다: 여기서 푼 `href`를 Rust가 그대로 요청한다
    declaredResolveUrl: ({ base, path }) => {
      try {
        const url = new URL(String(path), String(base));
        return { ok: true, href: url.href, sameOrigin: url.origin === new URL(String(base)).origin };
      } catch (error) {
        return failure(error);
      }
    },
    declaredRequest: async ({ href, method, headers, body }) => {
      try {
        const response = await declared.requestService(String(href), {
          method: String(method),
          ...(headers ? { headers: headers as Record<string, string> } : {}),
          ...(body !== undefined ? { body: String(body) } : {}),
          signal: graphSignal,
        });
        return { ok: true, status: response.status, text: response.text };
      } catch (error) {
        return failure(error);
      }
    },
    declaredLoadSupported: () => ({ ok: true, supported: Boolean(declared.sandbox.runLoad) }),
    declaredRunLoad: async ({ request }) => {
      try {
        return { ok: true, result: await declared.sandbox.runLoad!(request as LoadRequest, { signal }) };
      } catch (error) {
        return failure(error);
      }
    },
    declaredRedact: ({ text, rethrow }) => {
      try {
        return { ok: true, text: declared.sandbox.redact(String(text)) };
      } catch (error) {
        // 근거를 만들다 난 실패는 삼키고, 실패 사유를 가리다 난 실패는 게이트 밖으로 올라간다 — 어느 쪽인지는 Rust가 알린다
        if (rethrow === true) throw error;
        return failure(error);
      }
    },
    declaredPageData: ({ names }) => ({
      ok: true,
      items: (names as string[]).map((name) => {
        const { steps, compares, blocked, loadMs, warnings } = declared.pageMaps;
        return {
          ...(steps.has(name) ? { steps: steps.get(name) } : {}),
          ...(compares.has(name) ? { compare: compares.get(name) } : {}),
          ...(loadMs.has(name) ? { loadMs: loadMs.get(name) } : {}),
          blocked: blocked.get(name) ?? [],
          warnings: warnings.get(name) ?? [],
        };
      }),
    }),
    declaredThrowGraphError: ({ message }) => {
      throw new TaskGraphError(String(message));
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
