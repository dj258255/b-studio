import { describe, expect, it } from 'vitest';
import {
  discoverJsFile,
  discoverJunitFile,
  discoverPytestFile,
  discoverTestsInFile,
  extractRequirementIds,
  extractRequirementIdsWithSuites,
  flattenDiscoveredFile,
  isTestFilePath,
} from './test-discovery';

describe('extractRequirementIds', () => {
  it('찾는다: R1, [R12] 같은 독립 토큰', () => {
    expect(extractRequirementIds('[R3] 로그인 검증')).toEqual(['R3']);
    expect(extractRequirementIds('R1과 R2를 함께 확인한다 R1')).toEqual(['R1', 'R2']);
    expect(extractRequirementIds('평범한 테스트 이름')).toEqual([]);
  });
});

describe('discoverJunitFile', () => {
  it('클래스·@Test 메서드·@DisplayName·@Disabled를 찾는다', () => {
    const content = `
package com.example;

import org.junit.jupiter.api.*;

class OrderServiceTest {
  @Test
  @DisplayName("[R1] 주문을 만들면 재고가 줄어든다")
  void createOrderReducesStock() {
    assertTrue(true);
  }

  @Test
  @Disabled("나중에 고침")
  void flakyTest() {
  }

  @Nested
  @DisplayName("결제 취소")
  class WhenCancelled {
    @Test
    void refundsPayment() {
    }
  }
}
`;
    const file = discoverJunitFile('src/test/java/com/example/OrderServiceTest.java', content);
    expect(file.framework).toBe('junit');
    expect(file.suites).toHaveLength(1);
    const root = file.suites[0]!;
    expect(root.name).toBe('OrderServiceTest');
    expect(root.tests.map((test) => test.name)).toEqual(['createOrderReducesStock', 'flakyTest']);
    expect(root.tests[0]!.displayName).toBe('[R1] 주문을 만들면 재고가 줄어든다');
    expect(root.tests[0]!.requirementIds).toEqual(['R1']);
    expect(root.tests[1]!.skipped).toBe(true);
    expect(root.suites).toHaveLength(1);
    expect(root.suites[0]!.name).toBe('WhenCancelled');
    expect(root.suites[0]!.displayName).toBe('결제 취소');
    expect(root.suites[0]!.tests.map((test) => test.name)).toEqual(['refundsPayment']);
  });

  it('@ParameterizedTest·@RepeatedTest도 테스트로 본다', () => {
    const content = `
class MathTest {
  @ParameterizedTest
  void addsNumbers(int a, int b) {
  }

  @RepeatedTest(3)
  void repeated() {
  }
}
`;
    const file = discoverJunitFile('MathTest.java', content);
    expect(file.suites[0]!.tests.map((test) => test.name)).toEqual(['addsNumbers', 'repeated']);
  });

  it('Kotlin fun 테스트 메서드를 찾는다', () => {
    const content = `
class GreetingTest {
    @Test
    fun returnsHello() {
        assertEquals("hello", greet())
    }
}
`;
    const file = discoverJunitFile('GreetingTest.kt', content);
    expect(file.suites[0]!.tests.map((test) => test.name)).toEqual(['returnsHello']);
  });

  it('@DisplayName 문자열을 이어 붙이거나 여러 줄에 걸쳐 써도 표시 이름 전체를 읽는다', () => {
    const content = `
class SchemaTest {
    @Test
    @DisplayName("R20.2: 새 게시글 id는 시드 id와 충돌하지 않는다 "
            + "(시퀀스가 보정되지 않으면 {PK} 위반으로 500이 난다)")
    void newPostId() throws Exception {
        assertThat(1).isEqualTo(1);
    }

    @Test
    @DisplayName("R4: 같은 " + "줄에서 이어 붙인다")
    void sameLine() {
    }

    @Test
    void afterwards() {
    }
}
`;
    const tests = discoverJunitFile('SchemaTest.java', content).suites[0]!.tests;
    expect(tests.map((test) => [test.name, test.displayName, test.requirementIds])).toEqual([
      ['newPostId', 'R20.2: 새 게시글 id는 시드 id와 충돌하지 않는다 (시퀀스가 보정되지 않으면 {PK} 위반으로 500이 난다)', ['R20.2']],
      ['sameLine', 'R4: 같은 줄에서 이어 붙인다', ['R4']],
      ['afterwards', 'afterwards', []],
    ]);
  });
});

describe('discoverJunitFile — 실행 환경 조건부 표시(다그푸딩 마찰 152)', () => {
  it('클래스에 @Tag("integration")·@Testcontainers가 있으면 안의 모든 테스트가 물려받는다', () => {
    const content = `
@Tag("integration")
@Testcontainers
class LiveOrderConcurrencyTest {
  @Test
  @DisplayName("R12: 방송 특가 한정 수량 초과 판매 방지")
  void doesNotOversell() {
  }

  @Test
  void anotherCase() {
  }
}
`;
    const file = discoverJunitFile('LiveOrderConcurrencyTest.java', content);
    const root = file.suites[0]!;
    expect(root.envConditionalReasons).toEqual(['@Tag("integration")', '@Testcontainers']);
    const rows = flattenDiscoveredFile(file);
    expect(rows[0]!.envConditionalReasons).toEqual(['@Tag("integration")', '@Testcontainers']);
    expect(rows[1]!.envConditionalReasons).toEqual(['@Tag("integration")', '@Testcontainers']);
  });

  it('메서드에 직접 건 @Tag는 그 메서드에만 붙고, 클래스 표시와 합쳐진다', () => {
    const content = `
@Tag("integration")
class OrderTest {
  @Test
  @Tag("slow")
  void slowCase() {
  }

  @Test
  void fastCase() {
  }
}
`;
    const rows = flattenDiscoveredFile(discoverJunitFile('OrderTest.java', content));
    expect(rows.find((row) => row.name === 'slowCase')!.envConditionalReasons).toEqual(['@Tag("integration")', '@Tag("slow")']);
    expect(rows.find((row) => row.name === 'fastCase')!.envConditionalReasons).toEqual(['@Tag("integration")']);
  });

  it('@EnabledIfEnvironmentVariable·@DisabledIfSystemProperty 같은 조건부 애노테이션도 잡지만, bare @Disabled는 잡지 않는다', () => {
    const content = `
class ConditionalTest {
  @Test
  @EnabledIfEnvironmentVariable(named = "CI", matches = "true")
  void onlyOnCi() {
  }

  @Test
  @Disabled("나중에 고침")
  void disabledCase() {
  }
}
`;
    const rows = flattenDiscoveredFile(discoverJunitFile('ConditionalTest.java', content));
    expect(rows.find((row) => row.name === 'onlyOnCi')!.envConditionalReasons).toEqual(['@EnabledIfEnvironmentVariable']);
    expect(rows.find((row) => row.name === 'disabledCase')!.envConditionalReasons).toBeUndefined();
  });

  it('아무 표시도 없는 평범한 테스트는 envConditionalReasons가 없다', () => {
    const content = `
class Plain {
  @Test
  void ok() {
  }
}
`;
    const rows = flattenDiscoveredFile(discoverJunitFile('Plain.java', content));
    expect(rows[0]!.envConditionalReasons).toBeUndefined();
  });
});

describe('discoverPytestFile — 실행 환경 조건부 표시(다그푸딩 마찰 152)', () => {
  it('skip·skipif·parametrize가 아닌 커스텀 마커(integration·docker 등)만 잡는다', () => {
    const content = `
import pytest


@pytest.mark.integration
@pytest.mark.docker
def test_full_checkout_flow():
    assert True


@pytest.mark.skip(reason="broken")
def test_skipped():
    pass


@pytest.mark.parametrize("qty", [1, 2])
def test_parametrized(qty):
    assert qty > 0
`;
    const file = discoverPytestFile('test_checkout.py', content);
    expect(file.tests[0]!.envConditionalReasons).toEqual(['@pytest.mark.integration', '@pytest.mark.docker']);
    expect(file.tests[1]!.envConditionalReasons).toBeUndefined();
    expect(file.tests[2]!.envConditionalReasons).toBeUndefined();
  });
});

describe('discoverJsFile', () => {
  it('describe/it 중첩과 skip/only/todo를 찾는다', () => {
    const content = `
import { describe, it, expect } from 'vitest';

describe('OrderService', () => {
  it('[R2] creates an order', () => {
    expect(true).toBe(true);
  });

  it.skip('flaky test', () => {});

  describe('when cancelled', () => {
    it('refunds payment', () => {});
  });
});

test('standalone test', () => {});
`;
    const file = discoverJsFile('src/order.test.ts', content);
    expect(file.framework).toBe('vitest');
    expect(file.suites).toHaveLength(1);
    const root = file.suites[0]!;
    expect(root.name).toBe('OrderService');
    expect(root.tests.map((test) => test.name)).toEqual(['[R2] creates an order', 'flaky test']);
    expect(root.tests[0]!.requirementIds).toEqual(['R2']);
    expect(root.tests[1]!.skipped).toBe(true);
    expect(root.suites[0]!.name).toBe('when cancelled');
    expect(root.suites[0]!.tests.map((test) => test.name)).toEqual(['refunds payment']);
    expect(file.tests.map((test) => test.name)).toEqual(['standalone test']);
  });

  it('Playwright의 test.describe를 찾고 playwright로 분류한다', () => {
    const content = `
import { test, expect } from '@playwright/test';

test.describe('login flow', () => {
  test('shows error on bad password', async ({ page }) => {
    await page.goto('/login');
  });
});
`;
    const file = discoverJsFile('e2e/login.spec.ts', content);
    expect(file.framework).toBe('playwright');
    expect(file.suites[0]!.name).toBe('login flow');
    expect(file.suites[0]!.tests.map((test) => test.name)).toEqual(['shows error on bad password']);
  });
});

describe('discoverPytestFile', () => {
  it('모듈 함수와 class Test* 안의 메서드를 찾는다', () => {
    const content = `
import pytest


def test_top_level():
    assert True


@pytest.mark.skip(reason="broken")
def test_skipped():
    pass


class TestOrders:
    def test_creates_order(self):
        assert True

    @pytest.mark.parametrize("qty", [1, 2, 3])
    def test_parametrized(self, qty):
        assert qty > 0


def test_after_class():
    assert True
`;
    const file = discoverPytestFile('tests/test_orders.py', content);
    expect(file.tests.map((test) => test.name)).toEqual(['test_top_level', 'test_skipped', 'test_after_class']);
    expect(file.tests[1]!.skipped).toBe(true);
    expect(file.suites).toHaveLength(1);
    expect(file.suites[0]!.name).toBe('TestOrders');
    expect(file.suites[0]!.tests.map((test) => test.name)).toEqual(['test_creates_order', 'test_parametrized']);
    expect(file.suites[0]!.tests[1]!.displayName).toContain('매개변수화됨');
  });
});

describe('isTestFilePath / discoverTestsInFile', () => {
  it('확장자·이름 관례로 프레임워크를 고른다', () => {
    expect(isTestFilePath('FooTest.java')).toBe(true);
    expect(isTestFilePath('foo.test.tsx')).toBe(true);
    expect(isTestFilePath('test_foo.py')).toBe(true);
    expect(isTestFilePath('foo_test.py')).toBe(true);
    expect(isTestFilePath('foo.ts')).toBe(false);

    expect(discoverTestsInFile('foo.ts', 'const x = 1;')).toBeUndefined();
    expect(discoverTestsInFile('FooTest.java', 'class FooTest { @Test void bar() {} }')?.framework).toBe('junit');
  });
});

describe('flattenDiscoveredFile', () => {
  it('중첩 스위트를 펴서 suitePath와 함께 목록을 만든다', () => {
    const content = `
describe('A', () => {
  it('a1', () => {});
  describe('B', () => {
    it('b1', () => {});
  });
});
it('top', () => {});
`;
    const file = discoverJsFile('x.test.ts', content, 'vitest');
    const rows = flattenDiscoveredFile(file);
    expect(rows.map((row) => [row.suitePath, row.name])).toEqual([
      [[], 'top'],
      [['A'], 'a1'],
      [['A', 'B'], 'b1'],
    ]);
  });
});

describe('묶음(describe) 제목에 단 id는 그 안의 모든 테스트의 id다', () => {
  const content = `
import { describe, it } from 'vitest';
describe('R11.2: 결제 승인 실패는 재시도할 수 있다', () => {
  it('사유를 담는다', () => {});
  it('R11.3 기본 문구도 쓴다', () => {});
  describe('중첩 묶음', () => {
    it('다시 실패해도 재시도할 수 있다', () => {});
  });
});
describe('R12 방송 중 주문', () => {
  describe('R12.1: 매진', () => {
    it('R12.1 매진이면 거절한다', () => {});
  });
});
it('묶음 밖의 테스트', () => {});
`;
  const rows = flattenDiscoveredFile(discoverJsFile('web/src/live.test.ts', content, 'vitest'));
  const idsOf = (name: string) => rows.find((row) => row.name === name)?.requirementIds;

  it('묶음 제목의 id가 안의 테스트 행에 붙는다', () => {
    expect(idsOf('사유를 담는다')).toEqual(['R11.2']);
  });

  it('테스트 자신의 id와 합집합이고 자신의 id가 앞에 온다', () => {
    expect(idsOf('R11.3 기본 문구도 쓴다')).toEqual(['R11.3', 'R11.2']);
  });

  it('중첩 묶음은 바깥 묶음의 id까지 물려받는다', () => {
    expect(idsOf('다시 실패해도 재시도할 수 있다')).toEqual(['R11.2']);
    expect(idsOf('R12.1 매진이면 거절한다')).toEqual(['R12.1', 'R12']);
  });

  it('묶음과 제목에서 같은 id를 받아도 한 번만 센다', () => {
    expect(idsOf('R12.1 매진이면 거절한다')!.filter((id) => id === 'R12.1')).toHaveLength(1);
  });

  it('묶음 밖의 테스트는 영향을 받지 않는다', () => {
    expect(idsOf('묶음 밖의 테스트')).toEqual([]);
  });

  it('JUnit 클래스 수준 @DisplayName의 id도 안의 테스트가 받는다', () => {
    const java = `
@DisplayName("R13 라이브 지연")
class LatencyTest {
  @Test
  @DisplayName("R13.1: 3초 이내다")
  void withinThreeSeconds() {}
  @Test
  void plain() {}
}
`;
    const javaRows = flattenDiscoveredFile(discoverJunitFile('LatencyTest.java', java));
    expect(javaRows.find((row) => row.name === 'plain')?.requirementIds).toEqual(['R13']);
    expect(javaRows.find((row) => row.name === 'withinThreeSeconds')?.requirementIds).toEqual(['R13.1', 'R13']);
  });

  it('extractRequirementIdsWithSuites는 묶음 경로가 없으면 제목만 본다', () => {
    expect(extractRequirementIdsWithSuites(undefined, 'R1 확인')).toEqual(['R1']);
    expect(extractRequirementIdsWithSuites([], '평범한 이름')).toEqual([]);
    expect(extractRequirementIdsWithSuites(['R2.1: 묶음', 'R2 바깥'], 'R2.1 제목')).toEqual(['R2.1', 'R2']);
  });
});
