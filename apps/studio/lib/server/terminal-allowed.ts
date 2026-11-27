/**
 * 세션 터미널을 열 수 있는 서버인지 가르는 판정. sessions.ts(여는 자리)와 /api/health(`pnpm studio`가 desk를 열기 전에 보는 표시)가
 * 같은 판정을 쓰도록 이 작은 모듈에 둔다 — health는 sessions.ts·session-terminal.ts의 무거운 의존(sandbox, child_process)을 끌어오지 않는다.
 */
import { experimentalEnabled } from '@b-studio/agent';
import { authConfig } from './auth';
import { StudioError } from './errors';

export type TerminalMode = 'container' | 'host';

/**
 * 세션 터미널 판정의 결과. 열 수 있는지(허용)와 어느 방식으로 여는지(방식)를 한 번에 읽어 돌려준다.
 * 닫힌 결과에도 방식(설정이 올바를 때만)이 실린다 — 열지 못하는 서버에서도 방식을 보는 자리(정리, 관문 주소)가 있다
 */
export type TerminalModeResolution = { allowed: true; mode: TerminalMode } | { allowed: false; reason: string; mode?: TerminalMode };

/**
 * 세션 터미널 판정의 유일한 자리. 인증 방식, B_STUDIO_TERMINAL, 실험 기능 스위치를 여기서 한 번만 읽는다.
 * "열 수 있는가"(sessionTerminalAllowed)와 "어느 방식으로 여는가"(sessionTerminalMode, 백엔드 선택, 관문 바인딩)가 같은 입력을 다르게 읽지 않도록 모두 이 함수에서 나온다.
 *
 * - 인증을 끈 개인 PC(none)에서만 연다. 인증을 켰거나(token·proxy) 인증 설정이 틀리면 닫는다.
 * - B_STUDIO_TERMINAL이 비었거나 host면 이 컴퓨터 방식(지원 경로, 실험 기능 없이 연다, ADR-200·ADR-173 덧붙임).
 * - container는 실험이라 B_STUDIO_EXPERIMENTAL을 켰을 때만 연다.
 * - 그 밖의 값(오타)은 닫는다. 조용히 이 컴퓨터 방식으로 떨어지지 않고, 실험 기능을 켜도 열지 않는다
 */
export function resolveTerminalMode(env: Record<string, string | undefined> = process.env): TerminalModeResolution {
  const value = env.B_STUDIO_TERMINAL?.trim();
  const mode: TerminalMode | undefined = !value || value === 'host' ? 'host' : value === 'container' ? 'container' : undefined;
  if (!mode) return { allowed: false, reason: `B_STUDIO_TERMINAL은 container, host 중 하나여야 합니다 (지금 값: ${value})` };
  let authOff = false;
  try {
    authOff = authConfig(env).mode === 'none';
  } catch {
    authOff = false;
  }
  if (!authOff) return { allowed: false, reason: '세션 터미널은 인증을 끈 개인 PC 모드에서만 씁니다', mode };
  if (mode === 'container' && !experimentalEnabled(env)) return { allowed: false, reason: '컨테이너 방식 세션 터미널은 B_STUDIO_EXPERIMENTAL=1이 필요합니다', mode };
  return { allowed: true, mode };
}

/**
 * Command Code 세션을 터미널로 띄울 수 없는 까닭(실험, ADR-233). 띄울 수 있으면 undefined다. 열린 것은 둘이 모두 맞을 때뿐이다:
 * 이 컴퓨터 방식(컨테이너에는 commandcode가 없고 mod를 붙이는 길도 없다)이고 실험 기능 스위치(B_STUDIO_EXPERIMENTAL)가 켜져 있다.
 * 방식은 부르는 쪽이 정한 값을 받는다(`sessionTerminalMode`가 모르는 방식은 던진다) — 이 판정은 그 값을 다시 읽지 않는다
 */
export function commandCodeTerminalReason(mode: TerminalMode, env: Record<string, string | undefined> = process.env): string | undefined {
  if (mode !== 'host') return 'Command Code 세션은 이 컴퓨터 방식 터미널(B_STUDIO_TERMINAL=host)에서만 띄웁니다. 컨테이너 방식은 지원하지 않습니다';
  if (!experimentalEnabled(env)) return 'Command Code 세션 터미널은 실험 기능이라 B_STUDIO_EXPERIMENTAL=1이 필요합니다';
  return undefined;
}

/**
 * Gemini CLI 세션을 터미널로 띄울 수 없는 까닭(실험, ADR-242). 띄울 수 있으면 undefined다. 열린 것은 둘이 모두 맞을 때뿐이다:
 * 이 컴퓨터 방식(컨테이너에는 gemini가 없고 훅을 붙이는 길도 없다)이고 실험 기능 스위치(B_STUDIO_EXPERIMENTAL)가 켜져 있다.
 * 방식은 부르는 쪽이 정한 값을 받는다(`sessionTerminalMode`가 모르는 방식은 던진다) — 이 판정은 그 값을 다시 읽지 않는다
 */
export function geminiTerminalReason(mode: TerminalMode, env: Record<string, string | undefined> = process.env): string | undefined {
  if (mode !== 'host') return 'Gemini 세션은 이 컴퓨터 방식 터미널(B_STUDIO_TERMINAL=host)에서만 띄웁니다. 컨테이너 방식은 지원하지 않습니다';
  if (!experimentalEnabled(env)) return 'Gemini 세션 터미널은 실험 기능이라 B_STUDIO_EXPERIMENTAL=1이 필요합니다';
  return undefined;
}

/** 세션 터미널을 열 수 있는 서버인가. 판정은 resolveTerminalMode 한 곳이다(막는 쪽 호출자들이 쓴다) */
export function sessionTerminalAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return resolveTerminalMode(env).allowed;
}

/**
 * 컨테이너 홈 볼륨을 나눌 사용자. 인증을 끈 개인 PC 방식이면 없다(옛 볼륨 이름 유지, 다시 로그인하지 않는다).
 * 그 밖의 방식(token·proxy, 모르는 값 포함)이면 세션 주인이다 — 모르는 방식은 사용자별로 가르는 쪽으로 틀린다.
 * session-terminal.ts가 아니라 여기 두는 까닭: 시험 파일 여럿이 session-terminal을 통째로 가짜로 바꾸므로, sessions.ts가 쓰는 판정은 가짜로 바뀌지 않는 이 모듈에 둔다
 */
export function terminalHomeUser(authMode: string, owner: string | undefined): string | undefined {
  if (authMode === 'none') return undefined;
  // 주인을 모르면 다른 사용자의 볼륨(또는 프로젝트 공용 볼륨)을 대신 쓰지 않고 연결하지 않는다
  if (!owner) throw new StudioError(409, '세션 주인을 알 수 없어 컨테이너 터미널의 홈 볼륨을 정할 수 없습니다');
  return owner;
}
