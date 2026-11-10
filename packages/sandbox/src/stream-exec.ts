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
 * `cwd`를 주면 그 폴더에서 돈다(2c-7). `maxBuffer`를 주면 읽는 중에 그 상한에서 멈춘다. 던지는 `execFile`이 필요한 자리는 `exec-checked.ts`의 `execChecked`가 이 위에서 던진다.
 */
export function runCommand(
  bin: string,
  args: string[],
  { signal, env, input, cwd, maxBuffer }: StreamExecOptions & { input?: string; cwd?: string; maxBuffer?: number } = {},
): Promise<ExecResult> {
  // maxBuffer를 주면 스트림마다 그 바이트에 닿는 순간 Rust가 자식을 멈춘다(주지 않으면 256MB). 다 읽은 뒤에 재지 않는다
  return native.runCommand(bin, args, input ?? null, definedEnv(env), cwd ?? null, maxBuffer ?? null, signal);
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

/** 양방향 exec 세션 하나(2c-4b). 출력은 바이트 그대로, 종료는 마지막 출력 뒤에 한 번 온다 */
export interface ExecSession {
  /** stdin에 쓴다. 닫힌 뒤의 쓰기는 조용히 버리고 false */
  write(data: Buffer | string): boolean;
  /** stdin을 닫는다(EOF) */
  end(): void;
  /** SIGTERM을 보낸다 */
  terminate(): void;
}

/**
 * `bin args`를 띄워 stdin·stdout·stderr를 양방향으로 잇는다(2c-4b). agent-terminal의 `docker exec -i`가 쓴다.
 * `onData`는 stdout·stderr의 바이트가 오는 대로, `onExit`는 두 출력이 끝난 뒤 한 번(종료 코드, 시그널로 죽었으면 null) 불린다.
 * 띄우기 실패는 던지지 않고 `onExit(-2)`로 온다(Node `close`의 ENOENT와 같다).
 * 콜백은 ThreadsafeFunction이라 호출한 틱이 끝난 뒤에야 온다 — 같은 틱에서 콜백을 붙이는 쪽은 사건을 놓치지 않는다.
 */
export function openExecSession(
  bin: string,
  args: string[],
  { env, cwd, onData, onExit }: { env?: NodeJS.ProcessEnv; cwd?: string; onData: (chunk: Buffer) => void; onExit: (code: number | null) => void },
): ExecSession {
  const session = new native.ExecSession(bin, args, definedEnv(env), cwd ?? null, (event) => {
    if (event.exited) onExit(event.code ?? null);
    else if (event.data) onData(event.data);
  });
  return {
    write: (data) => session.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : data),
    end: () => session.end(),
    terminate: () => session.terminate(),
  };
}
