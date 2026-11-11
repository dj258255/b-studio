import { native } from './native';

/**
 * Node `execFile`처럼 던지되 출력이 바이트인 실행(ADR-195 4f A1). 체크포인트의 git 호출이 쓴다.
 * 던지는 조건은 옛 `execFile`과 같다: 비0 종료, 신호로 죽음(`code: null`), 시간 초과(`killed: true`), 출력이 `maxBuffer`를 넘음, 띄우기 실패.
 * 오류는 `stdout`·`stderr`(바이트)·`code`·`killed`를 가진다. 출력이 `maxBuffer`를 넘으면 `killed`는 false이고
 * `code`는 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`다(옛 `execFile`과 같다, 2026-11-11 Node에서 확인).
 * 띄우기 실패는 `code: 'ENOENT'`·`stderr`는 `spawn <bin> ENOENT`(`execChecked`와 같은 꼴).
 * 시간 초과·상한 넘김은 SIGTERM이고, 5초 안에 안 죽으면 SIGKILL이다.
 */
export class ExecBytesError extends Error {
  constructor(
    message: string,
    readonly code: number | string | null,
    readonly killed: boolean,
    readonly stdout: Buffer,
    readonly stderr: Buffer,
  ) {
    super(message);
    this.name = 'ExecBytesError';
  }
}

export interface ExecBytesOptions {
  cwd?: string;
  /** 주면 상속 없이 통째로 바꾼다 */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** 이 시간이 지나면 멈추고 던진다(옛 `execFile`의 `timeout`) */
  timeoutMs?: number;
  /** 각 출력(stdout·stderr)의 바이트 상한. 넘으면 던진다. 기본은 `execFile`의 기본값 1MiB */
  maxBuffer?: number;
  /** 표준 입력으로 넣을 바이트. 안 주면 stdin을 바로 닫는다 */
  input?: Buffer | string;
}

const DEFAULT_MAX_BUFFER = 1024 * 1024;
/** Rust 쪽이 받는 가장 큰 상한(스트림마다 256MiB). 이보다 큰 maxBuffer는 이 값으로 줄어 그 자리에서 멈춘다 */
const MAX_NATIVE_BUFFER = 256 * 1024 * 1024;

export function definedEnv(env?: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!env) return undefined;
  const defined: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) defined[name] = value;
  }
  return defined;
}

export async function execBytes(bin: string, args: readonly string[], options: ExecBytesOptions = {}): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const { cwd, env, signal, timeoutMs, maxBuffer = DEFAULT_MAX_BUFFER, input } = options;
  const timeout = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const signals = [signal, timeout].filter((item): item is AbortSignal => item !== undefined);
  const combined = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  // 상한은 읽는 중에 본다: 스트림마다 maxBuffer + 1 바이트에 닿으면 Rust가 자식을 멈춘다. 한 바이트 더 받아야 "넘었다"를 길이로 안다
  const result = await native.runCommandBytes(
    bin,
    [...args],
    input === undefined ? null : Buffer.from(input),
    definedEnv(env),
    cwd ?? null,
    Math.min(maxBuffer, MAX_NATIVE_BUFFER - 1) + 1,
    combined,
  );
  const command = [bin, ...args].join(' ');
  // napi는 None을 null이 아니라 undefined로 준다
  if (result.spawnError != null) {
    throw new ExecBytesError(`Command failed: ${command}\n${result.spawnError}`, 'ENOENT', false, result.stdout, Buffer.from(result.spawnError));
  }
  // 상한을 먼저 본다: 넘겨서 멈춘 것은 시간 초과·취소와 겹치지 않는다
  if (result.stdout.length > maxBuffer || result.stderr.length > maxBuffer) {
    throw new ExecBytesError(`maxBuffer length exceeded: ${command}`, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', false, result.stdout, result.stderr);
  }
  if (result.aborted) throw new ExecBytesError(`Command failed: ${command}\n${result.stderr.toString('utf8')}`, null, true, result.stdout, result.stderr);
  if (result.exitCode !== 0) {
    throw new ExecBytesError(`Command failed: ${command}\n${result.stderr.toString('utf8')}`, result.exitCode ?? null, false, result.stdout, result.stderr);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export interface ArchiveExtractOutcome {
  gitCode: number | null;
  tarCode: number | null;
  stderr: string;
  spawnError: string | null;
}

/**
 * `gitBin gitArgs | tar -x --no-same-owner -C dest`를 Rust가 두 프로세스를 파이프로 이어 돌린다(ADR-195 4f A1).
 * git은 `gitEnv`로 환경을 통째로 바꾸고 stdin을 닫는다. tar는 환경을 상속한다. 던지지 않는다 — 종료 코드(신호로 죽으면 null)를 읽는 쪽이 판단한다.
 * stderr는 git 것 뒤에 tar 것이고 합쳐 1MiB씩까지만 받는다.
 */
export async function execArchiveExtract(gitBin: string, gitArgs: readonly string[], gitEnv: NodeJS.ProcessEnv, dest: string): Promise<ArchiveExtractOutcome> {
  const result = await native.runArchiveExtract(gitBin, [...gitArgs], definedEnv(gitEnv) ?? {}, dest);
  return { gitCode: result.gitCode ?? null, tarCode: result.tarCode ?? null, stderr: result.stderr.toString('utf8'), spawnError: result.spawnError ?? null };
}
