import { currentDevStatus } from '@/lib/server/dev-status';

/**
 * 개발 서버(로컬 `next dev`)의 코드가 부팅 뒤 바뀌었는지 화면 배너가 물어보는 자리. 운영 빌드에서는
 * `currentDevStatus`가 항상 undefined를 돌려줘 `{ active: false }`가 된다. 로그인한 화면에서만 쓰므로
 * 그 밖의 라우트와 같이 평소 인증을 거친다(auth.ts의 PUBLIC_PATHS에 넣지 않는다).
 */
export async function GET() {
  const status = await currentDevStatus();
  return Response.json(status ? { active: true, ...status } : { active: false });
}
