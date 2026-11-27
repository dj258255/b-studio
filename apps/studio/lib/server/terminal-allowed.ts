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
export type TerminalModeResolution = { allowed: true; mode: TerminalMode } | { allowed: false; reason: string; mode?: TerminalMode; server?: true };

/**
 * 인증을 켠 서버 방식(token·proxy)에서 세션 터미널을 열어도 된다고 운영자가 따로 적는 스위치(#1473). 정확히 `1`일 때만 켠다.
 * 서버 방식 터미널은 실제 환경에서 재 본 기록이 아직 없어서(AGENTS.md "지원 범위와 실험 기능") 기본이 꺼짐이다.
 * 인증을 끈 개인 PC는 이 값을 보지 않는다
 */
export const SERVER_TERMINAL_ENV = 'B_STUDIO_SERVER_TERMINAL';

/**
 * 세션 터미널 판정의 유일한 자리. 인증 방식, B_STUDIO_TERMINAL, 실험 기능 스위치, 서버 방식 스위치를 여기서 한 번만 읽는다.
 * "열 수 있는가"(sessionTerminalAllowed)와 "어느 방식으로 여는가"(sessionTerminalMode, 백엔드 선택, 관문 바인딩)가 같은 입력을 다르게 읽지 않도록 모두 이 함수에서 나온다.
 *
 * 허용 목록이다 — 아래에 적은 조합만 열고, 모르는 값·망가진 설정은 모두 닫는다.
 * - 인증을 끈 개인 PC(none):
 *   - B_STUDIO_TERMINAL이 비었거나 host면 이 컴퓨터 방식(지원 경로, 실험 기능 없이 연다, ADR-200·ADR-173 덧붙임).
 *   - container는 실험이라 B_STUDIO_EXPERIMENTAL을 켰을 때만 연다.
 * - 인증을 켠 서버 방식(token·proxy): 셋이 모두 맞을 때만 연다. 이 컴퓨터 방식(host)은 서버 컴퓨터에서 사용자의 CLI를 돌리게 되므로 어떤 경우에도 닫는다.
 *   1. 운영자가 B_STUDIO_SERVER_TERMINAL=1을 적었다.
 *   2. B_STUDIO_TERMINAL=container를 **적었다**(비어 있어서 host로 읽히는 것을 컨테이너로 바꿔 읽지 않는다).
 *   3. B_STUDIO_EXPERIMENTAL=1(컨테이너 방식은 실험이다).
 * - 인증 설정이 틀리면(authConfig가 던짐) 닫는다. B_STUDIO_TERMINAL의 오타도 닫는다: 조용히 이 컴퓨터 방식으로 떨어지지 않고, 실험 기능을 켜도 열지 않는다
 */
export function resolveTerminalMode(env: Record<string, string | undefined> = process.env): TerminalModeResolution {
  const value = env.B_STUDIO_TERMINAL?.trim();
  const mode: TerminalMode | undefined = !value || value === 'host' ? 'host' : value === 'container' ? 'container' : undefined;
  if (!mode) return { allowed: false, reason: `B_STUDIO_TERMINAL은 container, host 중 하나여야 합니다 (지금 값: ${value})` };
  let authMode: string | undefined;
  try {
    authMode = authConfig(env).mode;
  } catch {
    authMode = undefined;
  }
  if (authMode === 'none') {
    if (mode === 'container' && !experimentalEnabled(env)) return { allowed: false, reason: '컨테이너 방식 세션 터미널은 B_STUDIO_EXPERIMENTAL=1이 필요합니다', mode };
    return { allowed: true, mode };
  }
  if (authMode !== 'token' && authMode !== 'proxy') return { allowed: false, reason: '세션 터미널은 개인 PC 모드에서만 씁니다(인증 설정을 읽지 못했습니다)', mode };
  // 인증을 켠 서버 방식. 앞 순서에서 틀린 쪽의 까닭부터 알린다
  if (!serverTerminalEnabled(env)) {
    return { allowed: false, reason: `세션 터미널은 개인 PC 모드에서만 씁니다. 인증을 켠 서버 방식에서는 운영자가 ${SERVER_TERMINAL_ENV}=1로 켜야 합니다(컨테이너 방식, B_STUDIO_TERMINAL=container, B_STUDIO_EXPERIMENTAL=1도 필요합니다)`, mode, server: true };
  }
  if (!value || value !== 'container') {
    return { allowed: false, reason: '인증을 켠 서버 방식의 세션 터미널은 컨테이너 안에서만 돕니다. B_STUDIO_TERMINAL=container를 적으세요(이 컴퓨터 방식은 서버 방식에서 쓰지 않습니다)', mode, server: true };
  }
  if (!experimentalEnabled(env)) return { allowed: false, reason: '서버 방식의 컨테이너 세션 터미널은 B_STUDIO_EXPERIMENTAL=1이 필요합니다', mode, server: true };
  return { allowed: true, mode: 'container' };
}

/** 운영자가 서버 방식 세션 터미널을 켰는가. 정확히 `1`만 켠다(true·yes·0은 켜지 않는다) */
export function serverTerminalEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[SERVER_TERMINAL_ENV]?.trim() === '1';
}

/**
 * 세션 터미널을 쓸 수 없을 때 사용자에게 보일 글. 개인 PC에서 컨테이너 방식이 실험 기능 때문에 닫힌 것은 옛 문구를 그대로 쓰고,
 * 인증을 켠 서버 방식이면 판정이 적은 까닭(스위치·방식·실험 기능 중 틀린 것)을 보인다. 열 수 있는 서버에서 부르면 옛 문구다
 */
export function terminalClosedMessage(env: Record<string, string | undefined> = process.env): string {
  const resolved = resolveTerminalMode(env);
  if (!resolved.allowed && resolved.server) return resolved.reason;
  return '세션 터미널은 개인 PC 모드에서만 씁니다(컨테이너 방식은 B_STUDIO_EXPERIMENTAL=1도 필요합니다)';
}

/**
 * 컨테이너 방식 터미널이 띄울 수 있는 백엔드(허용 목록, ADR-245): claude-code(홈 볼륨에 설치)와 codex(에이전트 이미지)뿐이다.
 * api(자체 CLI)는 모델 키를 에이전트가 읽을 수 있는 자리에 둘 수밖에 없어 닫고, 모르는 이름도 거짓이다. 시험이 session-terminal을 통째로 가짜로 바꾸므로 이 모듈에 둔다
 */
export function containerRunnableBackend(backend: string): boolean {
  return backend === 'claude-code' || backend === 'codex';
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
 * OpenCode 세션을 터미널로 띄울 수 없는 까닭(실험, ADR-241). 띄울 수 있으면 undefined다. 열린 것은 둘이 모두 맞을 때뿐이다:
 * 이 컴퓨터 방식(컨테이너에는 opencode가 없고 플러그인을 붙이는 길도 없다)이고 실험 기능 스위치(B_STUDIO_EXPERIMENTAL)가 켜져 있다.
 * 방식은 부르는 쪽이 정한 값을 받는다(`sessionTerminalMode`가 모르는 방식은 던진다) — 이 판정은 그 값을 다시 읽지 않는다
 */
export function openCodeTerminalReason(mode: TerminalMode, env: Record<string, string | undefined> = process.env): string | undefined {
  if (mode !== 'host') return 'OpenCode 세션은 이 컴퓨터 방식 터미널(B_STUDIO_TERMINAL=host)에서만 띄웁니다. 컨테이너 방식은 지원하지 않습니다';
  if (!experimentalEnabled(env)) return 'OpenCode 세션 터미널은 실험 기능이라 B_STUDIO_EXPERIMENTAL=1이 필요합니다';
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
