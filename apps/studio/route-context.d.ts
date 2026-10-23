/**
 * 라우트 핸들러의 두 번째 인자 타입. Next의 typegen이 만들던 전역 `RouteContext<'/api/x/[id]'>`를 대신한다(ADR-188).
 * 경로 패턴의 `[name]`은 문자열, `[...name]`은 문자열 배열로 푼다. 값은 server/router.ts가 주소에서 뽑아 넘긴다
 */
type RouteParamsOf<P extends string> = P extends `${string}[${infer Name}]${infer Rest}`
  ? (Name extends `...${infer Spread}` ? { [K in Spread]: string[] } : { [K in Name]: string }) & RouteParamsOf<Rest>
  : unknown;

type RouteContext<P extends string> = { params: Promise<{ [K in keyof RouteParamsOf<P>]: RouteParamsOf<P>[K] }> };
