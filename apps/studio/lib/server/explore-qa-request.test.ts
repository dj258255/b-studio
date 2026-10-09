import { describe, expect, it } from 'vitest';
import { parseExploreQaRequest } from './explore-qa-request';

function messageOf(body: unknown): string {
  const parsed = parseExploreQaRequest(body);
  if (parsed.ok) throw new Error('오류여야 합니다');
  return parsed.message;
}

describe('parseExploreQaRequest', () => {
  it('올바른 시작·중지·저장 요청은 그대로 통과한다', () => {
    expect(parseExploreQaRequest({ action: 'start', service: 'web', goal: '점검', startPath: '/live' }).ok).toBe(true);
    expect(parseExploreQaRequest({ action: 'stop' }).ok).toBe(true);
    expect(parseExploreQaRequest({ action: 'save', service: 'web' }).ok).toBe(true);
  });

  it('action이 빠지면 어느 필드가 틀렸는지 말한다("Invalid input"만 남기지 않는다)', () => {
    const message = messageOf({ service: 'web', goal: '점검', startPath: '/live' });
    expect(message).toContain('action');
    expect(message).not.toBe('탐색형 QA 요청이 올바르지 않습니다: Invalid input');
  });

  it('알 수 없는 action도 action을 짚는다', () => {
    expect(messageOf({ action: 'run' })).toContain('action');
  });

  it('start의 필드가 빠지거나 틀리면 그 필드 이름을 말한다', () => {
    expect(messageOf({ action: 'start', service: 'web', goal: '점검' })).toContain('startPath');
    expect(messageOf({ action: 'start', service: 'web', goal: '점검', startPath: '/', maxActions: 'many' })).toContain('maxActions');
    expect(messageOf({ action: 'start', service: 'web', goal: '', startPath: '/' })).toContain('goal');
  });

  it('save에 service가 없으면 service를 짚고, 본문이 비면 요청 본문이라고 말한다', () => {
    expect(messageOf({ action: 'save' })).toContain('service');
    expect(messageOf(undefined)).toContain('요청 본문');
  });
});
