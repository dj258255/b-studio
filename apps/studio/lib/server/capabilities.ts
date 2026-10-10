/**
 * 이 스튜디오가 **어떤 방식으로 일을 시킬 수 있는지**를 한 곳에서 알린다.
 *
 * 화면(홈)은 기능 버튼을 모드마다 흩어 놓지 않고, 이 값으로 "지금 쓸 수 있는 방식"만 보여 준다.
 * 그래서 모양이 곧 계약이다 — 필드 이름과 값의 뜻을 테스트로 고정한다.
 *
 * - `single`: 한 세션에 요청 하나(만들기·질문). 모든 모드에서 된다.
 * - `fleet`: 여러 후보를 나란히 비교(Agent Fleet). 데모만 빼고 모든 모드에서 된다 —
 *   후보마다 backend를 고를 수 있어 로컬 구독 CLI 모드에서도 쓴다(후보의 backend는 허용 목록 안이어야 한다).
 * - `split`: 작업 분해(계획 → 레인 병렬). 모델에게 계획을 받을 수 있는 모드에서만 된다(api·claude-code).
 * - `backends`: 이 서버에서 세션 백엔드로 고를 수 있는 값(서버 모드 + B_STUDIO_BACKENDS).
 * - `openFolder`: 이 PC의 폴더를 프로젝트로 열 수 있는가(ADR-067). 인증을 끈 개인 PC 모드에서만 된다 —
 *   개발 화면 머리의 프로젝트 메뉴(ADR-070)가 이 값으로 "폴더 열기…" 항목을 보일지 정한다.
 *
 * - `experimental`: 실험 기능을 화면에 보이는가(B_STUDIO_EXPERIMENTAL, ADR-166). 꺼져 있으면 `fleet`·`split`도 꺼진 것으로 알린다 —
 *   화면이 그 방식을 권하지 않게 하려는 것이고, API는 그대로 받는다(숨기는 것이지 막는 것이 아니다).
 *
 * 목록은 각 기능이 실제로 막는 곳과 같은 상수(FLEET_MODES·PLANNER_MODES)를 쓴다 — 두 곳이 갈라지면
 * 화면이 되는 것처럼 보이는데 서버는 거부하는 상태가 된다.
 */
import { experimentalEnabled } from '@b-studio/agent';
import type { SessionMode } from '@/lib/studio-events';
import { FLEET_MODES } from './fleets';
import { allowedBackends, localFolderAllowed, sessionMode } from './sessions';
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
  openFolder: boolean;
  experimental: boolean;
}

/** 실험 기능을 켜지 않아 꺼진 방식의 사유. 켜는 방법을 함께 알린다 */
export const EXPERIMENTAL_REASON = '실험 기능이라 기본으로 숨겨 둡니다. B_STUDIO_EXPERIMENTAL=1로 스튜디오를 띄우면 쓸 수 있습니다';

/** 순수 계산. 라우트와 테스트가 같은 함수를 쓴다 */
export function buildCapabilities(input: { mode: SessionMode; backends: readonly SessionMode[]; openFolder: boolean; experimental?: boolean }): StudioCapabilities {
  const { mode } = input;
  // 생략하면 켠 것으로 본다(이 함수는 "서버가 할 수 있는가"를 계산하고, 숨김은 호출자가 넘긴다)
  const experimental = input.experimental ?? true;
  if (!experimental) {
    return {
      mode,
      single: { enabled: true },
      fleet: { enabled: false, reason: EXPERIMENTAL_REASON },
      split: { enabled: false, reason: EXPERIMENTAL_REASON },
      backends: [...input.backends],
      openFolder: input.openFolder,
      experimental,
    };
  }
  return {
    mode,
    // 한 세션에 요청 하나는 모든 모드에서 된다(데모는 준비된 대본으로 돈다)
    single: { enabled: true },
    fleet: (FLEET_MODES as readonly string[]).includes(mode)
      ? { enabled: true }
      : { enabled: false, reason: `여러 후보를 나란히 비교하는 방식은 데모 모드에서 쓸 수 없습니다 (지금 모드: ${mode})` },
    split: (PLANNER_MODES as readonly string[]).includes(mode)
      ? { enabled: true }
      : { enabled: false, reason: `계획을 모델에게 받으려면 B_STUDIO_MODE=${PLANNER_MODES.join(' 또는 ')}여야 합니다 (지금 모드: ${mode})` },
    backends: [...input.backends],
    openFolder: input.openFolder,
    experimental,
  };
}

/** 지금 서버 설정(B_STUDIO_MODE·B_STUDIO_BACKENDS·B_STUDIO_AUTH)으로 계산한 값 */
export function studioCapabilities(): StudioCapabilities {
  const mode = sessionMode();
  return buildCapabilities({ mode, backends: [...allowedBackends(mode)], openFolder: localFolderAllowed(), experimental: experimentalEnabled() });
}
