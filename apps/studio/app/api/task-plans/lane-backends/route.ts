import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { listSelectableModels } from '@/lib/server/model-picker';
import { selectableLaneBackends } from '@/lib/server/task-plans';
import type { SessionMode } from '@/lib/studio-events';

/**
 * 작업 분해 화면의 레인 백엔드·모델 선택기가 쓰는 자료.
 *  - backends: 이 서버에서 레인에 고를 수 있는 백엔드 목록("세션과 같음"은 화면이 따로 그린다)
 *  - picker: ?backend=로 넘긴 백엔드에서 고를 수 있는 모델·노력 단계(대화 입력창의 ModelPicker와 같은 자료)
 * backend를 생략하면 picker 없이 backends만 돌려준다(화면이 드롭다운을 먼저 그릴 때 쓴다).
 */
export async function GET(request: Request) {
  try {
    requireUser(request.headers);
    const url = new URL(request.url);
    const backends = selectableLaneBackends();
    const backend = url.searchParams.get('backend')?.trim();
    if (!backend) return Response.json({ backends });
    if (!backends.includes(backend as (typeof backends)[number])) {
      throw new StudioError(400, `이 서버에서 쓸 수 없는 백엔드입니다: ${backend} (쓸 수 있는 백엔드: ${backends.length > 0 ? backends.join(', ') : '없음'})`);
    }
    const current = url.searchParams.get('current')?.trim() || undefined;
    const effort = url.searchParams.get('effort')?.trim() || undefined;
    const picker = await listSelectableModels(backend as SessionMode, current, effort);
    return Response.json({ backends, picker });
  } catch (error) {
    return errorResponse(error);
  }
}
