import { AUTO_PAGE_MAX, type LoadedProject, type WorkflowSpec, type WorkflowStage } from '@b-studio/spec';
import { DECLARED_CHECKS_CHECK } from './declared-checks';
import { routesFromChangedFiles } from './next-routes';
import { isProtectedPath } from './policy';
import { ownsFile, servicesForFiles } from './services';

/**
 * 워크플로 판정을 Rust로 옮기기 전(ADR-191 3v) `workflow.ts`(와 `checkpoints.ts`의 두 트레일러 확인)에 있던 구현을 그대로 둔 것이다.
 * 차등 시험(`workflow-differential.test.ts`)과 벡터 시험(`workflow-vectors.test.ts`)이 기준으로 삼는다. 제품 코드는 이 파일을 쓰지 않는다. 지우지 않는다.
 * 경로 소유(`ownsFile`·`servicesForFiles`)·화면 경로(`routesFromChangedFiles`)·보호 경로(`isProtectedPath`)는 앞 조각에서 이미 Rust로 옮겨 검증했으므로 껍데기를 그대로 쓴다.
 */

export interface LegacyWorkflowCheck {
  stage: 'browser_check' | 'test' | 'concurrency_check' | 'load_check' | 'review';
  name: string;
  ok: boolean;
  attempts: number;
  detail?: string;
}

export const legacy = (() => {
  const VERIFICATION_STAGES: readonly WorkflowStage[] = ['run', 'browser_check', 'contract_check', 'test', 'concurrency_check', 'load_check', 'review'];
  const DEFAULT_WORKFLOW: readonly WorkflowStage[] = ['plan', 'implement', 'run', 'contract_check', 'review', 'checkpoint'];
  const WORKFLOW_TRAILER = 'Workflow-Passed';
  const WORKFLOW_VERIFY_TRAILER = 'Workflow-Verify';
  const WORKFLOW_INCOMPLETE_TRAILER = 'Workflow-Incomplete';
  const COVERAGE_GAP_PREFIX = 'coverage-gap';
  const DOC_CHECKPOINT_PATH = /^(docs\/.+|[^/]+\.md|\.github\/pull_request_template\.md)$/;
  const TEST_SIGNAL_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(vitest|jest|playwright)\.config\.[cm]?[jt]s$|(^|\/)__tests__\//;

  type VerifyTrailer = 'light' | 'docs' | 'unverified';

  function protectedPathsFor(workflow: WorkflowSpec | undefined): string[] {
    return [...(workflow?.protectedPaths ?? []), ...(workflow?.evaluationAssets ?? [])];
  }

  function maxTurnsFor(project: LoadedProject, override?: number): number | undefined {
    return override ?? project.spec.workflow?.maxTurns;
  }

  function workflowStages(project: LoadedProject): readonly WorkflowStage[] {
    const workflow = project.spec.workflow;
    if (workflow?.required) return workflow.required;
    const stages: WorkflowStage[] = [...DEFAULT_WORKFLOW];
    const insertBefore = (stage: WorkflowStage, before: WorkflowStage) => stages.splice(stages.indexOf(before), 0, stage);
    if (workflow?.pageChecks?.length) insertBefore('browser_check', 'contract_check');
    if (workflow?.tests?.length) insertBefore('test', 'review');
    if (workflow?.concurrencyChecks?.length) insertBefore('concurrency_check', 'review');
    if (workflow?.loadChecks?.length) insertBefore('load_check', 'review');
    return stages;
  }

  function workflowReleaseRequirements(project: LoadedProject): readonly WorkflowStage[] {
    return project.spec.workflow?.releaseRequires ?? ['checkpoint'];
  }

  function formatWorkflowTrailer(stages: readonly WorkflowStage[]): string {
    return `${WORKFLOW_TRAILER}: ${stages.length > 0 ? stages.join(', ') : 'none'}`;
  }

  function formatVerifyTrailer(mode: VerifyTrailer): string {
    return `${WORKFLOW_VERIFY_TRAILER}: ${mode}`;
  }

  function formatIncompleteTrailer(reason: 'max_turns'): string {
    return `${WORKFLOW_INCOMPLETE_TRAILER}: ${reason}`;
  }

  function parseIncompleteTrailerValues(values: readonly string[]): 'max_turns' | undefined {
    const value = values
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .at(-1);
    return value === 'max_turns' ? value : undefined;
  }

  function parseVerifyTrailerValues(values: readonly string[]): VerifyTrailer | undefined {
    const value = values
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .at(-1);
    return value === 'light' || value === 'docs' || value === 'unverified' ? value : undefined;
  }

  function isDocCheckpointPath(file: string): boolean {
    return DOC_CHECKPOINT_PATH.test(file);
  }

  function parseWorkflowTrailerValues(values: readonly string[]): WorkflowStage[] | undefined {
    const value = values.map((entry) => entry.trim()).filter(Boolean).at(-1);
    if (value === undefined) return undefined;
    if (value === 'none') return [];
    const known = new Set<string>([...VERIFICATION_STAGES, 'plan', 'implement', 'checkpoint']);
    return value.split(/\s*,\s*/).filter((stage): stage is WorkflowStage => known.has(stage));
  }

  function releaseBlockers(project: LoadedProject, passedStages: readonly WorkflowStage[] | undefined, verify?: VerifyTrailer): WorkflowStage[] {
    const passed = new Set(passedStages ?? []);
    if (verify === 'unverified' && project.spec.workflow?.releaseRequires === undefined) return ['checkpoint'];
    return workflowReleaseRequirements(project).filter((stage) => stage !== 'checkpoint' && !passed.has(stage));
  }

  function missingVerificationStages(project: LoadedProject, passed: ReadonlySet<WorkflowStage>): WorkflowStage[] {
    return workflowStages(project).filter((stage) => VERIFICATION_STAGES.includes(stage) && !passed.has(stage));
  }

  function reviewChanges(project: LoadedProject, changedFiles: readonly string[]): LegacyWorkflowCheck[] {
    const workflow = project.spec.workflow;
    const checks: LegacyWorkflowCheck[] = [];
    const touched = protectedPathsFor(workflow).flatMap((rule) =>
      changedFiles.filter((file) => isProtectedPath(file, rule)).map((file) => `${file} (보호 경로 ${rule})`),
    );
    checks.push({
      stage: 'review',
      name: 'protected-paths',
      ok: touched.length === 0,
      attempts: 1,
      detail: touched.length ? `보호 경로가 바뀌었습니다. 되돌리거나 사람 승인 흐름으로 요청하세요: ${touched.join(', ')}` : undefined,
    });
    if (workflow?.maxChangedFiles !== undefined) {
      const over = changedFiles.length > workflow.maxChangedFiles;
      checks.push({
        stage: 'review',
        name: 'change-size',
        ok: !over,
        attempts: 1,
        detail: over ? `한 요청에서 파일 ${changedFiles.length}개를 바꿨습니다(상한 ${workflow.maxChangedFiles}). 필요 없는 변경을 되돌리세요` : undefined,
      });
    }
    checks.push(...uncoveredChangeWarnings(project, changedFiles));
    return checks;
  }

  function uncoveredChangeWarnings(project: LoadedProject, changedFiles: readonly string[]): LegacyWorkflowCheck[] {
    if (!project.managed?.length) return [];
    const workflow = project.spec.workflow;
    const testedServices = new Set((workflow?.tests ?? []).map((test) => test.service));
    const autoPageService = workflow?.autoPageChecks?.service;

    const { services: touched } = servicesForFiles(project, changedFiles);
    const warnings: LegacyWorkflowCheck[] = [];
    for (const name of touched) {
      const entry = project.managed.find(([serviceName]) => serviceName === name);
      if (!entry) continue;
      const [, spec] = entry;

      if (!testedServices.has(name) && changedFiles.some((file) => ownsFile(spec, file) && TEST_SIGNAL_PATTERN.test(file))) {
        warnings.push({
          stage: 'review',
          name: `${COVERAGE_GAP_PREFIX}: ${name} 테스트`,
          ok: true,
          attempts: 1,
          detail: `${name}에 테스트 파일·설정이 새로 생겼지만 workflow.tests에 '${name}' 서비스를 다루는 항목이 없어 게이트의 test 단계가 돌리지 않았습니다. 돌려야 한다면 studio.yaml의 workflow.tests에 추가하세요.`,
        });
      }

      if (spec.template === 'nextjs' && autoPageService !== name) {
        const { routes } = routesFromChangedFiles(changedFiles, spec.path, {}, AUTO_PAGE_MAX);
        const declaredPaths = new Set((workflow?.pageChecks ?? []).filter((check) => check.service === name).map((check) => check.path));
        const uncoveredRoutes = routes.filter((route) => !declaredPaths.has(route.path));
        if (uncoveredRoutes.length > 0) {
          warnings.push({
            stage: 'review',
            name: `${COVERAGE_GAP_PREFIX}: ${name} 화면`,
            ok: true,
            attempts: 1,
            detail: `${name}에 화면 경로가 바뀌었지만(${uncoveredRoutes.map((route) => route.path).join(', ')}) workflow.pageChecks·autoPageChecks가 이 경로를 확인하지 않아 게이트가 열어 보지 않았습니다. studio.yaml에 pageChecks를 추가하거나 autoPageChecks를 켜세요.`,
          });
        }
      }
    }
    return warnings;
  }

  function formatCheckedCoverage(checks: readonly LegacyWorkflowCheck[] | undefined): string {
    if (!checks?.length) return '';
    const gapPrefix = `${COVERAGE_GAP_PREFIX}:`;
    const gaps = checks.filter((check) => check.name.startsWith(gapPrefix));
    const covered = checks.filter((check) => check.stage === 'browser_check' || check.stage === 'test' || check.stage === 'concurrency_check' || check.stage === 'load_check');
    const lines: string[] = [];
    if (covered.length > 0) {
      lines.push(`게이트가 확인함: ${covered.map((check) => `[${check.stage}] ${check.name}(${check.ok ? '통과' : '실패'})`).join(', ')}`);
    }
    if (gaps.length > 0) {
      lines.push(`확인 안 됨:\n${gaps.map((check) => `- ${check.detail ?? check.name}`).join('\n')}`);
    }
    const declared = checks.find((check) => check.stage === 'review' && check.name === DECLARED_CHECKS_CHECK && check.ok && check.detail);
    if (declared) lines.push(`확인 선언 변경: ${declared.detail}`);
    return lines.join('\n');
  }

  /** `checkpoints.ts`의 `hasEmptyPassedTrailer` */
  function hasEmptyPassedTrailer(trailers: readonly string[]): boolean {
    const prefix = `${WORKFLOW_TRAILER}:`.toLowerCase();
    const line = trailers.find((entry) => entry.trim().toLowerCase().startsWith(prefix));
    if (!line) return false;
    return line.slice(line.indexOf(':') + 1).trim().toLowerCase() === 'none';
  }

  /** `checkpoints.ts`의 `hasDocsVerifyTrailer` */
  function hasDocsVerifyTrailer(trailers: readonly string[]): boolean {
    const expected = formatVerifyTrailer('docs').toLowerCase();
    return trailers.some((entry) => entry.trim().toLowerCase() === expected);
  }

  return {
    protectedPathsFor,
    maxTurnsFor,
    workflowStages,
    workflowReleaseRequirements,
    formatWorkflowTrailer,
    formatVerifyTrailer,
    formatIncompleteTrailer,
    parseIncompleteTrailerValues,
    parseVerifyTrailerValues,
    parseWorkflowTrailerValues,
    isDocCheckpointPath,
    releaseBlockers,
    missingVerificationStages,
    reviewChanges,
    uncoveredChangeWarnings,
    formatCheckedCoverage,
    hasEmptyPassedTrailer,
    hasDocsVerifyTrailer,
  };
})();
