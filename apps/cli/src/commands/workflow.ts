import { piPolicyEnvironment, VERIFICATION_STAGES, workflowReleaseRequirements, workflowStages } from '@b-studio/agent';
import type { LoadedProject } from '@b-studio/spec';

/**
 * studio.yaml에서 실제로 강제할 워크플로를 보여 준다.
 * --pi-env는 Pi 확장이 읽는 환경 변수를 셸에 넣을 수 있게 출력한다: eval "$(studio workflow . --pi-env)"
 */
export function workflow(project: LoadedProject, options: { piEnv: boolean }): number {
  if (options.piEnv) {
    for (const [name, value] of Object.entries(piPolicyEnvironment(project))) console.log(`export ${name}=${shellQuote(value)}`);
    return 0;
  }

  const spec = project.spec.workflow;
  const stages = workflowStages(project);
  console.log(`단계: ${stages.join(' → ')}`);
  console.log(`플랫폼이 판정하는 단계: ${stages.filter((stage) => VERIFICATION_STAGES.includes(stage)).join(', ')}`);
  for (const test of spec?.tests ?? []) console.log(`  test  ${test.name} · ${test.service}: ${test.command.join(' ')} (최대 ${test.maxAttempts}회)`);
  for (const page of spec?.pageChecks ?? []) {
    console.log(`  page  ${page.service} ${page.path} → HTTP ${page.expectStatus}${page.expectText ? ` · '${page.expectText}' 포함` : ''}`);
  }
  console.log(`보호 경로: ${spec?.protectedPaths?.join(', ') || '없음'}`);
  if (spec?.maxChangedFiles !== undefined) console.log(`요청당 변경 파일 상한: ${spec.maxChangedFiles}`);
  console.log(`배포 조건: ${workflowReleaseRequirements(project).join(', ')}`);
  return 0;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
