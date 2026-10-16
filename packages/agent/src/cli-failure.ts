import { stripAnsi } from '@b-studio/sandbox';

/**
 * 로컬 CLI 확인 명령(`codex login status`·`cmd status` 등)이 실패했을 때의 결과.
 *
 * - `summary`: 사람이 할 일을 적은 한국어 한 문장. 계정 연결 화면은 이것만 앞에 보인다
 * - `detail`: CLI가 찍은 원문(`Command failed: …`와 표준에러). 색 코드는 지운다. 화면은 접어 두고 필요할 때 연다
 * - `reason`: 둘을 이은 한 줄. 세션 시작 실패·CLI 명령처럼 한 문장만 보여 주는 곳이 쓴다
 */
export interface CliPreflightFailure {
  ok: false;
  reason: string;
  /** 확인 함수를 바꿔 끼운 테스트·예전 호출자는 reason만 줄 수 있다 */
  summary?: string;
  detail?: string;
}

/** CLI 실행 오류를 화면에 옮길 수 있는 글로 바꾼다. 색·커서 같은 터미널 제어 코드를 지운다 */
export function describeCliError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return stripAnsi(raw).trim();
}

export function cliPreflightFailure(summary: string, error: unknown): CliPreflightFailure {
  const detail = describeCliError(error);
  return { ok: false, reason: detail ? `${summary} (${detail})` : summary, summary, detail };
}
