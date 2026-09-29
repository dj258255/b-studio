/**
 * 과제별 수용 확인. 통합 세션이 게이트를 통과했더라도 사용자가 요청한 결과가 실제 HTTP 응답에 나오는지 확인한다.
 */
import type { AcceptanceCheck } from './tasks';

export interface AcceptanceResult {
  check: string;
  ok: boolean;
  status?: number;
  detail: string;
}

export type AcceptanceFetcher = (url: URL, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 30_000;
const BODY_SNIPPET = 200;

export async function runAcceptance(
  checks: AcceptanceCheck[],
  urls: Record<'api' | 'web', string | undefined>,
  fetcher: AcceptanceFetcher = fetch,
): Promise<AcceptanceResult[]> {
  const results: AcceptanceResult[] = [];
  for (const check of checks) {
    const label = `${check.service} ${check.path}`;
    const base = urls[check.service];
    if (!base) {
      results.push({ check: label, ok: false, detail: '서비스 URL 없음' });
      continue;
    }

    let response: Response;
    try {
      response = await fetcher(new URL(check.path, base), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      results.push({ check: label, ok: false, detail: `요청 실패: ${describe(error)}` });
      continue;
    }

    const body = await response.text().catch(() => '');
    const snippet = plainText(body).slice(0, BODY_SNIPPET);
    if (response.status !== 200) {
      results.push({ check: label, ok: false, status: response.status, detail: `상태 ${response.status} · 본문: ${snippet}` });
      continue;
    }

    const missing = (check.expectAll ?? []).filter((text) => !body.includes(text));
    const anyPresent = !check.expectAny?.length || check.expectAny.some((text) => body.includes(text));
    if (missing.length > 0 || !anyPresent) {
      const reason = missing.length > 0 ? `문구 누락: ${missing.join(', ')}` : `기대 문구 없음: ${(check.expectAny ?? []).join(' 또는 ')}`;
      results.push({ check: label, ok: false, status: response.status, detail: `${reason} · 본문: ${snippet}` });
      continue;
    }

    results.push({ check: label, ok: true, status: response.status, detail: `HTTP 200 · 본문: ${snippet}` });
  }
  return results;
}

/** HTML 태그를 걷어내고 공백을 하나로 모은다 */
function plainText(body: string): string {
  return body
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
