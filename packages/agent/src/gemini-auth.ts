import { run } from './cli-exec';
import { cliPreflightFailure, type CliPreflightFailure } from './cli-failure';

/** 실제 실행할 CLI. 이 PC에 설치된 `gemini`를 그대로 쓴다 */
export const COMMAND = 'gemini';

/**
 * 샌드박스를 띄우기 전에 이 PC의 Gemini CLI가 있는지 확인한다. `gemini --version`만 부르므로 모델 호출도, 사용량도 쓰지 않는다.
 * 로그인 여부까지 확인하는 공식 명령을 찾지 못해(0단계 한계), CLI 존재만 확인한다 — 설치 안 됨과 로그인 안 됨을
 * 구분하지 못할 수 있다(opencode 러너의 preflight와 같은 한계).
 */
export async function preflightGemini({ command = COMMAND, timeoutMs = 60_000 }: { command?: string; timeoutMs?: number } = {}): Promise<{ ok: true } | CliPreflightFailure> {
  try {
    await run(command, ['--version'], timeoutMs);
    return { ok: true };
  } catch (error) {
    return cliPreflightFailure(`Gemini CLI를 찾지 못했습니다. 터미널에서 "${command}"가 실행되는지, 로그인돼 있는지 확인하세요.`, error);
  }
}
