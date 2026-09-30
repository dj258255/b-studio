import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('GET /api/health/routes', () => {
  it('중첩 라우트가 살아 있으면 200과 ok:true를 돌려준다', async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
