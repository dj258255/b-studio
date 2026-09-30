import { describe, expect, it } from 'vitest';
import { discoverJsFile, discoverJunitFile, discoverPytestFile, flattenDiscoveredFile } from './test-discovery';
import { attachResults, buildAddTestPrefill, buildFixTestPrefill, countByStatus, parseJestLikeJson, parseJUnitXml } from './test-results';

const GRADLE_JUNIT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="com.example.OrderServiceTest" tests="3" skipped="1" failures="1" errors="0" time="1.234">
  <testcase name="createOrderReducesStock" classname="com.example.OrderServiceTest" time="0.012"/>
  <testcase name="flakyTest" classname="com.example.OrderServiceTest" time="0.0">
    <skipped/>
  </testcase>
  <testcase name="refundsPayment" classname="com.example.OrderServiceTest$WhenCancelled" time="0.045">
    <failure message="expected &lt;true&gt; but was &lt;false&gt;" type="org.opentest4j.AssertionFailedError">org.opentest4j.AssertionFailedError: expected &lt;true&gt; but was &lt;false&gt;
	at com.example.OrderServiceTest.refundsPayment(OrderServiceTest.java:42)
	at java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)</failure>
  </testcase>
</testsuite>`;

const PYTEST_JUNIT_XML = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
<testsuite name="pytest" errors="0" failures="1" skipped="1" tests="3" time="0.123">
<testcase classname="tests.test_orders" name="test_top_level" time="0.001" />
<testcase classname="tests.test_orders" name="test_skipped" time="0.000">
  <skipped message="broken" />
</testcase>
<testcase classname="tests.test_orders.TestOrders" name="test_creates_order" time="0.002">
  <failure message="assert False">assert False
 +  where False = &lt;function created&gt;()</failure>
</testcase>
</testsuite>
</testsuites>`;

const JEST_JSON = JSON.stringify({
  testResults: [
    {
      name: '/app/src/order.test.ts',
      assertionResults: [
        { ancestorTitles: ['OrderService'], title: '[R2] creates an order', fullName: 'OrderService [R2] creates an order', status: 'passed', duration: 12 },
        { ancestorTitles: ['OrderService'], title: 'flaky test', fullName: 'OrderService flaky test', status: 'skipped', duration: null },
        {
          ancestorTitles: ['OrderService', 'when cancelled'],
          title: 'refunds payment',
          fullName: 'OrderService when cancelled refunds payment',
          status: 'failed',
          duration: 5,
          failureMessages: ['Error: expected 1 to be 2\n    at Object.<anonymous> (/app/src/order.test.ts:10:5)'],
        },
      ],
    },
  ],
});

describe('parseJUnitXml', () => {
  it('Gradle 스타일 보고서에서 통과·건너뜀·실패를 파싱한다', () => {
    const run = parseJUnitXml(GRADLE_JUNIT_XML);
    expect(run.cases).toHaveLength(3);
    expect(run.cases[0]).toEqual({ classOrFile: 'com.example.OrderServiceTest', name: 'createOrderReducesStock', result: { status: 'pass', durationMs: 12 } });
    expect(run.cases[1]!.result.status).toBe('skip');
    expect(run.cases[2]!.result.status).toBe('fail');
    expect(run.cases[2]!.result.failureMessage).toBe('expected <true> but was <false>');
    expect(run.cases[2]!.result.stack?.[0]).toContain('AssertionFailedError');
  });

  it('pytest --junitxml 보고서를 파싱한다(testsuites로 감싸도 된다)', () => {
    const run = parseJUnitXml(PYTEST_JUNIT_XML);
    expect(run.cases.map((c) => [c.classOrFile, c.name, c.result.status])).toEqual([
      ['tests.test_orders', 'test_top_level', 'pass'],
      ['tests.test_orders', 'test_skipped', 'skip'],
      ['tests.test_orders.TestOrders', 'test_creates_order', 'fail'],
    ]);
  });
});

describe('parseJestLikeJson', () => {
  it('Jest/Vitest json 보고서를 파싱한다', () => {
    const run = parseJestLikeJson(JEST_JSON);
    expect(run.cases).toHaveLength(3);
    expect(run.cases[0]!.result.status).toBe('pass');
    expect(run.cases[1]!.result.status).toBe('skip');
    expect(run.cases[2]!.result.status).toBe('fail');
    expect(run.cases[2]!.result.failureMessage).toContain('expected 1 to be 2');
  });

  it('JSON이 깨져도 던지지 않고 빈 결과를 돌려준다', () => {
    expect(parseJestLikeJson('not json')).toEqual({ cases: [] });
  });
});

describe('attachResults', () => {
  it('JUnit 발견 결과에 XML 결과를 파일+이름으로 잇는다', () => {
    const content = `
class OrderServiceTest {
  @Test
  void createOrderReducesStock() {}
  @Test
  void flakyTest() {}
  @Nested
  class WhenCancelled {
    @Test
    void refundsPayment() {}
  }
}
`;
    const discovered = discoverJunitFile('src/test/java/com/example/OrderServiceTest.java', content);
    const rows = flattenDiscoveredFile(discovered).map((row) => ({ ...row }));
    const run = parseJUnitXml(GRADLE_JUNIT_XML);
    const attached = attachResults(rows, run);
    const byName = Object.fromEntries(attached.map((row) => [row.name, row.result?.status]));
    expect(byName.createOrderReducesStock).toBe('pass');
    expect(byName.flakyTest).toBe('skip');
    expect(byName.refundsPayment).toBe('fail');
  });

  it('Vitest 발견 결과에 json 결과를 제목으로 잇는다', () => {
    const content = `
describe('OrderService', () => {
  it('[R2] creates an order', () => {});
  it.skip('flaky test', () => {});
  describe('when cancelled', () => {
    it('refunds payment', () => {});
  });
});
`;
    const discovered = discoverJsFile('src/order.test.ts', content, 'vitest');
    const rows = flattenDiscoveredFile(discovered).map((row) => ({ ...row }));
    const run = parseJestLikeJson(JEST_JSON);
    const attached = attachResults(rows, run);
    const byName = Object.fromEntries(attached.map((row) => [row.name, row.result?.status]));
    expect(byName['[R2] creates an order']).toBe('pass');
    expect(byName['flaky test']).toBe('skip');
    expect(byName['refunds payment']).toBe('fail');
  });

  it('결과가 없는 테스트는 result가 없다(안 돌림으로 본다)', () => {
    const discovered = discoverJsFile('x.test.ts', "it('never ran', () => {});", 'vitest');
    const rows = flattenDiscoveredFile(discovered).map((row) => ({ ...row }));
    const attached = attachResults(rows, { cases: [] });
    expect(attached[0]!.result).toBeUndefined();
  });

  it('pytest 발견 결과에 junitxml 결과를 이름으로 잇는다', () => {
    const content = `
def test_top_level():
    assert True


def test_skipped():
    pass


class TestOrders:
    def test_creates_order(self):
        assert True
`;
    const discovered = discoverPytestFile('tests/test_orders.py', content);
    const rows = flattenDiscoveredFile(discovered).map((row) => ({ ...row }));
    const attached = attachResults(rows, parseJUnitXml(PYTEST_JUNIT_XML));
    const byName = Object.fromEntries(attached.map((row) => [row.name, row.result?.status]));
    expect(byName.test_top_level).toBe('pass');
    expect(byName.test_skipped).toBe('skip');
    expect(byName.test_creates_order).toBe('fail');
  });
});

describe('countByStatus', () => {
  it('상태별 개수를 센다', () => {
    const rows = [
      { result: { status: 'pass' as const } },
      { result: { status: 'pass' as const } },
      { result: { status: 'fail' as const } },
      { result: { status: 'skip' as const } },
      {},
    ];
    expect(countByStatus(rows as never)).toEqual({ pass: 2, fail: 1, skip: 1, notRun: 1 });
  });
});

describe('prefill builders', () => {
  it('buildFixTestPrefill은 실패 메시지·스택·위치를 담는다', () => {
    const text = buildFixTestPrefill({
      displayName: '[R2] creates an order',
      file: 'src/order.test.ts',
      line: 4,
      result: { status: 'fail', failureMessage: 'expected 1 to be 2', stack: ['at foo (order.test.ts:10:5)'] },
    });
    expect(text).toContain('[R2] creates an order');
    expect(text).toContain('src/order.test.ts:4');
    expect(text).toContain('expected 1 to be 2');
    expect(text).toContain('at foo');
  });

  it('buildAddTestPrefill은 요구사항 id를 이름에 넣으라고 안내한다', () => {
    const text = buildAddTestPrefill('R5', '결제 취소 시 환불');
    expect(text).toContain('[R5] 결제 취소 시 환불');
    expect(text).toContain('R5');
  });
});
