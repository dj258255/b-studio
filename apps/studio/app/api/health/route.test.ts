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
    expect(await response.json()).toEqual({ status: 'ok', app: 'b-studio', terminal: true, experimental: true, apiVersion: 1 });
  });

  it('이 컴퓨터 방식(기본값) 세션 터미널은 지원 경로라 실험 기능이 꺼져 있어도 terminal은 true (ADR-200)', async () => {
    vi.stubEnv('B_STUDIO_AUTH', 'none');
    vi.stubEnv('B_STUDIO_EXPERIMENTAL', '');
    vi.stubEnv('B_STUDIO_TERMINAL', '');

    // experimental은 desk가 실험 화면(작업 나누기·여러 AI 비교)을 숨길지 가르는 값이다
    expect(await GET().json()).toEqual({ status: 'ok', app: 'b-studio', terminal: true, experimental: false, apiVersion: 1 });
  });

  it('컨테이너 방식은 실험이라 실험 기능이 꺼져 있으면 terminal은 false', async () => {
    vi.stubEnv('B_STUDIO_AUTH', 'none');
    vi.stubEnv('B_STUDIO_EXPERIMENTAL', '');
    vi.stubEnv('B_STUDIO_TERMINAL', 'container');

    expect(await GET().json()).toEqual({ status: 'ok', app: 'b-studio', terminal: false, experimental: false, apiVersion: 1 });
    vi.stubEnv('B_STUDIO_EXPERIMENTAL', '1');
    expect((await GET().json()).terminal).toBe(true);
  });

  it('여러 사람이 쓰는 서버(인증 켬)면 terminal은 false', async () => {
    vi.stubEnv('B_STUDIO_AUTH', 'proxy');
    vi.stubEnv('B_STUDIO_EXPERIMENTAL', '1');

    expect((await GET().json()).terminal).toBe(false);
    vi.stubEnv('B_STUDIO_EXPERIMENTAL', '');
    vi.stubEnv('B_STUDIO_TERMINAL', '');
    expect((await GET().json()).terminal).toBe(false);
  });
});
