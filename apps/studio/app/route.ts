/**
 * 스튜디오의 첫 주소. 웹 화면은 없고(ADR-186) 터미널 작업대가 API로 붙는다.
 * 브라우저나 다른 도구가 이 주소를 열면 화면 대신 여는 법을 알린다
 */
export function GET() {
  return Response.json({ app: 'b-studio', error: '웹 화면은 없습니다. 터미널에서 pnpm studio로 엽니다' }, { status: 404 });
}
