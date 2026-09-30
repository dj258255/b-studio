/** 컨테이너 헬스체크. 인증 없이 서버 프로세스가 요청을 받는지만 알리고, Docker 연결처럼 느린 확인은 넣지 않는다 */
export function GET() {
  return Response.json({ status: 'ok' });
}

// 중첩 라우트(동적 세그먼트가 있는 API)가 스테일해도 이 최상위 라우트는 그대로 응답한다.
// 그 차이를 이용한 확인은 `app/api/health/routes/route.ts`에 있다.
