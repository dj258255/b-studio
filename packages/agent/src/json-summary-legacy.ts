/** 옮기기 전(ADR-191 3단계 3af 이전)의 json-summary.ts 요약 원본. 차등 시험의 기준으로만 쓴다 */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `배열(${value.length.toLocaleString('ko-KR')})`;
  return typeof value;
}

/** 배열의 첫 항목이 객체면 "키: 타입" 나열, 원시값이거나 배열이면 보여줄 필드가 없다(undefined) */
function describeFirstItemFields(first: unknown): string | undefined {
  if (!first || typeof first !== 'object' || Array.isArray(first)) return undefined;
  const entries = Object.entries(first as Record<string, unknown>).map(([key, value]) => `${key}: ${describeType(value)}`);
  return entries.length > 0 ? entries.join(', ') : undefined;
}

/** 이미 파싱한 JSON 값의 최상위 모양을 요약 문장으로 만든다 */
export function legacySummarizeJsonStructure(parsed: unknown): string {
  if (Array.isArray(parsed)) {
    const base = `배열, ${parsed.length.toLocaleString('ko-KR')}개 항목`;
    const fields = describeFirstItemFields(parsed[0]);
    return fields ? `${base} · 첫 항목 필드: ${fields}` : base;
  }
  if (parsed && typeof parsed === 'object') {
    const entries = Object.entries(parsed as Record<string, unknown>).map(([key, value]) => (Array.isArray(value) ? `${key} ${value.length.toLocaleString('ko-KR')}개` : key));
    return entries.length > 0 ? entries.join(', ') : '(빈 객체)';
  }
  return String(parsed);
}

/** 문자열을 JSON으로 풀어 구조를 요약한다. JSON이 아니면(파싱 실패) undefined — 호출하는 쪽이 다른 미리보기로 대신한다 */
export function legacySummarizeJsonContent(content: string): string | undefined {
  try {
    return legacySummarizeJsonStructure(JSON.parse(content));
  } catch {
    return undefined;
  }
}

