import { LocalDockerProvider, runtimeFromEnv } from './docker/compose-provider';
import { SandboxError } from './errors';
import type { SandboxProvider } from './types';

/**
 * 스튜디오 서버와 CLI의 환경 변수로 샌드박스 제공자를 고른다.
 *  - B_STUDIO_SANDBOX_PROVIDER: docker(기본)
 *  - docker: B_STUDIO_CONTAINER_RUNTIME (예: runsc)
 * kubernetes 제공자는 지웠습니다(ADR-221). 그 값을 넣으면 조용히 Docker로 떨어지지 않고 시작을 거절합니다
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxProvider {
  const kind = env.B_STUDIO_SANDBOX_PROVIDER?.trim() || 'docker';
  if (kind.toLowerCase() === 'kubernetes') {
    throw new SandboxError(
      '더는 지원하지 않습니다: Kubernetes 제공자(B_STUDIO_SANDBOX_PROVIDER=kubernetes)는 지웠습니다. 이 값을 지우면 로컬 Docker로 시작합니다',
    );
  }
  if (kind !== 'docker') throw new SandboxError(`B_STUDIO_SANDBOX_PROVIDER는 docker여야 합니다 (지금 값: ${kind})`);
  return new LocalDockerProvider({ runtime: runtimeFromEnv(env) });
}
