import type { LoadedProject } from '@b-studio/spec';
import { native } from './native';

/**
 * 샌드박스 네트워크의 유일한 출입구(packages/sandbox/edge/edge.mjs)의 설정. Docker와 Kubernetes 제공자가 같은 설정을 쓴다.
 * 값을 정하는 코드와 상수는 Rust(crates/bstudio-guard/src/edge_config.rs)에 있고, 여기는 이름과 시그니처를 지키는 껍데기다(ADR-191)
 */
const constants = JSON.parse(native.edgeConstants()) as {
  edgeService: string;
  edgeProxyPort: number;
  edgeImage: string;
  sandboxNetwork: string;
  egressNetwork: string;
  defaultEgressAllow: string[];
};

export const EDGE_SERVICE = constants.edgeService;
export const EDGE_PROXY_PORT = constants.edgeProxyPort;
export const EDGE_IMAGE = constants.edgeImage;
/** 외부로 나갈 수 없는 네트워크. 모든 서비스가 여기에만 붙는다 */
export const SANDBOX_NETWORK = constants.sandboxNetwork;
/** edge만 붙는 네트워크. 허용한 외부 호스트로 나갈 때 쓴다 */
export const EGRESS_NETWORK = constants.egressNetwork;

/** 기본으로 허용하는 외부 호스트: 템플릿이 의존성을 받는 패키지 저장소와 Next 템플릿의 next/font/google */
export const DEFAULT_EGRESS_ALLOW: string[] = constants.defaultEgressAllow;

/** Rust로 보낼 프로젝트의 부분. 판정에 쓰는 필드만 담는다(`undefined`인 필드는 JSON에서 빠져 Rust가 `??`로 읽는다) */
export function nativeProject(project: LoadedProject) {
  return {
    managed: project.managed.map(([name, service]) => [name, service.port]),
    composeServices: project.composeServices,
    secrets: project.secrets?.map(([name, secret]) => [name, secret.services]),
    external: project.external?.map(([name, service]) => [name, { baseUrl: service.baseUrl, policy: service.policy }]),
    egress: project.egress,
    resources: project.resources,
    publicUrlRefs: project.publicUrlRefs,
  };
}

/** managed 서비스가 edge에서 공개되는 포트. 서비스 순서로 정해 여러 서비스가 같은 컨테이너 포트를 써도 겹치지 않는다 */
export function edgePortFor(project: LoadedProject, service: string): number {
  return native.edgePortFor(
    project.managed.map(([name]) => name),
    service,
  );
}

/** 프록시를 거치지 않고 부를 이름: 로컬, 샌드박스 서비스, edge가 받는 등록한 사내 API */
export function directHosts(project: LoadedProject, services: readonly string[]): string[] {
  return native.directHosts(
    [...services],
    (project.external ?? []).map(([name]) => name),
  );
}

/** 서비스가 밖으로 나가는 HTTP(S)를 edge 프록시로 보내게 하는 환경 변수 */
export function proxyEnvironment(direct: readonly string[]): Record<string, string> {
  return JSON.parse(native.proxyEnvironment([...direct])) as Record<string, string>;
}

/** edge 프로세스 설정. 값을 그대로 담는다 (compose override는 $를 따로 적는다) */
export function edgeEnvironment(project: LoadedProject, services: readonly string[]): Record<string, string> {
  const { managed, egress, external } = nativeProject(project);
  return JSON.parse(native.edgeEnvironment(JSON.stringify({ managed, services, egress, external }))) as Record<string, string>;
}
