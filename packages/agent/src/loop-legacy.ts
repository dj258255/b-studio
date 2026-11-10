import type Anthropic from '@anthropic-ai/sdk';

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;

/** 옮기기 전(ADR-191 3단계 3af 이전)의 loop.ts 진행 중 지시 판정 원본. 차등 시험의 기준으로만 쓴다 */
export const LEGACY_STEERING_MARKER = '[진행 중 지시]';

export function legacyFormatSteering(texts: readonly string[]): string {
  return `${LEGACY_STEERING_MARKER} ${texts.join('\n')}`;
}

export function legacyAppendUserText(messages: BetaMessageParam[], text: string): void {
  const last = messages.at(-1);
  if (last?.role === 'user') {
    if (typeof last.content === 'string') {
      last.content = `${last.content}\n\n${text}`;
      return;
    }
    if (Array.isArray(last.content)) {
      last.content.push({ type: 'text', text });
      return;
    }
  }
  messages.push({ role: 'user', content: text });
}
