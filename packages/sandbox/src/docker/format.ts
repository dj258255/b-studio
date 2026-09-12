import type { LoadedProject } from '@b-studio/spec';
import { directHosts, EDGE_IMAGE, EDGE_PROXY_PORT, EDGE_SERVICE, edgeEnvironment, edgePortFor, proxyEnvironment } from '../edge-config';
import type { ContainerState, EgressDenial, LogLine } from '../types';

export { DEFAULT_EGRESS_ALLOW, EDGE_PROXY_PORT, EDGE_SERVICE, edgePortFor } from '../edge-config';

/** 외부로 나갈 수 없는 네트워크. 모든 서비스가 여기에만 붙는다 */
const SANDBOX_NETWORK = 'b-studio-sandbox';
/** edge만 붙는 네트워크. 허용한 외부 호스트로 나갈 때 쓴다 */
const EGRESS_NETWORK = 'b-studio-egress';

/**
 * 사용자의 compose 파일은 건드리지 않고 덧씌울 설정.
 *  - 모든 서비스를 외부로 나갈 수 없는 internal 네트워크에만 붙인다 (운영 DB, 사내망, 인터넷 차단)
 *  - internal 네트워크의 컨테이너는 포트를 공개할 수 없으므로 edge가 루프백의 빈 포트로 대신 공개해 넘긴다
 *  - HTTP(S) 도구는 edge 프록시를 거쳐 허용한 호스트로만 나간다
 */
export function buildOverride(
  project: LoadedProject,
  sandboxId: string,
  { edgeScript = '', runtime }: { edgeScript?: string; runtime?: string } = {},
) {
  const composeServices = project.composeServices ?? project.managed.map(([name]) => name);
  const externals = project.external ?? [];
  // 등록한 사내 API 이름은 edge의 별칭이므로 HTTP 프록시(3128)를 거치지 않고 바로 부른다
  const environment = proxyEnvironment(directHosts(project, composeServices));

  // 프록시가 듣기 전에 서비스가 뜨면 첫 다운로드(corepack의 pnpm 등)가 연결 거부로 실패하고 컨테이너가 끝난다
  const waitForEdge = { [EDGE_SERVICE]: { condition: 'service_healthy' } };
  // gVisor(runsc) 같은 런타임은 에이전트 코드가 도는 서비스와 샌드박스 네트워크에 노출된 edge에 모두 건다
  const isolation = runtime ? { runtime } : {};
  const services: Record<string, Record<string, unknown>> = Object.fromEntries(
    composeServices.map((name) => [name, { networks: [SANDBOX_NETWORK], environment, depends_on: waitForEdge, ...isolation }]),
  );
  for (const [name] of project.managed) {
    services[name] = { ...services[name], labels: { 'b-studio.sandbox': sandboxId, 'b-studio.service': name } };
  }

  // 시크릿 값은 override 파일에 쓰지 않는다. 값 자리를 비워 두면 compose가 자기 프로세스 환경에서 채운다
  for (const [name, secret] of project.secrets ?? []) {
    for (const service of secret.services) {
      const current = services[service] ?? {};
      services[service] = { ...current, environment: { ...(current.environment as Record<string, unknown> | undefined), [name]: null } };
    }
  }

  services[EDGE_SERVICE] = {
    image: EDGE_IMAGE,
    ...isolation,
    // compose는 command 안의 $도 변수로 치환하므로 스크립트의 $를 $$로 적는다
    command: ['node', '--input-type=module', '-e', edgeScript.replaceAll('$', '$$$$')],
    environment: {
      // compose는 environment 값의 $도 치환하므로 $$로 적는다
      ...Object.fromEntries(Object.entries(edgeEnvironment(project, composeServices)).map(([key, value]) => [key, value.replaceAll('$', '$$$$')])),
      // 사내 API 인증 시크릿은 edge에만 넣는다. 값 자리를 비워 compose 프로세스 환경에서 채운다
      ...Object.fromEntries(externals.flatMap(([, service]) => (service.policy.auth ? [[service.policy.auth.secret, null]] : []))),
    },
    // 등록한 사내 API 이름을 internal 네트워크의 별칭으로 가져, 서비스가 http://<이름>/으로 부르면 edge로 온다
    networks: { [SANDBOX_NETWORK]: { aliases: externals.map(([name]) => name) }, [EGRESS_NETWORK]: {} },
    // 사내 API가 Docker 호스트에서 돌 때도 edge가 찾아갈 수 있게 한다
    ...(externals.length > 0 ? { extra_hosts: ['host.docker.internal:host-gateway'] } : {}),
    healthcheck: {
      test: ['CMD', 'node', '-e', `require('node:net').connect(${EDGE_PROXY_PORT}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))`],
      interval: '1s',
      timeout: '2s',
      retries: 30,
      start_interval: '200ms',
      start_period: '10s',
    },
    // 루프백의 빈 포트에만 공개해서 같은 네트워크의 다른 PC에서 접근하지 못하게 한다
    ports: project.managed.map(([name]) => `127.0.0.1::${edgePortFor(project, name)}`),
    labels: { 'b-studio.sandbox': sandboxId, 'b-studio.service': EDGE_SERVICE },
    deploy: { resources: { limits: { memory: '128m', cpus: '0.5' } } },
  };

  // 서비스 단위 cpus는 compose가 deploy.resources.limits와 섞어 쓰지 못하게 하므로 deploy 형식으로만 건다
  for (const [name, limit] of Object.entries(project.resources ?? {})) {
    const limits = {
      ...(limit.memory ? { memory: limit.memory } : {}),
      ...(limit.cpus ? { cpus: String(limit.cpus) } : {}),
    };
    services[name] = { ...services[name], deploy: { resources: { limits } } };
  }
  return {
    networks: { [SANDBOX_NETWORK]: { internal: true }, [EGRESS_NETWORK]: {} },
    services,
  };
}

/** edge 감사 로그 한 줄: `{"edge":"egress","decision":"deny","host":"example.com","port":443,"reason":"...","at":"..."}` */
export function parseEgressDenial(text: string): EgressDenial | undefined {
  if (!text.startsWith('{"edge":"egress"')) return undefined;
  try {
    const entry = JSON.parse(text) as { decision?: unknown; host?: unknown; port?: unknown; method?: unknown; path?: unknown; reason?: unknown; at?: unknown };
    if (entry.decision !== 'deny' || typeof entry.host !== 'string' || typeof entry.at !== 'string') return undefined;
    return {
      host: entry.host,
      ...(typeof entry.port === 'number' ? { port: entry.port } : {}),
      ...(typeof entry.method === 'string' ? { method: entry.method } : {}),
      ...(typeof entry.path === 'string' ? { path: entry.path } : {}),
      reason: typeof entry.reason === 'string' ? entry.reason : '',
      at: new Date(entry.at),
    };
  } catch {
    return undefined;
  }
}

/** `docker info --format '{{json .Runtimes}}'` 출력에서 등록된 런타임 이름을 읽는다 */
export function parseRuntimes(stdout: string): string[] {
  try {
    const runtimes = JSON.parse(stdout.trim() || '{}') as unknown;
    return runtimes && typeof runtimes === 'object' ? Object.keys(runtimes).sort() : [];
  } catch {
    return [];
  }
}

/** `docker compose port <service> <port>` 출력에서 호스트 포트를 읽는다 */
export function parseHostPort(stdout: string): number {
  const match = stdout.trim().split('\n').at(-1)?.match(/:(\d+)$/);
  const port = match ? Number(match[1]) : 0;
  if (!port) throw new Error(`공개된 호스트 포트를 찾을 수 없습니다: ${JSON.stringify(stdout)}`);
  return port;
}

const CONTAINER_STATES: ReadonlySet<string> = new Set<ContainerState>([
  'created',
  'running',
  'paused',
  'restarting',
  'removing',
  'exited',
  'dead',
]);

/** `docker compose ps --format json` 출력은 버전에 따라 줄 단위 JSON 또는 배열이다 */
export function parseContainerState(stdout: string): ContainerState {
  const text = stdout.trim();
  if (!text) return 'unknown';

  const rows: unknown[] = text.startsWith('[') ? JSON.parse(text) : text.split('\n').map((line) => JSON.parse(line));
  const state = (rows[0] as { State?: unknown } | undefined)?.State;
  return typeof state === 'string' && CONTAINER_STATES.has(state) ? (state as ContainerState) : 'unknown';
}

/**
 * 동기화 확인 스크립트 출력: 파일마다 `<sha256|MISSING|UNREADABLE> <경로>` 한 줄.
 * 경로에 공백이 있을 수 있으므로 첫 공백에서만 나눈다
 */
/**
 * 샌드박스 쪽에서 바뀐 파일이 보이는지 확인하는 스크립트. 인자는 프로젝트 루트 기준 경로이고, 줄마다 "해시 경로"를 출력한다.
 * 빌드 도구는 루트부터 디렉터리 목록을 따라 내려가므로, 파일이 든 폴더뿐 아니라 모든 상위 폴더의 목록에 다음 경로 이름이 보여야
 * 반영된 것으로 본다. 새 폴더를 만들면 그 폴더의 목록은 바로 보이지만 상위 폴더의 목록은 파일 공유 캐시 때문에 약 19초 늦게 바뀐다
 */
export const SYNC_SCRIPT = [
  'cd "${SYNC_ROOT:-/project}" || exit 2',
  'for f in "$@"; do',
  '  p="$f"',
  '  listed=1',
  '  while [ "$p" != "." ] && [ "$p" != "/" ]; do',
  '    if ! ls -1a "$(dirname "$p")" 2>/dev/null | grep -Fxq -- "$(basename "$p")"; then listed=0; break; fi',
  '    p=$(dirname "$p")',
  '  done',
  '  if [ "$listed" = 1 ]; then',
  '    h=$(sha256sum "$f" 2>/dev/null | cut -d " " -f 1)',
  '    echo "${h:-UNREADABLE} $f"',
  '  else',
  '    echo "MISSING $f"',
  '  fi',
  'done',
].join('\n');

export function parseSyncOutput(stdout: string): Map<string, string> {
  const seen = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) seen.set(line.slice(space + 1), line.slice(0, space));
  }
  return seen;
}

const LOG_LINE = /^(?<container>\S+)-\d+\s+\|\s(?<timestamp>\d{4}-\d{2}-\d{2}T\S+)\s?(?<text>.*)$/;
/** compose가 컨테이너 수명 주기를 알리는 줄: `api-1 exited with code 143`, `web-1 has been recreated` */
const STATUS_LINE = /^(?<container>[a-z0-9][a-z0-9_.-]*)-\d+\s+(?<text>[^|\s].*)$/;
/** --no-color를 줘도 상태 줄 앞에는 줄 지우기(ESC [K) 같은 제어 코드가 붙는다 */
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]/g;

/**
 * `docker compose logs --timestamps` 한 줄: `api-1  | 2026-09-10T11:48:35.123456789Z 메시지`.
 * 내용이 없는 줄은 undefined를 돌려 건너뛰게 한다.
 */
export function parseLogLine(raw: string): LogLine | undefined {
  const line = raw.replace(ANSI_ESCAPE, '');
  if (line.trim() === '') return undefined;

  const groups = LOG_LINE.exec(line)?.groups;
  if (groups?.container && groups.timestamp) {
    return {
      service: groups.container,
      text: groups.text ?? '',
      // 나노초 정밀도는 Date가 다루지 못하므로 밀리초까지만 남긴다
      at: new Date(groups.timestamp.replace(/(\.\d{3})\d+/, '$1')),
    };
  }

  const status = STATUS_LINE.exec(line)?.groups;
  if (status?.container && status.text) return { service: status.container, text: status.text, at: new Date() };

  return { service: 'unknown', text: line, at: new Date() };
}
