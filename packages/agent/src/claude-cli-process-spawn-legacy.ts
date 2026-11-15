import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { childEnv, DEFAULT_KILL_AFTER_MS, DEFAULT_TERM_AFTER_MS, resolveCliCommand } from './claude-cli-process';
import type { ClaudeCliProcess, CliExit, CliMessage, CliStopOptions } from './claude-cli-process';

/**
 * Rust로 옮기기 전(ADR-195 4f A8a) `claude-cli-process.ts`의 `spawnClaudeCli`(자식 프로세스 입출력: 띄우기·줄 나누기·표준 오류 끝부분·닫기 단계·끝 상태)를
 * `node:child_process`·`node:readline` 위의 구현 그대로 복사한 것이다. 차등 시험(`claude-cli-process-differential.test.ts`)의 기준이다.
 * 4g에서 지운다. 쓰는 곳은 시험뿐이다. 실행 파일 고르기(`resolveCliCommand`)와 PATH 정리(`childEnv`)는 옮기기 전부터 Rust 판정이라 그쪽 것을 그대로 쓴다.
 */

const STDERR_KEEP = 2_000;

export function spawnClaudeCliLegacy(options: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; stop?: CliStopOptions }): ClaudeCliProcess {
  const termAfterMs = options.stop?.termAfterMs ?? DEFAULT_TERM_AFTER_MS;
  const killAfterMs = options.stop?.killAfterMs ?? DEFAULT_KILL_AFTER_MS;
  // 실행 파일 경로와 인자는 배열로만 넘긴다(셸을 거치지 않는다)
  let resolved: string;
  try {
    // 프로젝트 루트(cwd) 안의 실행 파일은 고르지 않는다
    resolved = resolveCliCommand(options.command, options.env, options.cwd);
  } catch (error) {
    return failedProcess(error as Error);
  }
  // 자식이 PATH로 다시 찾는 인터프리터도 프로젝트 안의 것이 잡히지 않게 PATH를 정리해 넘긴다
  const child = spawn(resolved, [...options.args], { cwd: options.cwd, env: childEnv(options.env, options.cwd), stdio: ['pipe', 'pipe', 'pipe'] });
  // 입력 쪽이 먼저 닫혀도(CLI가 바로 끝난 경우) 실행 전체가 예외로 죽지 않게 한다. 실패는 결과 없음으로 드러난다
  child.stdin.on('error', () => {});
  let inputClosed = false;
  let termTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let termSent = false;
  let alive = true;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEEP);
  });

  const exited = new Promise<CliExit>((resolve) => {
    let spawnError: Error | undefined;
    child.once('error', (error) => {
      spawnError = error;
      // 띄우지 못하면 close가 오지 않을 수 있다
      if (child.pid === undefined) {
        alive = false;
        resolve({ code: null, signal: null, error });
      }
    });
    child.once('close', (code, signal) => {
      alive = false;
      clearTimeout(termTimer);
      clearTimeout(killTimer);
      resolve({ code, signal, ...(spawnError ? { error: spawnError } : {}) });
    });
  });

  const closeInput = (): void => {
    if (inputClosed) return;
    inputClosed = true;
    child.stdin.end();
  };
  const sendTerm = (): void => {
    if (!alive || termSent) return;
    termSent = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (alive) child.kill('SIGKILL');
    }, killAfterMs);
  };

  return {
    async *messages() {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) yield parsed as CliMessage;
      }
    },
    send(text) {
      if (inputClosed) return;
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })}\n`);
    },
    closeInput,
    stop(mode) {
      closeInput();
      if (!alive || termSent) return;
      if (mode === 'now') {
        clearTimeout(termTimer);
        termTimer = undefined;
        sendTerm();
        return;
      }
      termTimer ??= setTimeout(sendTerm, termAfterMs);
    },
    exited,
    stderrTail: () => stderr,
  };
}

/** 띄우지 못한 프로세스: 메시지 없이 곧바로 끝나고 exited에 오류를 싣는다(spawn이 실행 파일을 못 찾은 경우와 같은 흐름) */
function failedProcess(error: Error): ClaudeCliProcess {
  return {
    async *messages() {},
    send() {},
    closeInput() {},
    stop() {},
    exited: Promise.resolve({ code: null, signal: null, error }),
    stderrTail: () => '',
  };
}
