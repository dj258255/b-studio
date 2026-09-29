/**
 * 이 스튜디오가 **어떤 방식으로 일을 시킬 수 있는지**를 한 곳에서 알린다.
 *
 * 화면(홈)은 기능 버튼을 모드마다 흩어 놓지 않고, 이 값으로 "지금 쓸 수 있는 방식"만 보여 준다.
 * 그래서 모양이 곧 계약이다 — 필드 이름과 값의 뜻을 테스트로 고정한다.
 *
 * - `single`: 한 세션에 요청 하나(만들기·질문). 모든 모드에서 된다.
 * - `fleet`: 여러 모델을 나란히 비교(Agent Fleet). 모델 API를 직접 부르므로 유료 API 모드에서만 된다.
 * - `split`: 작업 분해(계획 → 레인 병렬). 모델에게 계획을 받을 수 있는 모드에서만 된다(api·claude-code).
 * - `backends`: 이 서버에서 세션 백엔드로 고를 수 있는 값(서버 모드 + B_STUDIO_BACKENDS).
 *
 * 목록은 각 기능이 실제로 막는 곳과 같은 상수(FLEET_MODES·PLANNER_MODES)를 쓴다 — 두 곳이 갈라지면
 * 화면이 되는 것처럼 보이는데 서버는 거부하는 상태가 된다.
 */
import type { SessionMode } from '@/lib/studio-events';
import { FLEET_MODES } from './fleets';
import { allowedBackends, sessionMode } from './sessions';
import { PLANNER_MODES } from './task-plans';

export interface CapabilityState {
  enabled: boolean;
  /** 못 하는 이유. enabled가 false일 때만 있다 */
  reason?: string;
}

export interface StudioCapabilities {
  mode: SessionMode;
  single: CapabilityState;
  fleet: CapabilityState;
  split: CapabilityState;
  backends: SessionMode[];
}

/** 순수 계산. 라우트와 테스트가 같은 함수를 쓴다 */
export function buildCapabilities(input: { mode: SessionMode; backends: readonly SessionMode[] }): StudioCapabilities {
  const { mode } = input;
  return {
    mode,
    // 한 세션에 요청 하나는 모든 모드에서 된다(데모는 준비된 대본으로 돈다)
    single: { enabled: true },
    fleet: (FLEET_MODES as readonly string[]).includes(mode)
      ? { enabled: true }
      : { enabled: false, reason: `여러 모델을 나란히 비교하는 방식은 B_STUDIO_MODE=${FLEET_MODES.join(' 또는 ')}에서만 쓸 수 있습니다 (지금 모드: ${mode})` },
    split: (PLANNER_MODES as readonly string[]).includes(mode)
      ? { enabled: true }
      : { enabled: false, reason: `계획을 모델에게 받으려면 B_STUDIO_MODE=${PLANNER_MODES.join(' 또는 ')}여야 합니다 (지금 모드: ${mode})` },
    backends: [...input.backends],
  };
}

/** 지금 서버 설정(B_STUDIO_MODE·B_STUDIO_BACKENDS)으로 계산한 값 */
export function studioCapabilities(): StudioCapabilities {
  const mode = sessionMode();
  return buildCapabilities({ mode, backends: [...allowedBackends(mode)] });
}
