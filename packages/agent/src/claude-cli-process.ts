import { decodeNative, native } from '@b-studio/sandbox';
import type { NativeCliProcess } from '@b-studio/sandbox';

/**
 * `claude` CLI 자식 프로세스를 공개 입출력(`-p --input-format stream-json --output-format stream-json`)으로 다루는 얇은 층.
 * 쓰는 것은 문서에 있는 것뿐이다: 표준 입력의 사용자 메시지 줄, 표준 출력의 줄 단위 JSON, 표준 입력 닫기, SIGTERM.
 * (SDK가 쓰는 control_request 같은 제어 메시지는 공식 문서에 없어 쓰지 않는다 — ADR-189.)
 * 근거: https://code.claude.com/docs/en/headless (스트리밍 출력·SIGTERM으로 멈추기),
 * https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode (스트리밍 입력의 사용자 메시지 꼴)
 */

/** CLI의 stream-json 한 줄에서 이 러너가 읽는 필드. 모르는 type·필드는 무시한다 */
export interface CliMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  claude_code_version?: string;
  mcp_servers?: Array<{ name?: string; status?: string }>;
  mcp_server_errors?: Array<{ name?: string; type?: string; message?: string }>;
  status?: string | null;
  parent_tool_use_id?: string | null;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  stop_reason?: string | null;
  duration_api_ms?: number;
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
  message?: {
    id?: string;
    content?: unknown;
    usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  };
  compact_metadata?: { trigger: 'manual' | 'auto'; pre_tokens: number; post_tokens?: number; duration_ms?: number };
}

/** 표준 입력을 닫은 뒤 SIGTERM을 보내기까지, SIGTERM 뒤 SIGKILL까지 기다리는 시간 */
export const DEFAULT_TERM_AFTER_MS = 10_000;
export const DEFAULT_KILL_AFTER_MS = 5_000;

export interface CliStopOptions {
  termAfterMs?: number;
  killAfterMs?: number;
}

export interface CliExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** 프로세스를 띄우지 못했다(실행 파일 없음 등) */
  error?: Error;
}

export interface ClaudeCliProcess {
  /** 표준 출력의 JSON 줄. JSON이 아니거나 객체가 아닌 줄은 건너뛴다. 프로세스의 출력이 끝나면 끝난다 */
  messages(): AsyncIterable<CliMessage>;
  /** 사용자 메시지 한 줄을 표준 입력으로 보낸다. 입력을 닫은 뒤에는 무시한다 */
  send(text: string): void;
  /** 표준 입력을 닫는다. CLI는 하던 턴을 마치고 스스로 끝난다 */
  closeInput(): void;
  /**
   * 끝내 달라고 한다. graceful: 입력을 닫고 termAfterMs 뒤에도 살아 있으면 SIGTERM, 그 뒤 killAfterMs 뒤에도 살아 있으면 SIGKILL.
   * now: 입력을 닫자마자 SIGTERM(진행 중인 턴을 끝까지 기다리지 않는다). 이미 graceful로 불렀어도 now로 당길 수 있다
   */
  stop(mode: 'graceful' | 'now'): void;
  exited: Promise<CliExit>;
  /** 표준 오류의 마지막 부분(잘라서 실패 메시지에 넣는다) */
  stderrTail(): string;
}

function notFound(command: string, why: string): Error {
  return Object.assign(new Error(`spawn ${command} ENOENT: ${why}`), { code: 'ENOENT' });
}

/**
 * CLI 실행 파일을 절대 경로로 찾는다(막는 쪽). 자식 프로세스는 cwd를 프로젝트 루트로 띄우므로, spawn에 이름만 넘기면 PATH의 빈 항목·`.`·상대 항목이
 * 프로젝트 폴더(에이전트가 파일을 쓰는 곳)로 풀려 심어 둔 실행 파일이 b-studio의 권한으로 돈다. 그래서:
 *  - 경로가 든 명령은 절대 경로만 받는다(상대 경로는 cwd 기준이라 거절).
 *  - 이름만 든 명령은 `env`의 PATH에서 절대 항목만 차례로 본다(빈 항목·상대 항목은 건너뛴다). 실행할 수 있는 파일만 고른다.
 *  - `forbiddenRoot`(프로젝트 루트)가 있으면 그 폴더 안에 있는 후보는 버린다(글자 그대로의 경로, 링크를 따라간 경로, 폴더의 식별자로 본다. 읽지 못하면 안으로 본다).
 * 못 찾으면 ENOENT로 던진다(띄우지 않는다).
 * 판정과 파일 상태 읽기(실제 경로·파일 종류·실행 권한)는 모두 Rust가 한다(crates/bstudio-io/src/cli_command.rs). 돌려주는 글자 하나로 읽고 그 글자를 그대로 spawn이 쓰므로
 * 확인한 경로와 띄우는 경로가 같다(ADR-191 3ac).
 */
export function resolveCliCommand(command: string, env: NodeJS.ProcessEnv, forbiddenRoot?: string): string {
  const found = decodeNative<{ path?: string; reason?: string }>(native.cliResolveCommand(command, env[pathKeyOf(env)], forbiddenRoot));
  if (found.path === undefined) throw notFound(command, found.reason ?? '실행 파일을 찾지 못했습니다');
  return found.path;
}

function pathKeyOf(env: NodeJS.ProcessEnv): string {
  return process.platform === 'win32' ? (Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH') : 'PATH';
}

/**
 * 자식에게 넘길 환경(막는 쪽). PATH에서 빈 항목·상대 항목과, `forbiddenRoot`가 있으면 그 폴더 안인 항목(읽지 못한 항목 포함)을 뺀다.
 * 실행 파일을 절대 경로로 띄워도 `#!/usr/bin/env node` 같은 스크립트는 자식의 PATH에서 인터프리터를 다시 찾는다.
 * cwd가 프로젝트 루트라 `.`·빈 항목이 남으면 에이전트가 심은 `node`가 돈다(커밋 보안 검토 지적). 나머지 환경 변수는 그대로 둔다.
 */
export function childEnv(env: NodeJS.ProcessEnv, forbiddenRoot?: string): NodeJS.ProcessEnv {
  const key = pathKeyOf(env);
  const value = env[key];
  if (value === undefined) return { ...env };
  return { ...env, [key]: native.cliChildPath(value, forbiddenRoot) };
}

/** 소비한 줄을 이만큼 모아 Rust에 알린다(큐를 다 비우면 모자라도 알린다) */
const CONSUMED_BATCH = 64;

/** Node `setTimeout`이 받는 값의 규칙(1 미만·너무 큰 값·숫자가 아닌 값은 1ms). 옛 구현의 타이머와 같게 맞춘다 */
export function timerMs(ms: number): number {
  return ms >= 1 && ms <= 2 ** 31 - 1 ? ms : 1;
}

/** Node가 띄우기 실패에 주던 것과 같은 모양의 오류 */
function spawnError(event: { errorCode?: string | null; errorMessage?: string | null; errno?: number | null }, command: string, args: readonly string[]): Error {
  return Object.assign(new Error(event.errorMessage ?? `spawn ${command} failed`), {
    code: event.errorCode ?? undefined,
    errno: event.errno ?? undefined,
    syscall: `spawn ${command}`,
    path: command,
    spawnargs: [...args],
  });
}

/** UTF-16 단위 그대로 글로 만든다(짝 없는 서로게이트도 보존한다) */
function unitsToString(units: Uint16Array): string {
  let text = '';
  for (let at = 0; at < units.length; at += 4096) text += String.fromCharCode(...units.subarray(at, at + 4096));
  return text;
}

/**
 * 자식 프로세스의 입출력(띄우기·표준 입력·줄 나누기·표준 오류 끝부분·닫기 단계·끝 상태)은 Rust가 한다(crates/bstudio-io/src/cli_process.rs, ADR-195 4f A8a).
 * 여기는 Rust가 순서대로 넘기는 줄을 큐로 받아 JSON 객체만 내놓는다(해석은 TS, ADR-201). 옛 구현은 지웠다(#1347)
 */
/**
 * 자식을 띄우기 전의 준비(막는 쪽): 실행 파일을 절대 경로로 고르고(프로젝트 루트 안의 것은 고르지 않는다), 자식에게 넘길 환경(PATH 정리)과 닫기 단계 시간을 정한다.
 * `spawnClaudeCli`와 러너 코어(`claude-code-runner.ts`의 `args` 콜백, ADR-202)가 같은 준비를 쓴다. 못 찾으면 띄우지 않고 오류를 돌려준다(`spawn <명령> ENOENT: <이유>`)
 */
export function prepareCliSpawn(options: { command: string; cwd: string; env: NodeJS.ProcessEnv; stop?: CliStopOptions }):
  | { ok: true; resolved: string; env: Record<string, string>; termAfterMs: number; killAfterMs: number }
  | { ok: false; error: Error } {
  const termAfterMs = options.stop?.termAfterMs ?? DEFAULT_TERM_AFTER_MS;
  const killAfterMs = options.stop?.killAfterMs ?? DEFAULT_KILL_AFTER_MS;
  // 실행 파일 경로와 인자는 배열로만 넘긴다(셸을 거치지 않는다)
  let resolved: string;
  try {
    // 프로젝트 루트(cwd) 안의 실행 파일은 고르지 않는다
    resolved = resolveCliCommand(options.command, options.env, options.cwd);
  } catch (error) {
    return { ok: false, error: error as Error };
  }
  // 자식이 PATH로 다시 찾는 인터프리터도 프로젝트 안의 것이 잡히지 않게 PATH를 정리해 넘긴다
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(childEnv(options.env, options.cwd))) if (value !== undefined) env[name] = value;
  return { ok: true, resolved, env, termAfterMs, killAfterMs };
}

export function spawnClaudeCli(options: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; stop?: CliStopOptions }): ClaudeCliProcess {
  const prepared = prepareCliSpawn(options);
  if (!prepared.ok) return failedProcess(prepared.error);
  const { resolved, env } = prepared;
  const termAfterMs = prepared.termAfterMs;
  const killAfterMs = prepared.killAfterMs;

  // Rust가 밀어 주는 줄. 소비자(messages)가 느려도 줄은 여기 쌓인다
  const queue: string[] = [];
  let head = 0;
  let finished = false;
  let wake: (() => void) | undefined;
  let inputClosed = false;
  let alive = true;
  // 소비한 줄 수 가운데 Rust에 아직 알리지 않은 것. Rust는 소비하지 않은 줄이 상한에 닿으면 표준 출력 읽기를 멈춘다(옛 readline 반복자의 highWaterMark와 같은 성질)
  let unreported = 0;
  let resolveExit!: (exit: CliExit) => void;
  const exited = new Promise<CliExit>((resolve) => {
    resolveExit = resolve;
  });

  // 콜백이 session을 붙잡고 있어(JS 함수는 Rust 쪽 콜백이 살아 있는 동안 GC되지 않는다) 호출한 쪽이 proc를 놓아도 자식의 입력이 닫히지 않는다
  const session: NativeCliProcess = new native.CliProcess(resolved, [...options.args], env, options.cwd, timerMs(termAfterMs), timerMs(killAfterMs), (event) => {
    void session;
    if (!event.exited) {
      for (const line of event.lines ?? []) queue.push(line);
    } else {
      alive = false;
      finished = true;
      if (event.errorCode) resolveExit({ code: null, signal: null, error: spawnError(event, resolved, options.args) });
      else resolveExit({ code: event.code ?? null, signal: (event.signal ?? null) as NodeJS.Signals | null });
    }
    wake?.();
  });

  const reportConsumed = (): void => {
    if (unreported === 0) return;
    const n = unreported;
    unreported = 0;
    session.consumed(n);
  };

  const closeInput = (): void => {
    if (inputClosed) return;
    inputClosed = true;
    session.closeInput();
  };

  return {
    async *messages() {
      for (;;) {
        if (head < queue.length) {
          const line = queue[head++] ?? '';
          if (++unreported >= CONSUMED_BATCH) reportConsumed();
          if (head > 4096 && head * 2 > queue.length) {
            queue.splice(0, head);
            head = 0;
          }
          if (!line.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) yield parsed as CliMessage;
          continue;
        }
        // 큐를 다 비웠다: 기다리기 전에 소비를 알린다(안 알리면 멈춘 읽기가 풀리지 않아 교착한다)
        reportConsumed();
        if (finished) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    },
    send(text) {
      if (inputClosed) return;
      session.writeLine(JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }));
    },
    closeInput,
    stop(mode) {
      closeInput();
      if (!alive) return;
      session.stop(mode === 'now');
    },
    exited,
    stderrTail: () => unitsToString(session.stderrTail()),
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
