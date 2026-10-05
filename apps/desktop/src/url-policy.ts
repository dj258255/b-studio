/**
 * 주소 정책(순수 함수).
 *
 * 앱 안에서 여는 것은 **이 PC의 스튜디오·미리보기 주소**뿐이다. 그 밖의 주소는 앱 안에서 열지 않는다 —
 * http/https면 기본 브라우저로 넘기고, 나머지(file:·javascript: 등)는 거부한다.
 * 화면의 링크 이동(will-navigate)·새 창(setWindowOpenHandler)에도 같은 판단을 쓴다.
 */

export type UrlDecision =
  /** 앱 안에서 연다 */
  | { kind: 'app'; url: string }
  /** 기본 브라우저로 넘긴다 */
  | { kind: 'external'; url: string }
  /** 열지 않는다. 이유는 도구 막대에 보여 준다 */
  | { kind: 'reject'; reason: string };

/** 스킴이 있는 입력(http://, file:, javascript: …) */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
/** `localhost:3000`처럼 스킴 없이 호스트·포트만 쓴 입력. `localhost:`는 URL 파서가 스킴으로 읽어 버린다 */
const LOOPBACK_INPUT = /^(?:localhost|127\.0\.0\.1|\[::1\]|\[0:0:0:0:0:0:0:1\])(?::\d{1,5})?(?:\/.*)?$/i;
/** 숫자만 쓴 입력은 미리보기 포트로 본다 */
const PORT_ONLY = /^\d{1,5}$/;

/** 앱 안에서 열어도 되는 호스트. 이 PC의 루프백만이다 */
export function isLocalHost(hostname: string): boolean {
  const name = hostname.toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '::1' || name === '[::1]';
}

/** 절대 주소 하나에 대한 판단 */
export function decideUrl(url: string): UrlDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'reject', reason: `주소를 알아볼 수 없습니다: ${url}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'reject', reason: `앱 안에서 열지 않는 주소입니다: ${parsed.protocol}` };
  }
  if (isLocalHost(parsed.hostname)) return { kind: 'app', url: parsed.href };
  // 외부 사이트는 앱 안에 가두지 않고 기본 브라우저로 넘긴다(로그인·비밀번호 관리자가 그쪽에 있다)
  return { kind: 'external', url: parsed.href };
}

/**
 * 도구 막대에 입력한 한 줄을 판단한다. 정규화 규칙:
 *   - `localhost:3000`·`127.0.0.1:3100/x` → `http://`를 붙인다
 *   - `3100`(숫자만) → `http://127.0.0.1:3100/` (미리보기 포트로 가기 쉽게)
 *   - `/sessions/abc`·`sessions/abc` → 스튜디오 주소 기준 상대 경로
 *   - 그 밖의 스킴(http/https)은 호스트로 허용·외부·거부를 가른다
 */
export function decideInput(text: string, baseUrl: string): UrlDecision {
  const normalized = normalizeInput(text, baseUrl);
  if ('reason' in normalized) return { kind: 'reject', reason: normalized.reason };
  return decideUrl(normalized.url);
}

/** 입력 한 줄을 절대 주소로 정규화한다. 실패하면 이유를 돌려준다 */
export function normalizeInput(text: string, baseUrl: string): { url: string } | { reason: string } {
  const trimmed = text.trim();
  if (!trimmed) return { reason: '주소를 입력하세요' };
  // 스킴이 있는 것처럼 보이지만(URL 파서가 `localhost:`를 스킴으로 읽는다) 로컬 주소인 입력을 먼저 받는다
  if (LOOPBACK_INPUT.test(trimmed)) return parse(`http://${trimmed}`, baseUrl);
  if (PORT_ONLY.test(trimmed)) {
    const port = Number(trimmed);
    if (port < 1 || port > 65_535) return { reason: `포트 번호가 범위를 벗어났습니다: ${trimmed}` };
    return { url: `http://127.0.0.1:${port}/` };
  }
  // 스킴이 없으면 스튜디오 주소 기준 상대 경로다
  return parse(trimmed, baseUrl);
}

function parse(input: string, baseUrl: string): { url: string } | { reason: string } {
  let url: URL;
  try {
    url = new URL(input, baseUrl);
  } catch {
    return { reason: `주소를 알아볼 수 없습니다: ${input}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { reason: `앱 안에서 열지 않는 주소입니다: ${url.protocol}` };
  }
  return { url: url.href };
}
