import { describe, expect, it } from 'vitest';
import { serviceNotReadyMessage, storedResultNotice } from './test-run-state';

describe('serviceNotReadyMessage(테스트 탭이 서비스 상태와 같은 말을 쓴다, 이슈 #720)', () => {
  it('시작에 실패한 서비스를 "꺼져 있다"고 하지 않는다', () => {
    expect(serviceNotReadyMessage('failed')).toBe('서비스가 시작하지 못해 테스트를 돌릴 수 없습니다');
    expect(serviceNotReadyMessage('failed')).not.toContain('꺼져');
  });

  it('켜지는 중이면 기다리라고 알린다', () => {
    expect(serviceNotReadyMessage('starting')).toBe('서비스가 켜지는 중이라 아직 테스트를 돌릴 수 없습니다');
    expect(serviceNotReadyMessage('probing')).toBe(serviceNotReadyMessage('starting'));
  });

  it('멈췄거나 꺼 둔 서비스, 상태를 모르는 서비스는 꺼져 있다고 알린다', () => {
    expect(serviceNotReadyMessage('stopped')).toBe('서비스가 꺼져 있습니다');
    expect(serviceNotReadyMessage('off')).toBe('서비스가 꺼져 있습니다');
    expect(serviceNotReadyMessage(undefined)).toBe('서비스가 꺼져 있습니다');
  });

  it('마지막 실행 결과만 보여 줄 때도 같은 상태 이름을 쓴다', () => {
    expect(storedResultNotice('failed')).toBe('서비스가 시작하지 못해 마지막 실행 결과만 보여 줍니다');
    expect(storedResultNotice('stopped')).toBe('서비스가 꺼져 있어 마지막 실행 결과만 보여 줍니다');
  });
});
