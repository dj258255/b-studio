import { describe, expect, it } from 'vitest';
import { Redactor } from '../secrets';
import { dockerFailureDetail } from './deploy';

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
