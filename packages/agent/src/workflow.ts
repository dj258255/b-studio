import type { LoadedProject, WorkflowStage, WorkflowSpec } from '@b-studio/spec';
import { DEFAULT_DENIED_COMMANDS, isProtectedPath, type ExecutionPolicy } from './policy';

/**
 * 모델의 도구 호출이나 턴 종료로 진입을 알 수 있는 진행 단계와 달리, 플랫폼이 직접 실행해 통과 여부를 판정하는 단계.
 * 이 단계가 필수인데 통과 기록이 없으면 게이트가 완료로 인정하지 않는다.
 */
export const VERIFICATION_STAGES: readonly WorkflowStage[] = ['run', 'browser_check', 'contract_check', 'test', 'review'];

/** workflow를 선언하지 않았을 때도 플랫폼이 항상 실행하는 단계만 둔다. 실행 수단이 없는 단계를 기본값에 넣으면 통과처럼 보이기만 한다 */
export const DEFAULT_WORKFLOW: readonly WorkflowStage[] = ['plan', 'implement', 'run', 'contract_check', 'review', 'checkpoint'];

export interface WorkflowCheck {
  stage: 'browser_check' | 'test' | 'review';
  name: string;
  ok: boolean;
  attempts: number;
  detail?: string;
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
  return checks;
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
  return `
[b-studio workflow]
이 프로젝트의 작업은 다음 순서로 진행합니다: ${stages.join(' → ')}.
에이전트의 완료 선언은 완료 판정이 아닙니다. 턴을 끝내면 플랫폼이 서비스 재시작·API 계약${pages ? '·화면 확인' : ''}${tests ? '·테스트' : ''}·리뷰를 직접 실행하고, 모두 통과해야 체크포인트를 만듭니다.
허용 도구: ${tools}
보호 경로: ${protectedPaths}
${tests ? `플랫폼이 실행할 테스트: ${tests}\n` : ''}${pages ? `플랫폼이 확인할 화면: ${pages}\n` : ''}실패하면 우회하지 말고 검증 결과에 표시된 원인을 고친 뒤 다시 턴을 끝내세요.
`;
}

export function describeWorkflow(workflow: WorkflowSpec | undefined): string {
  if (!workflow) return DEFAULT_WORKFLOW.join(' → ');
  return (workflow.required ?? DEFAULT_WORKFLOW).join(' → ');
}
