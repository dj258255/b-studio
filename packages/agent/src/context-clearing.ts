/**
 * 컨텍스트가 커지면 오래된 도구 결과를 **묶어서** 비우는 순수 함수.
 *
 * 도구 결과는 실행이 끝날 때까지 대화에 남아 뒤 턴마다 캐시 읽기로 다시 계산된다. 그런데 앞 메시지를 바꾸면
 * 그 지점부터 프롬프트 캐시가 깨진다(다시 쓰기 비용). 그래서 매 턴 조금씩 지우지 않고, 임계치를 넘을 때
 * **한 번에 묶어서** 비운다. Anthropic의 context editing(`clear_tool_uses`·`clear_at_least`)과 같은 발상이다.
 *
 * 여기서는 규칙만 정의하고 실제 적용은 loop.ts가 한다(테스트가 쉽도록 순수 함수로 둔다).
 * Claude Code·Codex 러너는 대화를 직접 다루지 않는다(각 CLI가 자체 압축을 한다). 이번 범위 밖이다.
 */
import type Anthropic from '@anthropic-ai/sdk';

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;

export interface ContextClearingPolicy {
  /** 직전 턴의 컨텍스트(input+cache_read+cache_write)가 이 토큰 수 이상이면 비운다 */
  triggerTokens: number;
  /** 최근 도구 결과 N개는 남긴다 */
  keepRecent: number;
  /** 한 번에 최소 이만큼(글자) 줄지 않으면 비우지 않는다. 캐시를 깨면서 얻는 것이 없으면 그대로 둔다 */
  clearAtLeastChars: number;
}

/** 기본 정책. 임계치는 작은 모델 컨텍스트의 20% 남짓(60k)으로 잡았다 */
export const DEFAULT_CONTEXT_CLEARING: ContextClearingPolicy = { triggerTokens: 60_000, keepRecent: 4, clearAtLeastChars: 20_000 };

/** 비운 자리에 남기는 표시의 접두어. 이 문구로 시작하면 이미 비운 것으로 본다 */
export const CLEARED_TOOL_RESULT_PREFIX = '[이전 도구 결과 생략: ';

/** 비운 자리에 남기는 문구 */
export function clearedToolResultNote(chars: number): string {
  return `${CLEARED_TOOL_RESULT_PREFIX}${chars.toLocaleString('ko-KR')}자. 필요하면 같은 도구를 다시 부르세요]`;
}

/** 이미 비운 자리인지 */
export function isClearedToolResult(text: string): boolean {
  return text.startsWith(CLEARED_TOOL_RESULT_PREFIX);
}

export interface ClearToolResults {
  /** 원본을 바꾸지 않은 새 배열. 비우지 않았으면 원본과 같은 내용의 복사본 */
  messages: BetaMessageParam[];
  clearedCount: number;
  /** 비우면서 줄어든 글자 수 */
  clearedChars: number;
}

/**
 * `role: 'user'` 메시지 안의 `tool_result` 블록 중 최근 keepRecent개를 뺀 것을 표시 문구로 바꾼다.
 * - `tool_use_id`와 `is_error`는 그대로 둔다 — API 규칙상 tool_use와 tool_result가 짝을 이뤄야 한다.
 * - 이미 비운 자리(표시 문구로 시작)는 다시 세지 않는다.
 * - 줄어드는 글자가 clearAtLeastChars보다 작으면 아무것도 바꾸지 않는다.
 * - 원본 배열·메시지·블록은 바꾸지 않는다.
 */
export function clearOldToolResults(messages: readonly BetaMessageParam[], policy: ContextClearingPolicy = DEFAULT_CONTEXT_CLEARING): ClearToolResults {
  const targets: Array<{ message: number; block: number; chars: number }> = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return;
    message.content.forEach((block, blockIndex) => {
      if (block.type !== 'tool_result') return;
      const chars = contentChars(block.content);
      // 이미 비운 자리는 후보에서도 최근 N개에도 넣지 않는다
      if (typeof block.content === 'string' && isClearedToolResult(block.content)) return;
      targets.push({ message: messageIndex, block: blockIndex, chars });
    });
  });

  const candidates = targets.slice(0, Math.max(0, targets.length - policy.keepRecent));
  const clearedChars = candidates.reduce((sum, target) => sum + target.chars, 0);
  if (candidates.length === 0 || clearedChars < policy.clearAtLeastChars) {
    return { messages: [...messages], clearedCount: 0, clearedChars: 0 };
  }

  const cleared = new Set(candidates.map((target) => `${target.message}:${target.block}`));
  const next = messages.map((message, messageIndex) => {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((block, blockIndex) => {
      if (block.type !== 'tool_result' || !cleared.has(`${messageIndex}:${blockIndex}`)) return block;
      changed = true;
      // tool_use_id·is_error 등 나머지 필드는 그대로 둔다
      return { ...block, content: clearedToolResultNote(contentChars(block.content)) };
    });
    return changed ? ({ ...message, content } as BetaMessageParam) : message;
  });

  return { messages: next, clearedCount: candidates.length, clearedChars };
}

/** 도구 결과 본문의 글자 수. 문자열이거나 텍스트 블록 배열일 수 있다 */
function contentChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce<number>((sum, block) => sum + (typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text.length : 0), 0);
  }
  return 0;
}

/**
 * 환경 변수에서 기본 정책을 읽는다. `B_STUDIO_CONTEXT_CLEARING=on`일 때만 켠다(기본은 끔 — 효과를 재기 전).
 * 스튜디오 API 모드와 벤치가 이 값을 읽어 러너에 넘긴다.
 */
export function contextClearingFromEnv(env: Record<string, string | undefined>): ContextClearingPolicy | undefined {
  return env.B_STUDIO_CONTEXT_CLEARING?.trim().toLowerCase() === 'on' ? DEFAULT_CONTEXT_CLEARING : undefined;
}

/** 옵션과 환경 변수를 합쳐 실제 정책을 정한다. `false`는 환경 변수보다 우선한다(명시적으로 끔) */
export function resolveContextClearing(
  option: ContextClearingPolicy | false | undefined,
  env: Record<string, string | undefined>,
): ContextClearingPolicy | undefined {
  if (option === false) return undefined;
  if (option) return option;
  return contextClearingFromEnv(env);
}
