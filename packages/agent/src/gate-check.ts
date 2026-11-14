import { setTimeout as sleep } from 'node:timers/promises';
import { decodeNative, encodeNative, native, type LoadRequest, type Sandbox } from '@b-studio/sandbox';
import { SPEC_FILE, type LoadedProject, type WorkflowPageCheck, type WorkflowStage } from '@b-studio/spec';
import { BrowserUnavailableError, StepFailedError, type BrowserFrame, type BrowserPageResult, type BrowserPageStep, type BrowserRunner } from './browser-check';
import { TEST_TIMEOUT_MS, type GateOutcome, type PageFetcher, type ServiceRequest } from './gate';
import type { AgentEvent } from './loop';
import { autoHandlers, autoInput } from './gate-auto';
import { MANUAL_VERIFICATION_CHECK } from './requirement-integrity';
import { TaskGraphError } from './task-graph';
import { clearTestReportsCommand, reportRootsForIncludes } from './test-run';
import { decodeStrings, encodeStrings, failure, serviceUrl, verifyChangesSetup, type HookHandler, type HookRequest, type VerificationReport, type VerifyOptions } from './verify';
import type { WorkflowCheck, WorkflowCompare, WorkflowStepCheck } from './workflow';
import type { Workspace } from './workspace';
import type { WorkflowPageCompare } from '@b-studio/spec';

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

/** 자동 화면 고르기가 게이트 객체에서 빌려 쓰는 값 */
export interface AutoOps {
  readonly workspace: Workspace;
  /** 옵션의 `reloadProject`. 없으면 이번 실행에서 studio.yaml이 바뀐 때만 디스크에서 읽는다 */
  readonly reloadProject: (() => Promise<LoadedProject>) | undefined;
  /** 시작 때 프로젝트의 root(studio.yaml을 읽는 곳) */
  readonly projectRoot: string;
}

/**
 * 선언한 검사 실행(`runDeclaredChecks` 아래)이 쓰는 TS 쪽 값과 동작. 조율·판정·글 조립은 Rust(`gate_declared.rs`, ADR-195 4f A5b-2)가 하고,
 * 화면 확인(`checkPage`의 부산물)과 자동 화면 고르기가 읽는 바깥 값(`auto`), sandbox·HTTP 요청은 여기로 부른다. 옛 구현(`declared-legacy.ts`)도 같은 값을 쓴다
 */
export interface DeclaredHost {
  readonly sandbox: Sandbox;
  readonly signal: AbortSignal | undefined;
  readonly onEvent: (event: AgentEvent) => void;
  /** 이번 검증에 쓰는 프로젝트(부르는 때의 것) */
  readonly project: LoadedProject;
  readonly requestService: ServiceRequest;
  /** 자동 화면 고르기(ADR-195 4f A5c-2)가 읽는 바깥 값. 고르는 규칙·막는 규칙·글 조립은 Rust(`gate_auto.rs`)가 하고, 옛 구현(`auto-pages-legacy.ts`)도 같은 값을 쓴다 */
  readonly auto: AutoOps;
  /** 화면 확인이 부르는 바깥 동작(브라우저 러너·페이지 요청·스크린샷 저장·디자인 비교·경고). 판정과 순서는 Rust(`gate_page.rs`, ADR-195 4f A5c-1)가 한다 */
  readonly page: PageOps;
  /** 화면 확인이 이름별로 모으는 부산물 */
  readonly pageMaps: {
    readonly steps: Map<string, WorkflowStepCheck[]>;
    readonly compares: Map<string, WorkflowCompare>;
    readonly blocked: Map<string, string[]>;
    readonly loadMs: Map<string, number>;
    readonly warnings: Map<string, string[]>;
  };
}

/** 화면 확인(`#checkPage` 아래)이 게이트 객체에서 빌려 쓰는 동작. 옛 구현(`check-page-legacy.ts`)도 같은 것을 쓴다 */
export interface PageOps {
  readonly sandbox: Sandbox;
  readonly pageFetcher: PageFetcher;
  readonly browserRunner: BrowserRunner;
  readonly saveArtifact: ((input: { name: string; data: Buffer; contentType: 'image/png' | 'image/jpeg' }) => Promise<string>) | undefined;
  readonly onBrowserFrame: ((input: { check: string; frame: BrowserFrame }) => void) | undefined;
  /** 화면 확인이 요청해도 되는 출처(세션의 모든 managed 서비스) */
  serviceOrigins(): Promise<string[]>;
  /** 단계 스크린샷을 저장하고 식별자를 붙인다. 저장 실패는 삼킨다(옛 그대로) */
  saveSteps(name: string, steps: readonly BrowserPageStep[]): Promise<WorkflowStepCheck[]>;
  /** 마지막 단계의 스크린샷을 디자인 기준 이미지와 비교한다. 실패하면 던진다 */
  compareDesign(compare: WorkflowPageCompare, name: string, result: BrowserPageResult, sandbox: Sandbox): Promise<void>;
  /** 게이트를 막지 않는 참고 문구를 이름별로 모아 둔다 */
  addWarning(name: string, message: string): void;
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
  let declaredPlan: { pages: WorkflowPageCheck[]; auto: { pages: Array<{ page: WorkflowPageCheck }> } } | undefined;
  /** 디자인 비교를 하는 화면 확인의 마지막 러너 결과(스크린샷 포함). 이름별로 든다 — 스크린샷(Buffer)은 경계를 넘기지 않는다 */
  const browserResults = new Map<string, BrowserPageResult>();
  /** 화면 확인 하나의 선언: 선언한 pageChecks의 `index`번째, 자동이면 자동 페이지의 `index`번째 */
  const pageOf = (auto: unknown, index: unknown): WorkflowPageCheck => (auto === true ? declaredPlan!.auto.pages[Number(index)]!.page : declaredPlan!.pages[Number(index)]!);
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
      // 이번 실행에서 바뀐 Next.js 페이지를 스스로 찾아 선언한 pageChecks와 같은 경로로 확인한다(autoPageChecks).
      // 고르는 일은 Rust가 한다(ADR-195 4f A5c-2): 여기서는 입력(`auto`)만 건네고, 고른 자동 페이지의 확인 선언은 `declaredAutoReady`로 받는다
      declaredPlan = { pages, auto: { pages: [] } };
      browserResults.clear();
      if (pages.length > 0 || tests.length > 0 || concurrency.length > 0 || loads.length > 0) {
        for (const map of Object.values(declared.pageMaps)) map.clear();
      }
      return {
        ok: true,
        pages: pages.map((page) => ({ service: page.service, path: page.path, mode: page.mode, viewport: page.viewport ?? null, stepCount: page.steps?.length ?? 0 })),
        // 화면 확인의 판정은 Rust가 한다: 판정이 읽는 선언 전체
        pageChecks: pages,
        auto: autoInput(declared),
        tests: tests.map((test) => ({ name: test.name, service: test.service, command: test.command, ...(test.maxAttempts !== undefined ? { maxAttempts: test.maxAttempts } : {}) })),
        concurrency,
        loads,
      };
    },
    // Rust가 자동 화면을 골랐다(열 화면이나 건너뜀이 있을 때만 부른다): 자동 페이지의 확인 선언을 들고, 이름별 부산물을 비운다
    declaredAutoReady: ({ pages }) => {
      declaredPlan!.auto = { pages: (pages as WorkflowPageCheck[]).map((page) => ({ page })) };
      for (const map of Object.values(declared.pageMaps)) map.clear();
      return { ok: true };
    },
    ...autoHandlers(declared),
    // ── 화면 확인(ADR-195 4f A5c-1): 판정·순서·글 조립은 Rust(`gate_page.rs`)가 한다. 아래는 그 Rust가 부르는 바깥 동작이다 ──
    declaredPageFetch: async ({ href }) => {
      try {
        const response = await declared.page.pageFetcher(String(href), graphSignal);
        return { ok: true, status: response.status, text: response.text };
      } catch (error) {
        return failure(error);
      }
    },
    // `fallbackProbe`의 경로를 서비스 위의 주소로 만든다. 출처가 다르면 던진다(#1187): Rust는 요청하지 않고 실패로 본다
    declaredServiceUrl: ({ base, path }) => {
      try {
        return { ok: true, href: new URL(serviceUrl(String(path), String(base))).href };
      } catch (error) {
        return failure(error);
      }
    },
    // 브라우저 러너를 돌리고 판정에 쓰는 값만 돌려준다. 스크린샷(Buffer)은 경계를 넘기지 않고 이름으로 들고 있다가 단계 저장·디자인 비교가 쓴다.
    // 헤드리스 브라우저를 못 띄운 오류만 `kind: 'unavailable'`로 알린다(Rust가 fallbackProbe가 있을 때만 대신 HTTP로 확인한다)
    declaredBrowserRun: async ({ auto, index, name, href }) => {
      try {
        const page = pageOf(auto, index);
        const label = String(name);
        const { page: ops, pageMaps } = declared;
        let result: BrowserPageResult;
        try {
          result = await ops.browserRunner(String(href), {
            viewport: page.viewport,
            ...(page.expectInViewport ? { viewportTexts: page.expectInViewport } : {}),
            steps: page.steps,
            signal: graphSignal,
            // 로드 예산을 적은 확인만 잰다. 재려면 워밍업 이동을 한 번 더 해야 해서(게이트 시간이 늘고, 워밍업 때의 오류는 비운다)
            // 예산이 없는 확인까지 두 번 열면 첫 로드에서만 나는 오류를 놓칠 수 있다
            measureLoad: page.maxLoadMs !== undefined,
            // 스크린샷을 저장할 곳이 있거나 디자인 비교를 할 때만 찍는다
            capture: ops.saveArtifact !== undefined || page.compare !== undefined,
            // 세션 서비스의 출처 밖으로는 요청이 나가지 못하게 한다(모델이 만든 페이지를 통한 요청 위조 차단)
            allowedOrigins: await ops.serviceOrigins(),
            ...(ops.onBrowserFrame ? { onFrame: (frame: BrowserFrame) => ops.onBrowserFrame!({ check: label, frame }) } : {}),
          });
        } catch (error) {
          if (error instanceof BrowserUnavailableError) return failure(error, { kind: 'unavailable' });
          // 실패한 단계의 스크린샷도 결과에 남긴다
          if (error instanceof StepFailedError) pageMaps.steps.set(label, await ops.saveSteps(label, error.steps));
          return failure(error);
        }
        if (ops.saveArtifact) pageMaps.steps.set(label, await ops.saveSteps(label, result.steps));
        if (result.blockedRequests.length > 0) pageMaps.blocked.set(label, result.blockedRequests);
        if (result.loadMs !== undefined) pageMaps.loadMs.set(label, result.loadMs);
        if (page.compare) browserResults.set(label, result);
        else browserResults.delete(label);
        return {
          ok: true,
          result: { ...result, blockedRequests: undefined, steps: Array.isArray(result.steps) ? result.steps.map((step) => ({ label: step.label, ok: step.ok })) : result.steps },
        };
      } catch (error) {
        return failure(error);
      }
    },
    // 문제가 없을 때만 Rust가 부른다. 기준 이미지 읽기·비교·저장은 TS가 한다
    declaredCompare: async ({ auto, index, name }) => {
      try {
        const page = pageOf(auto, index);
        const label = String(name);
        const result = browserResults.get(label);
        if (!page.compare || !result) throw new Error('디자인 비교에 쓸 화면 확인 결과가 없습니다');
        await declared.page.compareDesign(page.compare, label, result, declared.page.sandbox);
        return { ok: true };
      } catch (error) {
        return failure(error);
      }
    },
    declaredWarn: ({ name, message }) => {
      declared.page.addWarning(String(name), String(message));
      return { ok: true };
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
