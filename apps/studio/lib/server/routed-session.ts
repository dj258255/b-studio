/**
 * 규칙으로 고른 AI로 새 세션을 만들고 첫 요청을 보낸다(#822). 플릿(fleets.ts)과 같은 순서다: 세션을 만들고 → 요청을 보낸다.
 * 세션은 사람이 만든 일반 세션처럼 샌드박스를 지연 기동한다(첫 만들기 요청이 켠다).
 */
import type { RuleIntent } from '../backend-rules';
import type { SessionMode, SessionSnapshot } from '../studio-events';
import { chooseBackend, type RoutingDecision } from './backend-rules';
import { assertDesignApprovedForRequest } from './design-pipeline';
import { StudioError } from './errors';
import { newSessionModel } from './new-session';
import { findProject } from './projects';
import { createSession, sendMessage } from './sessions';

export interface RoutedSession {
  session: SessionSnapshot;
  routing: RoutingDecision;
  /** 보낸 요청의 실행. 세션은 만들었는데 보내지 못했으면 없고 sendError에 까닭이 있다 */
  runId?: string;
  sendError?: string;
}

export async function startRoutedSession(input: { projectId: string; user: string; workspace: 'copy' | 'local'; request: string; intent: RuleIntent }): Promise<RoutedSession> {
  const request = input.request.trim();
  if (!request) throw new StudioError(400, '요청 내용을 입력하세요');
  const project = await findProject(input.projectId);
  if (!project) throw new StudioError(404, '프로젝트를 찾을 수 없습니다');
  const routing = await chooseBackend({ request, intent: input.intent, cwd: project.root });
  const backend = routing.backend as SessionMode;
  const { modelId, effort } = await newSessionModel(input.projectId, backend, routing.model);
  const session = await createSession(input.projectId, input.user, input.workspace, { modelId, effort, backend, boot: 'on-demand' });
  try {
    // 대화 창에서 보낸 요청과 같은 조건이다(messages 라우트). 설계 승인은 만들기 요청만 본다
    if (input.intent === 'build') await assertDesignApprovedForRequest(session.id, request);
    const { runId } = sendMessage(session.id, request, { allowBreaking: false, by: input.user, intent: input.intent, interactive: true, steering: true });
    return { session, routing, runId };
  } catch (error) {
    // 세션은 이미 만들어졌다. 지우지 않고 돌려줘 화면이 그 세션을 열고 까닭을 보이게 한다
    return { session, routing, sendError: error instanceof Error ? error.message : String(error) };
  }
}
