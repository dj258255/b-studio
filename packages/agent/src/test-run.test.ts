import { describe, expect, it } from 'vitest';
import { buildTestRunPlan, detectRunner, JEST_LIKE_REPORT_PATH, PYTEST_REPORT_PATH, splitCollectedReports } from './test-run';

describe('buildTestRunPlan', () => {
  it('gradle: 전체 실행', () => {
    const plan = buildTestRunPlan('gradle');
    expect(plan.command).toEqual(['./gradlew', 'test', '--no-daemon', '--console=plain']);
    expect(plan.format).toBe('junit-xml');
    expect(plan.collect[0]).toBe('sh');
  });

  it('gradle: 클래스 하나로 좁히기', () => {
    const plan = buildTestRunPlan('gradle', { className: 'com.example.OrderServiceTest' });
    expect(plan.command).toEqual(['./gradlew', 'test', '--no-daemon', '--console=plain', '--tests', 'com.example.OrderServiceTest']);
  });

  it('gradle: 테스트 하나로 좁히기(클래스+메서드)', () => {
    const plan = buildTestRunPlan('gradle', { className: 'com.example.OrderServiceTest', testName: 'createOrderReducesStock' });
    expect(plan.command).toEqual(['./gradlew', 'test', '--no-daemon', '--console=plain', '--tests', 'com.example.OrderServiceTest.createOrderReducesStock']);
  });

  it('maven: 클래스+메서드로 좁히기', () => {
    const plan = buildTestRunPlan('maven', { className: 'OrderServiceTest', testName: 'createOrderReducesStock' });
    expect(plan.command).toEqual(['mvn', '-q', 'test', '-Dtest=OrderServiceTest#createOrderReducesStock']);
  });

  it('vitest: 파일+테스트 이름으로 좁히기', () => {
    const plan = buildTestRunPlan('vitest', { file: 'src/order.test.ts', testName: 'creates an order' });
    expect(plan.command).toEqual(['npx', 'vitest', 'run', '--reporter=json', `--outputFile=${JEST_LIKE_REPORT_PATH}`, 'src/order.test.ts', '-t', 'creates an order']);
    expect(plan.collect).toEqual(['cat', JEST_LIKE_REPORT_PATH]);
    expect(plan.format).toBe('jest-json');
  });

  it('jest: 파일만으로 좁히기', () => {
    const plan = buildTestRunPlan('jest', { file: 'src/order.test.ts' });
    expect(plan.command).toEqual(['npx', 'jest', '--json', `--outputFile=${JEST_LIKE_REPORT_PATH}`, 'src/order.test.ts']);
  });

  it('pytest: 노드 id로 좁히기(파일::클래스::테스트)', () => {
    const plan = buildTestRunPlan('pytest', { file: 'tests/test_orders.py', className: 'TestOrders', testName: 'test_creates_order' });
    expect(plan.command).toEqual(['pytest', `--junitxml=${PYTEST_REPORT_PATH}`, 'tests/test_orders.py::TestOrders::test_creates_order']);
  });

  it('pytest: 파일만으로 좁히기', () => {
    const plan = buildTestRunPlan('pytest', { file: 'tests/test_orders.py' });
    expect(plan.command).toEqual(['pytest', `--junitxml=${PYTEST_REPORT_PATH}`, 'tests/test_orders.py']);
  });

  it('pytest: 전체 실행에는 파일 인자를 붙이지 않는다', () => {
    const plan = buildTestRunPlan('pytest');
    expect(plan.command).toEqual(['pytest', `--junitxml=${PYTEST_REPORT_PATH}`]);
  });
});

describe('splitCollectedReports', () => {
  it('경계 표지가 없으면 단일 보고서로 본다(cat 결과)', () => {
    const parts = splitCollectedReports('{"testResults":[]}');
    expect(parts).toEqual([{ file: 'report', content: '{"testResults":[]}' }]);
  });

  it('빈 출력은 빈 배열', () => {
    expect(splitCollectedReports('')).toEqual([]);
    expect(splitCollectedReports('   \n')).toEqual([]);
  });

  it('경계 표지로 나눈 여러 보고서 파일을 나눈다(find+cat 결과)', () => {
    const stdout = [
      '@@@b-studio-test-report@@@build/test-results/test/OrderServiceTest.xml',
      '<testsuite>A</testsuite>',
      '',
      '@@@b-studio-test-report@@@build/test-results/test/GreetingTest.xml',
      '<testsuite>B</testsuite>',
      '',
    ].join('\n');
    const parts = splitCollectedReports(stdout);
    expect(parts).toEqual([
      { file: 'build/test-results/test/OrderServiceTest.xml', content: '<testsuite>A</testsuite>' },
      { file: 'build/test-results/test/GreetingTest.xml', content: '<testsuite>B</testsuite>' },
    ]);
  });
});

describe('detectRunner', () => {
  it('spring-boot 템플릿은 gradle(기본) 또는 maven(pom.xml이 있으면)', () => {
    expect(detectRunner({ template: 'spring-boot' })).toBe('gradle');
    expect(detectRunner({ template: 'spring-boot', hasPomXml: true })).toBe('maven');
  });

  it('fastapi 템플릿은 pytest', () => {
    expect(detectRunner({ template: 'fastapi' })).toBe('pytest');
  });

  it('nextjs/vite 템플릿은 package.json의 devDependencies로 vitest/jest를 가른다', () => {
    expect(detectRunner({ template: 'nextjs', packageJson: { devDependencies: { vitest: '^2.0.0' } } })).toBe('vitest');
    expect(detectRunner({ template: 'vite', packageJson: { devDependencies: { jest: '^29.0.0' } } })).toBe('jest');
  });

  it('devDependencies가 없으면 test 스크립트 글자로 가른다', () => {
    expect(detectRunner({ template: 'nextjs', packageJson: { scripts: { test: 'vitest run' } } })).toBe('vitest');
    expect(detectRunner({ template: 'nextjs', packageJson: { scripts: { test: 'jest --ci' } } })).toBe('jest');
  });

  it('아무 단서도 없으면 undefined', () => {
    expect(detectRunner({ template: 'nextjs' })).toBeUndefined();
    expect(detectRunner({ template: 'unknown-template' })).toBeUndefined();
  });
});

describe('buildTestRunPlan — 래퍼', () => {
  it('래퍼가 없으면 이미지의 gradle·mvn을 쓴다', () => {
    expect(buildTestRunPlan('gradle', { className: 'FooTest' }, { wrapper: false }).command.slice(0, 2)).toEqual(['gradle', 'test']);
    expect(buildTestRunPlan('gradle', { className: 'FooTest' }).command[0]).toBe('./gradlew');
    expect(buildTestRunPlan('maven', undefined, { wrapper: false }).command[0]).toBe('mvn');
    expect(buildTestRunPlan('maven', undefined, { wrapper: true }).command[0]).toBe('./mvnw');
  });
});

describe('buildTestRunPlan — includes 서브프로젝트 보고서(도그푸딩 마찰 135)', () => {
  it('gradle: extraReportRoots가 있으면 그 경로의 build/test-results/test도 함께 모은다(경로는 작은따옴표로 감싼다)', () => {
    const plan = buildTestRunPlan('gradle', undefined, { extraReportRoots: ['/workspace/media'] });
    const script = plan.collect[2] as string;
    expect(script).toContain('for f in build/test-results/test/*.xml');
    expect(script).toContain("for f in '/workspace/media'/build/test-results/test/*.xml");
  });

  it('maven: extraReportRoots가 있으면 그 경로의 target/surefire-reports도 함께 모은다(경로는 작은따옴표로 감싼다)', () => {
    const plan = buildTestRunPlan('maven', undefined, { extraReportRoots: ['/workspace/media'] });
    const script = plan.collect[2] as string;
    expect(script).toContain('for f in target/surefire-reports/*.xml');
    expect(script).toContain("for f in '/workspace/media'/target/surefire-reports/*.xml");
  });

  it('extraReportRoots를 주지 않으면 전과 같은 단일 glob만 모은다', () => {
    const plan = buildTestRunPlan('gradle');
    const script = plan.collect[2] as string;
    expect(script).not.toContain('workspace');
  });

  it('vitest·jest·pytest는 extraReportRoots를 받아도 무시한다(단일 보고서 파일 경로라 서브프로젝트 개념이 없다)', () => {
    const plan = buildTestRunPlan('vitest', undefined, { extraReportRoots: ['/workspace/media'] });
    expect(plan.collect).toEqual(['cat', JEST_LIKE_REPORT_PATH]);
  });

  it('보안: 셸 메타문자가 섞인 extraReportRoots는 조용히 버린다(스키마를 우회해도 임의 명령을 못 심는다)', () => {
    const dangerous = [
      '/workspace/media; rm -rf /',
      '/workspace/media`whoami`',
      '/workspace/media$(whoami)',
      '/workspace/media && echo pwned',
      "/workspace/media' ; echo pwned ; '",
      '/workspace/media|cat /etc/passwd',
      '/workspace/media media2', // 공백
    ];
    const plan = buildTestRunPlan('gradle', undefined, { extraReportRoots: dangerous });
    const script = plan.collect[2] as string;
    // 안전한 기본 glob 하나만 남고, 위험한 값은 전부 조용히 빠졌다
    expect(script).toBe(`for f in build/test-results/test/*.xml; do [ -f "$f" ] && { echo '@@@b-studio-test-report@@@'"$f"; cat "$f"; echo; }; done`);
    for (const value of dangerous) expect(script).not.toContain(value);
  });

  it('보안: 안전한 영문·숫자·.·_·-·/ 경로는 작은따옴표로 감싸져 그대로 쓰인다', () => {
    const plan = buildTestRunPlan('gradle', undefined, { extraReportRoots: ['/workspace/media-service_2.0'] });
    const script = plan.collect[2] as string;
    expect(script).toContain("'/workspace/media-service_2.0'/build/test-results/test/*.xml");
  });
});
