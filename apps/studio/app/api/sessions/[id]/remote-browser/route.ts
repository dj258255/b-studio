import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import {
  closeRemoteBrowser,
  inputRemoteBrowser,
  pickRemoteBrowser,
  RemoteBrowserError,
  remoteBrowserRequestSchema,
  startRemoteBrowser,
} from '@/lib/server/remote-browsers';
import { recoverSessions, remoteBrowserAllowedOrigins, remoteBrowserUrl, saveElementArtifact } from '@/lib/server/sessions';

/** 뷰포트를 정하지 않았을 때의 크기. agent의 기본 뷰포트와 같다 */
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/**
 * 서버 소유 원격 브라우저를 시작·중지·조작한다.
 * 세션을 바꾸는 권한(만든 사람과 관리자)으로 제한하고, 입력은 zod로 좁게 검증한다
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/remote-browser'>) {
  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    // 원격 브라우저는 샌드박스를 조작하는 일이라 세션을 바꿀 수 있는 사람만 쓴다
    await authorizeSession(id, user);
    const parsed = remoteBrowserRequestSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, `원격 브라우저 요청이 올바르지 않습니다: ${parsed.error.issues[0]?.message ?? '형식 오류'}`);
    const body = parsed.data;

    switch (body.action) {
      case 'start': {
        const url = remoteBrowserUrl(id, body.service);
        // 프론트가 다른 포트의 백엔드를 부르므로 세션의 모든 서비스 출처를 허용한다. 그 밖으로는 브라우저가 나가지 못한다
        const allowedOrigins = remoteBrowserAllowedOrigins(id);
        const opened = await startRemoteBrowser(id, { service: body.service, url, viewport: body.viewport ?? DEFAULT_VIEWPORT, allowedOrigins });
        return Response.json(opened);
      }
      case 'stop':
        await closeRemoteBrowser(id);
        return Response.json({ ok: true });
      case 'input':
        await inputRemoteBrowser(id, body.input);
        return Response.json({ ok: true });
      case 'pick': {
        const pick = await pickRemoteBrowser(id, body.x, body.y);
        // 잘라 낸 스크린샷은 세션 산출물로 남기고 식별자만 돌려준다
        const screenshotArtifact = await saveElementArtifact(id, { name: pick.selector, data: pick.screenshot, contentType: 'image/png' });
        return Response.json({ selector: pick.selector, html: pick.html, css: pick.css, screenshotArtifact });
      }
    }
  } catch (error) {
    if (error instanceof RemoteBrowserError) return errorResponse(new StudioError(error.status, error.message));
    return errorResponse(error);
  }
}
