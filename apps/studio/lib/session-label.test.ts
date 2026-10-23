import { describe, expect, it } from 'vitest';
import { cleanSessionLabel, SESSION_LABEL_MAX, sessionDisplayName, sessionLabelProblem } from './session-label';

describe('세션 이름(#875)', () => {
  it('제어 글자를 빼고 앞뒤 빈칸을 뗀다', () => {
    expect(cleanSessionLabel('  결제\n화면\x1b[31m  ')).toBe('결제화면[31m');
    expect(cleanSessionLabel('   ')).toBe('');
  });

  it('60자를 넘으면 고칠 것을 알리고, 그 안이면 없다. 글자 수는 이모지도 한 글자로 센다', () => {
    expect(SESSION_LABEL_MAX).toBe(60);
    expect(sessionLabelProblem('가'.repeat(60))).toBeUndefined();
    expect(sessionLabelProblem('😀'.repeat(60))).toBeUndefined();
    expect(sessionLabelProblem('가'.repeat(61))).toBe('세션 이름은 60자까지입니다');
  });

  it('이름이 있으면 이름, 없거나 빈칸이면 프로젝트 이름을 보인다', () => {
    expect(sessionDisplayName({ projectName: 'shop', label: '결제 화면' })).toBe('결제 화면');
    expect(sessionDisplayName({ projectName: 'shop', label: '  ' })).toBe('shop');
    expect(sessionDisplayName({ projectName: 'shop' })).toBe('shop');
  });
});
