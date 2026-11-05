/**
 * 도커 밖(호스트)에서 직접 뜬 프로세스를 관찰한다(gradle bootRun, next dev 등).
 * 조사 노트(host_process_observability.md)가 정리하듯, 호스트 프로세스에는 도커 소켓 같은 보편적 관찰 창구가
 * 없어 포트→PID 매칭(lsof/ss)과 리소스(ps), 그리고 사용자가 미리 열어 둔 Spring Boot Actuator 정도가 전부다.
 */
import { decodeNative, native } from '../native';

export interface ListeningProcess {
  pid: number;
  command: string;
  port: number;
}

/** colima·Docker Desktop·VPN 등이 포트를 포워딩하느라 띄우는 프로세스. 컨테이너 쪽에서 이미 보이므로 중복 표시를 피한다(판정은 Rust: crates/bstudio-guard/src/host_processes.rs) */
export function isForwarderProcess(command: string): boolean {
  return native.isForwarderProcess(command);
}

/** macOS `lsof -nP -iTCP -sTCP:LISTEN` 출력을 파싱한다. 헤더 줄(COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME)은 건너뛴다 */
export function parseLsofListening(output: string): ListeningProcess[] {
  return decodeNative<ListeningProcess[]>(native.parseLsofListening(output));
}

/** Linux `ss -ltnp` 출력을 파싱한다. 형식: State Recv-Q Send-Q "Local Address:Port" "Peer Address:Port" Process */
export function parseSsListening(output: string): ListeningProcess[] {
  return decodeNative<ListeningProcess[]>(native.parseSsListening(output));
}

/**
 * 프로젝트가 studio.yaml에 선언한 포트에서 듣고 있는 프로세스만 남긴다(흔한 개발 포트를 넘겨짚지 않는다).
 * 포워더 프로세스(lima·ssh·vpnkit·com.docker)는 뺀다 — 그 포트를 연 컨테이너는 이미 다른 곳(내 환경 docker 목록)에서 보인다.
 * 같은 포트를 여러 줄이 보고하면(IPv4/IPv6 중복 등) 먼저 나온 것만 남긴다.
 * excludePids는 스튜디오 서버 자신이다. 프로젝트가 선언한 포트(예: Next.js 3000)를 스튜디오가 듣고 있으면
 * 사용자 앱으로 잘못 보이므로 뺀다
 */
export function matchDeclaredPorts(listening: readonly ListeningProcess[], declaredPorts: readonly number[], excludePids: readonly number[] = []): ListeningProcess[] {
  const kept = native.matchDeclaredPorts(
    listening.map((row) => row.pid),
    listening.map((row) => row.command),
    listening.map((row) => row.port),
    [...declaredPorts],
    [...excludePids],
  );
  return kept.map((index) => listening[index]!);
}

export interface ProcessResourceUsage {
  pid: number;
  cpuPercent: number;
  rssKb: number;
  command: string;
}

/** `ps -o pid,pcpu,rss,command= -p <pid>` 한 줄 출력을 파싱한다(명령줄에 공백이 있어도 마지막 그룹으로 통째로 받는다) */
export function parsePsRow(output: string): ProcessResourceUsage | undefined {
  const text = native.parsePsRow(output);
  return text ? decodeNative<ProcessResourceUsage>(text) : undefined;
}

export interface ActuatorProbe {
  /** /actuator/health가 응답했다 */
  connected: boolean;
  logfileAvailable: boolean;
  /** 로그를 못 보여줄 때 사용자가 studio.yaml이 아니라 자기 앱 설정에서 해야 할 일 */
  guidance?: string;
}

/** health·logfile 응답 상태만으로 보여 줄 문구를 정한다(네트워크 호출 없이 테스트할 수 있게 분리) */
export function classifyActuatorProbe(healthOk: boolean, logfileStatus: number | undefined): ActuatorProbe {
  return decodeNative<ActuatorProbe>(native.classifyActuatorProbe(healthOk, logfileStatus));
}

/**
 * 127.0.0.1의 선언된 포트로만 Actuator health·logfile을 확인한다. 실패해도 예외를 던지지 않고 "연결 안 됨"으로 분류한다.
 * logfile은 Range 헤더로 끝부분만 받는다(전체를 받지 않는다)
 */
export async function probeActuator(
  port: number,
  { fetchImpl = fetch, timeoutMs = 1_000, tailBytes = 8_192 }: { fetchImpl?: typeof fetch; timeoutMs?: number; tailBytes?: number } = {},
): Promise<ActuatorProbe & { logExcerpt?: string }> {
  const base = `http://127.0.0.1:${port}`;
  const healthOk = await fetchImpl(`${base}/actuator/health`, { signal: AbortSignal.timeout(timeoutMs) })
    .then((response) => response.ok)
    .catch(() => false);
  if (!healthOk) return classifyActuatorProbe(false, undefined);

  let logfileStatus: number | undefined;
  let logExcerpt: string | undefined;
  try {
    const response = await fetchImpl(`${base}/actuator/logfile`, { signal: AbortSignal.timeout(timeoutMs), headers: { Range: `bytes=-${tailBytes}` } });
    logfileStatus = response.status;
    if (response.ok) logExcerpt = (await response.text()).slice(-tailBytes);
  } catch {
    logfileStatus = undefined;
  }
  return { ...classifyActuatorProbe(true, logfileStatus), logExcerpt };
}
