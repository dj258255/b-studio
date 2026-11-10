import { native } from '../native';
import { runCommand } from '../stream-exec';
import type { ExecResult } from '../types';

/**
 * "내 환경" 관찰 탭(사용자가 docker compose로 직접 띄운 컨테이너)이 쓸 수 있는 docker 하위 명령 화이트리스트.
 * 조사 보고서(container_auto_discovery.md)가 지적하듯 소켓/CLI 접근은 사실상 호스트 root급 권한과 같으므로,
 * 읽기만 하는 하위 명령만 허용하고 그 밖은(run, exec, rm, restart, stop 등) 여기서 거부한다.
 * `events`는 지금은 호출하지 않지만(스냅샷 폴링으로 충분) 장차 실시간 갱신에 쓸 수 있도록 화이트리스트에는 남겨 둔다.
 */
export const READONLY_DOCKER_SUBCOMMANDS: ReadonlySet<string> = new Set(native.readonlyDockerSubcommands());

export class ReadonlyDockerViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadonlyDockerViolation';
  }
}

/**
 * 인자가 화이트리스트를 지키는지 본다(판정은 Rust). 지키지 않으면 던진다(명령을 실행하지 않는다).
 * `stats`는 `--no-stream`이 없으면(스트리밍) 연결을 계속 붙잡아 둘 수 있어 한 번 읽고 끝나는 호출만 허용한다.
 */
export function assertReadonlyDockerArgs(args: readonly string[]): void {
  // 판정은 Rust(crates/bstudio-guard/src/readonly_docker.rs)가 한다
  const message = native.assertReadonlyDockerArgs([...args]);
  if (message != null) throw new ReadonlyDockerViolation(message);
}

/**
 * ps·inspect·stats처럼 한 번 실행하고 끝나는 읽기 전용 docker 명령. 화이트리스트를 어기면 실행 전에 던진다.
 * 비0 종료·취소·띄우기 실패·출력 상한 초과는 던지지 않고 결과로 돌려준다(옛 `execFile`의 `isExecFailure` 분기와 같다).
 * 단 stderr가 비면 옛 오류의 `message` 대신 `runCommand`가 채운 문구가 들어간다
 */
export async function execReadonlyDocker(
  dockerBin: string,
  args: readonly string[],
  options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  assertReadonlyDockerArgs(args);
  return runCommand(dockerBin, [...args], { signal: options.signal, env: options.env ?? process.env });
}
