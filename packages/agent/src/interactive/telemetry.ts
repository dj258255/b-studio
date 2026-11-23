import type { InteractiveSettings } from './settings';

export interface ApiRequestRecord {
  requestId: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** 단가를 모르면 없다(0을 보내지 않는다) */
  costUsd?: number;
  durationMs: number;
}

export interface Pricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/** 단가가 있을 때만 비용을 계산한다. 캐시 토큰은 단가를 모르므로 계산에 넣지 않는다 */
export function computeCost(pricing: Pricing | undefined, input: number, output: number): number | undefined {
  if (!pricing) return undefined;
  return (input * pricing.inputPerMillion + output * pricing.outputPerMillion) / 1_000_000;
}

/**
 * OTLP/HTTP JSON 로그로 api_request 하나를 보낸다(끝점·머리글은 설정의 env에서, 관문이 읽는 꼴).
 * 끝점이 없으면 조용히 건너뛰고, 보내기가 실패해도 던지지 않는다(루프를 멈추지 않는다). 상태 문자열을 돌려준다
 */
export async function sendApiRequest(settings: InteractiveSettings, record: ApiRequestRecord): Promise<string> {
  const env = settings.env ?? {};
  const endpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (!endpoint) return 'skipped';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const pair of (env.OTEL_EXPORTER_OTLP_LOGS_HEADERS ?? '').split(',').filter(Boolean)) {
    const at = pair.indexOf('=');
    if (at < 0) continue;
    try {
      headers[pair.slice(0, at).trim()] = decodeURIComponent(pair.slice(at + 1).trim());
    } catch {
      // 해석할 수 없는 머리글 값은 보내지 않는다
    }
  }
  const str = (stringValue: string) => ({ stringValue });
  const int = (value: number) => ({ intValue: String(Math.round(value)) });
  const attributes = [
    { key: 'event.name', value: str('api_request') },
    { key: 'model', value: str(record.model) },
    { key: 'input_tokens', value: int(record.input) },
    { key: 'output_tokens', value: int(record.output) },
    { key: 'cache_read_tokens', value: int(record.cacheRead) },
    { key: 'cache_creation_tokens', value: int(record.cacheCreation) },
    ...(record.costUsd === undefined ? [] : [{ key: 'cost_usd', value: { doubleValue: record.costUsd } }]),
    { key: 'duration_ms', value: int(record.durationMs) },
    { key: 'request_id', value: str(record.requestId) },
  ];
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ attributes }] }] }] }),
      signal: AbortSignal.timeout(10_000),
    });
    return String(response.status);
  } catch (error) {
    return `error: ${error instanceof Error ? error.message : String(error)}`;
  }
}
