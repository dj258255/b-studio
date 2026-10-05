import { describe, expect, it } from 'vitest';
import type { SessionMode } from '@/lib/studio-events';
import { buildCapabilities } from './capabilities';

describe('buildCapabilities', () => {
  it('API 모드는 한 명·비교·나눠서 병렬을 모두 쓸 수 있다', () => {
    const caps = buildCapabilities({ mode: 'api', backends: ['api', 'claude-code'], openFolder: false });

    expect(caps).toEqual({
      mode: 'api',
      single: { enabled: true },
      fleet: { enabled: true },
      split: { enabled: true },
      backends: ['api', 'claude-code'],
      openFolder: false,
    });
    // enabled면 이유를 붙이지 않는다(화면이 빈 문구를 그리지 않게)
    expect(caps.fleet.reason).toBeUndefined();
    expect(caps.split.reason).toBeUndefined();
  });

  it('로컬 Claude Code 모드는 계획(나눠서 병렬)도 여러 후보 비교도 된다', () => {
    const caps = buildCapabilities({ mode: 'claude-code', backends: ['claude-code'], openFolder: true });

    expect(caps.single).toEqual({ enabled: true });
    expect(caps.split).toEqual({ enabled: true });
    // 후보마다 backend를 고를 수 있어 구독 CLI 모드에서도 비교한다
    expect(caps.fleet).toEqual({ enabled: true });
    // 폴더 열기는 서버가 계산해 그대로 넘긴다(여기서는 정하지 않는다)
    expect(caps.openFolder).toBe(true);
  });

  it('데모만 여러 후보 비교를 못 하고, 계획 경로가 없는 모드는 나눠서 병렬을 못 한다', () => {
    for (const mode of ['codex', 'commandcode', 'opencode', 'demo'] as const) {
      const caps = buildCapabilities({ mode, backends: [mode], openFolder: false });

      // 한 명에게 시키는 것은 어떤 모드에서도 된다(데모는 준비된 대본)
      expect(caps.single, mode).toEqual({ enabled: true });
      expect(caps.split.enabled, mode).toBe(false);
      // 이유에 지금 모드가 들어가 화면이 그대로 보여 줄 수 있다
      expect(caps.split.reason, mode).toContain(mode);
      expect(caps.backends, mode).toEqual([mode]);
      // 여러 후보 비교는 데모에서만 못 한다(후보의 backend만 허용 목록 안이면 된다)
      expect(caps.fleet.enabled, mode).toBe(mode !== 'demo');
      if (mode === 'demo') expect(caps.fleet.reason).toContain('데모');
    }
  });

  it('홈 화면이 기대는 키 이름을 고정한다', () => {
    const caps = buildCapabilities({ mode: 'api', backends: ['api', 'codex'] as SessionMode[], openFolder: false });

    expect(Object.keys(caps).sort()).toEqual(['backends', 'fleet', 'mode', 'openFolder', 'single', 'split']);
    expect(Object.keys(caps.single).sort()).toEqual(['enabled']);
    expect(caps.backends).toEqual(['api', 'codex']);
  });
});
