import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/health', () => {
  it('b-studio 표지를 실어 다른 프로그램과 가르고, 세션 터미널을 쓸 수 있는지 알린다', async () => {
    vi.stubEnv('B_STUDIO_AUTH', 'none');
    vi.stubEnv('B_STUDIO_EXPERIMENTAL', '1');

    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', app: 'b-studio', terminal: true });
  });

  it('실험 기능이 꺼져 있으면 terminal은 false', async () => {
    vi.stubEnv('B_STUDIO_AUTH', 'none');
    vi.stubEnv('B_STUDIO_EXPERIMENTAL', '');

    expect(await GET().json()).toEqual({ status: 'ok', app: 'b-studio', terminal: false });
  });

  it('여러 사람이 쓰는 서버(인증 켬)면 terminal은 false', async () => {
    vi.stubEnv('B_STUDIO_AUTH', 'proxy');
    vi.stubEnv('B_STUDIO_EXPERIMENTAL', '1');

    expect((await GET().json()).terminal).toBe(false);
  });
});
