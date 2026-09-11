import { describe, expect, it } from 'vitest';
import { skipAlreadySeen } from './logs';

describe('skipAlreadySeen', () => {
  it('다시 구독할 때 재시작하지 않은 컨테이너가 다시 보낸 줄만 건너뛴다', () => {
    const seen = [
      { service: 'b-studio-edge', text: '{"edge":"started"}', at: '2026-09-11T01:06:30.000Z' },
      { service: 'db', text: 'database system is ready to accept connections', at: '2026-09-11T01:06:31.120Z' },
      { service: 'web', text: 'GET / 200', at: '2026-09-11T01:07:10.000Z' },
    ];
    const keep = skipAlreadySeen(seen);

    expect(keep(seen[0]!)).toBe(false);
    expect(keep(seen[1]!)).toBe(false);
    // 새 컨테이너의 줄, 같은 내용이라도 시각이 다른 줄은 남긴다
    expect(keep({ service: 'web', text: 'GET / 200', at: '2026-09-11T01:08:02.000Z' })).toBe(true);
    expect(keep({ service: 'web', text: '✓ Ready in 307ms', at: '2026-09-11T01:07:10.000Z' })).toBe(true);
  });
});
