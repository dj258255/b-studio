import { describe, expect, it } from 'vitest';
import { LocalDockerProvider } from './docker/compose-provider';
import { SandboxError } from './errors';
import { KubernetesProvider } from './kubernetes/kubernetes-provider';
import { providerFromEnv } from './provider';

describe('providerFromEnv', () => {
  it('기본은 로컬 Docker이고, 컨테이너 런타임을 격리 표시로 쓴다', () => {
    const provider = providerFromEnv({ B_STUDIO_CONTAINER_RUNTIME: 'runsc' });

    expect(provider).toBeInstanceOf(LocalDockerProvider);
    expect(provider.isolation).toBe('runsc');
    expect(providerFromEnv({}).isolation).toBeUndefined();
  });

  it('kubernetes를 고르면 RuntimeClass를 격리 표시로 쓴다', () => {
    const provider = providerFromEnv({
      B_STUDIO_SANDBOX_PROVIDER: 'kubernetes',
      B_STUDIO_K8S_RUNTIME_CLASS: 'gvisor',
      B_STUDIO_K8S_HOST_PATHS: '/Users/dev/.cache/b-studio=/b-studio',
      B_STUDIO_K8S_KIND_CLUSTER: 'b-studio',
    });

    expect(provider).toBeInstanceOf(KubernetesProvider);
    expect(provider).toMatchObject({ name: 'kubernetes', isolation: 'gvisor' });
  });

  it('잘못된 설정은 샌드박스를 만들기 전에 이유와 함께 거부한다', () => {
    expect(() => providerFromEnv({ B_STUDIO_SANDBOX_PROVIDER: 'nomad' })).toThrow('docker나 kubernetes');
    expect(() => providerFromEnv({ B_STUDIO_SANDBOX_PROVIDER: 'kubernetes' })).toThrow('B_STUDIO_K8S_KIND_CLUSTER나 B_STUDIO_K8S_REGISTRY');
    expect(() => providerFromEnv({ B_STUDIO_SANDBOX_PROVIDER: 'kubernetes', B_STUDIO_K8S_REGISTRY: 'registry.internal/b-studio', B_STUDIO_K8S_HOST_PATHS: '/only-host' })).toThrow(SandboxError);
  });
});
