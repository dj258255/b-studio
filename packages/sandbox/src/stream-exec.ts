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
