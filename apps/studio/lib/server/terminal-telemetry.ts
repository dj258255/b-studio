/**
 * 터미널의 CLI가 보내는 OTLP/HTTP JSON 텔레메트리에서 "모델 요청 한 건"의 사용량만 꺼낸다(#726).
 *
 * claude는 `claude_code.api_request` 이벤트를, codex는 `codex.sse_event`(event.kind = response.completed)를 로그로 내보낸다(#825). 이벤트를 알아보는 꼴은 정해지지 않았으므로
 * 속성(`event.name`)과 본문(`body.stringValue`) 두 자리를 모두 본다. 값은 바깥에서 온 것이라 그대로 믿지 않는다 —
 * 숫자로 바꿀 수 없거나 음수·NaN·너무 큰 값이면 그 항목을 버린다.
 *
 * 이 파일은 순수 함수만 둔다(서버·CLI·도커를 부르지 않는다).
 */

/** CLI가 알려 온 모델 요청 한 건. 나머지는 여기서 더하고 골라 쓴다 */
export interface ApiRequestUsage {
  requestId?: string;
  promptId?: string;
  sessionId?: string;
  /** 모델 요청 시각(밀리초). 실행에 붙일 때 견준다 */
  at: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
  durationMs?: number;
}

/** 한 본문에서 꺼내는 항목의 상한. 텔레메트리 묶음 하나가 세션 기록을 채우지 않게 한다 */
const MAX_REQUESTS = 1_000;
/** 값의 상한. 이보다 큰 숫자는 바깥에서 온 잘못된 값으로 본다(토큰·시간·비용 어느 것도 10억을 넘지 않는다) */
const MAX_ATTRIBUTE = 1_000_000_000;
/** 이벤트를 알아보는 이름들. CLI가 보내는 꼴을 확신할 수 없어 둘 다 받는다 */
const API_REQUEST_EVENTS = new Set(['api_request', 'claude_code.api_request']);

/** OTLP/HTTP JSON 로그 본문에서 claude_code.api_request 이벤트만 꺼낸다. 모양이 틀린 항목은 건너뛴다 */
export function apiRequestsFromOtlp(body: unknown): ApiRequestUsage[] {
  const found: ApiRequestUsage[] = [];
  if (!isRecord(body)) return found;
  const resourceLogs = body.resourceLogs;
  if (!Array.isArray(resourceLogs)) return found;
  const now = Date.now();
  for (const resourceLog of resourceLogs) {
    if (found.length >= MAX_REQUESTS) break;
    const scopeLogs = asRecord(resourceLog)?.scopeLogs;
    if (!Array.isArray(scopeLogs)) continue;
    for (const scopeLog of scopeLogs) {
      if (found.length >= MAX_REQUESTS) break;
      const logRecords = asRecord(scopeLog)?.logRecords;
      if (!Array.isArray(logRecords)) continue;
      for (const record of logRecords) {
        if (found.length >= MAX_REQUESTS) break;
        const usage = apiRequestFromRecord(record, now);
        if (usage) found.push(usage);
      }
    }
  }
  return found;
}

/** 로그 레코드 하나에서 사용량을 꺼낸다. api_request가 아니거나 값이 이상하면 없다 */
function apiRequestFromRecord(value: unknown, now: number): ApiRequestUsage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const attributes = attributesOf(record);
  if (isCodexCompleted(attributes)) return codexUsageFromRecord(record, attributes, now);
  if (!isApiRequest(record, attributes)) return undefined;

  const model = stringValue(attributes.get('model'));
  const input = numeric(attributes.get('input_tokens'));
  const output = numeric(attributes.get('output_tokens'));
  const cacheRead = numeric(attributes.get('cache_read_tokens'));
  const cacheWrite = numeric(attributes.get('cache_creation_tokens'));
  const cost = numeric(attributes.get('cost_usd'));
  const duration = numeric(attributes.get('duration_ms'));
  // 필수 속성이 없으면 0으로 채우지 않고 버린다. 빠진 값을 "0을 썼다"로 오해하면 실제보다 싸 보인다
  if (!model || !input.seen || !output.seen || !cacheRead.seen || !cacheWrite.seen) return undefined;
  // 값이 있지만 이상하면(음수·NaN·너무 큼) 그 레코드도 버린다
  if ([input, output, cacheRead, cacheWrite, cost, duration].some((entry) => entry.seen && !entry.ok)) return undefined;
  const requestId = stringValue(attributes.get('request_id'));
  const promptId = stringValue(attributes.get('prompt.id'));
  const sessionId = stringValue(attributes.get('session.id'));

  return {
    at: timestamp(record, now),
    model,
    inputTokens: input.value,
    outputTokens: output.value,
    cacheReadTokens: cacheRead.value,
    cacheWriteTokens: cacheWrite.value,
    ...(requestId ? { requestId } : {}),
    ...(promptId ? { promptId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(cost.seen ? { costUsd: cost.value } : {}),
    ...(duration.seen ? { durationMs: duration.value } : {}),
  };
}

/** codex가 응답 하나를 다 받은 기록인가. 같은 응답에 토큰 수가 없는 기록이 먼저 오므로, 토큰 수가 있는 것만 받는다 */
function isCodexCompleted(attributes: Map<string, unknown>): boolean {
  return stringValue(attributes.get('event.name')) === 'codex.sse_event' && stringValue(attributes.get('event.kind')) === 'response.completed' && attributes.has('input_token_count');
}

/**
 * codex의 응답 하나(#825). OpenAI의 입력 토큰은 캐시 읽기를 포함하므로 빼서 claude와 같은 뜻(캐시 밖 입력)으로 맞춘다.
 * 출력 토큰은 추론 토큰을 포함한 그대로 둔다. CLI가 비용을 보내지 않으므로 비용은 단가로 환산한다.
 * 요청 번호가 없어 대화 번호와 이벤트 시각으로 같은 응답을 가른다
 */
function codexUsageFromRecord(record: Record<string, unknown>, attributes: Map<string, unknown>, now: number): ApiRequestUsage | undefined {
  const model = stringValue(attributes.get('model'));
  const input = numeric(attributes.get('input_token_count'));
  const output = numeric(attributes.get('output_token_count'));
  const cached = numeric(attributes.get('cached_token_count'));
  const cacheWrite = numeric(attributes.get('cache_write_token_count'));
  const duration = numeric(attributes.get('duration_ms'));
  if (!model || !input.seen || !output.seen || !cached.seen) return undefined;
  if ([input, output, cached, cacheWrite, duration].some((entry) => entry.seen && !entry.ok)) return undefined;
  // 캐시 읽기가 입력보다 많으면 두 값 중 하나가 틀렸다. 어느 쪽인지 모르니 버린다
  if (cached.value > input.value) return undefined;
  const conversation = stringValue(attributes.get('conversation.id'));
  const at = stringValue(attributes.get('event.timestamp'));
  return {
    at: timestamp(record, now),
    model,
    inputTokens: input.value - cached.value,
    outputTokens: output.value,
    cacheReadTokens: cached.value,
    cacheWriteTokens: cacheWrite.seen ? cacheWrite.value : 0,
    ...(conversation && at ? { requestId: `${conversation}:${at}` } : {}),
    ...(conversation ? { sessionId: conversation } : {}),
    ...(duration.seen ? { durationMs: duration.value } : {}),
  };
}

/** 이벤트 이름이 api_request인지. 속성과 본문 두 자리를 모두 본다 */
function isApiRequest(record: Record<string, unknown>, attributes: Map<string, unknown>): boolean {
  const fromAttribute = stringValue(attributes.get('event.name'));
  if (fromAttribute !== undefined && API_REQUEST_EVENTS.has(fromAttribute)) return true;
  const fromBody = stringValue(record.body);
  return fromBody !== undefined && API_REQUEST_EVENTS.has(fromBody);
}

/** OTLP AnyValue(속성 값)를 숫자로 바꾼다. 없으면 seen: false, 값이 이상하면 seen: true에 ok: false */
function numeric(raw: unknown): { seen: boolean; ok: boolean; value: number } {
  if (raw === undefined) return { seen: false, ok: false, value: 0 };
  const number = anyValueToNumber(raw);
  const ok = number !== undefined && Number.isFinite(number) && number >= 0 && number <= MAX_ATTRIBUTE;
  return { seen: true, ok, value: ok ? number! : 0 };
}

/** intValue(문자열일 수 있음)·doubleValue·숫자 꼴 stringValue를 숫자로 바꾼다. 아니면 없다 */
function anyValueToNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ['intValue', 'doubleValue'] as const) {
    const raw = record[key];
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
    if (typeof raw === 'string') {
      const parsed = Number(raw.trim());
      if (raw.trim() !== '' && Number.isFinite(parsed)) return parsed;
    }
  }
  if (typeof record.stringValue === 'string') {
    const text = record.stringValue.trim();
    const parsed = Number(text);
    if (text !== '' && Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** 로그 레코드의 시각(밀리초). timeUnixNano → observedTimeUnixNano → 받은 시각. 0은 값이 없다는 뜻이다(codex가 0을 보낸다) */
function timestamp(record: Record<string, unknown>, now: number): number {
  for (const key of ['timeUnixNano', 'observedTimeUnixNano'] as const) {
    const raw = record[key];
    if (raw === '0' || raw === 0) continue;
    if (typeof raw === 'string' && /^\d+$/.test(raw)) {
      try {
        return Number(BigInt(raw) / 1_000_000n);
      } catch {
        return now;
      }
    }
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.floor(raw / 1_000_000);
  }
  return now;
}

function attributesOf(record: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  if (!Array.isArray(record.attributes)) return map;
  for (const entry of record.attributes) {
    const attribute = asRecord(entry);
    if (!attribute || typeof attribute.key !== 'string') continue;
    map.set(attribute.key, attribute.value);
  }
  return map;
}

function stringValue(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record && typeof record.stringValue === 'string') return record.stringValue;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
