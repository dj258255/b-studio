import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { listStudioOpenCodeModels } from '@/lib/server/opencode-models';

/** OpenCode 모델 목록. 세션을 만들 때 고를 수 있는 모델과 무료만 모드 여부를 내려준다 */
export async function GET(request: Request) {
  try {
    requireUser(request.headers);
    return Response.json(await listStudioOpenCodeModels());
  } catch (error) {
    return errorResponse(error);
  }
}
