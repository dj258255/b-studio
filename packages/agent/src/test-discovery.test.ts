import { describe, expect, it } from 'vitest';
import {
  discoverJsFile,
  discoverJunitFile,
  discoverPytestFile,
  discoverTestsInFile,
  extractRequirementIds,
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
