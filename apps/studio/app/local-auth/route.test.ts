import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('GET /local-auth 교환 페이지 (ADR-173 덧붙임)', () => {
  it('토큰 없이 작은 페이지를 주고, 쿠키를 심지 않는다(토큰은 # 뒤에서 읽어 본문으로 보낸다)', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    const html = await response.text();
    // 주소의 # 뒤에서 토큰을 읽고, 곧바로 주소에서 지운 뒤, 본문으로 교환 API에 보낸다
    expect(html).toContain('window.location.hash');
    expect(html).toContain('replaceState');
    expect(html).toContain('/api/local-auth');
    // 토큰을 쿼리에서 읽는 길은 없다
    expect(html).not.toContain("get('token')");
  });
});
