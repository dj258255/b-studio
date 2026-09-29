import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  CLEARED_TOOL_RESULT_PREFIX,
  clearedToolResultNote,
  clearOldToolResults,
  contextClearingFromEnv,
  DEFAULT_CONTEXT_CLEARING,
  isClearedToolResult,
  resolveContextClearing,
  type ContextClearingPolicy,
} from './context-clearing';

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;

const BIG = '가'.repeat(30);

function toolResult(toolUseId: string, content: string | Array<{ type: 'text'; text: string }>, isError = false) {
  return { type: 'tool_result' as const, tool_use_id: toolUseId, content, is_error: isError };
}

function user(blocks: unknown[]): BetaMessageParam {
  return { role: 'user', content: blocks } as BetaMessageParam;
}

function policy(overrides: Partial<ContextClearingPolicy> = {}): ContextClearingPolicy {
  return { triggerTokens: 1, keepRecent: 1, clearAtLeastChars: 10, ...overrides };
}

describe('clearOldToolResults', () => {
  it('최근 keepRecent개는 남기고 오래된 도구 결과만 비운다', () => {
    const messages = [user([toolResult('a', BIG), toolResult('b', BIG)]), user([toolResult('c', BIG)])];

    const result = clearOldToolResults(messages, policy({ keepRecent: 1 }));

    expect(result.clearedCount).toBe(2);
    expect(result.clearedChars).toBe(60);
    const first = result.messages[0]!.content as Array<{ tool_use_id: string; content: string }>;
    const second = result.messages[1]!.content as Array<{ tool_use_id: string; content: string }>;
    expect(first[0]!.content.startsWith(CLEARED_TOOL_RESULT_PREFIX)).toBe(true);
    expect(first[0]!.content).toContain('30자');
    expect(first[1]!.content.startsWith(CLEARED_TOOL_RESULT_PREFIX)).toBe(true);
    // 최근 것은 그대로 남는다
    expect(second[0]!.content).toBe(BIG);
  });

  it('줄어드는 글자가 clearAtLeastChars보다 작으면 아무것도 바꾸지 않는다', () => {
    const messages = [user([toolResult('a', BIG), toolResult('b', BIG)]), user([toolResult('c', BIG)])];

    const result = clearOldToolResults(messages, policy({ keepRecent: 1, clearAtLeastChars: 100 }));

    expect(result.clearedCount).toBe(0);
    expect(result.clearedChars).toBe(0);
    expect(result.messages).toEqual(messages);
  });

  it('이미 비운 자리는 후보에서도 최근 N개에도 넣지 않는다', () => {
    const messages = [user([toolResult('a', clearedToolResultNote(1_000)), toolResult('b', BIG), toolResult('c', BIG)])];

    // a를 후보로 세면 오래된 것 2개(a·b)를 비우게 된다. a를 빼야 후보가 b 하나뿐이다
    const result = clearOldToolResults(messages, policy({ keepRecent: 1 }));

    expect(result.clearedCount).toBe(1);
    const blocks = result.messages[0]!.content as Array<{ content: string }>;
    expect(blocks[0]!.content).toBe(clearedToolResultNote(1_000));
    expect(blocks[1]!.content.startsWith(CLEARED_TOOL_RESULT_PREFIX)).toBe(true);
    expect(blocks[2]!.content).toBe(BIG);
  });

  it('tool_use_id와 is_error는 그대로 두고 원본은 바꾸지 않는다', () => {
    const messages = [user([toolResult('call-1', BIG, true)])];

    const result = clearOldToolResults(messages, policy({ keepRecent: 0 }));

    const cleared = (result.messages[0]!.content as Array<{ tool_use_id: string; is_error: boolean; content: string }>)[0]!;
    expect(cleared.tool_use_id).toBe('call-1');
    expect(cleared.is_error).toBe(true);
    // 원본은 그대로다
    expect((messages[0]!.content as Array<{ content: string }>)[0]!.content).toBe(BIG);
    expect(result.messages[0]).not.toBe(messages[0]);
  });

  it('텍스트 블록 배열 본문도 글자 수를 세고 비운다', () => {
    const messages = [user([toolResult('a', [{ type: 'text', text: BIG }]), toolResult('b', BIG)])];

    const result = clearOldToolResults(messages, policy({ keepRecent: 1 }));

    expect(result.clearedChars).toBe(30);
    const blocks = result.messages[0]!.content as Array<{ content: string }>;
    expect(blocks[0]!.content.startsWith(CLEARED_TOOL_RESULT_PREFIX)).toBe(true);
  });

  it('도구 결과가 없는 메시지(assistant·문자열 본문)는 건드리지 않는다', () => {
    const messages: BetaMessageParam[] = [
      { role: 'user', content: '요청입니다' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'read_file', input: {} }] },
      user([toolResult('call-1', BIG)]),
    ];

    const result = clearOldToolResults(messages, policy({ keepRecent: 0 }));

    expect(result.clearedCount).toBe(1);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toBe(messages[1]);
    expect(result.messages[2]).not.toBe(messages[2]);
  });

  it('isClearedToolResult는 표시 문구만 알아본다', () => {
    expect(isClearedToolResult(clearedToolResultNote(12))).toBe(true);
    expect(isClearedToolResult('보통 결과')).toBe(false);
  });
});

describe('정책 해석', () => {
  it('B_STUDIO_CONTEXT_CLEARING=on일 때만 기본 정책을 켠다', () => {
    expect(contextClearingFromEnv({ B_STUDIO_CONTEXT_CLEARING: 'on' })).toEqual(DEFAULT_CONTEXT_CLEARING);
    expect(contextClearingFromEnv({ B_STUDIO_CONTEXT_CLEARING: ' ON ' })).toEqual(DEFAULT_CONTEXT_CLEARING);
    expect(contextClearingFromEnv({ B_STUDIO_CONTEXT_CLEARING: 'off' })).toBeUndefined();
    expect(contextClearingFromEnv({})).toBeUndefined();
  });

  it('옵션이 이기고, false는 환경 변수보다 우선한다', () => {
    const custom = policy({ triggerTokens: 100 });
    expect(resolveContextClearing(custom, {})).toEqual(custom);
    expect(resolveContextClearing(undefined, { B_STUDIO_CONTEXT_CLEARING: 'on' })).toEqual(DEFAULT_CONTEXT_CLEARING);
    expect(resolveContextClearing(false, { B_STUDIO_CONTEXT_CLEARING: 'on' })).toBeUndefined();
    expect(resolveContextClearing(undefined, {})).toBeUndefined();
  });
});
