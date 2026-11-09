import { native } from './native';
import type { ExecResult } from './types';

/**
 * 자식 프로세스의 출력을 파일로 흘리거나(`runCommandToFile`) 파일을 입력으로 넣는다(`runCommandFromFile`).
 * 판정과 syscall은 Rust(`crates/bstudio-io`)가 하고 여기는 JS 값을 바꿔 넘긴다(ADR-193, 2c-1). 동작:
 *  - 잡는 출력은 1MiB(UTF-16 코드 단위)까지, 넘치면 `\n... output truncated ...`를 붙인다.
 *  - `env`를 주면 상속 없이 통째로 바꾼다(Node `spawn`의 `env`와 같다). 안 주면 상속한다.
 *  - `signal`로 취소하면 자식을 죽이고 Promise가 거절한다.
 */
interface StreamExecOptions {
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/** `NodeJS.ProcessEnv`에서 값이 정의된 쌍만 추린다. `env`가 없으면 undefined(상속) */
function definedEnv(env?: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!env) return undefined;
  const defined: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) defined[name] = value;
  }
  return defined;
}

export function runCommandToFile(bin: string, args: string[], outputFile: string, { signal, env }: StreamExecOptions = {}): Promise<ExecResult> {
  return native.runCommandToFile(bin, args, outputFile, definedEnv(env), signal);
}

export function runCommandFromFile(bin: string, args: string[], inputFile: string, { signal, env }: StreamExecOptions = {}): Promise<ExecResult> {
  return native.runCommandFromFile(bin, args, inputFile, definedEnv(env), signal);
}

/**
 * `bin args`를 한 번 돌려 stdout·stderr를 모은다(2c-2, #1043). `#docker`가 쓴다.
 * 던지지 않는다 — 비0 종료·취소·spawn 실패·maxBuffer 초과 모두 결과로 돌려준다(옛 `execFileAsync` + `isExecFailure`와 같다).
 * `signal`로 취소하면 거절하지 않고 그때까지의 부분 출력과 `exitCode: 1`을 돌려준다(`stats`의 timeout-cutoff 보존).
 */
export function runCommand(bin: string, args: string[], { signal, env, input }: StreamExecOptions & { input?: string } = {}): Promise<ExecResult> {
  return native.runCommand(bin, args, input ?? null, definedEnv(env), signal);
}

const NOOP_LINE = (): void => {};

/**
 * `bin args`를 돌리되 출력을 줄 단위로 `onLine`에 흘리고 뒤쪽 200K를 모아 돌려준다(2c-3a, #1045). deploy의 `#docker`가 쓴다.
 * `onLine`은 완성된 줄마다(`trim`이 비지 않으면) 불리고, 끝의 조각도 한 번 불린다. 없으면 모으기만 한다.
 * `cwd`를 받는다. `runCommand`와 같이 던지지 않는다 — 취소 시 부분 출력과 `exitCode: 1`을 돌려준다.
 */
export function runCommandStreaming(
  bin: string,
  args: string[],
  { signal, env, input, cwd, onLine }: StreamExecOptions & { input?: string; cwd?: string; onLine?: (line: string) => void } = {},
): Promise<ExecResult> {
  return native.runCommandStreaming(bin, args, input ?? null, definedEnv(env), cwd ?? null, onLine ?? NOOP_LINE, signal);
}

/**
 * `bin args`(= `docker compose logs ...`)의 stdout을 줄 단위로 당겨 주는 AsyncIterator다(2c-3b, #1047). compose-provider의 `logs()`가 쓴다.
 * 당기기(pull) 모델이라 소비자가 다음 줄을 받을 때까지 docker 읽기가 막힌다(백프레셔) — `--follow`로 끝없이 흘러도 안 샌다.
 * raw 줄만 흘린다(개행 제외). stderr는 버린다. `signal`이 깨거나 소비자가 `break`하면 자식을 kill한다.
 */
export function runCommandLogStream(
  bin: string,
  args: string[],
  { signal, env, cwd }: StreamExecOptions & { cwd?: string } = {},
): AsyncIterableIterator<string> {
  return new native.LogStream(bin, args, definedEnv(env), cwd ?? null, signal);
}
