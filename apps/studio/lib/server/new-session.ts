/**
 * 사람이 만드는 새 세션의 모델·노력 단계 기본값. 세션 만들기 라우트와 규칙으로 고른 세션(#822)이 같은 규칙을 쓴다.
 */
import type { SessionMode } from '../studio-events';
import { validateCommandCodeModelSelection } from './commandcode-models';
import { projectEffortDefault, projectModelDefault } from './model-defaults';
import { validateOpenCodeModelSelection } from './opencode-models';

export async function newSessionModel(projectId: string, backend: SessionMode, requestedModel: string | undefined): Promise<{ modelId?: string; effort?: string }> {
  // 요청이 모델을 따로 고르지 않았으면, 이 프로젝트·백엔드에서 대화로 마지막에 고른 모델을 새 세션의 기본값으로 쓴다.
  // 기록된 값이 "기본"(빈 문자열)이면 오버라이드가 없다는 뜻이므로 undefined로 되돌린다(레지스트리 id는 항상 비어 있지 않다)
  const requestedOrRemembered = (requestedModel ?? projectModelDefault(projectId, backend)) || undefined;
  // commandcode·opencode 백엔드에서는 고른 값이 그 CLI의 모델 id다. 목록에 있는 id만 받는다(목록을 못 불러오면 형식만 본다).
  // 서버 모드가 아니라 이 세션의 백엔드를 본다(레인이 서버 모드와 다른 백엔드를 고를 수 있다)
  const modelId =
    backend === 'commandcode'
      ? await validateCommandCodeModelSelection(requestedOrRemembered)
      : backend === 'opencode'
        ? await validateOpenCodeModelSelection(requestedOrRemembered)
        : requestedOrRemembered;
  // 노력 단계는 새 세션에서 직접 고를 수 없다(모델처럼 요청 바디로 받지 않는다) — 대화로 마지막에 고른 값만 이어받는다
  const effort = projectEffortDefault(projectId, backend) || undefined;
  return { ...(modelId ? { modelId } : {}), ...(effort ? { effort } : {}) };
}
