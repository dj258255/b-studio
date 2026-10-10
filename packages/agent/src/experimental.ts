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
