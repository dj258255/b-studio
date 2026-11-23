/**
 * "아무 폴더나 연다"(ADR-067)가 앱만 만들고 DB 같은 부가 서비스는 만들지 않아, 부가 서비스가 필요한 앱은 첫 기동이 실패했다(ADR-073).
 * 이 모듈은 사용자 저장소에 이미 있는 compose 파일(compose.yaml, docker-compose.yml 등)에서 postgres·redis·kafka 같은
 * 잘 알려진 인프라 이미지를 쓰는 서비스를 읽어 `compose.b-studio.yaml`에 함께 넣을 형태로 정리한다.
 * 순수 함수만 둔다(파일을 찾고 읽는 일은 호출자가 한다) — apps/studio는 `yaml` 패키지를 직접 물고 있지 않고, 이 패키지는 이미 물고 있다.
 *
 * 계산은 Rust(`crates/bstudio-guard/src/compose_import.rs`)가 한다. 옛 TS는 #1347에서 지웠다.
 * 차등 시험만 그것을 import한다.
 */
import { decodeNative, encodeNative, native } from './native';

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

/**
 * `quay.io/minio/minio:RELEASE...` → `minio`, `apache/kafka:3.8.0` → `kafka` 식으로 이미지 이름에서 엔진을 알아낸다.
 * 경로 조각(`/`)부터 나눈 뒤 마지막 조각에서 태그를 떼어낸다 — 태그부터 떼면 `localhost:5000/postgres:16`처럼
 * 포트가 있는 레지스트리 주소에서 "localhost"를 basename으로 잘못 읽는다(레지스트리:포트의 콜론과 태그의 콜론을 구분하지 못해서다)
 */
export function engineOfImage(image: string): InfraEngine | undefined {
  return (native.composeEngineOfImage(image) ?? undefined) as InfraEngine | undefined;
}

/** 파일 이름이 운영용으로 보이는지(docker-compose.prod.yml 등). 개발용이 있으면 이런 파일은 건너뛴다 */
export function isProdComposeFile(fileName: string): boolean {
  return native.composeIsProdComposeFile(fileName);
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
  return decodeNative<ComposeImportResult>(native.composeImportSupportingServices(composeText, sourceFile));
}

/** compose·studio.yaml 서비스 이름 규칙(소문자로 시작, 소문자·숫자·-)에 맞춘다 */
export function sanitizeServiceName(value: string): string {
  return native.composeSanitizeServiceName(value);
}

/** SQL 식별자 규칙에 맞춘다(POSTGRES_DB·POSTGRES_USER 기본값을 만들 때 쓴다) */
export function sanitizeSqlIdentifier(value: string): string {
  return native.composeSanitizeSqlIdentifier(value);
}

/** compose에서 못 찾았지만 앱 의존성으로 보아 postgres가 필요해 보일 때 새로 제안하는 서비스 하나(project당 하나만 제안한다) */
export function proposePostgresService(database: string, reason: string, serviceName = 'db'): ProposedInfraService {
  return decodeNative<ProposedInfraService>(native.composeProposePostgresService(database, reason, serviceName));
}

/** Spring(JPA + postgresql 드라이버)이나 FastAPI(psycopg·SQLAlchemy+postgres)의 의존성 파일에서 postgres가 필요해 보이는지 추측한다 */
export function suggestsPostgresNeed(template: 'spring-boot' | 'fastapi', dependencyText: string): boolean {
  return native.composeSuggestsPostgresNeed(template, dependencyText);
}

/** 앱 설정 텍스트(application.properties/yml, .env.example, requirements.txt 등)에서 어떤 인프라를 쓰는지 짐작한다. 놓치는 것보다 과하게 잡는 쪽이 안전하다(어차피 사람이 확인한다) */
export interface EnvReferences {
  postgres: boolean;
  mysql: boolean;
  redis: boolean;
  kafka: boolean;
}

export function detectEnvReferences(configText: string): EnvReferences {
  return decodeNative<EnvReferences>(native.composeDetectEnvReferences(configText));
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

export interface DbCredentials {
  database: string;
  user: string;
  /** compose에 비밀번호가 없으면(신뢰 인증 등) 없다 — 이때는 지어내지 않고 그대로 알린다 */
  password?: string;
}

/** 가져오거나 제안한 부가 서비스의 실제(또는 우리가 채운) 환경 변수에서 접속 정보를 읽는다. 값을 지어내지 않는다 — mysql/mariadb는 계정을 못 찾으면 undefined다 */
export function databaseCredentialsFor(engine: InfraEngine, environment: Record<string, string>): DbCredentials | undefined {
  const json = native.composeDatabaseCredentialsFor(engine, encodeNative(environment));
  return json === null ? undefined : decodeNative<DbCredentials>(json);
}

/**
 * 가져온 postgres/mysql/mariadb가 실제로 쓸 수 있는 비밀번호를 못 구했는지 본다.
 * edumeet의 mysql처럼 `env_file: .env`로만 값을 받고 `environment:`가 아예 없는 경우, 공식 이미지는 비밀번호 없이는 뜨지 않는다
 * (mysql은 MYSQL_ROOT_PASSWORD 등, postgres는 POSTGRES_PASSWORD가 없으면 기동을 거부한다).
 */
export function needsDevDefaultCredentials(service: { engine: InfraEngine; environment: Record<string, string> }): boolean {
  return native.composeNeedsDevDefaultCredentials(service.engine, encodeNative(service.environment));
}

/**
 * `needsDevDefaultCredentials`가 참일 때만 부른다. 실제로 값을 알 수 있는 키(치환 가능한 값)는 그대로 두고,
 * 비어 있거나 `${VAR}`처럼 알 수 없는 키만 개발용 기본값으로 채운다 — 부분적으로만 적힌 값(예: MYSQL_DATABASE만 있음)까지 지우지 않는다.
 * note는 왜 채웠는지(호출자가 env_file 존재 여부로 문구를 고른다) — "확인:" 주석으로 남는다
 */
export function withDevDefaultCredentials(service: ImportedInfraService, note: string): ImportedInfraService {
  return decodeNative<ImportedInfraService>(native.composeWithDevDefaultCredentials(encodeNative(service), note));
}

/** postgres·mysql/mariadb·redis/valkey인데 healthcheck가 없으면 기본값을 붙인다. depends_on이 service_healthy를 쓸 수 있어야 앱이 DB보다 먼저 뜨는 경합을 피한다 */
export function withDefaultHealthcheck(service: ImportedInfraService): ImportedInfraService {
  return decodeNative<ImportedInfraService>(native.composeWithDefaultHealthcheck(encodeNative(service)));
}

/**
 * 알아낸 참조(refs)와 가져오거나 제안한 인프라 목록을 보고, 관리형 서비스에 넣을 환경 변수를 만든다.
 * Spring은 SPRING_DATASOURCE_*·SPRING_DATA_REDIS_HOST·SPRING_KAFKA_BOOTSTRAP_SERVERS, 그 밖은 DATABASE_URL·REDIS_HOST/REDIS_URL·KAFKA_BOOTSTRAP_SERVERS를 쓴다.
 * 데이터베이스 이름·계정·비밀번호는 인프라 서비스의 실제 환경 변수에서 읽는다(지어내지 않는다 — 제안한 postgres는 우리가 그 환경 변수를 채워 뒀으므로 결과가 같다).
 * 그 밖(포트·Kafka 리스너)은 추측일 수 있어 "확인:" 메모를 함께 돌려준다
 */
export function wireAppEnvironment(template: 'nextjs' | 'vite' | 'spring-boot' | 'fastapi', refs: EnvReferences, infra: ReadonlyArray<WirableInfraService>): EnvWiringResult {
  return decodeNative<EnvWiringResult>(native.composeWireAppEnvironment(template, encodeNative(refs), encodeNative(infra)));
}

/** postgres 부가 서비스가 studio.yaml의 databases: 항목(체크포인트 스냅샷) 요건에 맞는지: POSTGRES_DB·POSTGRES_USER가 모두 있고 SQL 식별자여야 한다 */
export function databaseSpecFor(service: { engine: InfraEngine; environment: Record<string, string> }): { database: string; user: string } | undefined {
  const json = native.composeDatabaseSpecFor(service.engine, encodeNative(service.environment));
  return json === null ? undefined : decodeNative<{ database: string; user: string }>(json);
}

/**
 * 프론트엔드가 백엔드 주소를 받는 환경 변수 이름 모양(fix/frontend-backend-url). Next.js(NEXT_PUBLIC_*)·Vite(VITE_*)·
 * Create React App(REACT_APP_*)처럼 브라우저 번들에 그대로 박히는 접두사 중에, 이름에 API·BACKEND·SERVER·BASE_URL이
 * 섞인 것만 본다(그 밖의 공개 환경 변수까지 백엔드 주소로 보면 오탐이 늘어난다).
 *
 * 판정은 Rust가 한다(이 상수는 호환용이다 — 차등 시험이 Rust와 같은 답을 내는지 견준다).
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
  return native.composeSuffixFromUrlValue(value);
}

/** environment 맵에서 FRONTEND_BACKEND_ENV_NAME에 맞는 첫 키를 찾는다. 선언 순서(Object.entries)를 그대로 따른다 */
export function detectBackendUrlEnvFromEnvironment(environment: Record<string, string>): BackendUrlReference | undefined {
  const json = native.composeDetectBackendUrlEnvFromEnvironment(encodeNative(environment));
  return json === null ? undefined : decodeNative<BackendUrlReference>(json);
}

/**
 * 소스 코드(예: frontend/lib/api.ts)에서 `process.env.NEXT_PUBLIC_API_BASE_URL || ... || "http://localhost:8080"`처럼
 * 백엔드 주소를 읽는 자리를 찾는다. 줄 단위로 본다(폴백 체인은 보통 한 문·한 줄에 있다). 여러 줄에 걸쳐 있으면 놓칠 수 있다(추정이라 괜찮다 —
 * compose에 선언돼 있으면 그쪽을 먼저 본다, project-detect.ts 참고)
 */
export function detectBackendUrlEnvFromCode(sourceText: string): BackendUrlReference | undefined {
  const json = native.composeDetectBackendUrlEnvFromCode(sourceText);
  return json === null ? undefined : decodeNative<BackendUrlReference>(json);
}

export interface ServerBackendUrlReference extends BackendUrlReference {
  /** 리터럴 기본값에 적힌 포트(있으면). 백엔드 후보가 둘 이상일 때 이 포트로 어느 서비스인지 짝짓는다 */
  port?: number;
}

/** detectBackendUrlEnvFromCode의 서버 쪽 짝. 공개 변수로 이미 잡힌 이름은 그쪽이 우선이라 건너뛴다 */
export function detectServerBackendUrlEnvFromCode(sourceText: string): ServerBackendUrlReference | undefined {
  const json = native.composeDetectServerBackendUrlEnvFromCode(sourceText);
  return json === null ? undefined : decodeNative<ServerBackendUrlReference>(json);
}

/**
 * .env.example·.env.local.example나 README 코드 블록처럼 `KEY=value` 모양인 텍스트에서 백엔드 주소 변수를 찾는다.
 * 이름이 공개 접두사(NEXT_PUBLIC_ 등)에 맞으면 공개 변수로, 아니면 서버 쪽 조각으로 본다.
 * 둘 다 값이 http(s) 스킴이어야 찾은 것으로 본다(스킴이 다르면 백엔드 주소가 아니다).
 */
export function detectBackendUrlEnvFromAssignments(text: string): (ServerBackendUrlReference & { public: boolean }) | undefined {
  const json = native.composeDetectBackendUrlEnvFromAssignments(text);
  return json === null ? undefined : decodeNative<ServerBackendUrlReference & { public: boolean }>(json);
}

/** compose 텍스트 하나에서 특정 서비스의 environment만 꺼낸다(목록·맵 문법 모두). 서비스가 없거나 environment가 없으면 undefined */
export function environmentFromComposeText(composeText: string, serviceName: string): Record<string, string> | undefined {
  const json = native.composeEnvironmentFromComposeText(composeText, serviceName);
  return json === null ? undefined : decodeNative<Record<string, string>>(json);
}

/**
 * project-detect가 찾은 서비스 폴더(프로젝트 루트 기준 상대 경로, 루트 자신은 '.')가 원본 compose의 어느 서비스인지 찾는다.
 * 폴더 이름과 compose 서비스 이름이 다를 수 있어(예: 폴더는 frontend인데 compose 서비스 이름은 web) 먼저 build.context로
 * 연결하고, 못 찾으면 같은 이름의 서비스를 그대로 본다(흔한 경우: 폴더 이름과 compose 서비스 이름이 같다)
 */
export function originalComposeServiceFor(composeText: string, servicePath: string, serviceName: string): { name: string; environment: Record<string, string> } | undefined {
  const json = native.composeOriginalComposeServiceFor(composeText, servicePath, serviceName);
  return json === null ? undefined : decodeNative<{ name: string; environment: Record<string, string> }>(json);
}

/** environment에서 CORS 관련 키만 추려, 원래 compose의 백엔드 서비스가 적어 둔 값 그대로 돌려준다(지어내지 않는다) */
export function corsEnvironmentFrom(environment: Record<string, string>): Record<string, string> {
  return decodeNative<Record<string, string>>(native.composeCorsEnvironmentFrom(encodeNative(environment)));
}
