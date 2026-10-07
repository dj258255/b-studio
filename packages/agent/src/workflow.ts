import { AUTO_PAGE_MAX, type LoadedProject, type WorkflowStage, type WorkflowSpec } from '@b-studio/spec';
import { routesFromChangedFiles } from './next-routes';
import { DEFAULT_DENIED_COMMANDS, isProtectedPath, type ExecutionPolicy } from './policy';
import { servicesForFiles } from './services';

/**
 * 모델의 도구 호출이나 턴 종료로 진입을 알 수 있는 진행 단계와 달리, 플랫폼이 직접 실행해 통과 여부를 판정하는 단계.
 * 이 단계가 필수인데 통과 기록이 없으면 게이트가 완료로 인정하지 않는다.
 */
export const VERIFICATION_STAGES: readonly WorkflowStage[] = ['run', 'browser_check', 'contract_check', 'test', 'concurrency_check', 'review'];

/** workflow를 선언하지 않았을 때도 플랫폼이 항상 실행하는 단계만 둔다. 실행 수단이 없는 단계를 기본값에 넣으면 통과처럼 보이기만 한다 */
export const DEFAULT_WORKFLOW: readonly WorkflowStage[] = ['plan', 'implement', 'run', 'contract_check', 'review', 'checkpoint'];

/** 화면 확인의 단계별 결과. 스크린샷을 저장했으면 artifact에 저장 식별자가 들어간다 */
export interface WorkflowStepCheck {
  label: string;
  ok: boolean;
  detail?: string;
  artifact?: string;
}

/** browser 화면 확인이 디자인 기준 이미지와 비교한 결과. 세 이미지는 산출물 식별자다 */
export interface WorkflowCompare {
  /** 실제 화면이 디자인과 다른 픽셀 비율 (0~1) */
  ratio: number;
  /** 허용한 최대 비율 (0~1) */
  max: number;
  reference?: string;
  actual?: string;
  diff?: string;
}

export interface WorkflowCheck {
  stage: 'browser_check' | 'test' | 'concurrency_check' | 'review';
  name: string;
  ok: boolean;
  attempts: number;
  detail?: string;
  /** browser 모드 화면 확인의 단계별 결과. 스크린샷을 저장하지 않았으면 없다 */
  steps?: WorkflowStepCheck[];
  /** 디자인 기준 이미지와 비교했으면 그 결과. compare를 선언하지 않았으면 없다 */
  compare?: WorkflowCompare;
  /** 측정값. browser 모드 화면 확인의 로드 시간(loadMs). 예산(maxLoadMs)을 적은 확인만 잰다 */
  metrics?: { loadMs?: number };
}

/** studio.yaml의 선언을 실행기 정책으로 변환한다. 프롬프트와 별개로 항상 적용된다. */
export function executionPolicyFor(project: LoadedProject): ExecutionPolicy | undefined {
  const workflow = project.spec.workflow;
  if (!workflow) return undefined;
  return {
    allowedTools: workflow.allowedTools,
    deniedCommands: workflow.deniedCommands,
    requireApprovalFor: workflow.requireApprovalFor,
    protectedPaths: workflow.protectedPaths,
  };
}

/**
 * studio.yaml 정책 위에 쓰기 범위를 더한다. 정책을 통째로 바꾸면 금지 명령·보호 경로가 빠지므로 항상 합친다
 */
export function scopedExecutionPolicy(project: LoadedProject, writablePaths: readonly string[] | undefined): ExecutionPolicy | undefined {
  const base = executionPolicyFor(project);
  if (!writablePaths) return base;
  return { ...base, writablePaths };
}

/**
 * 턴 상한(ADR-131). 요청 옵션(override)이 studio.yaml(workflow.maxTurns)보다 우선한다.
 * 둘 다 없으면 undefined를 돌려줘 각 실행기가 자신의 기본값(60)을 그대로 쓰게 한다
 */
export function maxTurnsFor(project: LoadedProject, override?: number): number | undefined {
  return override ?? project.spec.workflow?.maxTurns;
}

/**
 * 이 프로젝트에서 순서대로 확인할 단계.
 * required를 생략해도 tests·pageChecks를 선언했다면 해당 단계를 필수로 넣는다. 선언한 검사를 건너뛸 방법은 두지 않는다
 */
export function workflowStages(project: LoadedProject): readonly WorkflowStage[] {
  const workflow = project.spec.workflow;
  if (workflow?.required) return workflow.required;
  const stages: WorkflowStage[] = [...DEFAULT_WORKFLOW];
  const insertBefore = (stage: WorkflowStage, before: WorkflowStage) => stages.splice(stages.indexOf(before), 0, stage);
  if (workflow?.pageChecks?.length) insertBefore('browser_check', 'contract_check');
  if (workflow?.tests?.length) insertBefore('test', 'review');
  if (workflow?.concurrencyChecks?.length) insertBefore('concurrency_check', 'review');
  return stages;
}

export function workflowReleaseRequirements(project: LoadedProject): readonly WorkflowStage[] {
  return project.spec.workflow?.releaseRequires ?? ['checkpoint'];
}

/** 체크포인트 커밋 본문 끝에 남기는 트레일러. 스튜디오를 다시 켜도 어떤 검증을 통과한 체크포인트인지 Git에서 읽을 수 있다 */
export const WORKFLOW_TRAILER = 'Workflow-Passed';

export function formatWorkflowTrailer(stages: readonly WorkflowStage[]): string {
  return `${WORKFLOW_TRAILER}: ${stages.length > 0 ? stages.join(', ') : 'none'}`;
}

/**
 * 가볍게 확인(light)했거나 문서만 바꿔(docs) 검증 게이트를 거치지 않은 체크포인트임을 커밋 본문 끝에 남기는 트레일러.
 * 배포 화면과 요구사항 "검증됨" 판정이 이 값으로 이 체크포인트를 게이트 증거로 세지 않는다(ADR-096).
 */
export const WORKFLOW_VERIFY_TRAILER = 'Workflow-Verify';

export function formatVerifyTrailer(mode: 'light' | 'docs'): string {
  return `${WORKFLOW_VERIFY_TRAILER}: ${mode}`;
}

/** git이 트레일러 블록에서 읽은 Workflow-Verify 값. 'light'·'docs'가 아니면 undefined(전체 검증 실행) */
export function parseVerifyTrailerValues(values: readonly string[]): 'light' | 'docs' | undefined {
  const value = values
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .at(-1);
  return value === 'light' || value === 'docs' ? value : undefined;
}

/**
 * docs/** 전부(마크다운·JSON 사이드카 모두), 저장소 루트의 *.md, .github/pull_request_template.md만 문서 경로로
 * 인정한다. studio의 commitWorkingCopyDocs(문서 체크포인트를 만들 때)와 buildPullRequest(그 체크포인트가 실제로
 * 문서만 건드렸는지 PR 본문에서 다시 확인할 때, ADR-110)가 같은 규칙을 공유한다 — 둘이 따로 베껴 두면 한쪽만
 * 고쳤을 때 "문서 체크포인트"의 뜻이 어긋난다.
 */
const DOC_CHECKPOINT_PATH = /^(docs\/.+|[^/]+\.md|\.github\/pull_request_template\.md)$/;

export function isDocCheckpointPath(file: string): boolean {
  return DOC_CHECKPOINT_PATH.test(file);
}

/**
 * git이 트레일러 블록(본문 마지막 문단)에서 읽은 Workflow-Passed 값. 없으면 undefined로, 스튜디오 밖에서 바꾼 파일이나 이전 버전의 체크포인트다.
 * 본문 전체에서 찾으면 에이전트 요약에 쓴 같은 모양의 줄로 통과 기록을 위조할 수 있어 트레일러 블록 값만 받는다.
 * 여러 개면 마지막 것을 쓴다
 */
export function parseWorkflowTrailerValues(values: readonly string[]): WorkflowStage[] | undefined {
  const value = values.map((entry) => entry.trim()).filter(Boolean).at(-1);
  if (value === undefined) return undefined;
  if (value === 'none') return [];
  const known = new Set<string>([...VERIFICATION_STAGES, 'plan', 'implement', 'checkpoint']);
  return value.split(/\s*,\s*/).filter((stage): stage is WorkflowStage => known.has(stage));
}

/**
 * 배포 전에 체크포인트가 releaseRequires를 채웠는지 본다. 빠진 단계를 돌려준다.
 * checkpoint는 체크포인트가 있다는 것 자체로 채워진다. 검증 기록이 없는 체크포인트는 다른 단계를 하나도 채우지 못한다
 */
export function releaseBlockers(project: LoadedProject, passedStages: readonly WorkflowStage[] | undefined): WorkflowStage[] {
  const passed = new Set(passedStages ?? []);
  return workflowReleaseRequirements(project).filter((stage) => stage !== 'checkpoint' && !passed.has(stage));
}

/** 게이트가 통과시킨 단계와 필수 단계를 비교해 빠진 검증 단계를 돌려준다 */
export function missingVerificationStages(project: LoadedProject, passed: ReadonlySet<WorkflowStage>): WorkflowStage[] {
  return workflowStages(project).filter((stage) => VERIFICATION_STAGES.includes(stage) && !passed.has(stage));
}

/**
 * review 단계의 플랫폼 검토. 도구 게이트를 거치지 않은 하네스(로컬 CLI, Pi 등)가 바꾼 파일도
 * 체크포인트 직전에 같은 규칙으로 다시 본다.
 */
export function reviewChanges(project: LoadedProject, changedFiles: readonly string[]): WorkflowCheck[] {
  const workflow = project.spec.workflow;
  const checks: WorkflowCheck[] = [];
  const touched = (workflow?.protectedPaths ?? []).flatMap((rule) =>
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

/** coverage-gap 체크 이름에 붙는 접두사. 체크포인트 본문이 이 접두사로 "확인 안 됨" 항목만 따로 묶어 보여준다(ADR-135) */
export const COVERAGE_GAP_PREFIX = 'coverage-gap';

/** 테스트 파일·테스트 러너 설정으로 보이는 경로. 버그 리포트 108의 lib/shortsFeed.test.ts·vitest.config.ts가 둘 다 걸린다 */
const TEST_SIGNAL_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(vitest|jest|playwright)\.config\.[cm]?[jt]s$|(^|\/)__tests__\//;

/**
 * 이번 실행이 바꾼 파일을 보고, workflow.tests·workflow.pageChecks(또는 autoPageChecks)가 다루지 않는 서비스에
 * 테스트 파일이나 화면 경로가 새로 생겼는지 본다(버그 리포트 108 — BE-commerce R26에서 에이전트가 apps/web에
 * vitest·테스트 파일을 넣었지만 workflow.tests는 commerce-test 하나뿐이라 게이트가 돌리지 않았는데도
 * 트레일러는 test·browser_check가 통과한 것처럼 보였다).
 *
 * 게이트를 막지 않는다(ok: true뿐이다) — studio.yaml을 몰래 고치거나 임의로 새 명령을 돌리는 대신,
 * "이번 실행에서 확인되지 않았다"는 사실만 드러낸다(선택 A, docs/decisions.md ADR-135).
 * 테스트 명령을 studio.yaml에 자동으로 추가하지 않는 이유: ADR-133이 이미 "studio.yaml은 사람 모르게 바뀌지
 * 않는다"는 원칙을 세웠다(explore-qa-save.ts와 같은 원칙) — 여기서도 그 원칙을 지킨다.
 */
export function uncoveredChangeWarnings(project: LoadedProject, changedFiles: readonly string[]): WorkflowCheck[] {
  if (!project.managed?.length) return [];
  const workflow = project.spec.workflow;
  const testedServices = new Set((workflow?.tests ?? []).map((test) => test.service));
  const autoPageService = workflow?.autoPageChecks?.service;

  const { services: touched } = servicesForFiles(project, changedFiles);
  const warnings: WorkflowCheck[] = [];
  for (const name of touched) {
    const entry = project.managed.find(([serviceName]) => serviceName === name);
    if (!entry) continue;
    const [, spec] = entry;

    if (!testedServices.has(name) && changedFiles.some((file) => isWithinService(file, spec.path) && TEST_SIGNAL_PATTERN.test(file))) {
      warnings.push({
        stage: 'review',
        name: `${COVERAGE_GAP_PREFIX}: ${name} 테스트`,
        ok: true,
        attempts: 1,
        detail: `${name}에 테스트 파일·설정이 새로 생겼지만 workflow.tests에 '${name}' 서비스를 다루는 항목이 없어 게이트의 test 단계가 돌리지 않았습니다. 돌려야 한다면 studio.yaml의 workflow.tests에 추가하세요.`,
      });
    }

    // autoPageChecks가 이 서비스를 맡으면 새로 생긴 라우트를 스스로 찾아 확인(또는 건너뛴 이유를 기록)하므로 따로 보지 않는다.
    // 선언한 pageChecks는 서비스가 같아도 **경로가 정확히 같을 때만** 그 라우트를 확인한 것으로 본다 —
    // 버그 리포트 108에서 web pageChecks가 '/'만 선언해도 '/shorts'는 확인되지 않은 채 트레일러에 통과로 찍혔다
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

function isWithinService(file: string, servicePath: string): boolean {
  const root = servicePath.replace(/^\.\/?/, '').replace(/\/+$/, '');
  return root === '' || file === root || file.startsWith(`${root}/`);
}

/**
 * 체크포인트 본문에 남길, 게이트가 실제로 확인한 서비스·테스트·경로 요약과 확인되지 않은 항목(ADR-135).
 * "에이전트의 완료 선언을 믿지 않는다"는 약속을 트레일러의 단계 이름뿐 아니라 무엇을 확인했는지까지 드러내서 지킨다.
 */
export function formatCheckedCoverage(checks: readonly WorkflowCheck[] | undefined): string {
  if (!checks?.length) return '';
  const gapPrefix = `${COVERAGE_GAP_PREFIX}:`;
  const gaps = checks.filter((check) => check.name.startsWith(gapPrefix));
  const covered = checks.filter((check) => check.stage === 'browser_check' || check.stage === 'test' || check.stage === 'concurrency_check');
  const lines: string[] = [];
  if (covered.length > 0) {
    lines.push(`게이트가 확인함: ${covered.map((check) => `[${check.stage}] ${check.name}(${check.ok ? '통과' : '실패'})`).join(', ')}`);
  }
  if (gaps.length > 0) {
    lines.push(`확인 안 됨:\n${gaps.map((check) => `- ${check.detail ?? check.name}`).join('\n')}`);
  }
  return lines.join('\n');
}

/** Pi 확장(packages/agent/pi/bstudio-policy.ts)이 읽는 환경 변수. 같은 studio.yaml에서 만들어 규칙이 두 곳에서 어긋나지 않게 한다 */
export function piPolicyEnvironment(project: LoadedProject): Record<string, string> {
  const workflow = project.spec.workflow;
  return {
    BSTUDIO_WORKFLOW: workflowStages(project).join(' → '),
    BSTUDIO_PROTECTED_PATHS: (workflow?.protectedPaths ?? []).join(','),
    BSTUDIO_DENIED_COMMANDS: [...new Set([...DEFAULT_DENIED_COMMANDS, ...(workflow?.deniedCommands ?? [])])].join(','),
  };
}

/** 모델에게 주되 모델이 바꿀 수 없는 현재 작업 규칙과 다음 행동 */
export function workflowContext(project: LoadedProject): string {
  const workflow = project.spec.workflow;
  const stages = workflowStages(project);
  const tools = workflow?.allowedTools?.join(', ') ?? 'b-studio 기본 도구';
  const protectedPaths = workflow?.protectedPaths?.join(', ') || '없음';
  const tests = workflow?.tests?.map((test) => `${test.name}(${test.service}: ${test.command.join(' ')})`).join(', ');
  const pages = workflow?.pageChecks?.map((check) => `${check.service} ${check.path}`).join(', ');
  const concurrency = workflow?.concurrencyChecks?.map((check) => `${check.name}(${check.service} ${check.method} ${check.path} ×${check.concurrent})`).join(', ');
  return `
[b-studio workflow]
이 프로젝트의 작업은 다음 순서로 진행합니다: ${stages.join(' → ')}.
에이전트의 완료 선언은 완료 판정이 아닙니다. 턴을 끝내면 플랫폼이 서비스 재시작·API 계약${pages ? '·화면 확인' : ''}${tests ? '·테스트' : ''}·리뷰를 직접 실행하고, 모두 통과해야 체크포인트를 만듭니다.
허용 도구: ${tools}
보호 경로: ${protectedPaths}
${tests ? `플랫폼이 실행할 테스트: ${tests}\n` : ''}${pages ? `플랫폼이 확인할 화면: ${pages}\n` : ''}${concurrency ? `플랫폼이 동시에 보낼 요청: ${concurrency}\n` : ''}실패하면 우회하지 말고 검증 결과에 표시된 원인을 고친 뒤 다시 턴을 끝내세요.
`;
}

export function describeWorkflow(workflow: WorkflowSpec | undefined): string {
  if (!workflow) return DEFAULT_WORKFLOW.join(' → ');
  return (workflow.required ?? DEFAULT_WORKFLOW).join(' → ');
}
