import { z } from 'zod';

type JsonProperty = { type?: string; enum?: unknown[]; items?: { type?: string }; description?: string };

/**
 * 도구 스키마는 buildTools 한 곳에서만 정의하고, MCP 도구가 요구하는 zod 형태로 옮긴다.
 * b-studio 도구가 쓰는 형태(문자열·열거형·정수·문자열 배열)만 지원하고 나머지는 바로 드러낸다.
 * 기본은 모든 인자를 필수로 둔다. honorRequired를 주면 스키마의 required에 없는 인자를 선택으로 연다 — 모델이 선택 인자를
 * 비워 두지 못하고 빈 문자열이라도 채워 넣는 것을 막는다(탐색형 QA의 qa_scroll이 이렇게 실패했다).
 */
export function zodShape(schema: { properties?: unknown; required?: unknown }, options: { honorRequired?: boolean } = {}): Record<string, z.ZodType> {
  const required = Array.isArray(schema.required) ? new Set(schema.required.map(String)) : undefined;
  const shape: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries((schema.properties ?? {}) as Record<string, JsonProperty>)) {
    let type: z.ZodType;
    if (value.type === 'string' && value.enum?.length) type = z.enum(value.enum.map(String) as [string, ...string[]]);
    else if (value.type === 'string') type = z.string();
    else if (value.type === 'integer') type = z.number().int();
    else if (value.type === 'boolean') type = z.boolean();
    else if (value.type === 'array' && value.items?.type === 'string') type = z.array(z.string());
    else throw new Error(`지원하지 않는 도구 입력 형식입니다: ${key} ${JSON.stringify(value)}`);
    if (options.honorRequired && required && !required.has(key)) type = type.optional();
    shape[key] = value.description ? type.describe(value.description) : type;
  }
  return shape;
}

/**
 * 도구 호출을 모델이 낸 순서대로 하나씩 실행한다. 로컬 Claude Code 러너와 Codex 러너가 같이 쓴다.
 * 끝난 뒤 실행 중이던 호출까지 기다릴 수 있게 idle()을 함께 돌려준다.
 */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.catch(() => {});
    return next;
  };
  return Object.assign(enqueue, { idle: () => tail });
}
