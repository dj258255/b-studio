/**
 * 중첩 라우트가 실제로 살아 있는지 확인한다. 오래 켜둔 dev 서버가 병합을 여러 번 겪으면
 * 최상위 라우트(`/api/health`, `/api/folders`)는 응답해도 `/api/projects/open`·`/api/sessions/[id]` 같은
 * 중첩 라우트는 라우트 표가 스테일해 HTML 404를 돌려주는 경우가 있었다. 데스크톱 셸(`apps/cli`의
 * `studio launch`)이 이 라우트로 그 차이를 확인해 스테일하면 서버를 다시 켠다.
 * 컨테이너 헬스체크와 같은 이유로 인증은 요구하지 않는다.
 */
export function GET() {
  return Response.json({ ok: true });
}
