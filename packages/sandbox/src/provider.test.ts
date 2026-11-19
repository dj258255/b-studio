import { describe, expect, it } from 'vitest';
import { LocalDockerProvider } from './docker/compose-provider';
import { SandboxError } from './errors';
import { providerFromEnv } from './provider';

describe('providerFromEnv', () => {
  it('기본은 로컬 Docker이고, 컨테이너 런타임을 고르던 환경 변수는 이제 거절한다', () => {
    expect(providerFromEnv({})).toBeInstanceOf(LocalDockerProvider);
    expect(providerFromEnv({}).isolation).toBeUndefined();
    expect(providerFromEnv({ B_STUDIO_CONTAINER_RUNTIME: '' }).isolation).toBeUndefined();
    expect(providerFromEnv({ B_STUDIO_CONTAINER_RUNTIME: '   ' }).isolation).toBeUndefined();

    for (const value of ['runsc', 'gvisor', 'runc', ' runsc ']) {
      expect(() => providerFromEnv({ B_STUDIO_CONTAINER_RUNTIME: value }), value).toThrow(SandboxError);
      expect(() => providerFromEnv({ B_STUDIO_CONTAINER_RUNTIME: value }), value).toThrow('`B_STUDIO_CONTAINER_RUNTIME`은 더는 지원하지 않습니다');
      expect(() => providerFromEnv({ B_STUDIO_CONTAINER_RUNTIME: value }), value).toThrow('이 환경 변수를 지우세요');
    }
  });

  it('제공자 값보다 런타임 환경 변수를 먼저 본다(어느 제공자 값이든 조용히 무시하지 않는다)', () => {
    for (const provider of ['docker', 'kubernetes', 'nomad']) {
      expect(() => providerFromEnv({ B_STUDIO_SANDBOX_PROVIDER: provider, B_STUDIO_CONTAINER_RUNTIME: 'runsc' }), provider).toThrow(
        '`B_STUDIO_CONTAINER_RUNTIME`은 더는 지원하지 않습니다',
      );
    }
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
