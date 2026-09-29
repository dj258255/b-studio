import { describe, expect, it } from 'vitest';
import type { LoadedProject, WorkflowSpec } from '@b-studio/spec';
import {
  DEFAULT_WORKFLOW,
  executionPolicyFor,
  formatVerifyTrailer,
  missingVerificationStages,
  parseVerifyTrailerValues,
  parseWorkflowTrailerValues,
  piPolicyEnvironment,
  releaseBlockers,
  formatWorkflowTrailer,
  reviewChanges,
  WORKFLOW_VERIFY_TRAILER,
  workflowContext,
  workflowStages,
} from './workflow';

function projectWith(workflow?: Partial<WorkflowSpec>): LoadedProject {
  return { spec: { name: 'orders', workflow } } as unknown as LoadedProject;
}

const unit = { name: 'unit', service: 'api', command: ['./gradlew', 'test'], maxAttempts: 1 };

describe('project workflow', () => {
  it('turns studio.yaml workflow rules into the executor policy', () => {
    const project = projectWith({
      required: ['plan', 'implement', 'run', 'test', 'checkpoint'],
      tests: [unit],
      allowedTools: ['read_file', 'edit_file'],
      deniedCommands: ['npm publish'],
      protectedPaths: ['.env', 'infra'],
    });
    expect(executionPolicyFor(project)).toEqual({
      allowedTools: ['read_file', 'edit_file'],
      deniedCommands: ['npm publish'],
      requireApprovalFor: undefined,
      protectedPaths: ['.env', 'infra'],
    });
    expect(workflowStages(project)).toEqual(['plan', 'implement', 'run', 'test', 'checkpoint']);
  });

  it('기본 단계에는 플랫폼이 항상 실행하는 단계만 두고, 선언한 테스트·화면 확인은 자동으로 필수 단계가 된다', () => {
    expect(workflowStages(projectWith())).toEqual(DEFAULT_WORKFLOW);
    expect(
      workflowStages(projectWith({ tests: [unit], pageChecks: [{ service: 'web', path: '/', mode: 'http', expectStatus: 200, allowConsoleErrors: false, noHorizontalScroll: false }] })),
    ).toEqual(['plan', 'implement', 'run', 'browser_check', 'contract_check', 'test', 'review', 'checkpoint']);
  });

  it('선언한 동시 요청 확인은 자동으로 필수 단계가 되고 모델 컨텍스트에 나온다', () => {
    const project = projectWith({
      concurrencyChecks: [{ name: 'stock', service: 'api', method: 'POST', path: '/api/products/1/orders', concurrent: 5, expect: { successCount: { exactly: 1 } } }],
    });
    expect(workflowStages(project)).toContain('concurrency_check');
    expect(missingVerificationStages(project, new Set(['run', 'contract_check', 'review']))).toEqual(['concurrency_check']);
    expect(workflowContext(project)).toContain('플랫폼이 동시에 보낼 요청: stock(api POST /api/products/1/orders ×5)');
  });

  it('통과 기록이 없는 검증 단계만 빠진 단계로 본다 (plan·implement·checkpoint는 게이트가 판정하지 않는다)', () => {
    const project = projectWith({ tests: [unit] });
    expect(missingVerificationStages(project, new Set(['run', 'contract_check', 'review']))).toEqual(['test']);
    expect(missingVerificationStages(project, new Set(['run', 'contract_check', 'test', 'review']))).toEqual([]);
  });

  it('리뷰 단계는 보호 경로 변경과 변경 파일 수 상한을 확인한다', () => {
    const project = projectWith({ protectedPaths: ['.env', 'migrations'], maxChangedFiles: 2 });
    const checks = reviewChanges(project, ['web/page.tsx', '.env.local', 'migrations/V2.sql']);
    expect(checks.map((check) => [check.name, check.ok])).toEqual([
      ['protected-paths', false],
      ['change-size', false],
    ]);
    expect(checks[0]!.detail).toContain('.env.local (보호 경로 .env)');
    expect(reviewChanges(project, ['web/page.tsx']).every((check) => check.ok)).toBe(true);
  });

  it('배포 조건은 체크포인트에 남은 통과 기록으로 판정하고, 기록이 없는 체크포인트는 checkpoint 외 조건을 채우지 못한다', () => {
    const strict = projectWith({ tests: [unit], releaseRequires: ['test', 'review', 'checkpoint'] });
    expect(releaseBlockers(strict, ['run', 'contract_check', 'test', 'review'])).toEqual([]);
    expect(releaseBlockers(strict, ['run', 'contract_check', 'review'])).toEqual(['test']);
    expect(releaseBlockers(strict, undefined)).toEqual(['test', 'review']);
    // 선언하지 않으면 기존처럼 모든 체크포인트를 배포할 수 있다
    expect(releaseBlockers(projectWith(), undefined)).toEqual([]);

    const value = (stages: Parameters<typeof formatWorkflowTrailer>[0]) => formatWorkflowTrailer(stages).split(': ')[1]!;
    expect(parseWorkflowTrailerValues([value(['run', 'review'])])).toEqual(['run', 'review']);
    expect(parseWorkflowTrailerValues([value([])])).toEqual([]);
    expect(parseWorkflowTrailerValues([''])).toBeUndefined();
    // 알 수 없는 단계 이름은 버리고, 여러 값이면 마지막 것을 쓴다
    expect(parseWorkflowTrailerValues(['test, review', 'run, deploy'])).toEqual(['run']);
  });

  it('가볍게 확인(Workflow-Verify) 표시를 읽고, 없거나 다른 값이면 전체 검증으로 본다', () => {
    expect(formatVerifyTrailer('light')).toBe(`${WORKFLOW_VERIFY_TRAILER}: light`);
    expect(parseVerifyTrailerValues(['light'])).toBe('light');
    // 여러 값이면 마지막 것을 쓴다. 'full'·빈 값·모르는 값은 전체 검증(undefined)이다
    expect(parseVerifyTrailerValues(['', 'light'])).toBe('light');
    expect(parseVerifyTrailerValues(['light', 'full'])).toBeUndefined();
    expect(parseVerifyTrailerValues(['full'])).toBeUndefined();
    expect(parseVerifyTrailerValues([''])).toBeUndefined();
    // 가볍게 확인한 체크포인트(run·contract_check만 통과)는 releaseRequires가 채워지지 않아 배포가 막힌다
    const strict = projectWith({ releaseRequires: ['contract_check', 'test', 'review', 'checkpoint'] });
    expect(releaseBlockers(strict, ['run', 'contract_check'])).toEqual(['test', 'review']);
  });

  it('Pi 확장이 읽을 환경 변수를 같은 studio.yaml에서 만든다', () => {
    const env = piPolicyEnvironment(projectWith({ protectedPaths: ['infra'], deniedCommands: ['npm publish'], tests: [unit] }));
    expect(env.BSTUDIO_PROTECTED_PATHS).toBe('infra');
    expect(env.BSTUDIO_DENIED_COMMANDS!.split(',')).toEqual(expect.arrayContaining(['git push', 'npm publish']));
    expect(env.BSTUDIO_WORKFLOW).toContain('test → review');
  });

  it('gives the harness a useful next-action context without treating it as a security boundary', () => {
    const context = workflowContext(projectWith({ tests: [unit], allowedTools: ['read_file', 'edit_file'] }));
    expect(context).toContain('run → contract_check → test → review');
    expect(context).toContain('read_file, edit_file');
    expect(context).toContain('플랫폼이 실행할 테스트: unit(api: ./gradlew test)');
    expect(context).toContain('완료 선언은 완료 판정이 아닙니다');
  });
});
