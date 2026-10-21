import { describe, expect, it } from 'vitest';
import { Redactor } from '../secrets';
import { dockerFailureDetail, keepsFailedReleaseRunning, restoreRouteAfterFailedCheck, RouteRestoreError } from './deploy';

describe('dockerFailureDetail (#751)', () => {
  it('가린 뒤에 뒤쪽 4,000자를 남겨 잘린 경계에 걸친 시크릿의 뒷부분도 남기지 않는다', () => {
    const secret = 'sk_test_ABCDEFGHIJKLMNOP';
    const redactor = new Redactor({ REGISTRY_TOKEN: secret });
    // 뒤쪽 4,000자가 시크릿의 마지막 10글자부터 시작하게 한다
    const stderr = `login failed: ${secret}${'y'.repeat(4_000 - 10)}`;

    const detail = dockerFailureDetail(stderr, (text) => redactor.redact(text));
    expect(detail.length).toBeLessThanOrEqual(4_000);
    expect(detail).not.toContain(secret.slice(-6));
  });
});

describe('프록시 확인 실패 뒤 되돌리기(#811)', () => {
  it('되돌리기는 한 번 실패해도 다시 시도하고, 되면 성공으로 알린다', async () => {
    let calls = 0;
    const logs: string[] = [];
    await restoreRouteAfterFailedCheck(async () => {
      calls += 1;
      if (calls === 1) throw new Error('caddy reload 실패');
    }, { back: 'r1', failed: 'r2', log: (text) => logs.push(text), delayMs: 0 });
    expect(calls).toBe(2);
    expect(logs).toEqual(['프록시를 거친 확인에 실패해 운영 주소를 릴리스 r1로 되돌렸습니다']);
  });

  it('끝내 되돌리지 못하면 "되돌렸습니다"를 남기지 않고, 운영 주소가 실패한 릴리스를 가리킨다는 오류를 낸다', async () => {
    const logs: string[] = [];
    const error = await restoreRouteAfterFailedCheck(async () => {
      throw new Error('proxy down');
    }, { back: 'r1', failed: 'r2', log: (text) => logs.push(text), delayMs: 0 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RouteRestoreError);
    expect((error as RouteRestoreError).routedTo).toBe('r2');
    expect((error as Error).message).toContain('되돌리지 못했습니다');
    expect(logs.some((text) => text.includes('되돌렸습니다'))).toBe(false);
    expect(logs.some((text) => text.includes('되돌리지 못했습니다'))).toBe(true);
  });

  it('되돌리지 못한 실패에서는 운영 주소가 가리키는 새 릴리스를 내리지 않는다', () => {
    expect(keepsFailedReleaseRunning(new RouteRestoreError('x', 'r2'))).toBe(true);
    expect(keepsFailedReleaseRunning(new Error('빌드 실패'))).toBe(false);
  });
});
