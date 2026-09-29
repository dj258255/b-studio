import { EDGE_SERVICE } from './edge-config';
import type { ServiceRole } from './types';

/**
 * compose 프로젝트(또는 Kubernetes 네임스페이스의 Pod 집합)에 있는 컨테이너를 화면에 묶어 보여 줄 세 갈래로 나눈다.
 *  - managed: studio.yaml에 적어 스튜디오가 직접 다루는 서비스 (기동·재시작 대상)
 *  - platform: b-studio가 붙이는 edge 프록시 (사용자 코드가 아니다)
 *  - supporting: 그 밖에 compose 파일에 있는 서비스 (DB 등 부가 서비스)
 */
export function classifyRole(service: string, managedNames: ReadonlySet<string>): ServiceRole {
  if (service === EDGE_SERVICE) return 'platform';
  return managedNames.has(service) ? 'managed' : 'supporting';
}
