import { requireUser } from '@/lib/server/access';
import {
  attachStatus,
  cancelLogin,
  checkAccountStatus,
  getLoginProgress,
  isCliAccountBackend,
  loginCommandFor,
  loginCommandText,
  startLogin,
} from '@/lib/server/cli-accounts';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { localFolderAllowed } from '@/lib/server/sessions';

type Context = RouteContext<'/api/accounts/[backend]/login'>;

function resolveBackend(backendParam: string) {
  if (!isCliAccountBackend(backendParam)) throw new StudioError(400, `알 수 없는 백엔드입니다: ${backendParam}`);
  return backendParam;
}

function requirePersonalMode(request: Request): void {
  requireUser(request.headers);
  if (!localFolderAllowed()) throw new StudioError(403, '계정 연결은 개인 PC 모드(로컬 CLI)에서만 씁니다');
}

/**
 * 로그인을 시작한다. TTY가 필요해 자동으로 띄울 수 없는 CLI(opencode)는 프로세스를 띄우지 않고
 * `{ spawnable: false, command }`만 돌려준다 — 화면은 이 값으로 "복사해서 터미널에서 실행" 안내를 보여준다.
 */
export async function POST(request: Request, context: Context) {
  try {
    requirePersonalMode(request);
    const backend = resolveBackend((await context.params).backend);
    const spec = loginCommandFor(backend);
    if (!spec.spawnable) return Response.json({ spawnable: false, command: loginCommandText(backend), note: spec.note });
    return Response.json({ spawnable: true, progress: startLogin(backend) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * 진행 상황(로그 줄·찾은 URL·코드·상태)을 폴링으로 읽는다. 프로세스가 이미 끝났고 아직 재확인하지 않았으면
 * 한 번만 preflight를 다시 불러 progress.status를 채운다(폴링마다 CLI를 다시 부르지 않는다).
 */
export async function GET(request: Request, context: Context) {
  try {
    requirePersonalMode(request);
    const backend = resolveBackend((await context.params).backend);
    const progress = getLoginProgress(backend);
    if (!progress) throw new StudioError(404, '시작한 로그인이 없습니다');
    if (progress.state !== 'running' && !progress.status) attachStatus(progress, await checkAccountStatus(backend));
    return Response.json({ progress });
  } catch (error) {
    return errorResponse(error);
  }
}

/** 진행 중인 로그인을 취소한다. 시작한 적 없거나 이미 끝났으면 404 */
export async function DELETE(request: Request, context: Context) {
  try {
    requirePersonalMode(request);
    const backend = resolveBackend((await context.params).backend);
    const progress = cancelLogin(backend);
    if (!progress) throw new StudioError(404, '취소할 로그인이 없습니다');
    return Response.json({ progress });
  } catch (error) {
    return errorResponse(error);
  }
}
