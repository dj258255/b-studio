import { describe, expect, it } from 'vitest';
import { API_MODE_REASON, chatMethodAvailability } from './chat-methods';

describe('chatMethodAvailability', () => {
  it('구독 CLI 모드에서 서버가 허용하면 비교·병렬을 입력창에서 보낸다', () => {
    const result = chatMethodAvailability({ mode: 'claude-code', fleet: { enabled: true }, split: { enabled: true } });
    expect(result).toEqual({ single: { enabled: true }, fleet: { enabled: true }, split: { enabled: true } });
  });

  it('API 모드는 모델을 골라야 해서 막고 새로 시작 화면으로 안내한다', () => {
    const result = chatMethodAvailability({ mode: 'api', fleet: { enabled: true }, split: { enabled: true } });
    expect(result.fleet).toEqual({ enabled: false, reason: API_MODE_REASON });
    expect(result.split).toEqual({ enabled: false, reason: API_MODE_REASON });
  });

  it('서버가 막으면 그 이유를 그대로 보여 주고, 한 명은 늘 된다', () => {
    const result = chatMethodAvailability({ mode: 'demo', fleet: { enabled: false, reason: '데모에서는 못 씁니다' }, split: { enabled: false } });
    expect(result.single).toEqual({ enabled: true });
    expect(result.fleet).toEqual({ enabled: false, reason: '데모에서는 못 씁니다' });
    expect(result.split).toEqual({ enabled: false });
  });

  it('아직 서버 답을 받지 못했으면 비교·병렬을 막아 둔다', () => {
    expect(chatMethodAvailability(undefined).fleet.enabled).toBe(false);
  });
});
