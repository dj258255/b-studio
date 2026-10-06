import { describe, expect, it } from 'vitest';
import { StudioError } from './errors';
import { requireSameOrigin } from './my-env';

describe('requireSameOrigin', () => {
  it('Origin이 없으면(curl 등) 통과시킨다', () => {
    expect(() => requireSameOrigin(new Headers({ host: 'localhost:3000' }))).not.toThrow();
  });

  it('Origin이 호스트와 같으면 통과시킨다', () => {
    expect(() => requireSameOrigin(new Headers({ host: 'localhost:3000', origin: 'http://localhost:3000' }))).not.toThrow();
  });

  it('다른 Origin이면 403으로 거부한다', () => {
    try {
      requireSameOrigin(new Headers({ host: 'localhost:3000', origin: 'https://evil.example' }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(StudioError);
      expect((error as StudioError).status).toBe(403);
    }
  });
});
