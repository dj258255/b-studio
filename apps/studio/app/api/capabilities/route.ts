import { requireUser } from '@/lib/server/access';
import { studioCapabilities } from '@/lib/server/capabilities';
import { errorResponse } from '@/lib/server/errors';

/**
 * 지금 이 스튜디오가 쓸 수 있는 방식(한 명·여러 명 비교·나눠서 병렬)과 세션 백엔드 목록.
 * 화면이 이 모양에 기대므로 필드 이름을 바꾸지 않는다(테스트로 고정).
 */
export function GET(request: Request) {
  try {
    requireUser(request.headers);
    return Response.json(studioCapabilities());
  } catch (error) {
    return errorResponse(error);
  }
}
