import { describe, expect, it } from 'vitest';
import { experimentalEnabled } from './experimental';

describe('experimentalEnabled', () => {
  it('기본은 꺼짐이다', () => {
    expect(experimentalEnabled({})).toBe(false);
    expect(experimentalEnabled({ B_STUDIO_EXPERIMENTAL: '' })).toBe(false);
    expect(experimentalEnabled({ B_STUDIO_EXPERIMENTAL: '0' })).toBe(false);
    expect(experimentalEnabled({ B_STUDIO_EXPERIMENTAL: 'off' })).toBe(false);
    expect(experimentalEnabled({ B_STUDIO_EXPERIMENTAL: 'yes please' })).toBe(false);
  });

  it('1·true·on으로 켠다(대소문자·앞뒤 공백 무시)', () => {
    for (const value of ['1', 'true', 'on', 'TRUE', ' On ']) expect(experimentalEnabled({ B_STUDIO_EXPERIMENTAL: value })).toBe(true);
  });
});
