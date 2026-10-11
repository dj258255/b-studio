/**
 * 실험 기능을 드러낼지(B_STUDIO_EXPERIMENTAL). 기본은 숨긴다.
 *
 * 지원 범위는 단일 세션 + 로컬 CLI 백엔드(claude-code) + 로컬 Docker다(docs/status.md, ADR-166). 그 밖의 기능(작업 분해·여러 명 비교·
 * 나란히 보기, 운영 배포, 원격 브라우저, 디자인 비교 등)은 코드를 지우지 않고 화면과 에이전트 도구에서 기본으로 숨긴다.
 * 숨기는 것일 뿐 막는 것이 아니다 — API와 페이지 주소는 그대로 있고, 벤치와 E2E도 그대로 쓴다.
 */
export function experimentalEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.B_STUDIO_EXPERIMENTAL?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on';
}

/**
 * 관문 방식(이슈 #670, E17)을 쓸지(B_STUDIO_GATEWAY). 기본은 끈다.
 *
 * 켜면 claude-code 백엔드의 만들기 요청이 러너(`runClaudeCodeAgent`) 대신 `claude` CLI를 그대로 띄우는 경로(`runClaudeGatewayAgent`)로 돈다.
 * 화면에 드러내는 실험 기능(B_STUDIO_EXPERIMENTAL)과 따로 둔다 — 같은 세션에서 두 방식을 견주려면 이것만 바꿔야 한다.
 */
export function gatewayEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.B_STUDIO_GATEWAY?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on';
}
