/**
 * "아무 폴더나 연다"(ADR-067)가 앱만 만들고 DB 같은 부가 서비스는 만들지 않아, 부가 서비스가 필요한 앱은 첫 기동이 실패했다(ADR-073).
 * 이 모듈은 사용자 저장소에 이미 있는 compose 파일(compose.yaml, docker-compose.yml 등)에서 postgres·redis·kafka 같은
 * 잘 알려진 인프라 이미지를 쓰는 서비스를 읽어 `compose.b-studio.yaml`에 함께 넣을 형태로 정리한다.
 * 순수 함수만 둔다(파일을 찾고 읽는 일은 호출자가 한다) — apps/studio는 `yaml` 패키지를 직접 물고 있지 않고, 이 패키지는 이미 물고 있다.
 */
import { parse } from 'yaml';

export type InfraEngine =
  | 'postgres'
  | 'mysql'
  | 'mariadb'
  | 'redis'
  | 'valkey'
  | 'kafka'
  | 'zookeeper'
  | 'rabbitmq'
  | 'mongodb'
  | 'elasticsearch'
  | 'opensearch'
  | 'minio'
  | 'mailpit'
  | 'localstack';

/** 엔진별 컨테이너 기본 포트. 연결 문자열을 만들 때 쓰는 추측값이라, compose가 다른 포트로 리스너를 열면 틀릴 수 있다 */
export const ENGINE_DEFAULT_PORT: Record<InfraEngine, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  redis: 6379,
  valkey: 6379,
  kafka: 9092,
  zookeeper: 2181,
  rabbitmq: 5672,
  mongodb: 27017,
  elasticsearch: 9200,
  opensearch: 9200,
  minio: 9000,
  mailpit: 1025,
  localstack: 4566,
};

/** 이미지 이름의 마지막 경로 조각(레지스트리·조직 접두사와 태그를 뺀 것) → 엔진. dbtower·pay·edumeet의 실제 compose로 골랐다 */
const BASENAME_ENGINE: Record<string, InfraEngine> = {
  postgres: 'postgres',
  postgis: 'postgres',
  pgvector: 'postgres',
  timescaledb: 'postgres',
  mysql: 'mysql',
  mariadb: 'mariadb',
  redis: 'redis',
  valkey: 'valkey',
  kafka: 'kafka',
  'cp-kafka': 'kafka',
  zookeeper: 'zookeeper',
  'cp-zookeeper': 'zookeeper',
  rabbitmq: 'rabbitmq',
  mongo: 'mongodb',
  mongodb: 'mongodb',
  elasticsearch: 'elasticsearch',
  opensearch: 'opensearch',
  minio: 'minio',
  mailhog: 'mailpit',
  mailpit: 'mailpit',
  localstack: 'localstack',
};

/**
 * `quay.io/minio/minio:RELEASE...` → `minio`, `apache/kafka:3.8.0` → `kafka` 식으로 이미지 이름에서 엔진을 알아낸다.
 * 경로 조각(`/`)부터 나눈 뒤 마지막 조각에서 태그를 떼어낸다 — 태그부터 떼면 `localhost:5000/postgres:16`처럼
 * 포트가 있는 레지스트리 주소에서 "localhost"를 basename으로 잘못 읽는다(레지스트리:포트의 콜론과 태그의 콜론을 구분하지 못해서다)
 */
export function engineOfImage(image: string): InfraEngine | undefined {
  const withoutDigest = image.split('@')[0] ?? image;
  const lastSegment = withoutDigest.split('/').filter(Boolean).pop() ?? '';
  const basename = (lastSegment.split(':')[0] ?? lastSegment).toLowerCase();
  return BASENAME_ENGINE[basename];
}

const PROD_FILENAME = /(^|[._-])prod(uction)?([._-]|$)/i;

/** 파일 이름이 운영용으로 보이는지(docker-compose.prod.yml 등). 개발용이 있으면 이런 파일은 건너뛴다 */
export function isProdComposeFile(fileName: string): boolean {
  return PROD_FILENAME.test(fileName);
}

/** compose 파일을 찾을 때 우선순위. 앞쪽이 개발용으로 더 흔한 이름이다 */
export const COMPOSE_FILE_CANDIDATES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml', 'docker-compose.dev.yml', 'docker-compose.local.yml'];

/** 기존 compose에서 가져온 부가 서비스. 호스트 포트·바인드 마운트·container_name·networks·build는 버린다 */
export interface ImportedInfraService {
  name: string;
  engine: InfraEngine;
  image: string;
  environment: Record<string, string>;
  command?: string[] | string;
  healthcheck?: Record<string, unknown>;
  /** 같이 가져온 부가 서비스 중 이 서비스가 기다리는 것만 남긴다 */
  dependsOn: string[];
  /** 새 볼륨 이름(서비스 접두사를 붙였다) → 컨테이너 경로. 이름 있는 볼륨만, 호스트 바인드 마운트는 뺀다 */
  volumes: Record<string, string>;
  /** compose의 env_file 이름만 기록한다(경로 문자열). 비밀값이 든 내용은 절대 읽지 않는다 — 세션 폴더 복사본에도 .env는 없다 */
  envFiles: string[];
  /** 확인이 필요한 추가 메모(예: 접속 정보를 개발용 기본값으로 채웠다는 안내). compose.b-studio.yaml에 "# 확인:" 주석으로 남긴다 */
  notes: string[];
  /** 가져온 compose 파일의 프로젝트 폴더 기준 상대 경로 */
  sourceFile: string;
  proposed?: false;
}

/** compose가 없거나 부가 서비스를 못 찾았는데 앱 의존성으로 보아 DB가 필요해 보일 때 새로 제안하는 서비스 */
export interface ProposedInfraService extends Omit<ImportedInfraService, 'sourceFile' | 'proposed'> {
  proposed: true;
  /** 왜 제안했는지. studio.yaml·compose.b-studio.yaml에 "확인:" 주석으로 남긴다 */
  reason: string;
}

export type InfraService = ImportedInfraService | ProposedInfraService;

export interface ComposeImportResult {
  services: ImportedInfraService[];
  /** 부가 서비스가 아니라고 판단해 뺀 것들(진단용) */
  skipped: Array<{ name: string; reason: string }>;
}

/** compose YAML 텍스트를 읽고 잘 알려진 인프라 이미지를 쓰는 서비스만 골라낸다. 파싱에 실패하면 빈 결과를 돌려준다(호출자가 원본을 보여줄 수 있게 던지지 않는다) */
export function importSupportingServices(composeText: string, sourceFile: string): ComposeImportResult {
  let doc: unknown;
  try {
    doc = parse(composeText);
  } catch {
    return { services: [], skipped: [] };
  }
  const servicesRaw = (doc as { services?: unknown } | null)?.services;
  if (!servicesRaw || typeof servicesRaw !== 'object') return { services: [], skipped: [] };

  const skipped: ComposeImportResult['skipped'] = [];
  const matched = new Map<string, { def: Record<string, unknown>; engine: InfraEngine; image: string }>();

  for (const [name, raw] of Object.entries(servicesRaw as Record<string, unknown>)) {
    const def = raw as Record<string, unknown> | null;
    if (!def || typeof def !== 'object') continue;
    // 이미지를 pull하지 않고 build하는 서비스는 저장소의 앱 자신일 가능성이 크다(project-detect가 따로 다룬다). 부가 서비스로 보지 않는다
    if ('build' in def) {
      skipped.push({ name, reason: '이미지를 pull하지 않고 build하는 서비스라 앱 서비스로 보고 뺐습니다' });
      continue;
    }
    // profiles가 있으면 기본 `docker compose up`에 포함되지 않는, 선택적으로만 켜는 서비스다(CDC·관측성 등)
    if ('profiles' in def) {
      skipped.push({ name, reason: 'profiles가 있어 기본 기동에 포함되지 않는 서비스라 뺐습니다' });
      continue;
    }
    const image = typeof def.image === 'string' ? def.image : undefined;
    if (!image) {
      skipped.push({ name, reason: 'image가 없어 무엇인지 알 수 없습니다' });
      continue;
    }
    const engine = engineOfImage(image);
    if (!engine) {
      skipped.push({ name, reason: `${image}은(는) 알려진 인프라 이미지가 아닙니다` });
      continue;
    }
    matched.set(name, { def, engine, image });
  }

  const services: ImportedInfraService[] = [...matched.entries()].map(([name, { def, engine, image }]) => ({
    name,
    engine,
    image,
    environment: normalizeEnvironment(def.environment),
    ...(def.command !== undefined ? { command: def.command as string[] | string } : {}),
    ...(def.healthcheck !== undefined ? { healthcheck: def.healthcheck as Record<string, unknown> } : {}),
    dependsOn: dependsOnNames(def.depends_on).filter((dep) => matched.has(dep)),
    volumes: namedVolumesFor(name, def.volumes),
    envFiles: envFileNames(def.env_file),
    notes: [],
    sourceFile,
  }));

  return { services, skipped };
}

/** env_file은 문자열 하나·문자열 목록·`{ path, required? }` 목록으로 쓸 수 있다. 이름만 뽑는다(파일을 읽지 않는다) */
function envFileNames(value: unknown): string[] {
  const nameOf = (entry: unknown): string | undefined => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') return (entry as { path: string }).path;
    return undefined;
  };
  if (Array.isArray(value)) return value.flatMap((entry) => { const name = nameOf(entry); return name ? [name] : []; });
  const single = nameOf(value);
  return single ? [single] : [];
}

function normalizeEnvironment(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    const out: Record<string, string> = {};
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      const eq = entry.indexOf('=');
      if (eq === -1) continue;
      out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) out[key] = String(val);
    return out;
  }
  return {};
}

function dependsOnNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  if (value && typeof value === 'object') return Object.keys(value as Record<string, unknown>);
  return [];
}

/** 이름 있는 볼륨만 `${서비스}-${컨테이너 경로 마지막 조각}`으로 새 이름을 붙여 가져온다. `./`·`/`·`~`로 시작하는 호스트 바인드 마운트는 뺀다 */
function namedVolumesFor(serviceName: string, value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  let fallbackIndex = 0;
  for (const mount of value) {
    const parsed = typeof mount === 'string' ? parseShortVolume(mount) : parseLongVolume(mount);
    if (!parsed || isBindMount(parsed.source)) continue;
    const label = parsed.target.split('/').filter(Boolean).pop() || `data${fallbackIndex++}`;
    out[`${serviceName}-${label}`] = parsed.target;
  }
  return out;
}

function isBindMount(source: string): boolean {
  return source.startsWith('.') || source.startsWith('/') || source.startsWith('~');
}

function parseShortVolume(mount: string): { source: string; target: string } | undefined {
  const parts = mount.split(':');
  if (parts.length < 2 || !parts[0] || !parts[1]) return undefined;
  return { source: parts[0], target: parts[1] };
}

function parseLongVolume(mount: unknown): { source: string; target: string } | undefined {
  const obj = mount as { source?: unknown; target?: unknown } | null;
  if (!obj || typeof obj.source !== 'string' || typeof obj.target !== 'string') return undefined;
  return { source: obj.source, target: obj.target };
}

/** SQL 식별자(영문·숫자·밑줄, 63자 이하, 숫자로 시작하지 않음). packages/spec의 DatabaseSchema와 같은 규칙이다 */
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** compose·studio.yaml 서비스 이름 규칙(소문자로 시작, 소문자·숫자·-)에 맞춘다 */
export function sanitizeServiceName(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/g, '')
    .replace(/-{2,}/g, '-');
  return cleaned || 'db';
}

/** SQL 식별자 규칙에 맞춘다(POSTGRES_DB·POSTGRES_USER 기본값을 만들 때 쓴다) */
export function sanitizeSqlIdentifier(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^[^a-z_]+/, '');
  return cleaned || 'app';
}

/** compose에서 못 찾았지만 앱 의존성으로 보아 postgres가 필요해 보일 때 새로 제안하는 서비스 하나(project당 하나만 제안한다) */
export function proposePostgresService(database: string, reason: string, serviceName = 'db'): ProposedInfraService {
  const db = sanitizeSqlIdentifier(database);
  return {
    name: sanitizeServiceName(serviceName),
    engine: 'postgres',
    image: 'postgres:17-alpine',
    environment: { POSTGRES_DB: db, POSTGRES_USER: db, POSTGRES_PASSWORD: db },
    healthcheck: { test: ['CMD-SHELL', `pg_isready -U ${db} -d ${db}`], interval: '2s', timeout: '3s', retries: 30 },
    dependsOn: [],
    volumes: { [`${sanitizeServiceName(serviceName)}-data`]: '/var/lib/postgresql/data' },
    envFiles: [],
    notes: [],
    proposed: true,
    reason,
  };
}

/** Spring(JPA + postgresql 드라이버)이나 FastAPI(psycopg·SQLAlchemy+postgres)의 의존성 파일에서 postgres가 필요해 보이는지 추측한다 */
export function suggestsPostgresNeed(template: 'spring-boot' | 'fastapi', dependencyText: string): boolean {
  if (template === 'spring-boot') {
    return /spring-boot-starter-data-jpa/.test(dependencyText) && /postgresql/i.test(dependencyText);
  }
  return /psycopg2?\b/i.test(dependencyText) || (/sqlalchemy/i.test(dependencyText) && /postgres/i.test(dependencyText));
}

/** 앱 설정 텍스트(application.properties/yml, .env.example, requirements.txt 등)에서 어떤 인프라를 쓰는지 짐작한다. 놓치는 것보다 과하게 잡는 쪽이 안전하다(어차피 사람이 확인한다) */
export interface EnvReferences {
  postgres: boolean;
  mysql: boolean;
  redis: boolean;
  kafka: boolean;
}

export function detectEnvReferences(configText: string): EnvReferences {
  return {
    postgres: /jdbc:postgresql|postgresql:\/\/|psycopg2?\b|org\.postgresql/i.test(configText),
    mysql: /jdbc:mysql|mysql:\/\/|pymysql|mysqlclient|mysql-connector/i.test(configText),
    redis: /spring\.(data\.)?redis|REDIS_(HOST|URL|PORT)|redis:\/\/|\bredis\b/i.test(configText),
    kafka: /spring\.kafka|KAFKA_BOOTSTRAP|kafka:\/\/|bootstrap[-._]?servers|\bkafka\b/i.test(configText),
  };
}

export interface EnvWiringResult {
  environment: Record<string, string>;
  notes: string[];
  dependsOn: string[];
}

/** wireAppEnvironment가 필요로 하는 인프라 정보. ImportedInfraService·ProposedInfraService 둘 다 이 모양을 만족한다 */
export interface WirableInfraService {
  name: string;
  engine: InfraEngine;
  environment: Record<string, string>;
  command?: string[] | string;
  /** 있으면(예: 개발용 기본값으로 채웠다는 메모) 접속 정보가 실제 compose 값이 아닐 수 있다는 뜻이라, 앱 쪽 메모 문구를 다르게 쓴다 */
  notes?: readonly string[];
}

/**
 * compose의 `${VAR:-default}` 치환에서 기본값만 뽑는다. `${VAR}`처럼 기본값이 없으면(값이 호스트 셸 환경에 달려 있어
 * 여기서는 알 수 없다) undefined를 돌려준다 — 없는 값을 지어내지 않는다
 */
function resolveComposeVar(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const withDefault = /^\$\{[A-Za-z_][A-Za-z0-9_]*:-(.*)\}$/.exec(raw);
  if (withDefault) return withDefault[1];
  if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(raw)) return undefined;
  return raw;
}

/** 후보 키를 순서대로 보아 처음 값이 있는(치환 후에도 빈 문자열이 아닌) 것을 돌려준다 */
function firstDefined(environment: Record<string, string>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const resolved = resolveComposeVar(environment[key]);
    if (resolved) return resolved;
  }
  return undefined;
}

export interface DbCredentials {
  database: string;
  user: string;
  /** compose에 비밀번호가 없으면(신뢰 인증 등) 없다 — 이때는 지어내지 않고 그대로 알린다 */
  password?: string;
}

/** MySQL_USER/PASSWORD가 없으면(전용 계정을 안 만들고 root만 쓰는 compose) root + MYSQL_ROOT_PASSWORD로 내려간다. MariaDB의 MARIADB_* 변형도 같이 본다 */
function mysqlLikeCredentials(environment: Record<string, string>): DbCredentials | undefined {
  const database = firstDefined(environment, ['MYSQL_DATABASE', 'MARIADB_DATABASE']);
  if (!database) return undefined;
  const user = firstDefined(environment, ['MYSQL_USER', 'MARIADB_USER']);
  const password = firstDefined(environment, ['MYSQL_PASSWORD', 'MARIADB_PASSWORD']);
  if (user) return { database, user, password };
  const rootPassword = firstDefined(environment, ['MYSQL_ROOT_PASSWORD', 'MARIADB_ROOT_PASSWORD']);
  return rootPassword ? { database, user: 'root', password: rootPassword } : undefined;
}

/** 공식 postgres 이미지 기본값: POSTGRES_USER가 없으면 postgres, POSTGRES_DB가 없으면 POSTGRES_USER 값을 쓴다 */
function postgresCredentials(environment: Record<string, string>): DbCredentials {
  const user = firstDefined(environment, ['POSTGRES_USER']) ?? 'postgres';
  const database = firstDefined(environment, ['POSTGRES_DB']) ?? user;
  const password = firstDefined(environment, ['POSTGRES_PASSWORD']);
  return { database, user, password };
}

/** 가져오거나 제안한 부가 서비스의 실제(또는 우리가 채운) 환경 변수에서 접속 정보를 읽는다. 값을 지어내지 않는다 — mysql/mariadb는 계정을 못 찾으면 undefined다 */
export function databaseCredentialsFor(engine: InfraEngine, environment: Record<string, string>): DbCredentials | undefined {
  if (engine === 'postgres') return postgresCredentials(environment);
  if (engine === 'mysql' || engine === 'mariadb') return mysqlLikeCredentials(environment);
  return undefined;
}

type CredentialedEngine = 'postgres' | 'mysql' | 'mariadb';

function isCredentialedEngine(engine: InfraEngine): engine is CredentialedEngine {
  return engine === 'postgres' || engine === 'mysql' || engine === 'mariadb';
}

/**
 * 가져온 postgres/mysql/mariadb가 실제로 쓸 수 있는 비밀번호를 못 구했는지 본다.
 * edumeet의 mysql처럼 `env_file: .env`로만 값을 받고 `environment:`가 아예 없는 경우, 공식 이미지는 비밀번호 없이는 뜨지 않는다
 * (mysql은 MYSQL_ROOT_PASSWORD 등, postgres는 POSTGRES_PASSWORD가 없으면 기동을 거부한다).
 */
export function needsDevDefaultCredentials(service: { engine: InfraEngine; environment: Record<string, string> }): boolean {
  if (!isCredentialedEngine(service.engine)) return false;
  const credentials = databaseCredentialsFor(service.engine, service.environment);
  return credentials === undefined || credentials.password === undefined;
}

const DEV_DEFAULT_CREDENTIAL_ENV: Record<CredentialedEngine, Record<string, string>> = {
  postgres: { POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'app' },
  mysql: { MYSQL_DATABASE: 'app', MYSQL_USER: 'app', MYSQL_PASSWORD: 'app', MYSQL_ROOT_PASSWORD: 'root' },
  mariadb: { MYSQL_DATABASE: 'app', MYSQL_USER: 'app', MYSQL_PASSWORD: 'app', MYSQL_ROOT_PASSWORD: 'root' },
};

/**
 * `needsDevDefaultCredentials`가 참일 때만 부른다. 실제로 값을 알 수 있는 키(치환 가능한 값)는 그대로 두고,
 * 비어 있거나 `${VAR}`처럼 알 수 없는 키만 개발용 기본값으로 채운다 — 부분적으로만 적힌 값(예: MYSQL_DATABASE만 있음)까지 지우지 않는다.
 * note는 왜 채웠는지(호출자가 env_file 존재 여부로 문구를 고른다) — "확인:" 주석으로 남는다
 */
export function withDevDefaultCredentials(service: ImportedInfraService, note: string): ImportedInfraService {
  if (!isCredentialedEngine(service.engine)) return service;
  const defaults = DEV_DEFAULT_CREDENTIAL_ENV[service.engine];
  const environment = { ...service.environment };
  for (const [key, value] of Object.entries(defaults)) {
    if (resolveComposeVar(environment[key]) === undefined) environment[key] = value;
  }
  return { ...service, environment, notes: [...service.notes, note] };
}

/** postgres·mysql/mariadb·redis/valkey인데 healthcheck가 없으면 기본값을 붙인다. depends_on이 service_healthy를 쓸 수 있어야 앱이 DB보다 먼저 뜨는 경합을 피한다 */
export function withDefaultHealthcheck(service: ImportedInfraService): ImportedInfraService {
  if (service.healthcheck) return service;
  const healthcheck = defaultHealthcheckFor(service);
  return healthcheck ? { ...service, healthcheck } : service;
}

function defaultHealthcheckFor(service: { engine: InfraEngine; environment: Record<string, string> }): Record<string, unknown> | undefined {
  if (service.engine === 'postgres') {
    const credentials = postgresCredentials(service.environment);
    return { test: ['CMD-SHELL', `pg_isready -U ${credentials.user} -d ${credentials.database}`], interval: '2s', timeout: '3s', retries: 30 };
  }
  if (service.engine === 'mysql' || service.engine === 'mariadb') {
    // withDevDefaultCredentials를 먼저 거치지 않아 계정을 못 구했으면(비밀번호가 없으면) mysqladmin ping도 인증에 실패하니 붙이지 않는다
    const credentials = mysqlLikeCredentials(service.environment);
    if (!credentials?.password) return undefined;
    return { test: ['CMD', 'mysqladmin', 'ping', '-h', 'localhost', `-u${credentials.user}`, `-p${credentials.password}`], interval: '5s', timeout: '3s', retries: 10 };
  }
  if (service.engine === 'redis' || service.engine === 'valkey') {
    return { test: ['CMD', 'redis-cli', 'ping'], interval: '2s', timeout: '3s', retries: 10 };
  }
  return undefined;
}

/** `redis-server --port 6380`·`postgres -p 5433`처럼 command에서 포트를 바꿨으면 그 값을 쓴다. 간단한 형태만 본다(그 밖은 건너뛴다) */
function customPortFrom(command: string[] | string | undefined): number | undefined {
  if (command === undefined) return undefined;
  const tokens = Array.isArray(command) ? command : command.split(/\s+/);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) continue;
    const inline = /^(?:--port|-p)=(\d+)$/.exec(token);
    if (inline) return Number(inline[1]);
    if ((token === '--port' || token === '-p') && /^\d+$/.test(tokens[index + 1] ?? '')) return Number(tokens[index + 1]);
  }
  return undefined;
}

/**
 * Kafka는 `KAFKA_ADVERTISED_LISTENERS`(bitnami는 `KAFKA_CFG_ADVERTISED_LISTENERS`)에 리스너별 광고 주소를 적는다.
 * 컨테이너 안에서는 서비스 이름으로 광고하는 리스너를 써야 한다 — pay처럼 `PLAINTEXT://localhost:9092,INTERNAL://kafka:29092`면
 * localhost:9092는 호스트 전용이고 kafka:29092가 컨테이너 사이에서 쓸 주소다. 못 찾으면 기본 포트로 추측한다
 */
function kafkaBootstrapFor(serviceName: string, environment: Record<string, string>): { bootstrap: string; guessed: boolean } {
  const raw = environment.KAFKA_ADVERTISED_LISTENERS ?? environment.KAFKA_CFG_ADVERTISED_LISTENERS;
  for (const listener of raw?.split(',') ?? []) {
    const match = /^[A-Za-z0-9_]+:\/\/([^:,]+):(\d+)$/.exec(listener.trim());
    if (match && match[1] === serviceName) return { bootstrap: `${match[1]}:${match[2]}`, guessed: false };
  }
  return { bootstrap: `${serviceName}:${ENGINE_DEFAULT_PORT.kafka}`, guessed: true };
}

/**
 * 알아낸 참조(refs)와 가져오거나 제안한 인프라 목록을 보고, 관리형 서비스에 넣을 환경 변수를 만든다.
 * Spring은 SPRING_DATASOURCE_*·SPRING_DATA_REDIS_HOST·SPRING_KAFKA_BOOTSTRAP_SERVERS, 그 밖은 DATABASE_URL·REDIS_HOST/REDIS_URL·KAFKA_BOOTSTRAP_SERVERS를 쓴다.
 * 데이터베이스 이름·계정·비밀번호는 인프라 서비스의 실제 환경 변수에서 읽는다(지어내지 않는다 — 제안한 postgres는 우리가 그 환경 변수를 채워 뒀으므로 결과가 같다).
 * 그 밖(포트·Kafka 리스너)은 추측일 수 있어 "확인:" 메모를 함께 돌려준다
 */
export function wireAppEnvironment(template: 'nextjs' | 'vite' | 'spring-boot' | 'fastapi', refs: EnvReferences, infra: ReadonlyArray<WirableInfraService>): EnvWiringResult {
  const environment: Record<string, string> = {};
  const notes: string[] = [];
  const dependsOn: string[] = [];
  const byEngine = (engine: InfraEngine) => infra.find((service) => service.engine === engine);

  if (refs.postgres || refs.mysql) {
    const db = refs.postgres ? byEngine('postgres') : (byEngine('mysql') ?? byEngine('mariadb'));
    if (db) {
      dependsOn.push(db.name);
      const scheme = db.engine === 'postgres' ? 'postgresql' : 'mysql';
      const port = customPortFrom(db.command) ?? ENGINE_DEFAULT_PORT[db.engine];
      const credentials = databaseCredentialsFor(db.engine, db.environment);
      if (credentials) {
        const auth = credentials.password !== undefined ? `${credentials.user}:${credentials.password}` : credentials.user;
        if (template === 'spring-boot') {
          environment.SPRING_DATASOURCE_URL = `jdbc:${scheme}://${db.name}:${port}/${credentials.database}`;
          environment.SPRING_DATASOURCE_USERNAME = credentials.user;
          if (credentials.password !== undefined) environment.SPRING_DATASOURCE_PASSWORD = credentials.password;
        } else {
          environment.DATABASE_URL = `${scheme}://${auth}@${db.name}:${port}/${credentials.database}`;
        }
        notes.push(
          credentials.password === undefined
            ? `${db.name}에서 비밀번호를 찾지 못했습니다(신뢰 인증이거나 compose 밖에서 설정). 필요하면 직접 채우세요`
            : (db.notes?.length ?? 0) > 0
              ? `${db.name}은(는) 개발용 기본값을 쓰고 있습니다(부가 서비스 목록의 메모를 보세요). 운영 배포 전에 반드시 바꾸세요`
              : `데이터베이스 접속 정보는 ${db.name}의 환경 변수에서 그대로 가져왔습니다. 값이 바뀌면 함께 고치세요`,
        );
      } else {
        notes.push(`${db.name}의 데이터베이스·계정 정보를 compose 환경 변수에서 찾지 못해 접속 정보를 채우지 못했습니다. 직접 확인하세요`);
      }
    }
  }
  if (refs.redis) {
    const redis = byEngine('redis') ?? byEngine('valkey');
    if (redis) {
      dependsOn.push(redis.name);
      const port = customPortFrom(redis.command) ?? ENGINE_DEFAULT_PORT[redis.engine];
      if (template === 'spring-boot') {
        environment.SPRING_DATA_REDIS_HOST = redis.name;
      } else {
        environment.REDIS_HOST = redis.name;
        environment.REDIS_URL = `redis://${redis.name}:${port}`;
      }
      notes.push(`Redis 연결 환경 변수 이름은 추측입니다(REDIS_HOST/REDIS_URL). 코드가 읽는 이름과 맞는지 확인하세요`);
    }
  }
  if (refs.kafka) {
    const kafka = byEngine('kafka');
    if (kafka) {
      dependsOn.push(kafka.name);
      const { bootstrap, guessed } = kafkaBootstrapFor(kafka.name, kafka.environment);
      if (template === 'spring-boot') environment.SPRING_KAFKA_BOOTSTRAP_SERVERS = bootstrap;
      else environment.KAFKA_BOOTSTRAP_SERVERS = bootstrap;
      notes.push(
        guessed
          ? 'Kafka 부트스트랩 주소는 기본 포트(9092)로 추측했습니다. compose의 리스너 설정이 다르면 고치세요'
          : `Kafka 부트스트랩 주소는 ${kafka.name}의 KAFKA_ADVERTISED_LISTENERS에서 컨테이너 사이 리스너(${bootstrap})를 찾아 채웠습니다`,
      );
    }
  }
  return { environment, notes, dependsOn: [...new Set(dependsOn)] };
}

/** postgres 부가 서비스가 studio.yaml의 databases: 항목(체크포인트 스냅샷) 요건에 맞는지: POSTGRES_DB·POSTGRES_USER가 모두 있고 SQL 식별자여야 한다 */
export function databaseSpecFor(service: { engine: InfraEngine; environment: Record<string, string> }): { database: string; user: string } | undefined {
  if (service.engine !== 'postgres') return undefined;
  const database = service.environment.POSTGRES_DB;
  const user = service.environment.POSTGRES_USER;
  if (database && user && SQL_IDENTIFIER.test(database) && SQL_IDENTIFIER.test(user)) return { database, user };
  return undefined;
}

/**
 * 프론트엔드가 백엔드 주소를 받는 환경 변수 이름 모양(fix/frontend-backend-url). Next.js(NEXT_PUBLIC_*)·Vite(VITE_*)·
 * Create React App(REACT_APP_*)처럼 브라우저 번들에 그대로 박히는 접두사 중에, 이름에 API·BACKEND·SERVER·BASE_URL이
 * 섞인 것만 본다(그 밖의 공개 환경 변수까지 백엔드 주소로 보면 오탐이 늘어난다)
 */
export const FRONTEND_BACKEND_ENV_NAME = /^(NEXT_PUBLIC|VITE|REACT_APP)_\w*(API|BACKEND|SERVER|BASE_URL)\w*$/i;

/** 프론트엔드가 백엔드 주소를 받는 참조 하나: 어느 환경 변수 이름으로 받고, 주소 뒤에 어떤 경로 접미사(`/api` 등)가 붙어 있는지 */
export interface BackendUrlReference {
  envKey: string;
  /** 값에서 포트 뒤에 붙어 있던 경로. 없으면 빈 문자열 */
  suffix: string;
}

/**
 * compose의 `${VAR:-default}` 같은 중첩 치환이 섞인 값에서도, 포트 숫자 뒤에 남은 경로만 뽑는다.
 * 예: `http://localhost:${BACKEND_PORT:-8080}/api}`(바깥 `${...}`의 닫는 중괄호까지 원문 그대로 들어온 조각)에서
 * `/api`만, `http://localhost:8080`에서는 빈 문자열을 돌려준다. 값에 포트 숫자가 여러 번 나오면 마지막 것 기준이다
 */
export function suffixFromUrlValue(value: string): string {
  const PORT_THEN_PATH = /\d+\}*(\/[^}$"'\s]*)/g;
  let suffix = '';
  for (const match of value.matchAll(PORT_THEN_PATH)) suffix = match[1] ?? suffix;
  return suffix;
}

/** environment 맵에서 FRONTEND_BACKEND_ENV_NAME에 맞는 첫 키를 찾는다. 선언 순서(Object.entries)를 그대로 따른다 */
export function detectBackendUrlEnvFromEnvironment(environment: Record<string, string>): BackendUrlReference | undefined {
  for (const [key, value] of Object.entries(environment)) {
    if (FRONTEND_BACKEND_ENV_NAME.test(key)) return { envKey: key, suffix: suffixFromUrlValue(value) };
  }
  return undefined;
}

/** `process.env.NEXT_PUBLIC_API_BASE_URL` 같은 접근 뒤에, 같은 줄에 적힌 문자열 리터럴(폴백 주소)이 있으면 함께 찾는다 */
const ENV_ACCESS = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/;
const STRING_LITERAL = /["'`](https?:\/\/[^"'`]+)["'`]/;

/**
 * 소스 코드(예: frontend/lib/api.ts)에서 `process.env.NEXT_PUBLIC_API_BASE_URL || ... || "http://localhost:8080"`처럼
 * 백엔드 주소를 읽는 자리를 찾는다. 줄 단위로 본다(폴백 체인은 보통 한 문·한 줄에 있다). 여러 줄에 걸쳐 있으면 놓칠 수 있다(추정이라 괜찮다 —
 * compose에 선언돼 있으면 그쪽을 먼저 본다, project-detect.ts 참고)
 */
export function detectBackendUrlEnvFromCode(sourceText: string): BackendUrlReference | undefined {
  for (const line of sourceText.split('\n')) {
    const access = ENV_ACCESS.exec(line);
    if (!access || !FRONTEND_BACKEND_ENV_NAME.test(access[1]!)) continue;
    const literal = STRING_LITERAL.exec(line);
    return { envKey: access[1]!, suffix: literal ? suffixFromUrlValue(literal[1]!) : '' };
  }
  return undefined;
}

/** compose 텍스트 하나에서 특정 서비스의 environment만 꺼낸다(목록·맵 문법 모두). 서비스가 없거나 environment가 없으면 undefined */
export function environmentFromComposeText(composeText: string, serviceName: string): Record<string, string> | undefined {
  let doc: unknown;
  try {
    doc = parse(composeText);
  } catch {
    return undefined;
  }
  const services = (doc as { services?: unknown } | null)?.services;
  if (!services || typeof services !== 'object') return undefined;
  const service = (services as Record<string, unknown>)[serviceName] as { environment?: unknown } | undefined;
  if (!service || typeof service !== 'object') return undefined;
  const environment = normalizeEnvironment(service.environment);
  return Object.keys(environment).length > 0 ? environment : undefined;
}

/** `./frontend`·`frontend`·`frontend/`를 모두 같은 상대 경로로 본다. 없거나 '.'이면 프로젝트 루트 */
function normalizeContext(context: string | undefined): string {
  return (context ?? '.').replace(/^\.\//, '').replace(/\/+$/, '') || '.';
}

/** build 항목(문자열 "./frontend" 또는 { context: "./frontend", ... })에서 context만 꺼낸다 */
function buildContext(build: unknown): string | undefined {
  if (typeof build === 'string') return build;
  if (build && typeof build === 'object' && typeof (build as { context?: unknown }).context === 'string') return (build as { context: string }).context;
  return undefined;
}

/**
 * project-detect가 찾은 서비스 폴더(프로젝트 루트 기준 상대 경로, 루트 자신은 '.')가 원본 compose의 어느 서비스인지 찾는다.
 * 폴더 이름과 compose 서비스 이름이 다를 수 있어(예: 폴더는 frontend인데 compose 서비스 이름은 web) 먼저 build.context로
 * 연결하고, 못 찾으면 같은 이름의 서비스를 그대로 본다(흔한 경우: 폴더 이름과 compose 서비스 이름이 같다)
 */
export function originalComposeServiceFor(
  composeText: string,
  servicePath: string,
  serviceName: string,
): { name: string; environment: Record<string, string> } | undefined {
  let doc: unknown;
  try {
    doc = parse(composeText);
  } catch {
    return undefined;
  }
  const services = (doc as { services?: unknown } | null)?.services;
  if (!services || typeof services !== 'object') return undefined;
  const entries = services as Record<string, unknown>;

  const normalizedPath = normalizeContext(servicePath);
  for (const [name, raw] of Object.entries(entries)) {
    const def = raw as { build?: unknown } | null;
    if (!def || typeof def !== 'object') continue;
    if (normalizeContext(buildContext(def.build)) === normalizedPath) return { name, environment: environmentFromComposeText(composeText, name) ?? {} };
  }
  const byName = entries[serviceName];
  if (byName && typeof byName === 'object') return { name: serviceName, environment: environmentFromComposeText(composeText, serviceName) ?? {} };
  return undefined;
}

/** 환경 변수 이름에 CORS가 섞여 있으면(대소문자 가리지 않음) 백엔드가 허용하는 출처 설정으로 본다 */
const CORS_ENV_NAME = /CORS/i;

/** environment에서 CORS 관련 키만 추려, 원래 compose의 백엔드 서비스가 적어 둔 값 그대로 돌려준다(지어내지 않는다) */
export function corsEnvironmentFrom(environment: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => CORS_ENV_NAME.test(key)));
}
