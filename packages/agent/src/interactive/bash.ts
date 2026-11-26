import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ToolOutcome } from './tools';

/** 명령 하나의 시간 기본값·상한(밀리초), 모아 두는 출력의 글자 상한, 종료 신호를 보낸 뒤 강제로 끊기까지의 유예 */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000;
export const BASH_MAX_TIMEOUT_MS = 600_000;
export const BASH_MAX_OUTPUT_CHARS = 30_000;
export const BASH_KILL_GRACE_MS = 1_000;

/**
 * 자식 프로세스의 환경에서 빼는 모델 자격 증명 이름. 경계가 아니다: 이 컴퓨터 방식에서 에이전트는 사용자의 권한으로 돌아
 * 같은 사용자의 셸은 서버 프로세스의 환경도 읽을 수 있다(ADR-227). 명령 출력에 키가 우연히 섞이는 것만 줄인다
 */
export const SCRUBBED_ENV_NAMES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GOOGLE_API_KEY'];

export interface BashOptions {
  /** 작업 폴더(명령의 cwd) */
  cwd: string;
  /** 자식 환경의 바탕(기본은 process.env). 아래 이름들을 뺀다 */
  env?: NodeJS.ProcessEnv;
  /** 기본 목록에 더해 뺄 환경 변수 이름(프로필의 키 이름) */
  scrubEnvNames?: readonly string[];
  /** 시험이 줄이는 값 */
  killGraceMs?: number;
  maxOutputChars?: number;
  /** 우두머리가 끝난 뒤 남은 출력을 더 받는 시간(기본 200ms) */
  exitDrainMs?: number;
}

export function scrubbedEnv(base: NodeJS.ProcessEnv, extra: readonly string[] = []): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const name of [...SCRUBBED_ENV_NAMES, ...extra]) delete out[name];
  return out;
}

/**
 * 아직 정리하지 않은 명령의 프로세스 그룹. 명령이 어떻게 끝나든 그룹째 끊고 여기서 뺀다.
 * CLI가 끝날 때(정상 종료·SIGTERM·SIGHUP 뒤의 exit) 남은 그룹을 끊는다. SIGKILL로 죽은 CLI는 정리하지 못한다(새 그룹이라 PTY의 SIGHUP도 받지 않는다)
 */
const liveGroups = new Set<number>();
let exitHookInstalled = false;
function trackGroup(pid: number): void {
  liveGroups.add(pid);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const group of liveGroups) killGroup(group, 'SIGKILL');
  });
}

const killGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    // 음수 pid는 프로세스 그룹 전체다(자식이 detached로 새 그룹의 우두머리다)
    process.kill(-pid, signal);
  } catch {
    // 이미 없다
  }
};

/**
 * 셸 명령을 작업 폴더에서 `/bin/bash -c`로 실행한다. 명령은 인자 배열의 한 칸이라 다른 값과 문자열로 이어 붙이지 않는다.
 * 자식은 새 프로세스 그룹이라 시간 초과·중단 때 손자까지 그룹째 끊는다(SIGTERM, 유예 뒤 SIGKILL). stdin은 닫는다.
 * 출력은 읽는 동안 상한까지만 모으고 나머지는 세기만 한다(끝없는 출력이 메모리를 채우지 않는다).
 * 종료 코드가 0이 아닌 것은 실패한 도구 결과일 뿐 던지지 않는다
 */
export async function runBash(input: Record<string, unknown>, options: BashOptions, signal?: AbortSignal): Promise<ToolOutcome> {
  const command = input.command;
  if (typeof command !== 'string' || command.trim() === '') return { text: 'command가 필요합니다', isError: true };
  if (command.includes('\0')) return { text: 'command에 NUL이 있습니다', isError: true };
  let timeoutMs = BASH_DEFAULT_TIMEOUT_MS;
  if (input.timeout !== undefined) {
    if (typeof input.timeout !== 'number' || !Number.isFinite(input.timeout) || input.timeout <= 0) return { text: `timeout은 양수(밀리초)여야 합니다(최대 ${BASH_MAX_TIMEOUT_MS})`, isError: true };
    timeoutMs = Math.min(input.timeout, BASH_MAX_TIMEOUT_MS);
  }
  if (signal?.aborted) return { text: '중단되어 실행하지 않았습니다', isError: true };
  const graceMs = options.killGraceMs ?? BASH_KILL_GRACE_MS;
  const maxChars = options.maxOutputChars ?? BASH_MAX_OUTPUT_CHARS;

  return new Promise<ToolOutcome>((resolve) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd: options.cwd,
      env: scrubbedEnv(options.env ?? process.env, options.scrubEnvNames),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const pid = child.pid;
    if (pid !== undefined) trackGroup(pid);
    let collected = '';
    let totalBytes = 0;
    let keptBytes = 0;
    let reason: 'timeout' | 'abort' | undefined;
    // 우두머리가 끝났다. 그 뒤의 시간 초과·중단은 결과를 바꾸지 않는다(이미 끝난 명령을 끊었다고 보고하지 않는다)
    let exited = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const collect = (decoder: StringDecoder) => (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (collected.length >= maxChars) return;
      const text = decoder.write(chunk);
      const room = maxChars - collected.length;
      const piece = text.length > room ? text.slice(0, room) : text;
      collected += piece;
      keptBytes += Buffer.byteLength(piece);
    };
    child.stdout.on('data', collect(new StringDecoder('utf8')));
    child.stderr.on('data', collect(new StringDecoder('utf8')));

    const finish = (outcome: ToolOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      // 명령이 끝났으면 그룹에 남은 것(백그라운드로 보낸 하위 프로세스)도 끊는다. 이 도구는 백그라운드 작업을 되찾을 길이 없다
      if (pid !== undefined) {
        killGroup(pid, 'SIGKILL');
        liveGroups.delete(pid);
      }
      resolve(outcome);
    };
    const render = (head: string, isError: boolean): ToolOutcome => {
      const dropped = totalBytes - keptBytes;
      const body = collected === '' ? '(출력 없음)' : collected;
      const note = dropped > 0 ? `\n(출력이 길어 ${dropped}바이트를 버렸습니다. 앞 ${keptBytes}바이트만 남겼습니다)` : '';
      return { text: `${head}\n${body}${note}`, isError };
    };

    // 그룹을 끊는다: 종료 신호를 보내고, 유예 뒤에는 우두머리가 이미 끝났어도 그룹에 남은 것을 강제로 끊은 다음에야 결과를 낸다
    const terminate = (why: 'timeout' | 'abort') => {
      if (reason !== undefined || settled || exited || pid === undefined) return;
      reason = why;
      killGroup(pid, 'SIGTERM');
      killTimer = setTimeout(() => {
        killGroup(pid, 'SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        const head = why === 'timeout' ? `시간 초과(${timeoutMs}ms)로 명령과 그 하위 프로세스를 끊었습니다` : '중단되어 명령과 그 하위 프로세스를 끊었습니다';
        finish(render(head, true));
      }, graceMs);
    };
    function onAbort() {
      terminate('abort');
    }
    timer = setTimeout(() => terminate('timeout'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error) => finish({ text: `명령을 시작하지 못했습니다: ${(error as NodeJS.ErrnoException).code ?? error.message}`, isError: true }));
    // 우두머리가 끝나면 남은 출력을 잠깐 더 받고 끝낸다. 백그라운드로 보낸 하위 프로세스가 파이프를 쥐고 있어도 기다리지 않는다
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    const done = () => {
      if (reason !== undefined) return;
      finish(exitCode === 0 ? render('종료 코드: 0', false) : render(exitCode === null ? `종료 신호: ${exitSignal ?? '알 수 없음'}` : `종료 코드: ${exitCode}`, true));
    };
    child.on('exit', (code, sig) => {
      exited = true;
      exitCode = code;
      exitSignal = sig;
      setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        done();
      }, options.exitDrainMs ?? 200).unref();
    });
    child.on('close', done);
  });
}
