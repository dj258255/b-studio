import { describe, expect, it } from 'vitest';
import { apiRequestsFromOtlp } from './terminal-telemetry';

/** OTLP 속성 하나 */
const attr = (key: string, value: unknown): { key: string; value: unknown } => ({ key, value });
const str = (value: string) => ({ stringValue: value });
const int = (value: number | string) => ({ intValue: value });
const dbl = (value: number) => ({ doubleValue: value });

/** api_request의 필수 속성(model과 네 토큰 수). 하나라도 없으면 그 레코드는 버려진다 */
const required = (): Array<{ key: string; value: unknown }> => [
  attr('model', str('claude-sonnet-5')),
  attr('input_tokens', int('1000')),
  attr('output_tokens', int(200)),
  attr('cache_read_tokens', dbl(3000)),
  attr('cache_creation_tokens', int('50')),
];

/** 로그 레코드 하나. over는 같은 이름의 속성을 덧붙여 값을 덮어쓴다(맵이 마지막 값을 쓴다) */
function record(over: Array<{ key: string; value: unknown }> = [], extra: Record<string, unknown> = {}): unknown {
  return {
    timeUnixNano: '1750000000000000000',
    attributes: [
      attr('event.name', str('claude_code.api_request')),
      ...required(),
      attr('cost_usd', dbl(0.0123)),
      attr('duration_ms', int(1234)),
      attr('request_id', str('req-1')),
      attr('prompt.id', str('prompt-1')),
      attr('session.id', str('session-1')),
      ...over,
    ],
    ...extra,
  };
}

const otlp = (records: unknown[]): unknown => ({ resourceLogs: [{ scopeLogs: [{ logRecords: records }] }] });

describe('apiRequestsFromOtlp (CLI의 OTLP/HTTP JSON 로그, 이슈 #726)', () => {
  it('문서의 속성 이름을 꺼내 숫자로 바꾼다(문자열 intValue와 doubleValue가 섞여도)', () => {
    const [usage, ...rest] = apiRequestsFromOtlp(otlp([record()]));
    expect(rest).toEqual([]);
    expect(usage).toEqual({
      requestId: 'req-1',
      promptId: 'prompt-1',
      sessionId: 'session-1',
      at: 1_750_000_000_000,
      model: 'claude-sonnet-5',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 3000,
      cacheWriteTokens: 50,
      costUsd: 0.0123,
      durationMs: 1234,
    });
  });

  it('event.name이 다른 이벤트는 건너뛴다. body.stringValue로 알아보는 꼴도 받는다', () => {
    const other = record([attr('event.name', str('claude_code.tool_result'))]);
    expect(apiRequestsFromOtlp(otlp([other]))).toEqual([]);
    // 본문으로 알아보는 꼴: event.name 속성이 없어도 body가 api_request이고 필수 속성이 다 있으면 받는다
    const byBody = { timeUnixNano: '1750000000000000000', body: str('claude_code.api_request'), attributes: required() };
    expect(apiRequestsFromOtlp(otlp([byBody]))).toHaveLength(1);
    expect(apiRequestsFromOtlp(otlp([byBody]))[0]).toMatchObject({ inputTokens: 1000, model: 'claude-sonnet-5' });
  });

  it('필수 속성(model·네 토큰 수)이 하나라도 없으면 그 레코드를 버린다(0으로 채우지 않는다)', () => {
    for (const missing of ['model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens']) {
      const without = required().filter((entry) => entry.key !== missing);
      const rec = { timeUnixNano: '1750000000000000000', attributes: [attr('event.name', str('api_request')), ...without] };
      expect(apiRequestsFromOtlp(otlp([rec])), missing).toEqual([]);
    }
    // 빈 model도 없는 것으로 본다
    expect(apiRequestsFromOtlp(otlp([record([attr('model', str(''))])]))).toEqual([]);
    // 다 있으면 받는다
    expect(apiRequestsFromOtlp(otlp([record()]))).toHaveLength(1);
  });

  it('음수·NaN·10^9를 넘는 값의 레코드는 버린다', () => {
    for (const bad of [int(-1), { intValue: 'not-a-number' }, dbl(2_000_000_000), dbl(Number.NaN)]) {
      expect(apiRequestsFromOtlp(otlp([record([attr('input_tokens', bad)])]))).toEqual([]);
    }
    // 한 레코드만 버리고 같은 묶음의 멀쩡한 것은 남긴다
    expect(apiRequestsFromOtlp(otlp([record([attr('output_tokens', int(-1))]), record()]))).toHaveLength(1);
  });

  it('모양이 틀린 본문(배열·null·문자열·빈 것)은 빈 목록', () => {
    for (const body of [[], null, '문자열', 42, {}, { resourceLogs: 'x' }, { resourceLogs: [null, 7] }, { resourceLogs: [{ scopeLogs: [{ logRecords: 'x' }] }] }]) {
      expect(apiRequestsFromOtlp(body)).toEqual([]);
    }
  });

  it('at은 timeUnixNano, 없으면 observedTimeUnixNano, 그것도 없으면 받은 시각', () => {
    const observed = { observedTimeUnixNano: '1700000000000000000', attributes: [attr('event.name', str('api_request')), ...required()] };
    expect(apiRequestsFromOtlp(otlp([observed]))[0]!.at).toBe(1_700_000_000_000);
    const neither = { attributes: [attr('event.name', str('api_request')), ...required()] };
    const before = Date.now();
    const at = apiRequestsFromOtlp(otlp([neither]))[0]!.at;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('한 본문에서 꺼내는 항목은 1,000개까지다', () => {
    const many = Array.from({ length: 1500 }, () => record());
    expect(apiRequestsFromOtlp(otlp(many))).toHaveLength(1000);
  });
});
