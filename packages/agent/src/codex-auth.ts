import { execFile } from 'node:child_process';
import { cliPreflightFailure, type CliPreflightFailure } from './cli-failure';

/**
 * 샌드박스를 띄우기 전에 이 PC의 Codex CLI가 로그인돼 있는지 확인한다.
 * `codex login status`만 부르므로 모델 호출도, 사용량도 쓰지 않는다. 토큰·계정 정보는 읽지 않는다.
 */
export async function preflightCodex(
  { command = 'codex', timeoutMs = 60_000, env }: { command?: string; timeoutMs?: number; /** 계정마다 CODEX_HOME을 따로 둘 때 준다(#885). 없으면 process.env */ env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: true } | CliPreflightFailure> {
  try {
    await run(command, ['login', 'status'], timeoutMs, env);
    return { ok: true };
  } catch (error) {
    return cliPreflightFailure(`Codex CLI에 로그인돼 있지 않습니다. 터미널에서 "codex"를 실행해 "Sign in with ChatGPT"로 로그인하세요.`, error);
  }
}

export function run(command: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, ...(env ? { env } : {}) }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}
