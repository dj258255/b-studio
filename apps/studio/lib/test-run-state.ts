import type { ServiceState } from './studio-events';

/**
 * 테스트 탭이 서비스 상태를 말하는 문구. 머리의 서비스 상태(실패·켜지는 중·꺼짐)와 같은 말을 써야 한다 —
 * 시작에 실패한 서비스를 "꺼져 있다"고 하면 사람이 서비스를 켜려고 헤맨다(이슈 #720).
 */
export function serviceNotReadyMessage(state: ServiceState | undefined): string {
  if (state === 'failed') return '서비스가 시작하지 못해 테스트를 돌릴 수 없습니다';
  if (state === 'starting' || state === 'probing') return '서비스가 켜지는 중이라 아직 테스트를 돌릴 수 없습니다';
  return '서비스가 꺼져 있습니다';
}

/** 서비스가 준비되지 않아 저장해 둔 마지막 실행 결과만 보여 줄 때의 안내 */
export function storedResultNotice(state: ServiceState | undefined): string {
  if (state === 'failed') return '서비스가 시작하지 못해 마지막 실행 결과만 보여 줍니다';
  if (state === 'starting' || state === 'probing') return '서비스가 켜지는 중이라 마지막 실행 결과만 보여 줍니다';
  return '서비스가 꺼져 있어 마지막 실행 결과만 보여 줍니다';
}

/**
 * "전체 실행"을 끌 이유. 돌릴 수 있는 서비스가 하나라도 있으면 undefined(켠다).
 * 모든 서비스가 같은 이유로 못 돌면 그 이유를 그대로 쓰고, 아니면 한 줄로 묶는다.
 */
export function runAllBlockedReason(services: readonly { service: string; supported: boolean; error?: string }[] | undefined): string | undefined {
  if (!services) return '테스트 목록을 불러오는 중입니다';
  if (services.some((service) => service.supported)) return undefined;
  const reasons = [...new Set(services.map((service) => service.error).filter((error): error is string => Boolean(error)))];
  if (reasons.length === 1 && services.every((service) => service.error)) return reasons[0];
  return '테스트를 돌릴 수 있는 서비스가 없습니다';
}
