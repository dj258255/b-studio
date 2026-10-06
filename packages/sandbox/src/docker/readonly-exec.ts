import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecResult } from '../types';

const execFileAsync = promisify(execFile);

/**
 * "내 환경" 관찰 탭(사용자가 docker compose로 직접 띄운 컨테이너)이 쓸 수 있는 docker 하위 명령 화이트리스트.
 * 조사 보고서(container_auto_discovery.md)가 지적하듯 소켓/CLI 접근은 사실상 호스트 root급 권한과 같으므로,
 * 읽기만 하는 하위 명령만 허용하고 그 밖은(run, exec, rm, restart, stop 등) 여기서 거부한다.
 * `events`는 지금은 호출하지 않지만(스냅샷 폴링으로 충분) 장차 실시간 갱신에 쓸 수 있도록 화이트리스트에는 남겨 둔다.
 */
export const READONLY_DOCKER_SUBCOMMANDS: ReadonlySet<string> = new Set(['ps', 'inspect', 'logs', 'stats', 'events']);

export class ReadonlyDockerViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadonlyDockerViolation';
  }
}

/**
 * 인자가 화이트리스트를 지키는지 본다. 지키지 않으면 던진다(명령을 실행하지 않는다).
 * `stats`는 `--no-stream`이 없으면(스트리밍) 연결을 계속 붙잡아 둘 수 있어 한 번 읽고 끝나는 호출만 허용한다.
 */
export function assertReadonlyDockerArgs(args: readonly string[]): void {
  const sub = args[0];
  if (!sub || !READONLY_DOCKER_SUBCOMMANDS.has(sub)) {
    throw new ReadonlyDockerViolation(`읽기 전용 docker 래퍼는 '${sub ?? ''}' 명령을 허용하지 않습니다`);
  }
  if (sub === 'stats' && !args.includes('--no-stream')) {
    throw new ReadonlyDockerViolation("'docker stats'는 --no-stream과 함께만 허용합니다");
  }
}

/** ps·inspect·stats처럼 한 번 실행하고 끝나는 읽기 전용 docker 명령. 화이트리스트를 어기면 실행 전에 던진다 */
export async function execReadonlyDocker(
  dockerBin: string,
  args: readonly string[],
  options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  assertReadonlyDockerArgs(args);
  try {
    const { stdout, stderr } = await execFileAsync(dockerBin, [...args], {
      signal: options.signal,
      maxBuffer: 64 * 1024 * 1024,
      env: options.env ?? process.env,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    if (!isExecFailure(error)) throw error;
    return { exitCode: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr || error.message };
  }
}

/** logs --follow처럼 스트리밍하는 읽기 전용 docker 명령. 화이트리스트를 어기면 프로세스를 띄우지 않고 던진다 */
export function spawnReadonlyDocker(
  dockerBin: string,
  args: readonly string[],
  options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  assertReadonlyDockerArgs(args);
  return spawn(dockerBin, [...args], { signal: options.signal, stdio: ['ignore', 'pipe', 'pipe'], env: options.env ?? process.env });
}

function isExecFailure(error: unknown): error is Error & { code?: number | string; stdout?: string; stderr?: string } {
  return error instanceof Error && 'stdout' in error;
}
