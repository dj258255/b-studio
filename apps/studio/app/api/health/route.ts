/** 컨테이너 헬스체크. 인증 없이 서버 프로세스가 요청을 받는지만 알리고, Docker 연결처럼 느린 확인은 넣지 않는다 */
export function GET() {
  return Response.json({ status: 'ok' });
}
