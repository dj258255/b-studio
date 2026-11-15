/**
 * 세션 터미널을 열 수 있는 서버인지 가르는 판정. sessions.ts(여는 자리)와 /api/health(`pnpm studio`가 desk를 열기 전에 보는 표시)가
 * 같은 판정을 쓰도록 이 작은 모듈에 둔다 — health는 sessions.ts·session-terminal.ts의 무거운 의존(sandbox, child_process)을 끌어오지 않는다.
 */
import { experimentalEnabled } from '@b-studio/agent';
import { localFolderAllowed } from './repo-token';

/**
 * B_STUDIO_TERMINAL을 읽는다. 비었거나 host면 'host'(기본값, ADR-173 덧붙임), container면 'container', 그 밖은 undefined.
 * 모르는 값을 던지는 것은 여는 자리(session-terminal.ts의 sessionTerminalMode)의 일이고, 여기서는 판정에 쓸 값만 돌려준다
 */
export function terminalModeSetting(env: Record<string, string | undefined> = process.env): 'host' | 'container' | undefined {
  const value = env.B_STUDIO_TERMINAL?.trim();
  if (!value || value === 'host') return 'host';
  if (value === 'container') return 'container';
  return undefined;
}

/**
 * 세션 터미널은 에이전트 CLI를 서버 컴퓨터에서 띄우므로(이 컴퓨터 방식) 또는 호스트에 닿는 컨테이너를 쓰므로 인증을 끈 개인 PC에서만 연다.
 * 이 컴퓨터 방식은 지원 경로라 실험 기능 없이 연다(ADR-200). 컨테이너 방식은 실험이라 B_STUDIO_EXPERIMENTAL을 켰을 때만 연다.
 * 모르는 값도 실험 기능을 켰을 때만 참이다 — 켜 두면 여는 자리에서 설정 오류로 던지고, 꺼 두면 조용히 이 컴퓨터 방식으로 떨어지지 않고 닫힌다
 */
export function sessionTerminalAllowed(env: Record<string, string | undefined> = process.env): boolean {
  if (!localFolderAllowed()) return false;
  return terminalModeSetting(env) === 'host' || experimentalEnabled(env);
}
