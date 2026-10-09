/**
 * 게이트 보고서 수거(sessions.ts collectGateTestReports)가 어느 서비스의 보고서를 새 체크포인트의 근거로 찍어도 되는지 가린다.
 * 디스크에 보고서가 있다는 것만으로는 이번 게이트의 것이라고 말할 수 없다(에이전트가 중간에 돌린 부분 테스트, 이전 실행의 잔재).
 * 그래서 "이번 게이트가 그 서비스의 test 항목을 전부 돌려 통과시켰다"는 체크 기록이 있는 서비스만 고른다.
 * 순수 함수라 세션 없이 테스트한다.
 */

export interface DeclaredGateTest {
  name: string;
  service: string;
}

export interface GateCheckLike {
  stage: string;
  name: string;
  ok: boolean;
}

/**
 * workflow.tests에 선언된 항목 중, 이번 게이트의 test 체크가 모두 통과한 서비스의 집합.
 * - test 항목이 여럿인 서비스는 전부 통과해야 한다(하나라도 실패했거나 체크가 없으면 제외 — 일부만 본 보고서를 근거로 삼지 않는다).
 * - 같은 이름의 체크가 둘 이상이면 모두 통과해야 한다.
 * - 선언에 없는 이름이나 test가 아닌 단계의 체크는 세지 않는다.
 */
export function servicesWithPassedGateTests(tests: readonly DeclaredGateTest[], checks: readonly GateCheckLike[]): Set<string> {
  const passed = new Set<string>();
  const services = new Set(tests.map((test) => test.service));
  for (const service of services) {
    const declared = tests.filter((test) => test.service === service);
    const allPassed = declared.every((test) => {
      const matching = checks.filter((candidate) => candidate.stage === 'test' && candidate.name === test.name);
      return matching.length > 0 && matching.every((candidate) => candidate.ok);
    });
    if (allPassed) passed.add(service);
  }
  return passed;
}
