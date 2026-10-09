import { describe, expect, it } from 'vitest';
import { servicesWithPassedGateTests } from './gate-test-evidence';

const tests = [
  { name: 'api-test', service: 'api' },
  { name: 'web-unit', service: 'web' },
  { name: 'web-smoke', service: 'web' },
];
const check = (name: string, ok: boolean, stage = 'test') => ({ stage, name, ok });

describe('servicesWithPassedGateTests', () => {
  it('test 체크가 하나도 없으면 빈 집합이다', () => {
    expect([...servicesWithPassedGateTests(tests, [])]).toEqual([]);
    expect([...servicesWithPassedGateTests(tests, [check('api-test', true, 'browser_check')])]).toEqual([]);
  });

  it('통과한 test 체크의 서비스만 담는다', () => {
    expect([...servicesWithPassedGateTests(tests, [check('api-test', true), check('web-unit', false)])]).toEqual(['api']);
  });

  it('한 서비스의 test 항목이 여럿이면 전부 통과해야 담는다', () => {
    expect([...servicesWithPassedGateTests(tests, [check('web-unit', true), check('web-smoke', false)])]).toEqual([]);
    expect([...servicesWithPassedGateTests(tests, [check('web-unit', true)])]).toEqual([]);
    expect([...servicesWithPassedGateTests(tests, [check('web-unit', true), check('web-smoke', true)])]).toEqual(['web']);
  });

  it('선언한 test와 이름이 다른 체크나 다른 단계의 같은 이름은 세지 않는다', () => {
    expect([...servicesWithPassedGateTests(tests, [check('api-test', true, 'review'), check('other', true)])]).toEqual([]);
  });

  it('같은 이름의 체크가 둘 이상이고 하나라도 실패했으면 담지 않는다', () => {
    expect([...servicesWithPassedGateTests(tests, [check('api-test', true), check('api-test', false)])]).toEqual([]);
  });
});
