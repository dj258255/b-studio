import type { Sandbox, StartOptions } from '@b-studio/sandbox';
import type { LoadedProject, WorkflowPageCheck, WorkflowStage, WorkflowTest } from '@b-studio/spec';
import { runInBrowser, type BrowserRunner } from './browser-check';
import type { AgentEvent } from './loop';
import { servicesForFiles } from './services';
import { runTaskGraph, type TaskNode } from './task-graph';
import { captureBaselines, formatVerificationReport, verifyChanges, type ContractFetcher, type VerificationReport } from './verify';
import { missingVerificationStages, reviewChanges, type WorkflowCheck } from './workflow';
import type { OpenApiDocument } from './contract-diff';
import type { Workspace } from './workspace';

export type GateOutcome =
  | { kind: 'pass' }
  /** 모델에게 돌려줄 게이트 결과. 고친 뒤 다시 턴을 끝내게 한다 */
  | { kind: 'retry'; feedback: string }
  | { kind: 'exhausted'; summary: string };

/** browser_check에서 화면 경로를 불러오는 함수. 테스트에서 네트워크 없이 바꿔 끼운다 */
export type PageFetcher = (url: string, signal?: AbortSignal) => Promise<{ status: number; text: string }>;

const PAGE_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 10 * 60_000;
const CHECK_CONCURRENCY = 2;
const OUTPUT_TAIL_LINES = 30;

export const fetchPage: PageFetcher = async (url, signal) => {
  const timeout = AbortSignal.timeout(PAGE_TIMEOUT_MS);
  const response = await fetch(url, { redirect: 'manual', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  return { status: response.status, text: await response.text() };
};

export interface GateOptions {
  project: LoadedProject;
  sandbox: Sandbox;
  workspace: Workspace;
  allowBreaking: boolean;
  maxVerifyAttempts: number;
  fetcher: ContractFetcher;
  pageFetcher?: PageFetcher;
  browserRunner?: BrowserRunner;
  signal?: AbortSignal;
  onServiceStatus?: StartOptions['onStatus'];
  onEvent: (event: AgentEvent) => void;
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
  /** 바뀐 파일을 실제로 검증해 통과했는지. 바뀐 파일이 없어 검증 없이 끝났다면 false라서 체크포인트 단계로 넘어가지 않는다 */
  verified = false;
  readonly #options: GateOptions;
  readonly #baselines: ReadonlyMap<string, OpenApiDocument>;
  #verifiedVersion = 0;
  #failedServices = new Set<string>();

  private constructor(options: GateOptions, baselines: ReadonlyMap<string, OpenApiDocument>) {
    this.#options = options;
    this.#baselines = baselines;
  }

  /** 계약 비교 기준은 모델이 파일을 바꾸기 전에 잡아야 한다 */
  static async create(options: GateOptions): Promise<VerificationGate> {
    return new VerificationGate(options, await captureBaselines(options.sandbox, options.project, options.fetcher));
  }

  async check(): Promise<GateOutcome> {
    const { project, sandbox, workspace, allowBreaking, maxVerifyAttempts, fetcher, signal, onServiceStatus, onEvent } = this.#options;
    if (workspace.changedFiles().length === 0) return { kind: 'pass' };

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
    this.checks = [];

    const text = formatVerificationReport(report, { allowBreaking });
    onEvent({ type: 'verify_result', report, text });

    // 서비스가 뜨지 않았거나 계약이 깨졌으면 그 위에서 테스트나 화면 확인을 돌려도 의미가 없다
    if (report.ok) {
      this.passedStages.add('run');
      this.passedStages.add('contract_check');
      const checks = await this.#runDeclaredChecks();
      signal?.throwIfAborted();
      this.#stage('review');
      checks.push(...reviewChanges(project, workspace.changedFiles()));
      this.checks = checks;
      for (const check of checks) onEvent({ type: 'workflow_check', check });
      for (const stage of ['browser_check', 'test', 'review'] as const) {
        const ofStage = checks.filter((check) => check.stage === stage);
        if (ofStage.length > 0 && ofStage.every((check) => check.ok)) this.passedStages.add(stage);
      }
    }

    const failedChecks = this.checks.filter((check) => !check.ok);
    if (report.ok && failedChecks.length === 0) {
      // 스키마가 실행 수단 없는 필수 단계를 막지만, 어떤 경로로든 단계가 돌지 않았다면 통과로 보지 않는다
      const missing = missingVerificationStages(project, this.passedStages);
      if (missing.length > 0) return { kind: 'exhausted', summary: `워크플로 필수 단계가 실행되지 않아 완료로 인정하지 않습니다: ${missing.join(', ')}` };
      this.verified = true;
      return { kind: 'pass' };
    }

    this.attempts += 1;
    if (this.attempts >= maxVerifyAttempts) {
      return { kind: 'exhausted', summary: `검증 게이트를 ${this.attempts}번 통과하지 못했습니다` };
    }
    return {
      kind: 'retry',
      feedback: `[b-studio 검증 게이트] 변경 사항이 검증을 통과하지 못했습니다. 아래 결과를 보고 고친 뒤 턴을 끝내세요.\n\n${text}${formatFailedChecks(failedChecks)}`,
    };
  }

  #stage(stage: WorkflowStage): void {
    this.#options.onEvent({ type: 'stage', stage, source: 'platform' });
  }

  /** studio.yaml에 선언한 화면 확인과 테스트는 서로 기다릴 이유가 없으므로 작업 그래프로 동시에 돌린다 */
  async #runDeclaredChecks(): Promise<WorkflowCheck[]> {
    const workflow = this.#options.project.spec.workflow;
    const pages = workflow?.pageChecks ?? [];
    const tests = workflow?.tests ?? [];
    if (pages.length === 0 && tests.length === 0) return [];

    const meta: Array<Pick<WorkflowCheck, 'stage' | 'name'>> = [];
    const nodes: TaskNode<void>[] = [];
    for (const page of pages) {
      const browser = page.viewport ? `browser ${page.viewport.width}x${page.viewport.height}` : 'browser';
      const steps = page.steps?.length ? `, 단계 ${page.steps.length}개` : '';
      const name = `${page.service} ${page.path}${page.mode === 'browser' ? ` (${browser}${steps})` : ''}`;
      meta.push({ stage: 'browser_check', name });
      nodes.push({ id: `page:${name}`, run: ({ signal }) => this.#checkPage(page, signal) });
    }
    for (const test of tests) {
      meta.push({ stage: 'test', name: test.name });
      nodes.push({ id: `test:${test.name}`, maxAttempts: test.maxAttempts, run: ({ signal }) => this.#runTest(test, signal) });
    }
    if (pages.length > 0) this.#stage('browser_check');
    if (tests.length > 0) this.#stage('test');

    const results = await runTaskGraph(nodes, { concurrency: CHECK_CONCURRENCY, signal: this.#options.signal });
    return results.map((result, index) => ({
      ...meta[index]!,
      ok: result.status === 'succeeded',
      attempts: result.attempts,
      detail: result.error,
    }));
  }

  async #checkPage(page: WorkflowPageCheck, signal: AbortSignal): Promise<void> {
    const { sandbox, pageFetcher = fetchPage, browserRunner = runInBrowser } = this.#options;
    const endpoint = await sandbox.endpoint(page.service);
    const url = new URL(page.path, endpoint.url);
    if (url.origin !== new URL(endpoint.url).origin) throw new Error('path must stay on the service host');
    if (page.mode === 'browser') {
      const result = await browserRunner(url.href, { viewport: page.viewport, steps: page.steps, signal });
      const problems: string[] = [];
      if (result.status !== page.expectStatus) problems.push(`HTTP ${result.status ?? '응답 없음'} (기대 ${page.expectStatus})`);
      if (page.expectText && !result.text.includes(page.expectText)) problems.push(`렌더링된 화면에 '${page.expectText}'가 없습니다`);
      if (result.pageErrors.length > 0) problems.push(`스크립트 예외: ${result.pageErrors.slice(0, 3).join(' | ')}`);
      if (!page.allowConsoleErrors && result.consoleErrors.length > 0) problems.push(`console.error: ${result.consoleErrors.slice(0, 3).join(' | ')}`);
      if (!page.allowConsoleErrors && result.failedRequests.length > 0) problems.push(`실패한 요청: ${result.failedRequests.slice(0, 3).join(' | ')}`);
      if (page.noHorizontalScroll && result.horizontalOverflowPx > 1) problems.push(`가로로 ${result.horizontalOverflowPx}px 넘칩니다`);
      // 화면 출력에 시크릿 값이 섞여 있을 수 있어 가린 뒤 모델에게 돌려준다
      if (problems.length > 0) throw new Error(sandbox.redact(problems.join('\n')));
      return;
    }
    const { status, text } = await pageFetcher(url.href, signal);
    if (status !== page.expectStatus) throw new Error(`HTTP ${status} (기대 ${page.expectStatus})`);
    if (page.expectText && !text.includes(page.expectText)) throw new Error(`응답 본문에 '${page.expectText}'가 없습니다`);
  }

  async #runTest(test: WorkflowTest, signal: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(TEST_TIMEOUT_MS);
    // exec는 기본으로 출력의 시크릿 값을 가려서 돌려준다. 실패 출력이 모델에게 그대로 들어가므로 가린 결과만 쓴다
    const result = await this.#options.sandbox.exec(test.service, test.command, { signal: AbortSignal.any([signal, timeout]) });
    if (result.exitCode !== 0) {
      const output = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');
      throw new Error(`종료 코드 ${result.exitCode}\n${output}`);
    }
  }

  /** 지난 검증 이후 바뀐 파일 + 지난번에 준비에 실패한 서비스의 파일 (고치지 않았더라도 다시 확인해야 한다) */
  #filesToVerify(): string[] {
    const { project, workspace } = this.#options;
    const files = new Set(workspace.changedSince(this.#verifiedVersion));
    if (this.#failedServices.size > 0) {
      for (const file of workspace.changedFiles()) {
        const [owner] = servicesForFiles(project, [file]).services;
        if (owner && this.#failedServices.has(owner)) files.add(file);
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
