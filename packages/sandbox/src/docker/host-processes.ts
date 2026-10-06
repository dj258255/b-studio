/**
 * 도커 밖(호스트)에서 직접 뜬 프로세스를 관찰한다(gradle bootRun, next dev 등).
 * 조사 노트(host_process_observability.md)가 정리하듯, 호스트 프로세스에는 도커 소켓 같은 보편적 관찰 창구가
 * 없어 포트→PID 매칭(lsof/ss)과 리소스(ps), 그리고 사용자가 미리 열어 둔 Spring Boot Actuator 정도가 전부다.
 */

export interface ListeningProcess {
  pid: number;
  command: string;
  port: number;
}

/** colima·Docker Desktop·VPN 등이 포트를 포워딩하느라 띄우는 프로세스. 컨테이너 쪽에서 이미 보이므로 중복 표시를 피한다 */
const FORWARDER_COMMAND = /lima|ssh|vpnkit|com\.docker/i;

export function isForwarderProcess(command: string): boolean {
  return FORWARDER_COMMAND.test(command);
}

/** macOS `lsof -nP -iTCP -sTCP:LISTEN` 출력을 파싱한다. 헤더 줄(COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME)은 건너뛴다 */
export function parseLsofListening(output: string): ListeningProcess[] {
  const rows: ListeningProcess[] = [];
  const lines = output.split('\n').slice(1);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const command = parts[0]!;
    const pid = Number.parseInt(parts[1]!, 10);
    if (!Number.isFinite(pid)) continue;
    const last = parts.at(-1);
    const nameField = last === '(LISTEN)' ? parts.at(-2) : last;
    const port = Number.parseInt(/:(\d+)$/.exec(nameField ?? '')?.[1] ?? '', 10);
    if (!Number.isFinite(port)) continue;
    rows.push({ pid, command, port });
  }
  return rows;
}

/** Linux `ss -ltnp` 출력을 파싱한다. 형식: State Recv-Q Send-Q "Local Address:Port" "Peer Address:Port" Process */
export function parseSsListening(output: string): ListeningProcess[] {
  const rows: ListeningProcess[] = [];
  const lines = output.split('\n').slice(1);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const port = Number.parseInt(/:(\d+)$/.exec(parts[3] ?? '')?.[1] ?? '', 10);
    if (!Number.isFinite(port)) continue;
    const rest = parts.slice(4).join(' ');
    const pid = Number.parseInt(/pid=(\d+)/.exec(rest)?.[1] ?? '', 10);
    if (!Number.isFinite(pid)) continue;
    const command = /\(\("([^"]+)"/.exec(rest)?.[1] ?? '';
    rows.push({ pid, command, port });
  }
  return rows;
}

/**
 * 프로젝트가 studio.yaml에 선언한 포트에서 듣고 있는 프로세스만 남긴다(흔한 개발 포트를 넘겨짚지 않는다).
 * 포워더 프로세스(lima·ssh·vpnkit·com.docker)는 뺀다 — 그 포트를 연 컨테이너는 이미 다른 곳(내 환경 docker 목록)에서 보인다.
 * 같은 포트를 여러 줄이 보고하면(IPv4/IPv6 중복 등) 먼저 나온 것만 남긴다.
 * excludePids는 스튜디오 서버 자신이다. 프로젝트가 선언한 포트(예: Next.js 3000)를 스튜디오가 듣고 있으면
 * 사용자 앱으로 잘못 보이므로 뺀다
 */
export function matchDeclaredPorts(listening: readonly ListeningProcess[], declaredPorts: readonly number[], excludePids: readonly number[] = []): ListeningProcess[] {
  const declared = new Set(declaredPorts);
  const excluded = new Set(excludePids);
  const seen = new Set<number>();
  const result: ListeningProcess[] = [];
  for (const row of listening) {
    if (!declared.has(row.port) || excluded.has(row.pid) || isForwarderProcess(row.command) || seen.has(row.port)) continue;
    seen.add(row.port);
    result.push(row);
  }
  return result;
}

export interface ProcessResourceUsage {
  pid: number;
  cpuPercent: number;
  rssKb: number;
  command: string;
}

/** `ps -o pid,pcpu,rss,command= -p <pid>` 한 줄 출력을 파싱한다(명령줄에 공백이 있어도 마지막 그룹으로 통째로 받는다) */
export function parsePsRow(output: string): ProcessResourceUsage | undefined {
  const line = output.split('\n').find((row) => row.trim().length > 0);
  if (!line) return undefined;
  const match = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(line);
  if (!match) return undefined;
  return { pid: Number.parseInt(match[1]!, 10), cpuPercent: Number.parseFloat(match[2]!), rssKb: Number.parseInt(match[3]!, 10), command: match[4]!.trim() };
}

export interface ActuatorProbe {
  /** /actuator/health가 응답했다 */
  connected: boolean;
  logfileAvailable: boolean;
  /** 로그를 못 보여줄 때 사용자가 studio.yaml이 아니라 자기 앱 설정에서 해야 할 일 */
  guidance?: string;
}

const LOGFILE_GUIDANCE =
  'Actuator는 연결됐지만 로그 파일이 없습니다. management.endpoints.web.exposure.include=health,logfile과 logging.file.name을 설정하면 최근 로그를 볼 수 있습니다';
const HEALTH_GUIDANCE = '/actuator/health에 응답이 없습니다. 이 포트의 앱이 Spring Boot Actuator를 쓴다면 management.endpoints.web.exposure.include=health,logfile을 열어 두세요';

/** health·logfile 응답 상태만으로 보여 줄 문구를 정한다(네트워크 호출 없이 테스트할 수 있게 분리) */
export function classifyActuatorProbe(healthOk: boolean, logfileStatus: number | undefined): ActuatorProbe {
  if (!healthOk) return { connected: false, logfileAvailable: false, guidance: HEALTH_GUIDANCE };
  const logfileAvailable = logfileStatus === 200 || logfileStatus === 206;
  return { connected: true, logfileAvailable, ...(logfileAvailable ? {} : { guidance: LOGFILE_GUIDANCE }) };
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
