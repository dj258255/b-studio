import { authConfig, canManage, LOCAL_USER, USER_HEADER } from './auth';
import { StudioError } from './errors';
import { getSnapshot, recoverSessions } from './sessions';

/**
 * 앞단(스튜디오 서버의 인증 판단, server/app.ts)이 확인해 넣은 사용자. 인증을 켰는데 없으면 앞단을 거치지 않은 요청이므로 거부한다.
 * 앞단이 막더라도 데이터를 다루는 라우트에서 한 번 더 확인한다
 */
export function requireUser(requestHeaders: Headers): string {
  if (authConfig().mode === 'none') return LOCAL_USER;
  const user = requestHeaders.get(USER_HEADER);
  if (!user) throw new StudioError(401, '로그인이 필요합니다');
  return user;
}

/** 세션을 바꾸는 요청. 인증을 켜면 세션을 만든 사람이나 관리자만 할 수 있다 */
export async function authorizeSession(id: string, user: string): Promise<void> {
  await recoverSessions();
  const snapshot = getSnapshot(id);
  // 없는 세션은 각 동작이 404로 알린다
  if (!snapshot || canManage(user, snapshot.owner, authConfig())) return;
  throw new StudioError(
    403,
    snapshot.owner ? `이 세션은 ${snapshot.owner}님이 만들었습니다. 만든 사람이나 관리자만 바꿀 수 있습니다` : '만든 사람이 기록되지 않은 세션이라 관리자만 바꿀 수 있습니다',
  );
}

export function canManageSession(user: string, owner: string | undefined): boolean {
  return canManage(user, owner, authConfig());
}
