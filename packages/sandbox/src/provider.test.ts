import { describe, expect, it } from 'vitest';
import { LocalDockerProvider } from './docker/compose-provider';
import { SandboxError } from './errors';
import { providerFromEnv } from './provider';

describe('providerFromEnv', () => {
  it('기본은 로컬 Docker이고, 컨테이너 런타임을 격리 표시로 쓴다', () => {
    const provider = providerFromEnv({ B_STUDIO_CONTAINER_RUNTIME: 'runsc' });

    expect(provider).toBeInstanceOf(LocalDockerProvider);
    expect(provider.isolation).toBe('runsc');
    expect(providerFromEnv({}).isolation).toBeUndefined();
  });

  it('kubernetes 제공자는 조용히 Docker로 떨어지지 않고 더는 지원하지 않는다고 시작을 거절한다', () => {
    for (const value of ['kubernetes', 'Kubernetes', ' KUBERNETES ']) {
      expect(() => providerFromEnv({ B_STUDIO_SANDBOX_PROVIDER: value })).toThrow(/^더는 지원하지 않습니다/);
    }
  });

  it('잘못된 설정은 샌드박스를 만들기 전에 이유와 함께 거부한다', () => {
    expect(() => providerFromEnv({ B_STUDIO_SANDBOX_PROVIDER: 'nomad' })).toThrow('docker여야 합니다');
    expect(() => providerFromEnv({ B_STUDIO_SANDBOX_PROVIDER: 'nomad' })).toThrow(SandboxError);
  });
});
