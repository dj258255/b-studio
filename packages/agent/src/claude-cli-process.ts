import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

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

const STDERR_KEEP = 2_000;

function notFound(command: string, why: string): Error {
  return Object.assign(new Error(`spawn ${command} ENOENT: ${why}`), { code: 'ENOENT' });
}

/** `inner`의 실제 경로가 `root`의 실제 경로와 같거나 그 안인가. 실제 경로를 못 읽으면 안으로 본다(막는 쪽) */
function insideRoot(file: string, root: string): boolean {
  let real: string;
  let realRoot: string;
  try {
    real = realpathSync(file);
    realRoot = realpathSync(root);
  } catch {
    return true;
  }
  const rel = path.relative(realRoot, real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * CLI 실행 파일을 절대 경로로 찾는다. 자식 프로세스는 cwd를 프로젝트 루트로 띄우므로, spawn에 이름만 넘기면 PATH의 빈 항목·`.`·상대 항목이
 * 프로젝트 폴더(에이전트가 파일을 쓰는 곳)로 풀려 심어 둔 실행 파일이 b-studio의 권한으로 돈다. 그래서:
 *  - 경로가 든 명령은 절대 경로만 받는다(상대 경로는 cwd 기준이라 거절).
 *  - 이름만 든 명령은 `env`의 PATH에서 절대 항목만 차례로 본다(빈 항목·상대 항목은 건너뛴다). 실행할 수 있는 파일만 고른다.
 *  - `forbiddenRoot`(프로젝트 루트)가 있으면 실제 경로(링크를 따라간 경로)가 그 안인 후보는 버린다.
 * 못 찾으면 ENOENT로 던진다(띄우지 않는다).
 */
export function resolveCliCommand(command: string, env: NodeJS.ProcessEnv, forbiddenRoot?: string): string {
  const hasSeparator = command.includes('/') || (process.platform === 'win32' && command.includes('\\'));
  if (hasSeparator) {
    if (!path.isAbsolute(command)) throw notFound(command, '실행 파일 경로는 절대 경로여야 합니다');
    if (forbiddenRoot !== undefined && insideRoot(command, forbiddenRoot)) throw notFound(command, '프로젝트 폴더 안의 실행 파일은 띄우지 않습니다');
    return command;
  }
  const pathKey = process.platform === 'win32' ? (Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH') : 'PATH';
  const dirs = (env[pathKey] ?? '').split(path.delimiter).filter((dir) => dir !== '' && path.isAbsolute(dir));
  const exts = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (!isExecutableFile(candidate)) continue;
      if (forbiddenRoot !== undefined && insideRoot(candidate, forbiddenRoot)) continue;
      return candidate;
    }
  }
  throw notFound(command, 'PATH의 절대 경로 항목에서 찾지 못했습니다(빈 항목·상대 항목과 프로젝트 폴더 안은 보지 않습니다)');
}

export function spawnClaudeCli(options: { command: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; stop?: CliStopOptions }): ClaudeCliProcess {
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
  const child = spawn(resolved, [...options.args], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
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
