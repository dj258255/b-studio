import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { formatBytes, type Sandbox, type StartOptions } from '@b-studio/sandbox';
import { SAFE_SEGMENT, type AutoPageChecks, type ConcurrencyExpect, type LoadedProject, type WorkflowConcurrencyCheck, type WorkflowPageCheck, type WorkflowPageCompare, type WorkflowStage, type WorkflowTest } from '@b-studio/spec';
import { BrowserUnavailableError, runInBrowser, StepFailedError, type BrowserFrame, type BrowserPageResult, type BrowserPageStep, type BrowserRunner } from './browser-check';
import type { AgentEvent } from './loop';
import { collectImportGraph, DEFAULT_IMPORT_GRAPH_LIMITS, DEFAULT_TRACE_DEPTH, isGraphSourceFile, isPageFileInService, tracePages, type PageCandidate } from './import-graph';
import { DEFAULT_DYNAMIC_ROUTE_FALLBACK, routesFromCandidates, routesFromChangedFiles } from './next-routes';
import { servicesForFiles } from './services';
import { detectStuckLoading } from './stuck-loading';
import { runTaskGraph, type TaskNode } from './task-graph';
import { captureBaselines, formatVerificationReport, verifyChanges, type ContractFetcher, type VerificationReport } from './verify';
import { missingVerificationStages, reviewChanges, type WorkflowCheck, type WorkflowCompare, type WorkflowStepCheck } from './workflow';
import type { OpenApiDocument } from './contract-diff';
import { compareScreenshot, VisualCompareError, type CompareResult } from './visual-compare';
import { MANUAL_VERIFICATION_CHECK, reviewRequirementRecords } from './requirement-integrity';
import { REQUIREMENTS_FILE } from './requirements';
import { readProjectFileSync, type Workspace } from './workspace';

export type GateOutcome =
  | { kind: 'pass' }
  /** 모델에게 돌려줄 게이트 결과. 고친 뒤 다시 턴을 끝내게 한다 */
  | { kind: 'retry'; feedback: string }
  | { kind: 'exhausted'; summary: string };

/** recheckGateOnMaxTurns의 결과. pass면 summary를 'done' 요약으로, 아니면 'failed' 요약으로 쓴다 */
export interface MaxTurnsRecheck {
  pass: boolean;
  summary: string;
}

/**
 * 턴 상한에 걸렸을 때 바로 실패로 끝내지 않고, 지금까지의 변경이 검증 게이트를 통과하는지 한 번 더 확인한다(ADR-131).
 * 턴 상한에 걸린 시점은 모델이 마지막 도구 호출 뒤 자기 입으로 "끝났다"고 말할 기회를 얻지 못했을 수 있어,
 * 실제로는 요청이 끝나 있을 수도 있다 — 되돌리기 전에 한 번은 플랫폼이 직접 확인한다.
 * 게이트가 없으면(질문 모드·지연 기동이 아직 아무것도 바꾸지 않은 세션) 확인할 것이 없어 바로 실패로 본다.
 * 통과(pass)든 실패든 다른 실패 사유(오류·중지)와 달리 재시도 횟수를 넘겼는지는 따지지 않는다 —
 * 어차피 턴이 남지 않아 모델에게 피드백을 돌려줄 수 없으므로, pass가 아니면 모두 실패로 끝낸다.
 */
export async function recheckGateOnMaxTurns(gate: VerificationGate | undefined, maxTurns: number, onEvent: (event: AgentEvent) => void): Promise<MaxTurnsRecheck> {
  const limitMessage = `최대 턴 수(${maxTurns})를 넘었습니다`;
  if (!gate) return { pass: false, summary: limitMessage };
  const outcome = await gate.check();
  if (outcome.kind !== 'pass') return { pass: false, summary: limitMessage };
  if (gate.verified) onEvent({ type: 'stage', stage: 'checkpoint', source: 'platform' });
  return { pass: true, summary: `${limitMessage}. 다만 지금까지의 변경이 검증 게이트를 통과해 체크포인트로 남깁니다(요청의 일부만 끝났을 수 있습니다).` };
}

/**
 * 검증 범위. full은 지금과 같고, light(가볍게 확인)는 서비스 재시작·준비 판정·계약만 돌린다.
 * 작은 변경에서 빠른 피드백을 받으려는 것이라, 건너뛴 단계는 배포 조건(releaseRequires)이 자연히 막는다.
 */
export type VerifyMode = 'full' | 'light';

/** browser_check에서 화면 경로를 불러오는 함수. 테스트에서 네트워크 없이 바꿔 끼운다 */
export type PageFetcher = (url: string, signal?: AbortSignal) => Promise<{ status: number; text: string }>;

const PAGE_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 10 * 60_000;
/** 동시 요청 확인에서 요청 하나가 기다릴 시간 */
const REQUEST_TIMEOUT_MS = 15_000;
const CHECK_CONCURRENCY = 2;
const OUTPUT_TAIL_LINES = 30;

/**
 * Next.js가 오류 화면을 대신 그릴 때 나오는 문구. 상태 코드가 200이어도 본문이 오류 화면이면 실패로 본다.
 * 자동으로 연 페이지에만 적용한다(선언한 pageChecks는 사람이 기대 문구를 적어 두므로 그대로 둔다).
 *  - "Application error: a server-side exception has occurred" — App Router가 서버 컴포넌트 예외를 만나면(프로덕션) 대신 그리는 화면
 *  - "Unhandled Runtime Error" — 클라이언트 예외를 Next.js 개발 오버레이가 보여 줄 때의 제목
 */
export const NEXT_ERROR_MARKERS = ['Application error: a server-side exception has occurred', 'Unhandled Runtime Error'] as const;
/** Next.js 기본 404 화면. 약속한 응답이 404가 아니면 실패로 본다(없는 라우트를 열어 본 셈이다) */
export const NEXT_NOT_FOUND_MARKER = 'This page could not be found';

/** 자동으로 연 페이지의 본문에서 찾은 오류 표지. 없으면 undefined */
export function nextErrorMarker(text: string, expectStatus: number): string | undefined {
  const found = NEXT_ERROR_MARKERS.find((marker) => text.includes(marker));
  if (found) return found;
  if (expectStatus !== 404 && text.includes(NEXT_NOT_FOUND_MARKER)) return NEXT_NOT_FOUND_MARKER;
  return undefined;
}

/**
 * `workflow.autoPageChecks` 설정을 선언형 pageChecks와 같은 모양으로 바꾼다.
 * 같은 `#checkPage` 경로로 돌리기 위한 것이라, 설정에 없는 값은 pageChecks의 기본값과 같게 둔다.
 */
export function autoPageCheck(config: AutoPageChecks, routePath: string): WorkflowPageCheck {
  return {
    service: config.service,
    path: routePath,
    mode: config.mode,
    expectStatus: config.expectStatus,
    allowConsoleErrors: false,
    noHorizontalScroll: false,
    ...(config.viewport ? { viewport: config.viewport } : {}),
  };
}

export const fetchPage: PageFetcher = async (url, signal) => {
  const timeout = AbortSignal.timeout(PAGE_TIMEOUT_MS);
  const response = await fetch(url, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  return { status: response.status, text: await response.text() };
};

/** 게이트가 세션 서비스에 직접 보내는 요청. 동시 요청 확인에서 테스트가 네트워크 없이 바꿔 끼운다 */
export type ServiceRequest = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text: string }>;

const requestService: ServiceRequest = async (url, init) => {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(url, {
    method: init.method,
    ...(init.headers ? { headers: init.headers } : {}),
    // GET·HEAD에는 본문을 보낼 수 없다
    ...(init.body !== undefined && init.method !== 'GET' ? { body: init.body } : {}),
    redirect: 'manual',
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  return { status: response.status, text: await response.text() };
};

export interface GateOptions {
  project: LoadedProject;
  sandbox: Sandbox;
  workspace: Workspace;
  allowBreaking: boolean;
  maxVerifyAttempts: number;
  /** 검증 범위(기본 full). light면 재시작·준비 판정·계약만 돌리고 나머지 단계는 건너뛴다 */
  verify?: VerifyMode;
  fetcher: ContractFetcher;
  pageFetcher?: PageFetcher;
  browserRunner?: BrowserRunner;
  signal?: AbortSignal;
  onServiceStatus?: StartOptions['onStatus'];
  onEvent: (event: AgentEvent) => void;
  /**
   * 화면 확인 중 찍은 스크린샷(PNG/JPEG)을 저장하고 식별자를 돌려준다. 저장 위치는 호출자가 정한다(agent는 모른다).
   * 넘기면 browser 모드 화면 확인이 capture를 켜고 단계 스크린샷을 WorkflowCheck.steps에 남긴다
   */
  saveArtifact?: (input: { name: string; data: Buffer; contentType: 'image/png' | 'image/jpeg' }) => Promise<string>;
  /** 화면 확인 중 받은 실시간 프레임. 미리보기 중계에 쓴다 */
  onBrowserFrame?: (input: { check: string; frame: BrowserFrame }) => void;
  /** 동시 요청 확인이 세션 서비스에 보내는 요청. 넘기지 않으면 실제 fetch를 쓴다 */
  requestService?: ServiceRequest;
}

/**
 * 모델이 턴을 끝낼 때마다 도는 검증 게이트.
 * 모델 호출 방식(직접 만든 루프, 로컬 Claude Code)과 무관하게 같은 규칙으로 완료를 판정하도록 루프에서 분리했다.
 * 순서: 재시작·준비 판정·계약 비교 → (선언했다면) 화면 확인·테스트를 병렬로 → 변경 리뷰 → 필수 단계 대조
 */
export class VerificationGate {
  attempts = 0;
  /** 마지막 검증 결과 */
  report: VerificationReport | undefined;
  /** 마지막 검증에서 플랫폼이 실행한 화면 확인·테스트·리뷰 결과 */
  checks: WorkflowCheck[] = [];
  /** 마지막 검증에서 통과한 검증 단계 */
  passedStages = new Set<WorkflowStage>();
  /** light에서 건너뛴 필수 검증 단계. workflow.required 대조에서 실패로 보지 않는다(full에서는 빈 배열) */
  skippedStages: WorkflowStage[] = [];
  /** 바뀐 파일을 실제로 검증해 통과했는지. 바뀐 파일이 없어 검증 없이 끝났다면 false라서 체크포인트 단계로 넘어가지 않는다 */
  verified = false;
  /**
   * 가장 최근 check()의 결과. 한 번도 돌지 않았으면 없다. verified는 한 번 통과하면 켜진 채로 남으므로, 그 뒤의 검증이
   * 실패했는지는 이 값으로 본다(질문으로 끝난 실행이 체크포인트를 남겨도 되는지 판정하는 데 쓴다)
   */
  lastOutcome: GateOutcome['kind'] | undefined;
  readonly #options: GateOptions;
  readonly #baselines: ReadonlyMap<string, OpenApiDocument>;
  /** 게이트 재시도 상한. 기본은 생성 시 받은 값이고, 승격이 새 예산을 주면 커진다 */
  #maxAttempts: number;
  #verifiedVersion = 0;
  #failedServices = new Set<string>();
  /** 화면 확인 이름 → 단계 결과. 실패해 예외로 끝나도 실패 단계의 스크린샷을 남기려고 따로 모은다 */
  #pageSteps = new Map<string, WorkflowStepCheck[]>();
  /** 화면 확인 이름 → 디자인 비교 결과. 실패해 예외로 끝나도 결과를 남기려고 따로 모은다 */
  #pageCompares = new Map<string, WorkflowCompare>();
  /** 화면 확인 이름 → 허용 출처 밖이라 막은 요청. 앱의 오류가 아니라 경계에서 막은 것이라 실패로 세지 않고 기록만 한다 */
  #pageBlocked = new Map<string, string[]>();
  /** 화면 확인 이름 → 측정한 로드 시간(ms). 예산을 적은 확인만 재어 결과에 남긴다 */
  #pageLoadMs = new Map<string, number>();
  /** 화면 확인 이름 → 게이트를 막지 않는 참고 문구(ADR-078). HTTP 모드의 로딩 문구 경고처럼, 확정할 수 없지만 알려 둘 만한 것을 담는다 */
  #pageWarnings = new Map<string, string[]>();
  /** 동시 요청 확인 이름 → 통과했을 때의 요약(성공 건수·상태 분포·then 값) */
  #concurrencyNotes = new Map<string, string>();

  private constructor(options: GateOptions, baselines: ReadonlyMap<string, OpenApiDocument>) {
    this.#options = options;
    this.#baselines = baselines;
    this.#maxAttempts = options.maxVerifyAttempts;
  }

  /** 계약 비교 기준은 모델이 파일을 바꾸기 전에 잡아야 한다 */
  static async create(options: GateOptions): Promise<VerificationGate> {
    // 요구사항 문서의 실행 전 모습도 같은 이유로 여기서 고정한다(러너가 실행을 시작할 때 이미 불렀다면 그 값이 유지된다)
    options.workspace.snapshotRead(REQUIREMENTS_FILE);
    return new VerificationGate(options, await captureBaselines(options.sandbox, options.project, options.fetcher));
  }

  /**
   * 요구사항 문서의 검증 기록(사람 확인·재확인 판정 필드)이 이번 실행에서 바뀌었는지 본다(ADR-157).
   * 바뀐 파일 목록이 아니라 디스크의 문서를 직접 견주므로 서비스 안 명령(run_in_service)이나 CLI 러너가 고친 것도 잡는다.
   * 단계와 무관하게 항상 돌린다(가볍게 확인에서도 건너뛰지 않는다) — 파일 하나를 읽고 견주는 것뿐이라 가볍다.
   */
  async #requirementRecordChecks(): Promise<WorkflowCheck[]> {
    const { workspace } = this.#options;
    const before = workspace.snapshotRead(REQUIREMENTS_FILE);
    const after = readProjectFileSync(workspace.root, REQUIREMENTS_FILE);
    // 문서 자리에 링크·FIFO·거대한 파일이 놓였으면 견줄 수 없다. "문서가 없다"로 넘기면 링크 너머의 내용이 나중에 읽혀
    // 검증됨을 만들 수 있으므로 통과시키지 않는다
    if (after.kind === 'irregular') {
      return [
        {
          stage: 'review',
          name: MANUAL_VERIFICATION_CHECK,
          ok: false,
          attempts: 1,
          detail: `${REQUIREMENTS_FILE}을(를) 읽을 수 없어 검증 기록을 견줄 수 없습니다: ${after.reason}. 일반 파일로 되돌리세요`,
        },
      ];
    }
    const beforeText = before.kind === 'text' ? before.content : undefined;
    const afterText = after.kind === 'text' ? after.content : undefined;
    if (beforeText === afterText) return [];
    return reviewRequirementRecords(beforeText, afterText);
  }

  /**
   * 승격이 새 재시도 예산을 줄 때 쓴다. 상한을 "지금까지 시도한 수 + 예산"으로 다시 잡으므로,
   * 남은 횟수에 더하는 게 아니라 그 모델에게 예산만큼의 기회를 새로 준다(E4에서 2번째 실패 뒤 승격하고도
   * 한 번밖에 남지 않았던 문제). 돌려주는 값은 이 호출로 다음 시도가 가능해졌는지다
   */
  grantRetryBudget(budget: number): boolean {
    const next = this.attempts + (Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0);
    if (next > this.#maxAttempts) this.#maxAttempts = next;
    return this.attempts < this.#maxAttempts;
  }

  /**
   * 모델이 턴을 끝낼 때마다 부른다. 마지막 결과를 lastOutcome에 남긴다 — 호출자가 결과를 받아 쓰지 않는 자리(질문을 남기고
   * 멈추기 전에 한 번 돌리는 검증)에서도 "마지막 검증이 통과했는가"를 나중에 물을 수 있어야 한다
   */
  async check(): Promise<GateOutcome> {
    const outcome = await this.#check();
    this.lastOutcome = outcome.kind;
    return outcome;
  }

  async #check(): Promise<GateOutcome> {
    const { project, sandbox, workspace, allowBreaking, fetcher, signal, onServiceStatus, onEvent } = this.#options;
    const recordChecks = await this.#requirementRecordChecks();
    if (workspace.changedFiles().length === 0) {
      if (recordChecks.every((check) => check.ok)) return { kind: 'pass' };
      // 바뀐 파일로 추적되지 않은 경로(서비스 안 명령 등)로 검증 기록만 고쳤다: 다른 단계는 돌릴 것이 없다
      this.checks = recordChecks;
      for (const check of recordChecks) onEvent({ type: 'workflow_check', check });
      return this.#failure('', recordChecks.filter((check) => !check.ok));
    }

    const files = this.#filesToVerify();
    this.#stage('run');
    onEvent({ type: 'verify_start', files });
    this.#verifiedVersion = workspace.version;
    const report = await verifyChanges({
      sandbox,
      project,
      changedFiles: files,
      baselines: this.#baselines,
      allowBreaking,
      fetcher,
      start: { signal, onStatus: onServiceStatus },
    });
    // 도중에 취소되면 계약 조회처럼 결과로 바뀐 중단까지 게이트 실패로 알리지 않는다
    signal?.throwIfAborted();
    this.#stage('contract_check');
    this.report = report;
    this.#failedServices = new Set(report.restarted.filter((check) => !check.ready).map((check) => check.service));
    this.passedStages = new Set();
    this.checks = [...recordChecks];

    const text = formatVerificationReport(report, { allowBreaking });
    onEvent({ type: 'verify_result', report, text });
    // 세션이 시작할 때는 없던 부가 서비스를 새로 올렸으면 대화 화면에도 바로, 왜 켰는지와 함께 알린다
    // (도그푸딩 마찰 138, ADR-146) — report.text에도 같은 줄이 있지만, 그건 검증 결과 전체를 읽어야 보인다
    if (report.addedAddons?.length) {
      onEvent({
        type: 'warning',
        message: `compose에 새로 생긴 부가 서비스를 켰습니다(끄려면 서비스 메뉴에서): ${report.addedAddons.join(', ')}`,
      });
    }

    // 서비스가 뜨지 않았거나 계약이 깨졌으면 그 위에서 테스트나 화면 확인을 돌려도 의미가 없다
    if (report.ok) {
      this.passedStages.add('run');
      this.passedStages.add('contract_check');
      if (this.#options.verify === 'light') {
        // 가볍게 확인: 재시작·준비 판정·계약만 돌린다. 건너뛴 단계는 기록만 하고 실패로 보지 않는다
        this.skippedStages = missingVerificationStages(project, this.passedStages);
        for (const check of recordChecks) onEvent({ type: 'workflow_check', check });
      } else {
        const checks = await this.#runDeclaredChecks();
        signal?.throwIfAborted();
        this.#stage('review');
        checks.push(...reviewChanges(project, workspace.changedFiles()), ...recordChecks);
        this.checks = checks;
        for (const check of checks) onEvent({ type: 'workflow_check', check });
        for (const stage of ['browser_check', 'test', 'concurrency_check', 'review'] as const) {
          const ofStage = checks.filter((check) => check.stage === stage);
          if (ofStage.length > 0 && ofStage.every((check) => check.ok)) this.passedStages.add(stage);
        }
      }
    }

    const failedChecks = this.checks.filter((check) => !check.ok);
    if (report.ok && failedChecks.length === 0) {
      // light는 건너뛴 단계를 실패로 보지 않는다. 통과한 단계만 남겨 배포 조건(releaseRequires)이 자연히 막는다
      if (this.#options.verify === 'light') {
        this.verified = true;
        return { kind: 'pass' };
      }
      // 스키마가 실행 수단 없는 필수 단계를 막지만, 어떤 경로로든 단계가 돌지 않았다면 통과로 보지 않는다
      const missing = missingVerificationStages(project, this.passedStages);
      if (missing.length > 0) return { kind: 'exhausted', summary: `워크플로 필수 단계가 실행되지 않아 완료로 인정하지 않습니다: ${missing.join(', ')}` };
      this.verified = true;
      return { kind: 'pass' };
    }

    return this.#failure(text, failedChecks);
  }

  /** 검증 실패를 시도 횟수에 세고, 남은 기회가 있으면 모델에게 돌려줄 안내를, 없으면 중단 사유를 돌려준다 */
  #failure(reportText: string, failedChecks: readonly WorkflowCheck[]): GateOutcome {
    this.attempts += 1;
    if (this.attempts >= this.#maxAttempts) {
      // 사람 확인 기록 위조로 막힌 것이면 사유를 요약에 남긴다(대화에서 왜 되돌렸는지 바로 보이게)
      const record = failedChecks.find((check) => check.name === MANUAL_VERIFICATION_CHECK);
      const reason = record?.detail ? ` — ${record.detail.split('\n')[0]}` : '';
      return { kind: 'exhausted', summary: `검증 게이트를 ${this.attempts}번 통과하지 못했습니다${reason}` };
    }
    const body = reportText ? `${reportText}${formatFailedChecks(failedChecks)}` : formatFailedChecks(failedChecks).trimStart();
    return {
      kind: 'retry',
      feedback: `[b-studio 검증 게이트] 변경 사항이 검증을 통과하지 못했습니다. 아래 결과를 보고 고친 뒤 턴을 끝내세요.\n\n${body}`,
    };
  }

  #stage(stage: WorkflowStage): void {
    this.#options.onEvent({ type: 'stage', stage, source: 'platform' });
  }

  /** studio.yaml에 선언한 화면 확인·테스트·동시 요청 확인은 서로 기다릴 이유가 없으므로 작업 그래프로 동시에 돌린다 */
  async #runDeclaredChecks(): Promise<WorkflowCheck[]> {
    const workflow = this.#options.project.spec.workflow;
    const pages = workflow?.pageChecks ?? [];
    const tests = workflow?.tests ?? [];
    const concurrency = workflow?.concurrencyChecks ?? [];
    // 이번 실행에서 바뀐 Next.js 페이지를 스스로 찾아 선언한 pageChecks와 같은 경로로 확인한다(autoPageChecks)
    const auto = await this.#autoPages(pages);
    if (pages.length === 0 && tests.length === 0 && concurrency.length === 0 && auto.pages.length === 0 && auto.skipped.length === 0) return [];

    const meta: Array<Pick<WorkflowCheck, 'stage' | 'name'>> = [];
    const nodes: TaskNode<void>[] = [];
    this.#pageSteps.clear();
    this.#pageCompares.clear();
    this.#pageBlocked.clear();
    this.#pageLoadMs.clear();
    this.#pageWarnings.clear();
    this.#concurrencyNotes.clear();
    for (const page of pages) {
      const browser = page.viewport ? `browser ${page.viewport.width}x${page.viewport.height}` : 'browser';
      const steps = page.steps?.length ? `, 단계 ${page.steps.length}개` : '';
      const name = `${page.service} ${page.path}${page.mode === 'browser' ? ` (${browser}${steps})` : ''}`;
      meta.push({ stage: 'browser_check', name });
      nodes.push({ id: `page:${name}`, run: ({ signal }) => this.#checkPage(page, name, signal) });
    }
    for (const entry of auto.pages) {
      meta.push({ stage: 'browser_check', name: entry.name });
      // 자동 페이지는 같은 #checkPage로 돌리되 오류 화면 표지까지 본다. 추정한 id로 연 동적 경로는 probedId를 함께 넘겨 관대하게 판정한다
      nodes.push({
        id: `page:${entry.name}`,
        run: ({ signal }) => this.#checkPage(entry.page, entry.name, signal, { auto: true, ...(entry.probedId !== undefined ? { probedId: entry.probedId } : {}) }),
      });
    }
    for (const test of tests) {
      meta.push({ stage: 'test', name: test.name });
      nodes.push({ id: `test:${test.name}`, maxAttempts: test.maxAttempts, run: ({ signal }) => this.#runTest(test, signal) });
    }
    for (const check of concurrency) {
      meta.push({ stage: 'concurrency_check', name: check.name });
      nodes.push({ id: `concurrency:${check.name}`, run: ({ signal }) => this.#runConcurrencyCheck(check, check.name, signal) });
    }
    // 건너뛴 자동 페이지만 있는 경우(상한 초과 등)에는 browser_check를 돌았다고 세지 않는다
    if (pages.length > 0 || auto.pages.length > 0) this.#stage('browser_check');
    if (tests.length > 0) this.#stage('test');
    if (concurrency.length > 0) this.#stage('concurrency_check');

    const results = await runTaskGraph(nodes, { concurrency: CHECK_CONCURRENCY, signal: this.#options.signal });
    const checks = results.map((result, index) => {
      const entry = meta[index]!;
      const steps = this.#pageSteps.get(entry.name);
      const compare = this.#pageCompares.get(entry.name);
      const loadMs = this.#pageLoadMs.get(entry.name);
      // 동시 요청 확인은 통과해도 결과 요약을 남긴다(성공 건수·상태 분포·then 값)
      const note = this.#concurrencyNotes.get(entry.name);
      // 실패 사유에 막은 요청 수를 한 줄 덧붙인다. 통과해도 남겨 QA 보기에서 볼 수 있게 한다
      const blocked = this.#pageBlocked.get(entry.name) ?? [];
      // 게이트를 막지 않는 참고 문구(HTTP 모드의 로딩 문구 경고 등). 통과해도 남긴다
      const warnings = this.#pageWarnings.get(entry.name) ?? [];
      const detail = [result.error, note, blocked.length > 0 ? `다른 출처 요청 ${blocked.length}건을 막았습니다` : undefined, ...warnings]
        .filter((line) => line !== undefined)
        .join('\n');
      return {
        ...entry,
        ok: result.status === 'succeeded',
        attempts: result.attempts,
        detail: detail || undefined,
        ...(steps ? { steps } : {}),
        ...(compare ? { compare } : {}),
        ...(loadMs !== undefined ? { metrics: { loadMs } } : {}),
      };
    });
    // 건너뛴 라우트도 check로 남긴다(ok). 조용히 사라지면 "확인했다"처럼 보인다
    return [...checks, ...auto.skipped];
  }

  /**
   * 이번 실행에서 바뀐 Next.js 페이지 중 자동으로 열어 볼 것을 고른다(`workflow.autoPageChecks`).
   * 바뀐 page 파일에 더해, 바뀐 컴포넌트·유틸·layout을 (몇 단계 거쳐) import하는 page도 찾는다(`followImports`, ADR-154, #followImports).
   * 선언한 pageChecks와 같은 service+path는 두 번 열지 않고 건너뜀 check로 남긴다.
   * 동적 세그먼트에 sampleParams 값이 없어도(ADR-078) id처럼 보이는 이름이면 추정한 값으로 열어 보고, 그 라우트는 probedId를 함께 돌려준다.
   */
  async #autoPages(declared: readonly WorkflowPageCheck[]): Promise<{ pages: Array<{ page: WorkflowPageCheck; name: string; probedId?: string }>; skipped: WorkflowCheck[] }> {
    const config = this.#options.project.spec.workflow?.autoPageChecks;
    if (!config) return { pages: [], skipped: [] };
    const service = this.#options.project.managed.find(([name]) => name === config.service);
    // 불러올 때 막지만(load.ts), 여기서도 조용히 넘어가지 않고 이유를 남긴다
    if (!service) {
      return {
        pages: [],
        skipped: [this.#autoSkipCheck(config.service, config.service, `autoPageChecks.service '${config.service}'를 이 프로젝트의 관리형 서비스에서 찾지 못했습니다`)],
      };
    }

    const fallbackValue = await this.#dynamicRouteFallback(config);
    const followed = config.followImports === false ? undefined : await this.#followImports(service[1].path);
    const found = followed
      ? routesFromCandidates(followed.candidates, service[1].path, config.sampleParams ?? {}, config.maxPages, fallbackValue)
      : routesFromChangedFiles(this.#options.workspace.changedFiles(), service[1].path, config.sampleParams ?? {}, config.maxPages, fallbackValue);
    const declaredKeys = new Set(declared.map((page) => `${page.service} ${page.path}`));
    const pages: Array<{ page: WorkflowPageCheck; name: string; probedId?: string }> = [];
    const skipped = [...(followed?.notes ?? []).map((note) => this.#autoSkipCheck(config.service, note.file, note.reason)), ...found.skipped.map((entry) => this.#autoSkipCheck(config.service, entry.file, entry.reason))];
    for (const route of found.routes) {
      if (declaredKeys.has(`${config.service} ${route.path}`)) {
        skipped.push(this.#autoSkipCheck(config.service, route.file, `${route.path}은(는) 이미 선언한 pageChecks에 있어 두 번 열지 않았습니다`));
        continue;
      }
      // id를 추정해 채운 동적 경로는 이름에 표시하고, 404·500만 실패로 보도록 probedId를 남긴다
      const probed = (route.usedFallbackParams?.length ?? 0) > 0 && fallbackValue !== undefined;
      pages.push({
        page: autoPageCheck(config, route.path),
        name: `${config.service} ${route.path} (자동${probed ? ', id 추정' : ''}${route.cause ? ` · ${route.cause.slice(route.cause.lastIndexOf('/') + 1)} 변경` : ''})`,
        ...(probed ? { probedId: fallbackValue } : {}),
      });
    }
    return { pages, skipped };
  }

  /**
   * 바뀐 소스 파일을 쓰는 page를 찾는다(`autoPageChecks.followImports`, ADR-154). 서비스 폴더의 소스를 읽어 import 그래프를 만들고
   * 바뀐 파일에서 page까지 거꾸로 따라간다. 바뀐 파일 중 page가 아닌 소스(컴포넌트·유틸·layout 등)가 없으면 읽지 않고 undefined를 돌려
   * 예전처럼 바뀐 page 파일만 본다. 그래프를 만들다 상한에 걸리거나 읽기에 실패하면 notes로 남긴다(조용히 포기하지 않는다).
   */
  async #followImports(servicePath: string): Promise<{ candidates: PageCandidate[]; notes: Array<{ file: string; reason: string }> } | undefined> {
    const prefix = servicePath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
    const inService = (file: string): string | undefined => (prefix === '' || prefix === '.' ? file : file.startsWith(`${prefix}/`) ? file.slice(prefix.length + 1) : undefined);
    const changed = this.#options.workspace
      .changedFiles()
      .map(inService)
      .filter((file): file is string => file !== undefined && isGraphSourceFile(file));
    if (changed.length === 0) return undefined;
    // 바뀐 소스가 전부 page 파일이면 import를 따라갈 이유가 없다 — 읽기 없이 예전 경로로 간다
    if (changed.every(isPageFileInService)) return undefined;

    const workspace = this.#options.workspace;
    try {
      const graph = await collectImportGraph(
        // peek: 게이트가 훑어본 파일에 에이전트용 읽은 표시를 남기지 않는다(다음 쓰기에 낡은 읽기 검사가 걸리지 않게)
        { list: (dir) => workspace.list(dir, 1), read: (file) => workspace.peek(file), now: () => Date.now() },
        servicePath,
        DEFAULT_IMPORT_GRAPH_LIMITS,
      );
      const trace = tracePages(changed, graph.reverse, graph.files, DEFAULT_TRACE_DEPTH);
      const toProject = (file: string): string => (prefix === '' || prefix === '.' ? file : `${prefix}/${file}`);
      const notes: Array<{ file: string; reason: string }> = [];
      if (graph.incomplete) {
        notes.push({
          file: 'import 역추적',
          reason: `${graph.incomplete}(읽은 파일 ${graph.readCount}개, ${graph.elapsedMs}ms) — 그래프가 일부만 만들어져 바뀐 파일을 쓰는 페이지를 모두 찾지 못했을 수 있습니다`,
        });
      }
      for (const entry of trace.truncated) {
        notes.push({
          file: toProject(entry.cause),
          reason: `${toProject(entry.cause)}에서 import를 거꾸로 ${DEFAULT_TRACE_DEPTH}단계까지 따라갔고, ${toProject(entry.stoppedAt)}를 쓰는 파일이 더 있지만 깊이 상한이라 멈췄습니다`,
        });
      }
      return { candidates: trace.candidates, notes };
    } catch (error) {
      // 그래프를 만들지 못해도 바뀐 page 파일 확인은 계속한다. 다만 못 찾았다는 사실을 남긴다
      const detail = error instanceof Error ? error.message : String(error);
      const ownPages = changed.filter(isPageFileInService).map((page) => ({ page, cause: page, distance: 0, tie: 0 }));
      return { candidates: ownPages, notes: [{ file: 'import 역추적', reason: `import 역추적에 실패해 바뀐 파일을 쓰는 페이지를 찾지 못했습니다: ${detail}` }] };
    }
  }

  /** 건너뛴 자동 페이지를 남기는 check. ok로 두어 게이트를 막지 않되, 이유는 detail에 남긴다 */
  #autoSkipCheck(service: string, file: string, reason: string): WorkflowCheck {
    return { stage: 'browser_check', name: `${service} ${file} (자동, 건너뜀)`, ok: true, attempts: 1, detail: reason };
  }

  /**
   * 동적 세그먼트를 값 없이 건너뛰지 않고 추정 값으로 채워 열어 보게 한다(ADR-078).
   * config.dynamicRouteProbe가 false면(꺼져 있으면) undefined를 돌려줘 예전처럼 건너뛴다.
   * sampleIdFrom을 적었으면 그 api를 불러 jsonPath 값을 꺼내 쓰고, 없거나 불러오기를 실패하면 기본값('1')으로 물러난다 —
   * 이 확인은 "값을 하나라도 넣어 보는" 목적이라 api 실패까지 게이트 실패로 만들지 않는다
   */
  async #dynamicRouteFallback(config: AutoPageChecks): Promise<string | undefined> {
    if (config.dynamicRouteProbe === false) return undefined;
    const from = config.sampleIdFrom;
    if (!from) return DEFAULT_DYNAMIC_ROUTE_FALLBACK;
    try {
      const { sandbox, pageFetcher = fetchPage, signal } = this.#options;
      const endpoint = await sandbox.endpoint(from.service);
      const url = new URL(from.path, endpoint.url);
      if (url.origin !== new URL(endpoint.url).origin) return DEFAULT_DYNAMIC_ROUTE_FALLBACK;
      const { status, text } = await pageFetcher(url.href, signal);
      if (status < 200 || status >= 300) return DEFAULT_DYNAMIC_ROUTE_FALLBACK;
      const value = readJsonPath(text, from.jsonPath);
      if ((typeof value === 'string' || typeof value === 'number') && SAFE_SEGMENT.test(String(value))) return String(value);
      return DEFAULT_DYNAMIC_ROUTE_FALLBACK;
    } catch {
      return DEFAULT_DYNAMIC_ROUTE_FALLBACK;
    }
  }

  /** 게이트를 막지 않는 참고 문구를 이름별로 모아 둔다. detail에 붙여 QA 보기·모델 피드백에서 볼 수 있게 한다 */
  #addWarning(name: string, message: string): void {
    const list = this.#pageWarnings.get(name) ?? [];
    list.push(message);
    this.#pageWarnings.set(name, list);
  }

  async #checkPage(page: WorkflowPageCheck, name: string, signal: AbortSignal, options: { auto?: boolean; probedId?: string } = {}): Promise<void> {
    const { sandbox, pageFetcher = fetchPage, browserRunner = runInBrowser, saveArtifact, onBrowserFrame } = this.#options;
    // 자동으로 연 페이지의 실패는 경로를 앞에 붙여, 실패 서명에서 선언한 pageChecks의 실패와 구분되게 한다
    const fail = (message: string) => new Error(sandbox.redact(options.auto ? `자동 페이지 ${page.path}: ${message}` : message));
    // ① api를 불러 값을 꺼내 둔다. 여기서 실패하면 화면을 열지 않고 멈춘다(렌더링을 낭비하지 않는다)
    const api = await this.#apiValue(page, pageFetcher, signal);
    const endpoint = await sandbox.endpoint(page.service);
    const url = new URL(page.path, endpoint.url);
    if (url.origin !== new URL(endpoint.url).origin) throw new Error('path must stay on the service host');
    if (page.mode === 'browser') {
      let result: BrowserPageResult;
      try {
        result = await browserRunner(url.href, {
          viewport: page.viewport,
          steps: page.steps,
          signal,
          // 로드 예산을 적은 확인만 잰다. 재려면 워밍업 이동을 한 번 더 해야 해서(게이트 시간이 늘고, 워밍업 때의 오류는 비운다)
          // 예산이 없는 확인까지 두 번 열면 첫 로드에서만 나는 오류를 놓칠 수 있다
          measureLoad: page.maxLoadMs !== undefined,
          // 스크린샷을 저장할 곳이 있거나 디자인 비교를 할 때만 찍는다
          capture: saveArtifact !== undefined || page.compare !== undefined,
          // 세션 서비스의 출처 밖으로는 요청이 나가지 못하게 한다(모델이 만든 페이지를 통한 요청 위조 차단)
          allowedOrigins: await this.#serviceOrigins(),
          ...(onBrowserFrame ? { onFrame: (frame: BrowserFrame) => onBrowserFrame({ check: name, frame }) } : {}),
        });
      } catch (error) {
        // 헤드리스 브라우저를 못 띄우면(ADR-050은 원래 그대로 실패시킨다) fallbackProbe가 있는 확인만 대신 HTTP로 확인한다
        if (error instanceof BrowserUnavailableError && page.fallbackProbe) {
          return this.#checkFallbackProbe(page.fallbackProbe, name, signal, fail, error);
        }
        // 실패한 단계의 스크린샷도 결과에 남긴다
        if (error instanceof StepFailedError) this.#pageSteps.set(name, await this.#saveSteps(name, error.steps));
        throw error;
      }
      if (saveArtifact) this.#pageSteps.set(name, await this.#saveSteps(name, result.steps));
      if (result.blockedRequests.length > 0) this.#pageBlocked.set(name, result.blockedRequests);
      const problems: string[] = [];
      if (options.probedId !== undefined) {
        // 추정한 id로 연 동적 경로(ADR-078): id가 실제로 없을 수도 있어 404·500만 실패로 본다
        if (result.status === 404 || (result.status !== null && result.status >= 500)) problems.push(dynamicProbeStatusProblem(options.probedId, result.status));
      } else if (result.status !== page.expectStatus) {
        problems.push(`HTTP ${result.status ?? '응답 없음'} (기대 ${page.expectStatus})`);
      }
      if (page.expectText && !result.text.includes(page.expectText)) problems.push(`렌더링된 화면에 '${page.expectText}'가 없습니다`);
      // expectAnyText는 적은 문구 중 하나라도 있으면 통과한다(숫자 표기가 갈릴 때)
      if (page.expectAnyText && !page.expectAnyText.some((candidate) => result.text.includes(candidate))) problems.push(missingAnyText(page.expectAnyText));
      // expectAllText는 적은 문구가 모두 있어야 통과한다. 빠진 것만 알린다
      const missingAllRendered = page.expectAllText?.filter((candidate) => !result.text.includes(candidate)) ?? [];
      if (missingAllRendered.length > 0) problems.push(missingAllText(missingAllRendered));
      // ④ api에서 꺼낸 값이 렌더링된 글자에 있는지. expectText와 같은 위치에서 본다
      if (api && !containsApiValue(result.text, api.value)) problems.push(missingApiValue(api, page.path));
      if (result.pageErrors.length > 0) problems.push(`스크립트 예외: ${result.pageErrors.slice(0, 3).join(' | ')}`);
      if (!page.allowConsoleErrors && result.consoleErrors.length > 0) problems.push(`console.error: ${result.consoleErrors.slice(0, 3).join(' | ')}`);
      if (!page.allowConsoleErrors && result.failedRequests.length > 0) problems.push(`실패한 요청: ${result.failedRequests.slice(0, 3).join(' | ')}`);
      // <video>/<audio>/<img>의 로드·재생 실패(트러블슈팅 83). 같은 네트워크 404가 failedRequests에도 남을 수 있지만,
      // 이쪽은 "그 요청이 실제로 어느 화면 요소의 재생을 망가뜨렸는지"를 직접 보여준다
      if (!page.allowConsoleErrors && result.mediaErrors.length > 0) problems.push(`미디어 오류: ${result.mediaErrors.slice(0, 3).join(' | ')}`);
      // 데이터를 못 받아 로딩 상태에서 멈춘 화면(ADR-078). 실패한 요청·콘솔 오류·스크립트 예외를 증거로 함께 본다
      if (!page.allowLoadingPlaceholder) {
        const stuck = detectStuckLoading(result.text, {
          failedRequests: result.failedRequests.length,
          consoleErrors: result.consoleErrors.length,
          pageErrors: result.pageErrors.length,
        });
        if (stuck) problems.push(stuck);
      }
      if (page.noHorizontalScroll && result.horizontalOverflowPx > 1) problems.push(`가로로 ${result.horizontalOverflowPx}px 넘칩니다`);
      if (result.loadMs !== undefined) this.#pageLoadMs.set(name, result.loadMs);
      if (page.maxLoadMs !== undefined) {
        // 예산을 적었는데 재지 못했으면 "검사 안 함"이 통과로 보이지 않도록 실패로 본다
        if (result.loadMs === undefined) problems.push(`로드 시간을 재지 못했습니다 (예산 ${page.maxLoadMs.toLocaleString('ko-KR')}ms)`);
        else if (result.loadMs > page.maxLoadMs) {
          problems.push(`로드 ${result.loadMs.toLocaleString('ko-KR')}ms (예산 ${page.maxLoadMs.toLocaleString('ko-KR')}ms)`);
        }
      }
      // 화면 출력에 시크릿 값이 섞여 있을 수 있어 가린 뒤 모델에게 돌려준다
      if (options.auto) {
        // 상태 코드가 200이어도 본문이 Next.js 오류 화면이면 실패다(새로 만든 페이지가 500을 내는 것을 잡는 자리)
        const marker = nextErrorMarker(result.text, page.expectStatus);
        if (marker) problems.push(`Next.js 오류 화면: '${marker}'`);
      }
      // 추정한 id로 연 화면이 실패했으면, 그 id의 데이터가 없어서일 수 있다는 것과 실제 id를 알려 주는 방법을 붙인다.
      // (상태 코드 문제는 이미 같은 안내를 담고 있다.) 안내가 없으면 "실패한 요청: 404 …/1/…"만 보고 화면 코드를 의심하게 된다
      if (problems.length > 0 && options.probedId !== undefined && !problems.some((problem) => problem.includes('추정한 id('))) {
        problems.push(dynamicProbeDataHint(options.probedId));
      }
      if (problems.length > 0) throw fail(problems.join('\n'));
      if (page.compare) await this.#compareDesign(page.compare, name, result, sandbox);
      return;
    }
    const { status, text } = await pageFetcher(url.href, signal);
    if (options.probedId !== undefined) {
      // 추정한 id로 연 동적 경로(ADR-078): id가 실제로 없을 수도 있어 404·500만 실패로 본다
      if (status === 404 || status >= 500) throw fail(dynamicProbeStatusProblem(options.probedId, status));
    } else if (status !== page.expectStatus) {
      throw fail(`HTTP ${status} (기대 ${page.expectStatus})`);
    }
    if (options.auto) {
      const marker = nextErrorMarker(text, page.expectStatus);
      if (marker) throw fail(`Next.js 오류 화면: '${marker}'`);
      // HTTP 확인은 자바스크립트를 실행하지 않아 클라이언트 fetch가 실패했는지 확정할 수 없다. 보수적으로 경고만 남긴다(ADR-078)
      const stuck = detectStuckLoading(stripHtml(text));
      if (stuck) this.#addWarning(name, `[참고] ${stuck} — HTTP 확인은 자바스크립트를 실행하지 않아 확정할 수 없습니다. 확실히 판정하려면 autoPageChecks.mode: browser를 쓰세요`);
    }
    if (page.expectText && !text.includes(page.expectText)) throw fail(`응답 본문에 '${page.expectText}'가 없습니다`);
    // expectAnyText는 적은 문구 중 하나라도 있으면 통과한다(숫자 표기가 갈릴 때)
    if (page.expectAnyText && !page.expectAnyText.some((candidate) => text.includes(candidate))) throw fail(missingAnyText(page.expectAnyText));
    // expectAllText는 적은 문구가 모두 있어야 통과한다. 빠진 것만 알린다
    const missingAll = page.expectAllText?.filter((candidate) => !text.includes(candidate)) ?? [];
    if (missingAll.length > 0) throw fail(missingAllText(missingAll));
    // ④ api에서 꺼낸 값이 응답 본문(http) 글자에 있는지
    if (api && !containsApiValue(text, api.value)) throw fail(missingApiValue(api, page.path));
  }

  /**
   * 헤드리스 브라우저를 못 띄울 때(fix/frontend-backend-url) fallbackProbe가 가리키는 서비스·경로로 평범한 HTTP 요청을
   * 한 번 보낸다. 응답을 받으면(상태 코드와 무관하게) 그 주소가 살아 있다는 뜻이라 화면 확인을 통과시키되, 콘솔
   * 오류·실패한 요청 같은 화면 단위 문제는 보지 못했다는 참고 문구를 남긴다. 연결 자체가 안 되면(연결 거부 등) 실패로 본다
   */
  async #checkFallbackProbe(
    probe: { service: string; path: string },
    name: string,
    signal: AbortSignal,
    fail: (message: string) => Error,
    browserError: BrowserUnavailableError,
  ): Promise<void> {
    const { sandbox, pageFetcher = fetchPage } = this.#options;
    const endpoint = await sandbox.endpoint(probe.service);
    const url = new URL(probe.path, endpoint.url);
    try {
      const { status } = await pageFetcher(url.href, signal);
      this.#addWarning(
        name,
        `[참고] 헤드리스 브라우저를 쓸 수 없어(${browserError.message}) 화면 확인 대신 ${probe.service}${probe.path}로 HTTP 확인만 했습니다(응답 ${status}). 콘솔 오류·실패한 요청·화면에 보이는 오류 문구는 확인하지 못했습니다`,
      );
    } catch (error) {
      throw fail(
        `헤드리스 브라우저를 쓸 수 없어 ${probe.service}${probe.path}로 대신 확인했는데 연결하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * pageChecks.expectFromApi가 있으면 api를 불러 jsonPath 값(문자열·숫자)을 꺼낸다. 없으면 undefined.
   * 동시 요청 확인과 같은 규칙으로 **세션 서비스의 출처로만** 요청한다.
   * 상태·값이 없음은 에이전트가 문구만 보고 고칠 수 있게 구체적으로 알리고, 객체·배열·빈 문자열은 확인 설정 오류로 본다.
   */
  async #apiValue(page: WorkflowPageCheck, fetcher: PageFetcher, signal: AbortSignal): Promise<ApiValue | undefined> {
    const expect = page.expectFromApi;
    if (!expect) return undefined;
    const { sandbox } = this.#options;
    const endpoint = await sandbox.endpoint(expect.service);
    const url = new URL(expect.path, endpoint.url);
    if (url.origin !== new URL(endpoint.url).origin) throw new Error('path must stay on the service host');
    const { status, text } = await fetcher(url.href, signal);
    if (status < 200 || status >= 300) throw new Error(sandbox.redact(`${expect.service} GET ${expect.path}가 HTTP ${status}을 돌려줬습니다`));
    const value = readJsonPath(text, expect.jsonPath);
    if (value === undefined || value === null) {
      throw new Error(sandbox.redact(`${expect.service} 응답에 ${expect.jsonPath}이 없습니다. 응답 앞부분: ${text.slice(0, 200)}`));
    }
    if (typeof value === 'object') throw new Error(`${expect.jsonPath}는 ${Array.isArray(value) ? '배열' : '객체'}입니다. 화면에 그려질 문자열·숫자 값을 가리키세요`);
    if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${expect.jsonPath}는 ${typeof value}입니다. 화면에 그려질 문자열·숫자 값을 가리키세요`);
    if (typeof value === 'string' && value.trim() === '') throw new Error(`${expect.jsonPath} 값이 빈 문자열입니다. 화면에 그려질 문자열·숫자 값을 가리키세요`);
    return { service: expect.service, jsonPath: expect.jsonPath, value };
  }

  /**
   * 단계 스크린샷을 저장하고 식별자를 붙인다. 저장은 관측용이라 실패해도 확인 결과를 바꾸지 않고 경고만 남긴다.
   * browser_check의 browser 모드가 아니면 스크린샷이 없어 저장하지 않는다
   */
  async #saveSteps(name: string, steps: readonly BrowserPageStep[]): Promise<WorkflowStepCheck[]> {
    const save = this.#options.saveArtifact;
    const saved: WorkflowStepCheck[] = [];
    for (const [index, step] of steps.entries()) {
      let artifact: string | undefined;
      if (save && step.screenshot) {
        try {
          artifact = await save({ name: `${name} ${index + 1}. ${step.label}`, data: step.screenshot, contentType: 'image/png' });
        } catch (error) {
          console.warn(`화면 확인 스크린샷을 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      saved.push({ label: step.label, ok: step.ok, ...(step.detail !== undefined ? { detail: step.detail } : {}), ...(artifact ? { artifact } : {}) });
    }
    return saved;
  }

  /**
   * 마지막 단계 뒤의 뷰포트 화면을 디자인 기준 이미지와 비교한다.
   * 기준 이미지는 project.root 기준으로 읽고, 없거나 읽지 못하면 건너뛰지 않고 확인 실패로 알린다.
   * 비율이 허용치를 넘으면 실패시키되, 비교 이미지는 산출물로 남겨 화면에서 볼 수 있게 한다
   */
  async #compareDesign(compare: WorkflowPageCompare, name: string, result: BrowserPageResult, sandbox: Sandbox): Promise<void> {
    const actual = result.steps.at(-1)?.screenshot;
    if (!actual) throw new Error('디자인 비교에 쓸 뷰포트 스크린샷을 찍지 못했습니다');
    const reference = await readFile(path.join(this.#options.project.root, compare.reference)).catch(() => undefined);
    if (!reference) throw new Error(`디자인 기준 이미지를 읽지 못했습니다: ${compare.reference}`);

    let comparison: CompareResult;
    try {
      comparison = compareScreenshot({ actual, reference, masks: compare.masks, threshold: compare.threshold });
    } catch (error) {
      // 비교 자체가 성립하지 않는 경우(너비 불일치)는 원인을 그대로 알린다
      if (error instanceof VisualCompareError) throw new Error(sandbox.redact(error.message));
      throw error;
    }
    this.#pageCompares.set(name, { ratio: comparison.ratio, max: compare.maxDiffRatio, ...(await this.#saveCompareImages(name, reference, actual, comparison.diff)) });
    if (comparison.ratio > compare.maxDiffRatio) throw new Error(compareDetail(comparison, compare.maxDiffRatio));
  }

  /** 기준·실제·차이 이미지를 저장한다. 저장은 관측용이라 실패해도 비교 결과를 바꾸지 않고 경고만 남긴다 */
  async #saveCompareImages(name: string, reference: Buffer, actual: Buffer, diff: Buffer): Promise<Pick<WorkflowCompare, 'reference' | 'actual' | 'diff'>> {
    const save = this.#options.saveArtifact;
    const saved: Pick<WorkflowCompare, 'reference' | 'actual' | 'diff'> = {};
    if (!save) return saved;
    const images: Array<[keyof typeof saved, string, Buffer]> = [
      ['reference', '디자인', reference],
      ['actual', '실제', actual],
      ['diff', '차이', diff],
    ];
    for (const [key, label, data] of images) {
      try {
        saved[key] = await save({ name: `${name} ${label} 이미지`, data, contentType: 'image/png' });
      } catch (error) {
        console.warn(`디자인 비교 이미지를 저장하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return saved;
  }

  async #runTest(test: WorkflowTest, signal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(TEST_TIMEOUT_MS);
    // exec는 기본으로 출력의 시크릿 값을 가려서 돌려준다. 실패 출력이 모델에게 그대로 들어가므로 가린 결과만 쓴다
    const result = await this.#options.sandbox.exec(test.service, test.command, { signal: AbortSignal.any([signal, timeout]) });
    if (result.exitCode !== 0) {
      const revived = await this.#reviveIfOomKilled(test.service, signal);
      const output = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');
      throw new Error(`종료 코드 ${result.exitCode}${revived ? `\n환경 문제: ${test.service} 컨테이너가 ${revived} 종료됐습니다. 코드 문제가 아닐 수 있습니다 — 서비스를 다시 띄웠습니다(다음 시도에서 이어집니다)` : ''}\n${output}`);
    }
  }

  /**
   * test 단계 exec가 실패했을 때, 테스트 JVM이 코드 문제가 아니라 메모리 한도를 넘어 컨테이너째로
   * 죽은 것인지 본다(트러블슈팅 116). 맞으면 다음 시도(workflow.tests의 maxAttempts)가 죽은 컨테이너에
   * 또 부딪히지 않도록 여기서 미리 되살린다 — restartOnce(verify.ts)가 서비스 재시작 실패를 다루는 것과
   * 같은 신호(stats().oomKilled)를 쓴다. 되살리기 자체가 실패해도(이미 한 번 죽은 컨테이너라 더 불안정할
   * 수 있다) 원래 실패를 가리지 않도록 삼킨다 — 다음 시도가 어차피 그 실패를 다시 드러낸다
   */
  async #reviveIfOomKilled(service: string, signal: AbortSignal): Promise<string | undefined> {
    const { sandbox } = this.#options;
    const usage = (await sandbox.stats().catch(() => [])).find((candidate) => candidate.service === service);
    if (!usage?.oomKilled) return undefined;
    await sandbox.restart(service, { signal }).catch(() => {});
    return `메모리 한도${usage.memoryLimitBytes ? ` (${formatBytes(usage.memoryLimitBytes)})` : ''}를 넘어`;
  }

  /**
   * 같은 요청을 동시에 보낸 뒤 기대한 불변식을 확인한다. **세션 서비스의 출처로만** 요청한다(화면 확인과 같은 규칙).
   * 한 번의 실패를 재시도로 덮지 않는다 — 재시도하면 경합이 숨는다. DB 트랜잭션 격리 수준과 타이밍에 따라 결과가 흔들릴 수 있어 임계값은 넉넉히 잡는다.
   */
  async #runConcurrencyCheck(check: WorkflowConcurrencyCheck, name: string, signal: AbortSignal): Promise<void> {
    const { sandbox } = this.#options;
    const request = this.#options.requestService ?? requestService;
    const endpoint = await sandbox.endpoint(check.service);
    const url = new URL(check.path, endpoint.url);
    if (url.origin !== new URL(endpoint.url).origin) throw new Error('path must stay on the service host');

    const responses = await Promise.all(
      Array.from({ length: check.concurrent }, () =>
        request(url.href, {
          method: check.method,
          ...(check.headers ? { headers: check.headers } : {}),
          ...(check.method !== 'GET' && check.body !== undefined ? { body: check.body } : {}),
          signal,
        }),
      ),
    );
    const successCount = responses.filter((response) => response.status >= 200 && response.status < 300).length;
    const counts = new Map<number, number>();
    for (const response of responses) counts.set(response.status, (counts.get(response.status) ?? 0) + 1);
    const statusDetail = [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([status, count]) => `${status}:${count}`)
      .join(', ');

    const parts = [`성공 ${successCount}/${check.concurrent} (기대: ${describeConcurrencyExpect(check.expect)})`, `상태 ${statusDetail}`];
    const problems: string[] = [];
    const { successCount: expectedCount, allStatusIn, then } = check.expect;
    if (expectedCount?.exactly !== undefined && successCount !== expectedCount.exactly) {
      problems.push(`성공 ${successCount}/${check.concurrent} (기대: 정확히 ${expectedCount.exactly})`);
    }
    if (expectedCount?.atMost !== undefined && successCount > expectedCount.atMost) {
      problems.push(`성공 ${successCount}/${check.concurrent} (기대: 최대 ${expectedCount.atMost})`);
    }
    if (allStatusIn && !responses.every((response) => allStatusIn.includes(response.status))) {
      const outside = [...new Set(responses.map((response) => response.status).filter((status) => !allStatusIn.includes(status)))].join(', ');
      problems.push(`기대 밖 상태 코드: ${outside} (기대: ${allStatusIn.join(', ')})`);
    }
    if (then) {
      const thenUrl = new URL(then.path, endpoint.url);
      if (thenUrl.origin !== new URL(endpoint.url).origin) throw new Error('path must stay on the service host');
      const response = await request(thenUrl.href, { method: 'GET', signal });
      const actual = readJsonPath(response.text, then.jsonPath);
      parts.push(`${then.jsonPath} = ${JSON.stringify(actual)}`);
      if (actual !== then.equals) problems.push(`${then.jsonPath} 값이 ${JSON.stringify(actual)} (기대: ${JSON.stringify(then.equals)})`);
    }

    // 원인을 추정하지 않고 숫자만 남긴다
    const note = parts.join(' · ');
    if (problems.length > 0) throw new Error(sandbox.redact([note, ...problems].join('\n')));
    this.#concurrencyNotes.set(name, note);
  }

  /**
   * 화면 확인이 요청해도 되는 출처. 세션의 모든 managed 서비스가 게이트에서 쓰는 주소(endpoint)의 출처를 모은다.
   * 프론트가 다른 포트의 백엔드를 부르므로 한 서비스만 허용하면 화면이 망가지고, 그 밖의 출처로는 나가지 못하게 한다
   */
  async #serviceOrigins(): Promise<string[]> {
    const { sandbox, project } = this.#options;
    const origins = new Set<string>();
    for (const [name] of project.managed) {
      if (project.offServices?.has(name)) continue;
      try {
        origins.add(new URL((await sandbox.endpoint(name)).url).origin);
      } catch {
        // 아직 준비되지 않았거나 없는 서비스의 주소는 건너뛴다
      }
    }
    return [...origins];
  }

  /** 지난 검증 이후 바뀐 파일 + 지난번에 준비에 실패한 서비스의 파일 (고치지 않았더라도 다시 확인해야 한다) */
  #filesToVerify(): string[] {
    const { project, workspace } = this.#options;
    const files = new Set(workspace.changedSince(this.#verifiedVersion));
    if (this.#failedServices.size > 0) {
      for (const file of workspace.changedFiles()) {
        // studio.yaml·compose는 모든 서비스에 속하므로(servicesForFiles) 첫 서비스만 보지 않고 전부 본다
        if (servicesForFiles(project, [file]).services.some((owner) => this.#failedServices.has(owner))) files.add(file);
      }
    }
    return [...files].sort();
  }
}

function formatFailedChecks(checks: readonly WorkflowCheck[]): string {
  if (checks.length === 0) return '';
  const lines = checks.map((check) => `- [${check.stage}] ${check.name} (시도 ${check.attempts}회)${check.detail ? `\n${check.detail}` : ''}`);
  return `\n\n워크플로 검사 실패:\n${lines.join('\n')}`;
}

/** 디자인 비교 실패 문구. 비율과 허용치, 비교한 크기를 함께 적는다 */
function compareDetail(comparison: CompareResult, max: number): string {
  return `디자인 차이 ${(comparison.ratio * 100).toFixed(1)}% (허용 ${(max * 100).toFixed(1)}%, 비교 ${comparison.width}×${comparison.height})`;
}

/** 동시 요청 확인의 기대를 사람이 읽는 한 줄로. then 값은 따로 적으므로 여기 넣지 않는다 */
function describeConcurrencyExpect(expect: ConcurrencyExpect): string {
  const parts: string[] = [];
  if (expect.successCount?.exactly !== undefined) parts.push(`정확히 ${expect.successCount.exactly}`);
  else if (expect.successCount?.atMost !== undefined) parts.push(`최대 ${expect.successCount.atMost}`);
  if (expect.allStatusIn) parts.push(`상태 ${expect.allStatusIn.join('/')}`);
  return parts.join(', ');
}

/** api에서 꺼낸 값. 화면 글자와 비교한다 */
interface ApiValue {
  service: string;
  jsonPath: string;
  value: string | number;
}

/** api 값이 화면 글자에 있는지. 숫자는 원문과 천 단위 구분(12,000) 표기를 둘 다 인정한다 */
function containsApiValue(text: string, value: string | number): boolean {
  if (typeof value === 'number') return text.includes(String(value)) || text.includes(value.toLocaleString('en-US'));
  return text.includes(value);
}

/** api 값이 화면에 없을 때의 문구. 화면이 다른 필드 이름을 읽고 있을 수 있음을 알린다 */
function missingApiValue(api: ApiValue, pagePath: string): string {
  return `${api.service}의 ${api.jsonPath} 값 '${String(api.value)}'이 ${pagePath} 화면에 없습니다 — 화면이 다른 필드 이름을 읽고 있을 수 있습니다`;
}

/** expectAllText 실패 문구. 빠진 문구만 적는다 */
function missingAllText(values: readonly string[]): string {
  return `화면에 ${values.map((value) => `'${value}'`).join(', ')}가 없습니다`;
}

/** expectAnyText 실패 문구. 적은 문구 중 어느 것도 없을 때 */
function missingAnyText(values: readonly string[]): string {
  return `화면에 ${values.map((value) => `'${value}'`).join(', ')} 중 어느 것도 없습니다`;
}

/** 추정한 id로 연 동적 경로가 404·500을 돌려줬을 때의 문구(ADR-078). id가 실제로 없을 수도 있다는 것과 고치는 방법을 함께 적는다 */
/** 추정한 id로 연 화면이 상태 코드가 아닌 이유(실패한 요청, 멈춘 로딩 등)로 실패했을 때 붙이는 안내 */
function dynamicProbeDataHint(probedId: string): string {
  return `이 화면은 추정한 id(${probedId})로 열었습니다 — 그 id의 데이터가 없어서 생긴 실패일 수 있습니다. 실제로 있는 값을 studio.yaml의 autoPageChecks.sampleParams(예: { id: "..." })나 sampleIdFrom으로 알려주면 그 값으로 엽니다`;
}

function dynamicProbeStatusProblem(probedId: string, status: number | null): string {
  return `동적 경로를 추정한 id(${probedId})로 열었더니 HTTP ${status}을 돌려줬습니다 — id가 실제로 없을 수 있습니다. autoPageChecks.sampleParams나 sampleIdFrom으로 실제 값을 알려주면 더 정확히 확인합니다`;
}

/** HTTP 확인 응답 본문(HTML)에서 태그를 걷어내 로딩 문구 판정에 쓸 평문을 만든다. 자바스크립트는 실행하지 않는다 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * 응답 JSON에서 값을 꺼낸다. `$.a.b`와 `$[0].a`, `$.items[0].qty` 정도만 지원하고 그 밖은 undefined를 돌려준다.
 * 외부 라이브러리(k6 등) 없이 결과 불변식만 보려는 최소 구현이다
 */
function readJsonPath(text: string, jsonPath: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  for (const segment of jsonPath.replace(/^\$\.?/, '').split('.').filter(Boolean)) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
    if (!match) return undefined;
    const key = match[1]!;
    if (key) {
      if (typeof value !== 'object' || value === null) return undefined;
      value = (value as Record<string, unknown>)[key];
    }
    for (const index of match[2]!.match(/\d+/g) ?? []) {
      if (!Array.isArray(value)) return undefined;
      value = value[Number(index)];
    }
  }
  return value;
}
