import path from 'node:path';
import { LocalDockerProvider, runtimeFromEnv } from './docker/compose-provider';
import { SandboxError } from './errors';
import { KubernetesProvider, type ImageLoader } from './kubernetes/kubernetes-provider';
import type { SandboxProvider } from './types';

/**
 * 스튜디오 서버와 CLI의 환경 변수로 샌드박스 제공자를 고른다.
 *  - B_STUDIO_SANDBOX_PROVIDER: docker(기본) 또는 kubernetes
 *  - docker: B_STUDIO_CONTAINER_RUNTIME (예: runsc)
 *  - kubernetes: B_STUDIO_KUBECTL, B_STUDIO_KUBECONFIG, B_STUDIO_K8S_CONTEXT, B_STUDIO_K8S_RUNTIME_CLASS,
 *    B_STUDIO_K8S_HOST_PATHS(호스트경로=노드경로, 쉼표로 여러 개), B_STUDIO_K8S_KIND_CLUSTER 또는 B_STUDIO_K8S_REGISTRY
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxProvider {
  const kind = env.B_STUDIO_SANDBOX_PROVIDER?.trim() || 'docker';
  if (kind === 'docker') return new LocalDockerProvider({ runtime: runtimeFromEnv(env) });
  if (kind !== 'kubernetes') throw new SandboxError(`B_STUDIO_SANDBOX_PROVIDER는 docker나 kubernetes여야 합니다 (지금 값: ${kind})`);

  const hostPathMounts = (env.B_STUDIO_K8S_HOST_PATHS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hostPath, nodePath] = entry.split('=');
      if (!hostPath || !nodePath) throw new SandboxError(`B_STUDIO_K8S_HOST_PATHS 항목은 호스트경로=노드경로 형식이어야 합니다: ${entry}`);
      return { hostPath: path.resolve(hostPath), nodePath };
    });

  let images: ImageLoader;
  if (env.B_STUDIO_K8S_KIND_CLUSTER?.trim()) images = { kind: 'kind', cluster: env.B_STUDIO_K8S_KIND_CLUSTER.trim() };
  else if (env.B_STUDIO_K8S_REGISTRY?.trim()) images = { kind: 'registry', prefix: env.B_STUDIO_K8S_REGISTRY.trim() };
  else throw new SandboxError('Kubernetes 제공자는 build 서비스 이미지를 올릴 곳이 필요합니다. B_STUDIO_K8S_KIND_CLUSTER나 B_STUDIO_K8S_REGISTRY를 지정하세요');

  return new KubernetesProvider({
    // 클러스터와 버전이 맞는 kubectl을 따로 둘 때 (기본은 PATH의 kubectl)
    kubectlBin: env.B_STUDIO_KUBECTL?.trim() || undefined,
    kubeconfig: env.B_STUDIO_KUBECONFIG?.trim() || undefined,
    context: env.B_STUDIO_K8S_CONTEXT?.trim() || undefined,
    runtimeClassName: env.B_STUDIO_K8S_RUNTIME_CLASS?.trim() || undefined,
    hostPathMounts,
    images,
  });
}
