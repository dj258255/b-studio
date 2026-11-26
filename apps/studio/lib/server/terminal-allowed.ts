/**
 * 세션 터미널을 열 수 있는 서버인지 가르는 판정. sessions.ts(여는 자리)와 /api/health(`pnpm studio`가 desk를 열기 전에 보는 표시)가
 * 같은 판정을 쓰도록 이 작은 모듈에 둔다 — health는 sessions.ts·session-terminal.ts의 무거운 의존(sandbox, child_process)을 끌어오지 않는다.
 */
import { experimentalEnabled } from '@b-studio/agent';
import { authConfig } from './auth';

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

/** 세션 터미널을 열 수 있는 서버인가. 판정은 resolveTerminalMode 한 곳이다(막는 쪽 호출자들이 쓴다) */
export function sessionTerminalAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return resolveTerminalMode(env).allowed;
}
