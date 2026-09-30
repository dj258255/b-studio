/**
 * 개발 화면 머리(session-header)의 서비스 상태 줄. 예전에는 studio.yaml의 관리형 서비스(`snapshot.services`)만 하드코딩해 보여줬다.
 * 컨테이너는 이제 관리형 말고도 부가 서비스(DB 등, ADR-073)·플랫폼(edge 프록시)이 있을 수 있어, 관리형이 아닌 컨테이너를
 * `snapshot.usage.services`(role이 있다, 리소스 탭이 쓰는 것과 같은 값)에서 뽑아 "+N" 칩으로 압축해 보여준다.
 */
import type { ContainerHealth, ContainerState, ServiceRole, ServiceUsage } from '@b-studio/sandbox';

export interface SupportingContainerSummary {
  service: string;
  role: ServiceRole;
  state: ContainerState;
  health?: ContainerHealth;
}

/**
 * 관리형(studio.yaml에 적은 서비스)이 아닌 컨테이너만 뽑는다. usage가 없으면(샌드박스가 꺼졌거나 아직 재지 않음) 빈 배열이다.
 * role이 없는 컨테이너(옛 제공자·고정 픽스처)는 부가 서비스로 본다 — resource-history의 groupByRole과 같은 규칙이다
 */
export function supportingContainers(managedNames: ReadonlySet<string>, usageServices: readonly ServiceUsage[] | undefined): SupportingContainerSummary[] {
  if (!usageServices) return [];
  return usageServices
    .filter((usage) => !managedNames.has(usage.service))
    .map((usage) => ({ service: usage.service, role: usage.role ?? 'supporting', state: usage.state, health: usage.health }));
}
