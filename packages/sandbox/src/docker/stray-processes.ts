import type { ExecResult } from '../types';

/**
 * 서비스 컨테이너 안에서 PID 1과 세션이 다른 프로세스를 찾는 스크립트(#765). 한 줄에 "pid 시작시각 명령"을 낸다.
 *
 * `docker exec`로 들어온 프로세스는 새 세션을 받는다. 셸이 끝나 PID 1 밑으로 옮겨져도(nohup … &) 세션은 그대로이고,
 * 프로세스는 남의 세션에 들어갈 수 없으므로(setsid는 새 세션만 만든다) 서비스 본 프로세스의 세션으로 숨지 못한다.
 * 다만 서비스가 스스로 다른 세션으로 띄우는 것도 있다(Gradle wrapper가 띄운 bootRun 서버, 실측). 그래서 이 목록만으로
 * 끝낼 것을 정하지 않고, 서비스가 준비됐을 때의 목록(기준선)과 견준다(foreignProcesses).
 *
 * 시작 시각은 /proc/<pid>/stat의 22번째 필드(부팅 뒤 클록 틱)다. pid를 다시 쓴 프로세스를 같은 것으로 보지 않게 함께 견준다.
 * 좀비(Z)와 이 스크립트 자신의 세션은 뺀다. PID 1을 읽지 못하면 실패로 끝낸다 — "찾은 것이 없다"와 구분해야 한다.
 * SCAN_PROC·SCAN_SELF는 테스트가 가짜 /proc을 넘길 때만 쓴다. 호스트의 진짜 /proc에 돌리지 않는다.
 */
export const PROCESS_SCAN_SCRIPT = `proc=\${SCAN_PROC:-/proc}; self=\${SCAN_SELF:-$$}
field() { sed 's/^.*) //' "$1" 2>/dev/null | cut -d' ' -f"$2"; }
root=$(field "$proc/1/stat" 4); [ -n "$root" ] || { echo "$proc/1/stat를 읽지 못했습니다" >&2; exit 3; }
mine=$(field "$proc/$self/stat" 4)
for d in "$proc"/[0-9]*; do
  line=$(sed 's/^.*) //' "$d/stat" 2>/dev/null) || continue
  set -- $line
  [ -n "$4" ] || continue
  [ "$1" = Z ] && continue
  [ "$4" = "$root" ] && continue
  [ -n "$mine" ] && [ "$4" = "$mine" ] && continue
  start=$(echo "$line" | cut -d' ' -f20)
  echo "\${d##*/} $start $(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null | cut -c1-200)"
done`;

export interface ScannedProcess {
  pid: number;
  /** 부팅 뒤 클록 틱. pid와 함께 프로세스를 가린다 */
  start: string;
  command: string;
}

export function parseProcessScan(stdout: string): ScannedProcess[] {
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .flatMap((line) => {
      const match = /^(\d+) (\d+) ?(.*)$/.exec(line);
      return match ? [{ pid: Number(match[1]), start: match[2]!, command: match[3]!.trim() }] : [];
    })
    .sort((a, b) => a.pid - b.pid);
}

/** 서비스 안에서 찾기를 돌린다. 셸이 없거나 읽지 못하면 그 까닭을 돌려준다(호출자는 확인하지 못한 서비스를 다시 띄운다) */
export async function scanProcesses(exec: (command: string[]) => Promise<ExecResult>): Promise<{ processes: ScannedProcess[]; error?: undefined } | { error: string; processes?: undefined }> {
  const result = await exec(['sh', '-c', PROCESS_SCAN_SCRIPT]);
  if (result.exitCode === 0) return { processes: parseProcessScan(result.stdout) };
  if (result.exitCode === 126 || result.exitCode === 127 || /executable file not found|no such file or directory/i.test(result.stderr)) {
    return { error: 'sh가 없어 서비스 안의 프로세스를 확인하지 못했습니다' };
  }
  return { error: `서비스 안의 프로세스를 읽지 못했습니다: ${result.stderr.trim() || `종료 코드 ${result.exitCode}`}` };
}

/** 기준선(서비스가 준비됐을 때의 목록)에 없던 프로세스. 기준선이 없으면(스튜디오를 다시 띄운 뒤) 모두 모르는 것으로 본다 */
export function foreignProcesses(now: readonly ScannedProcess[], baseline: readonly ScannedProcess[] | undefined): ScannedProcess[] {
  const known = new Set((baseline ?? []).map((p) => `${p.pid}:${p.start}`));
  return now.filter((p) => !known.has(`${p.pid}:${p.start}`));
}
