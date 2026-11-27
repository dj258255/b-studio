import { requireUser } from './access';
import { authConfig, isLoopbackHost } from './auth';
import { cookieValue } from './cookies';
import { StudioError } from './errors';
import { hasLocalToken, LOCAL_TOKEN_COOKIE } from './local-token';
import { recoverSessions } from './sessions';
import { resolveTerminalMode } from './terminal-allowed';

/**
 * 세션 터미널 통로의 공통 검사(#673, B4). 터미널 통로가 둘(한 세션용, 나란히 보기의 묶음용)이라
 * 같은 규칙을 두 번 쓰지 않도록 한 곳에 둔다. 두 통로가 이 함수들을 함께 쓴다
 */

/**
 * 터미널 통로 앞부분의 검사 순서(두 통로가 같은 순서를 쓰게 한 곳에 둔다):
 * 이 컴퓨터 주소 → 로컬 토큰 → 사용자 → 세션 복구 → (그다음 각 통로가 id마다 권한·자리를 본다).
 * 복구를 권한 확인보다 먼저 부르지 않으면, 스튜디오를 다시 띄운 뒤 세션 표가 채워지기 전에 첫 요청이 와서 없는 세션처럼 보인다
 */
export async function assertTerminalAccess(headers: Headers): Promise<string> {
  assertLocalRequest(headers);
  assertLocalToken(headers);
  const user = requireUser(headers);
  await recoverSessions();
  return user;
}

/**
 * 터미널은 컨테이너 안의 셸에 닿는 통로다. 이 컴퓨터의 주소로 들어온 요청만 받는다.
 * 개인 PC 모드에는 인증이 없어서, 다른 사이트가 자기 도메인을 127.0.0.1로 풀리게 하면(DNS 리바인딩) 같은 출처로 보인다.
 *
 * 예외는 하나다: 인증을 켠 서버 방식이고 운영자가 서버 방식 세션 터미널을 켜 둔 서버(`resolveTerminalMode`가 허용)에서는 다른 주소로 온 요청도 받는다.
 * 사용자가 서버에 원격으로 붙는 것이 그 방식의 뜻이고, 그 요청의 근거는 주소가 아니라 로그인이다(이어지는 `requireUser`가 로그인 헤더를 요구하고,
 * 터미널을 움직이는 쓰기는 `authorizeSessionOwner`가 만든 사람만 받는다). 허용 목록이라 이 예외는 판정이 "열림"이라고 답한 때만 적용된다 —
 * 인증 설정을 읽지 못하거나 스위치가 꺼졌거나 이 컴퓨터 방식이면 옛 규칙(이 컴퓨터의 주소만)을 그대로 쓴다.
 * 인증을 켠 서버가 닫혀 있는데 다른 주소로 온 요청이면, 이 컴퓨터 주소 안내 대신 닫힌 까닭을 적어 거절한다
 */
export function assertLocalRequest(headers: Headers): void {
  const resolved = resolveTerminalMode();
  if (authMode() !== 'none' && authMode() !== undefined) {
    if (resolved.allowed) return;
    if (!isLoopbackHost(headers)) throw new StudioError(403, resolved.reason);
    return;
  }
  if (!isLoopbackHost(headers)) throw new StudioError(403, '세션 터미널은 이 컴퓨터의 주소(127.0.0.1 · localhost)로 연 화면에서만 씁니다');
}

/** 인증 방식. 설정이 틀려 읽지 못하면 undefined다(호출한 쪽은 "인증을 켠 서버"로 세지 않는다) */
function authMode(): string | undefined {
  try {
    return authConfig().mode;
  } catch {
    return undefined;
  }
}

/**
 * 개인 PC 모드의 터미널 통로는 `studio launch`가 심은 로컬 토큰 쿠키가 있어야 쓴다(ADR-173 덧붙임).
 * 같은 컴퓨터의 다른 프로세스가 스튜디오 포트로 보내는 요청을 가릴 수단이 인증에는 없기 때문이다. 인증을 켠 서버(token·proxy)는 로그인으로 충분하다
 */
export function assertLocalToken(headers: Headers): void {
  if (authConfig().mode !== 'none') return;
  if (!hasLocalToken(cookieValue(headers, LOCAL_TOKEN_COOKIE))) {
    throw new StudioError(403, '터미널은 `pnpm studio launch`가 연 창에서 씁니다. 다른 창이면 launch가 찍은 주소로 여세요');
  }
}

/** Cookie 헤더에서 이름 하나의 값을 꺼낸다(쿠키 도우미로 옮겼고, 옛 import를 위해 다시 내보낸다) */
export { cookieValue } from './cookies';
