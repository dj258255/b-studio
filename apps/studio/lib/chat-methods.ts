/**
 * 비교·병렬을 이 서버에서 바로 넘길 수 있는지. 에이전트의 제안 카드(ADR-068)가 넘기기 버튼을 켤지 정할 때 쓴다.
 * 넘기기는 대화의 진행 카드와 같은 경로(submitEntry)로 새 비교·계획을 만든다(ADR-069).
 * API 모드는 비교 후보·계획 모델을 사람이 직접 골라야 하는데, 그 화면이 따로 없어 막는다.
 */
export type ChatMethod = 'single' | 'fleet' | 'split';

export interface ChatCapabilities {
  mode: string;
  fleet: { enabled: boolean; reason?: string };
  split: { enabled: boolean; reason?: string };
}

export const API_MODE_REASON = '모델을 골라야 하는데 고를 화면이 없어 여기서는 막습니다';

export function chatMethodAvailability(capabilities: ChatCapabilities | undefined): Record<ChatMethod, { enabled: boolean; reason?: string }> {
  const other = (entry: { enabled: boolean; reason?: string } | undefined) => {
    if (!capabilities || !entry) return { enabled: false, reason: '쓸 수 있는 방식을 확인하는 중입니다' };
    if (!entry.enabled) return { enabled: false, ...(entry.reason ? { reason: entry.reason } : {}) };
    if (capabilities.mode === 'api') return { enabled: false, reason: API_MODE_REASON };
    return { enabled: true };
  };
  return { single: { enabled: true }, fleet: other(capabilities?.fleet), split: other(capabilities?.split) };
}
