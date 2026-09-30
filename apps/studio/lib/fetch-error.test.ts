import { describe, expect, it } from 'vitest';
import { describeFailedResponse } from './fetch-error';

describe('describeFailedResponse', () => {
  it('fetch 자체가 실패했으면(response 없음) 서버가 응답하지 않았다고 알린다', () => {
    expect(describeFailedResponse(undefined, '폴더를 살펴보지 못했습니다')).toBe('폴더를 살펴보지 못했습니다 (서버가 응답하지 않았습니다. 네트워크 연결을 확인해 보세요)');
  });

  it('404면 상태 코드와 함께 오래된 서버일 수 있다는 힌트를 붙인다', () => {
    const response = new Response(null, { status: 404 });
    expect(describeFailedResponse(response, '폴더를 살펴보지 못했습니다')).toBe(
      '폴더를 살펴보지 못했습니다 (서버 응답 404). 앱 서버가 오래된 상태일 수 있습니다 — b-studio를 다시 시작해 보세요',
    );
  });

  it('다른 상태 코드는 코드만 붙인다', () => {
    const response = new Response(null, { status: 500 });
    expect(describeFailedResponse(response, '세션을 만들지 못했습니다')).toBe('세션을 만들지 못했습니다 (서버 응답 500)');
  });
});
