import { describe, expect, it } from 'vitest';
import { WorkflowLoadCheckSchema, WorkflowPageCheckSchema, type LoadedProject, type WorkflowSpec } from '@b-studio/spec';
import {
  COVERAGE_GAP_PREFIX,
  DEFAULT_WORKFLOW,
  executionPolicyFor,
  formatCheckedCoverage,
  formatVerifyTrailer,
  maxTurnsFor,
  missingVerificationStages,
  LOAD_CHECK_GUIDE,
  PAGE_ASSERTION_GUIDE,
  parseVerifyTrailerValues,
  parseWorkflowTrailerValues,
  piPolicyEnvironment,
  releaseBlockers,
  formatWorkflowTrailer,
  reviewChanges,
  uncoveredChangeWarnings,
  WORKFLOW_VERIFY_TRAILER,
  workflowContext,
  workflowStages,
} from './workflow';

function projectWith(workflow?: Partial<WorkflowSpec>, managed?: LoadedProject['managed']): LoadedProject {
  return { spec: { name: 'orders', workflow }, ...(managed ? { managed } : {}) } as unknown as LoadedProject;
}

const webService: LoadedProject['managed'][number] = ['web', { source: 'managed', template: 'nextjs', path: 'apps/web', port: 3000, preview: 'browser' } as never];
const apiService: LoadedProject['managed'][number] = ['api', { source: 'managed', template: 'spring-boot', path: 'apps/api', port: 8080, preview: 'openapi' } as never];

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

  it('선언한 부하 확인은 자동으로 필수 단계가 되고 모델 컨텍스트에 기준과 함께 나온다', () => {
    const project = projectWith({
      loadChecks: [{ name: 'orders-p95', service: 'api', method: 'POST', path: '/api/orders', concurrent: 1000, warmup: 0, expect: { p95Ms: 200, latencyOf: [409] } }],
    });
    expect(workflowStages(project)).toEqual(['plan', 'implement', 'run', 'contract_check', 'load_check', 'review', 'checkpoint']);
    expect(missingVerificationStages(project, new Set(['run', 'contract_check', 'review']))).toEqual(['load_check']);
    expect(workflowContext(project)).toContain('플랫폼이 샌드박스 안에서 잴 응답 시간: orders-p95(api POST /api/orders 동시 1000 · p95 200ms 이하, 409 응답만)');
    expect(formatCheckedCoverage([{ stage: 'load_check', name: 'orders-p95', ok: true, attempts: 1 }])).toBe('게이트가 확인함: [load_check] orders-p95(통과)');
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
    // 문서만 바꿔 검증 게이트를 거치지 않은 체크포인트(ADR-096)도 같은 트레일러로 표시한다
    expect(formatVerifyTrailer('docs')).toBe(`${WORKFLOW_VERIFY_TRAILER}: docs`);
    expect(parseVerifyTrailerValues(['docs'])).toBe('docs');
    expect(parseVerifyTrailerValues(['light', 'docs'])).toBe('docs');
    expect(parseVerifyTrailerValues(['DOCS'])).toBe('docs');
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

  describe('uncoveredChangeWarnings(ADR-135, 버그 리포트 108)', () => {
    it('managed가 없는 프로젝트(옛 픽스처)는 조용히 빈 배열을 돌려준다', () => {
      expect(uncoveredChangeWarnings(projectWith({ tests: [unit] }), ['apps/web/lib/x.test.ts'])).toEqual([]);
    });

    it('workflow.tests가 다루지 않는 서비스에 테스트 파일이 새로 생기면 경고만 남기고 막지 않는다', () => {
      const project = projectWith({ tests: [{ ...unit, service: 'api' }] }, [webService, apiService]);
      const warnings = uncoveredChangeWarnings(project, ['apps/web/lib/shortsFeed.test.ts', 'apps/web/vitest.config.ts']);
      expect(warnings).toEqual([
        {
          stage: 'review',
          name: `${COVERAGE_GAP_PREFIX}: web 테스트`,
          ok: true,
          attempts: 1,
          detail: expect.stringContaining("workflow.tests에 'web' 서비스를 다루는 항목이 없어"),
        },
      ]);
    });

    it('workflow.tests가 그 서비스를 이미 다루면 경고를 남기지 않는다', () => {
      const project = projectWith({ tests: [{ ...unit, service: 'web' }] }, [webService, apiService]);
      expect(uncoveredChangeWarnings(project, ['apps/web/lib/shortsFeed.test.ts'])).toEqual([]);
    });

    it('요청이 말한 경로가 바뀌었는데 선언한 pageChecks가 다른 경로만 가리키면 "확인 안 됨"을 남긴다', () => {
      const project = projectWith(
        { pageChecks: [{ service: 'web', path: '/', mode: 'http', expectStatus: 200, allowConsoleErrors: false, noHorizontalScroll: false }] },
        [webService, apiService],
      );
      const warnings = uncoveredChangeWarnings(project, ['apps/web/app/shorts/page.tsx']);
      expect(warnings).toEqual([
        {
          stage: 'review',
          name: `${COVERAGE_GAP_PREFIX}: web 화면`,
          ok: true,
          attempts: 1,
          detail: expect.stringContaining('/shorts'),
        },
      ]);
    });

    it('autoPageChecks가 그 서비스를 맡고 있으면 새 라우트를 따로 경고하지 않는다(게이트가 스스로 찾아본다)', () => {
      const project = projectWith({ autoPageChecks: { service: 'web', mode: 'http', expectStatus: 200, maxPages: 5 } }, [webService, apiService]);
      expect(uncoveredChangeWarnings(project, ['apps/web/app/shorts/page.tsx'])).toEqual([]);
    });

    it('nextjs가 아닌 서비스는 화면 경로 경고 대상이 아니다', () => {
      const project = projectWith({}, [apiService]);
      expect(uncoveredChangeWarnings(project, ['apps/api/src/main/resources/templates/index.html'])).toEqual([]);
    });

    it('includes로 선언한 서비스 폴더 밖 경로의 테스트 파일도 그 서비스의 커버리지로 본다(ADR-139, 도그푸딩 마찰 119)', () => {
      const commerceWithMedia: LoadedProject['managed'][number] = [
        'commerce',
        { source: 'managed', template: 'spring-boot', path: 'commerce', port: 8080, preview: 'openapi', includes: ['media'] } as never,
      ];
      const project = projectWith({ tests: [{ ...unit, service: 'web' }] }, [webService, commerceWithMedia]);
      const warnings = uncoveredChangeWarnings(project, ['media/lib/shorts.test.ts']);
      expect(warnings).toEqual([
        {
          stage: 'review',
          name: `${COVERAGE_GAP_PREFIX}: commerce 테스트`,
          ok: true,
          attempts: 1,
          detail: expect.stringContaining("workflow.tests에 'commerce' 서비스를 다루는 항목이 없어"),
        },
      ]);
    });
  });

  it('사용자가 허용해 확인 선언이 바뀐 체크포인트는 그 사실을 본문에 남긴다 (ADR-164)', () => {
    const text = formatCheckedCoverage([
      { stage: 'test', name: 'unit', ok: true, attempts: 1 },
      { stage: 'review', name: 'declared-checks', ok: true, attempts: 1, detail: '사용자가 허용해 바뀐 확인 선언으로 검증했습니다 — 변경: 테스트 unit' },
    ]);
    expect(text).toBe('게이트가 확인함: [test] unit(통과)\n확인 선언 변경: 사용자가 허용해 바뀐 확인 선언으로 검증했습니다 — 변경: 테스트 unit');
    // 읽지 못해 실패한 기록은 본문에 "바뀌었다"로 남기지 않는다
    expect(formatCheckedCoverage([{ stage: 'review', name: 'declared-checks', ok: false, attempts: 1, detail: '다시 읽지 못해…' }])).toBe('');
  });

  describe('formatCheckedCoverage(ADR-135)', () => {
    it('빈 배열·undefined는 빈 문자열', () => {
      expect(formatCheckedCoverage(undefined)).toBe('');
      expect(formatCheckedCoverage([])).toBe('');
    });

    it('실제로 돈 확인과 확인 안 된 항목을 따로 묶어 보여준다', () => {
      const text = formatCheckedCoverage([
        { stage: 'test', name: 'commerce-test', ok: true, attempts: 1 },
        { stage: 'browser_check', name: 'web /', ok: true, attempts: 1 },
        { stage: 'review', name: `${COVERAGE_GAP_PREFIX}: web 화면`, ok: true, attempts: 1, detail: 'web에 /shorts가 바뀌었지만 확인하지 않았습니다' },
      ]);
      expect(text).toContain('게이트가 확인함: [test] commerce-test(통과), [browser_check] web /(통과)');
      expect(text).toContain('확인 안 됨:\n- web에 /shorts가 바뀌었지만 확인하지 않았습니다');
    });
  });

  describe('maxTurnsFor(ADR-131)', () => {
    it('둘 다 없으면 undefined를 돌려줘 실행기 기본값(60)을 쓰게 한다', () => {
      expect(maxTurnsFor(projectWith())).toBeUndefined();
    });

    it('studio.yaml의 workflow.maxTurns를 쓴다', () => {
      expect(maxTurnsFor(projectWith({ maxTurns: 30 }))).toBe(30);
    });

    it('요청 옵션(override)이 studio.yaml보다 우선한다', () => {
      expect(maxTurnsFor(projectWith({ maxTurns: 30 }), 90)).toBe(90);
    });
  });
});

describe('화면 요구를 화면 확인으로 선언하게 하는 안내 (ADR-161 덧붙임, #604)', () => {
  const withServices = (services: Array<[string, { preview: string }]>): LoadedProject => ({ spec: { name: 'shop', services: {} }, managed: services } as unknown as LoadedProject);

  it('화면이 있는 프로젝트의 문맥에는 단언 필드와 "다음 요청부터 확인된다"가 들어 있다', () => {
    const context = workflowContext(withServices([['web', { preview: 'browser' }], ['api', { preview: 'openapi' }]]));
    expect(context).toContain(PAGE_ASSERTION_GUIDE);
    for (const field of ['workflow.pageChecks', 'expectText', 'expectAllText', 'expectInViewport', 'steps', 'viewport']) expect(PAGE_ASSERTION_GUIDE).toContain(field);
    expect(PAGE_ASSERTION_GUIDE).toContain('다음 요청부터');
    expect(PAGE_ASSERTION_GUIDE).toContain('"확인됐다"고 쓰지 마세요');
  });

  it('화면이 없는 프로젝트(API만)의 문맥에는 붙이지 않는다', () => {
    expect(workflowContext(withServices([['api', { preview: 'openapi' }]]))).not.toContain('expectInViewport');
  });

  it('안내의 예시는 실제 스키마가 받아들이는 꼴이다', () => {
    const parsed = WorkflowPageCheckSchema.safeParse({ service: 'web', path: '/cart', mode: 'browser', expectInViewport: ['주문하기'], viewport: 'mobile', steps: [{ click: 'text=주문' }, { fill: { selector: '#qty', text: '2' } }, { waitFor: 'text=완료' }], expectAllText: ['가', '나'], expectText: '글자' });
    expect(parsed.success).toBe(true);
  });

  it('고정 문맥을 크게 늘리지 않는다(700자 이하)', () => {
    expect(PAGE_ASSERTION_GUIDE.length).toBeLessThanOrEqual(700);
  });
});

describe('응답 시간 요구를 부하 확인으로 선언하게 하는 안내 (ADR-163, #605)', () => {
  const withServices = (services: Array<[string, { preview: string }]>): LoadedProject => ({ spec: { name: 'shop', services: {} }, managed: services } as unknown as LoadedProject);

  it('화면이 있든 없든 문맥에 들어가고, 선언하라는 지시와 스크립트·절차 문서로 대신하지 말라는 말이 있다', () => {
    for (const services of [[['api', { preview: 'openapi' }]], [['web', { preview: 'browser' }]]] as Array<Array<[string, { preview: string }]>>) {
      expect(workflowContext(withServices(services))).toContain(LOAD_CHECK_GUIDE);
    }
    expect(LOAD_CHECK_GUIDE).toContain('workflow.loadChecks에 선언하세요');
    expect(LOAD_CHECK_GUIDE).toContain('부하 도구 스크립트나 사람이 돌리는 절차 문서로 대신하지 마세요');
    expect(LOAD_CHECK_GUIDE).toContain('다음 요청부터');
    expect(LOAD_CHECK_GUIDE).toContain('그렇다고 적으세요');
  });

  it('안내의 예시는 실제 스키마가 받아들이는 꼴이다', () => {
    expect(LOAD_CHECK_GUIDE).toContain('- { name: orders-p95, service: api, method: GET, path: /orders, concurrent: 100, requests: 1000, expect: { p95Ms: 200 } }');
    const parsed = WorkflowLoadCheckSchema.safeParse({ name: 'orders-p95', service: 'api', method: 'GET', path: '/orders', concurrent: 100, requests: 1000, expect: { p95Ms: 200 } });
    expect(parsed.success).toBe(true);
  });

  it('고정 문맥을 크게 늘리지 않는다(450자 이하)', () => {
    expect(LOAD_CHECK_GUIDE.length).toBeLessThanOrEqual(450);
  });
});
