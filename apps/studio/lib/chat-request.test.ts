import { describe, expect, it } from 'vitest';
import { chatRequestBody, intentFor } from './chat-request';

describe('intentFor', () => {
  it('읽기만 스위치가 경로를 가른다 (기본은 만들기)', () => {
    expect(intentFor(false)).toBe('build');
    expect(intentFor(true)).toBe('ask');
  });
});

describe('chatRequestBody', () => {
  it('스위치에 따라 intent를 정하고, 읽기만이면 호환성 파괴 허용을 보내지 않는다', () => {
    // 기본(스위치 꺼짐)은 지금의 만들기 경로 그대로다
    expect(chatRequestBody({ text: '주문 목록에 필터 추가', intent: intentFor(false), allowBreaking: true })).toEqual({
      text: '주문 목록에 필터 추가',
      allowBreaking: true,
      intent: 'build',
    });

    // 읽기만이면 질문 경로. 파일을 바꾸지 않으므로 allowBreaking은 뜻이 없다
    expect(chatRequestBody({ text: '이 함수는 어떻게 동작해?', intent: intentFor(true), allowBreaking: true })).toEqual({
      text: '이 함수는 어떻게 동작해?',
      allowBreaking: false,
      intent: 'ask',
    });
    // 스위치를 안 보내면 false로 둔다
    expect(chatRequestBody({ text: '질문', intent: 'ask' }).allowBreaking).toBe(false);
  });
});
