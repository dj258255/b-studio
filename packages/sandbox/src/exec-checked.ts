import { runCommand } from './stream-exec';

/**
 * Node `execFile`처럼 던지는 호출을 `runCommand`(던지지 않는다) 위에 얹는다(ADR-193, 2c-7).
 * 던지는 조건은 옛 `execFile`과 같다: 비0 종료, 시간 초과·취소, 출력이 `maxBuffer`를 넘음, 띄우기 실패.
 * 던지는 오류는 `stdout`·`stderr`·`code`를 가진다(옛 오류와 같은 이름이라 `describe`·`failureReason`이 그대로 읽는다).
 * 단, 띄우기 실패의 `stderr`는 비지 않고 `spawn <bin> ENOENT` 꼴이며 `code`는 숫자 1이다(옛 오류는 `code: 'ENOENT'`).
 */
export class ExecCheckedError extends Error {
  constructor(
    message: string,
    readonly code: number | string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'ExecCheckedError';
  }
}

export interface ExecCheckedOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** 이 시간이 지나면 자식을 죽이고 던진다(옛 `execFile`의 `timeout`) */
  timeoutMs?: number;
  /** 각 출력(stdout·stderr)의 바이트 상한. 넘으면 던진다. 기본은 `execFile`의 기본값 1MiB */
  maxBuffer?: number;
  /** 표준 입력으로 넣을 글. 안 주면 stdin을 바로 닫는다 */
  input?: string;
}

const DEFAULT_MAX_BUFFER = 1024 * 1024;
/** Rust 쪽이 받는 가장 큰 상한(스트림마다 256MiB). 이보다 큰 maxBuffer는 이 값으로 줄어 그 자리에서 멈춘다 */
const MAX_NATIVE_BUFFER = 256 * 1024 * 1024;

export async function execChecked(bin: string, args: readonly string[], options: ExecCheckedOptions = {}): Promise<{ stdout: string; stderr: string }> {
  const { cwd, env, signal, timeoutMs, maxBuffer = DEFAULT_MAX_BUFFER, input } = options;
  const signals = [signal, timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)].filter((item): item is AbortSignal => item !== undefined);
  const combined = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  // 상한은 읽는 중에 본다: Rust가 스트림마다 maxBuffer + 1 바이트에 닿으면 자식을 멈춘다. 한 바이트 더 받아야 "넘었다"를 길이로 안다
  const result = await runCommand(bin, [...args], { signal: combined, env, cwd, input, maxBuffer: Math.min(maxBuffer, MAX_NATIVE_BUFFER - 1) + 1 });
  const command = [bin, ...args].join(' ');
  // 취소·시간 초과는 부분 출력과 exitCode 1로 돌아온다. 정상 종료와 겹치지 않게 신호를 먼저 본다
  if (combined?.aborted && result.exitCode !== 0) throw new ExecCheckedError(`Command failed: ${command}\n${result.stderr}`, 'ABORT_ERR', result.stdout, result.stderr);
  if (Buffer.byteLength(result.stdout) > maxBuffer || Buffer.byteLength(result.stderr) > maxBuffer) {
    throw new ExecCheckedError(`maxBuffer length exceeded: ${command}`, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', result.stdout, result.stderr);
  }
  if (result.exitCode !== 0) throw new ExecCheckedError(`Command failed: ${command}\n${result.stderr}`, result.exitCode, result.stdout, result.stderr);
  return { stdout: result.stdout, stderr: result.stderr };
}
