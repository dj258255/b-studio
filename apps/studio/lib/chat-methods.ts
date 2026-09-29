/**
 * 개발 화면 입력창의 방식 선택(한 명 / 여러 명 비교 / 나눠서 병렬). 한 명은 지금 세션에 보내고,
 * 비교·병렬은 홈과 같은 경로(submitEntry)로 새 비교·계획을 만든다(ADR-066).
 * API 모드는 비교 후보·계획 모델을 골라야 하므로 입력창에서는 막고 새로 시작 화면으로 안내한다.
 */
export type ChatMethod = 'single' | 'fleet' | 'split';

export interface ChatCapabilities {
  mode: string;
  fleet: { enabled: boolean; reason?: string };
  split: { enabled: boolean; reason?: string };
}

export const API_MODE_REASON = '모델을 골라 보내야 해서 새로 시작 화면에서 보냅니다';

export function chatMethodAvailability(capabilities: ChatCapabilities | undefined): Record<ChatMethod, { enabled: boolean; reason?: string }> {
  const other = (entry: { enabled: boolean; reason?: string } | undefined) => {
    if (!capabilities || !entry) return { enabled: false, reason: '쓸 수 있는 방식을 확인하는 중입니다' };
    if (!entry.enabled) return { enabled: false, ...(entry.reason ? { reason: entry.reason } : {}) };
    if (capabilities.mode === 'api') return { enabled: false, reason: API_MODE_REASON };
    return { enabled: true };
  };
  return { single: { enabled: true }, fleet: other(capabilities?.fleet), split: other(capabilities?.split) };
}
