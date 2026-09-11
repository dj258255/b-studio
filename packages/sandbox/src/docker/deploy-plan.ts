import type { LoadedProject } from '@b-studio/spec';
import type { ComposeModel } from '../kubernetes/compose-model';

/** 운영 주소를 고정하고 릴리스를 무중단으로 바꾸는 프록시. 설정을 다시 읽어도 연결을 끊지 않는다 */
export const DEPLOY_PROXY_IMAGE = 'caddy:2-alpine';
/** 프록시 컨테이너 안에서 서비스마다 듣는 포트의 시작 번호. 호스트에는 서비스마다 고정 포트로 공개한다 */
const PROXY_LISTEN_BASE = 10_000;
/** 기록에 남기는 릴리스 수 */
const MAX_RECORDS = 20;

/** 데이터베이스 엔진별 데이터 폴더. 이미지의 익명 볼륨에 맡기지 않고 이름 붙인 볼륨으로 배포 사이에 남긴다 */
const DATA_DIRECTORIES: Record<string, string> = { postgres: '/var/lib/postgresql/data' };

export interface DeployRelease {
  /** 이미지 태그와 compose 프로젝트 이름에 들어간다 */
  id: string;
  createdAt: string;
  finishedAt?: string;
  /** 무엇을 배포했는지. 스튜디오는 체크포인트, CLI는 폴더나 Git 커밋 */
  source: { label: string; sha?: string };
  by?: string;
  /**
   * active: 운영 주소가 가리키는 릴리스, previous: 되돌릴 수 있게 이미지를 남긴 이전 릴리스,
   * retired: 이미지를 지운 오래된 릴리스, failed: 빌드나 준비 확인에 실패해 전환하지 않은 릴리스
   */
  status: 'active' | 'previous' | 'retired' | 'failed';
  /** 서비스 이름 → 운영 이미지 태그 */
  images: Record<string, string>;
  /** 이 릴리스 네트워크에 붙이는 기반 스택의 부가 서비스 (DB 등) */
  baseServices: string[];
  /** 한 줄 요약 */
  error?: string;
  /** 컴파일 에러나 컨테이너 로그처럼 원인을 찾을 줄 */
  errorDetail?: string;
}

export interface DeployHistoryEntry {
  at: string;
  action: 'deploy' | 'rollback' | 'failed';
  release: string;
  /** 전환하기 전에 운영 주소가 가리키던 릴리스 */
  from?: string;
  error?: string;
}

/** 프로젝트 하나의 운영 배포 상태. 스튜디오 서버의 상태 폴더에 둔다 */
export interface DeployState {
  version: 1;
  project: string;
  /** 서비스 이름 → 운영 주소로 공개한 127.0.0.1의 포트. 한 번 정하면 배포를 바꿔도 그대로다 */
  ports: Record<string, number>;
  active?: string;
  releases: DeployRelease[];
  history: DeployHistoryEntry[];
}

export function emptyDeployState(project: string): DeployState {
  return { version: 1, project, ports: {}, releases: [], history: [] };
}

/** 배포 자원 이름. 샌드박스(studio-*)와 섞이지 않게 접두사를 따로 쓴다 */
export function deployNames(project: string) {
  return {
    base: `bsd-${project}-base`,
    release: (id: string) => `bsd-${project}-${id}`,
    proxy: `bsd-${project}-proxy`,
    image: (service: string, id: string) => `b-studio-deploy/${project}-${service}:${id}`,
    container: (composeProject: string, service: string) => `${composeProject}-${service}-1`,
  };
}

/** 초 단위까지의 UTC 시각. 태그와 compose 프로젝트 이름에 쓸 수 있는 글자만 쓴다 */
export function newReleaseId(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `r${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

export function proxyListenPort(index: number): number {
  return PROXY_LISTEN_BASE + index;
}

/** compose는 파일을 읽을 때 `$`를 다시 치환하므로, 이미 해석한 값의 `$`는 `$$`로 적는다 */
function escapeDollars<T>(value: T): T {
  if (typeof value === 'string') return value.replaceAll('$', '$$$$') as T;
  if (Array.isArray(value)) return value.map(escapeDollars) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, escapeDollars(item)])) as T;
  return value;
}

/**
 * 부가 서비스(DB 등)만 담은 기반 스택. 릴리스를 바꿔도 내리지 않고, 데이터 폴더는 이름 붙인 볼륨에 둔다.
 * 개발용 공유 캐시 볼륨은 managed 서비스만 쓰므로 들어오지 않는다
 */
export function planBaseCompose(config: ComposeModel, project: Pick<LoadedProject, 'managed' | 'databases'>): { services: Record<string, unknown>; volumes?: Record<string, unknown> } | undefined {
  const managed = new Set(project.managed.map(([name]) => name));
  const names = Object.keys(config.services).filter((name) => !managed.has(name)).sort();
  if (names.length === 0) return undefined;

  const volumes: Record<string, unknown> = {};
  const services = Object.fromEntries(
    names.map((name) => {
      const source = config.services[name]!;
      const mounts = [...(source.volumes ?? [])];
      for (const mount of mounts) {
        if (mount.type !== 'volume' || !mount.source) continue;
        const declared = config.volumes?.[mount.source];
        volumes[mount.source] = declared?.external ? { external: true, name: declared.name ?? mount.source } : {};
      }
      const engine = project.databases.find(([database]) => database === name)?.[1].engine;
      const dataDirectory = engine ? DATA_DIRECTORIES[engine] : undefined;
      if (dataDirectory && !mounts.some((mount) => mount.target === dataDirectory)) {
        mounts.push({ type: 'volume', source: `${name}-data`, target: dataDirectory });
        volumes[`${name}-data`] = {};
      }
      // 부가 서비스가 managed 서비스를 기다리면 기반 스택만으로는 뜨지 못하므로 뺀다
      const dependsOn = Object.fromEntries(Object.entries(source.depends_on ?? {}).filter(([dependency]) => !managed.has(dependency)));
      const service = {
        ...(source.image ? { image: source.image } : {}),
        ...(source.build ? { build: source.build } : {}),
        ...(source.command ? { command: source.command } : {}),
        ...(source.entrypoint ? { entrypoint: source.entrypoint } : {}),
        ...(source.working_dir ? { working_dir: source.working_dir } : {}),
        ...(source.environment ? { environment: source.environment } : {}),
        ...(mounts.length > 0 ? { volumes: mounts } : {}),
        ...(source.healthcheck ? { healthcheck: source.healthcheck } : {}),
        ...(Object.keys(dependsOn).length > 0 ? { depends_on: dependsOn } : {}),
        restart: 'unless-stopped',
        labels: { 'b-studio.deploy': projectName(project), 'b-studio.service': name },
      };
      return [name, escapeDollars(service)];
    }),
  );
  return { services, ...(Object.keys(volumes).length > 0 ? { volumes } : {}) };
}

/**
 * 릴리스 스택. managed 서비스를 운영 이미지로 띄우고, 준비 확인용으로 루프백의 빈 포트에 공개한다.
 * 서비스끼리는 이 릴리스의 네트워크에서 이름으로 부르므로 다른 릴리스와 섞이지 않는다.
 * 개발용 소스 마운트와 명령은 가져오지 않는다
 */
export function planReleaseCompose(
  config: ComposeModel,
  project: Pick<LoadedProject, 'managed' | 'secrets' | 'resources' | 'spec'>,
  { releaseId, images }: { releaseId: string; images: Record<string, string> },
): { services: Record<string, unknown> } {
  const managed = new Set(project.managed.map(([name]) => name));
  const services = Object.fromEntries(
    project.managed.map(([name, spec]) => {
      const source = config.services[name] ?? {};
      const environment: Record<string, string | null> = escapeDollars({ ...(source.environment ?? {}) });
      // 시크릿 값은 파일에 쓰지 않는다. 값 자리를 비워 두면 compose가 자기 프로세스 환경에서 채운다
      for (const [secret, secretSpec] of project.secrets) if (secretSpec.services.includes(name)) environment[secret] = null;
      const dependsOn = Object.keys(source.depends_on ?? {}).filter((dependency) => managed.has(dependency));
      const limit = project.resources[name];
      const limits = limit ? { ...(limit.memory ? { memory: limit.memory } : {}), ...(limit.cpus ? { cpus: String(limit.cpus) } : {}) } : undefined;
      const image = images[name];
      if (!image) throw new Error(`${name} 서비스의 운영 이미지가 없습니다`);
      return [
        name,
        {
          image,
          environment,
          ports: [`127.0.0.1::${spec.port}`],
          restart: 'unless-stopped',
          labels: { 'b-studio.deploy': project.spec.name, 'b-studio.release': releaseId, 'b-studio.service': name },
          ...(dependsOn.length > 0 ? { depends_on: dependsOn } : {}),
          ...(limits ? { deploy: { resources: { limits } } } : {}),
        },
      ];
    }),
  );
  return { services };
}

/**
 * 운영 이미지의 빌드 인자. compose build.args에 더해, Dockerfile이 ARG로 선언한 이름 중 compose environment에 값이 있는 것만 넘긴다.
 * next.config의 rewrites처럼 빌드할 때 정해지는 값을 compose에 두 번 적지 않게 하고, 선언하지 않은 환경 변수(DB 비밀번호 등)는 이미지 기록에 남기지 않는다.
 * 값이 비어 있는 항목(compose 프로세스 환경에서 채우는 시크릿)은 넘기지 않는다
 */
export function buildArgsFor(
  dockerfile: string,
  build: { args?: Record<string, string | null> } | undefined,
  environment: Record<string, string | null> | undefined,
): Record<string, string> {
  const declared = new Set([...dockerfile.matchAll(/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)/gim)].map((match) => match[1]!));
  const args: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment ?? {})) if (declared.has(name) && value !== null) args[name] = value;
  for (const [name, value] of Object.entries(build?.args ?? {})) if (value !== null) args[name] = value;
  return args;
}

/**
 * 빌드 출력에서 원인을 찾을 줄만 고른다. BuildKit 출력에는 캐시 층과 전송 줄이 대부분이라 그대로 두면 컴파일 에러가 묻힌다.
 * 에러를 뜻하는 줄이 없으면 끝부분을 돌려준다
 */
export function summarizeBuildOutput(output: string, maxLines = 15): string {
  const lines = output
    .split('\n')
    .map((line) => line.replace(/^#\d+\s+[\d.]+\s+/, '').trimEnd())
    .filter((line) => line.trim());
  const important = [...new Set(lines.filter((line) => /\berror\b|ERROR|FAILED|FAILURE|failed to|Failed to compile|Type error/i.test(line) && !/^\s*#\d+ (DONE|CACHED)/.test(line)))];
  return (important.length > 0 ? important : lines).slice(-maxLines).join('\n');
}

/** 운영 프록시 설정. 자동 HTTPS는 끄고(루프백 공개), 서비스마다 한 포트에서 릴리스 컨테이너로 넘긴다 */
export function buildCaddyfile(routes: ReadonlyArray<{ listen: number; upstream: string }>): string {
  const sites = routes.map(({ listen, upstream }) => `:${listen} {\n\treverse_proxy ${upstream}\n}`);
  return ['{\n\tauto_https off\n}', ...sites].join('\n\n') + '\n';
}

/** 되돌릴 수 있게 남길 이전 릴리스를 고르고, 그보다 오래된 이전 릴리스를 돌려준다. 기록은 최근 것부터 정렬돼 있다 */
export function releasesToRetire(releases: readonly DeployRelease[], keepPrevious: number): DeployRelease[] {
  return releases.filter((release) => release.status === 'previous').slice(keepPrevious);
}

/** 기록을 최근 것부터 정해진 수만큼만 남긴다. 운영 주소가 가리키는 릴리스는 오래됐어도 남긴다 */
export function trimRecords(releases: readonly DeployRelease[], active: string | undefined): DeployRelease[] {
  const kept = releases.slice(0, MAX_RECORDS);
  const current = releases.find((release) => release.id === active);
  return current && !kept.includes(current) ? [...kept.slice(0, MAX_RECORDS - 1), current] : kept;
}

function projectName(project: Pick<LoadedProject, 'managed'> & { spec?: { name: string } }): string {
  return project.spec?.name ?? 'project';
}
