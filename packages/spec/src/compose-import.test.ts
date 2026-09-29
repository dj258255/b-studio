import { describe, expect, it } from 'vitest';
import {
  databaseCredentialsFor,
  databaseSpecFor,
  detectEnvReferences,
  engineOfImage,
  importSupportingServices,
  isProdComposeFile,
  needsDevDefaultCredentials,
  proposePostgresService,
  suggestsPostgresNeed,
  wireAppEnvironment,
  withDefaultHealthcheck,
  withDevDefaultCredentials,
  type ImportedInfraService,
  type WirableInfraService,
} from './compose-import';

/** 테스트용 최소 ImportedInfraService. import 결과를 흉내 낸다(진짜 파싱 없이 함수 하나만 검증할 때 쓴다) */
function infraFixture(partial: Partial<ImportedInfraService> & Pick<ImportedInfraService, 'name' | 'engine'>): ImportedInfraService {
  return { image: `${partial.engine}:latest`, environment: {}, dependsOn: [], volumes: {}, envFiles: [], notes: [], sourceFile: 'compose.yaml', ...partial };
}

// 실제 저장소(~/Desktop/pay, edumeet, dbtower — 읽기 전용으로 확인한 것)를 본떠 만든 조각. 통째로 복사하지 않았다
const PAY_COMPOSE = `
services:
  mysql:
    image: mysql:8.4
    ports: ["3306:3306"]
    environment:
      MYSQL_DATABASE: becommerce
      MYSQL_USER: becommerce
      MYSQL_PASSWORD: becommerce
      MYSQL_ROOT_PASSWORD: root
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 5s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7.4-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]

  kafka:
    image: apache/kafka:3.8.0
    ports: ["9092:9092"]
    environment:
      KAFKA_NODE_ID: 1
      # 리스너가 둘인 이유(실제 pay/compose.yaml 주석): 클라이언트는 <접속한 주소>가 아니라 <브로커가 광고한 주소>로 다시 붙는다.
      # 컨테이너 안에서는 INTERNAL(kafka:29092)을 써야 하고, PLAINTEXT(localhost:9092)는 호스트 전용이다
      KAFKA_LISTENERS: "PLAINTEXT://0.0.0.0:9092,INTERNAL://0.0.0.0:29092,CONTROLLER://0.0.0.0:9093"
      KAFKA_ADVERTISED_LISTENERS: "PLAINTEXT://localhost:9092,INTERNAL://kafka:29092"
    healthcheck:
      test: ["CMD-SHELL", "kafka-broker-api-versions.sh --bootstrap-server localhost:9092"]

  debezium:
    image: debezium/connect:3.0.0.Final
    profiles: ["cdc"]
    depends_on:
      mysql: { condition: service_healthy }
      kafka: { condition: service_healthy }

  prometheus:
    image: prom/prometheus:v2.54.1
    profiles: ["monitoring"]

  app:
    profiles: ["app"]
    build: { context: ., dockerfile: Dockerfile }
    environment:
      SPRING_DATASOURCE_URL: jdbc:mysql://mysql:3306/becommerce
    depends_on:
      mysql: { condition: service_healthy }
      redis: { condition: service_healthy }
      kafka: { condition: service_healthy }
`;

const EDUMEET_COMPOSE = `
services:
  mysql:
    image: mysql:8.0
    container_name: edumeet-mysql
    # 실제 edumeet은 자격 증명을 environment가 아니라 env_file(.env, 저장소에는 없음)로만 받는다 — 이 조각의 핵심이다
    env_file: .env
    volumes:
      - ./mysql_data:/var/lib/mysql
    ports: ["3306:3306"]
    networks: [edumeet-network]

  redis:
    image: redis:7-alpine
    container_name: edumeet-redis
    command: redis-server --appendonly yes
    ports: ["6379:6379"]
    volumes:
      - ./redis_data:/data
    networks: [edumeet-network]

  app:
    image: \${DOCKER_HUB_REPO}:\${IMAGE_TAG:-latest}
    container_name: edumeet-app
    ports: ["8080:8080"]
    depends_on: [mysql, redis]
    networks: [edumeet-network]

networks:
  edumeet-network:
    driver: bridge
`;

const DBTOWER_COMPOSE = `
services:
  mysql:
    image: mysql:8.4
    container_name: dbtower-mysql
    ports: ["13306:3306"]
    volumes:
      - mysql-data:/var/lib/mysql

  verify-postgres:
    image: postgres:16
    container_name: dbtower-verify-postgres
    environment:
      POSTGRES_PASSWORD: dbtower1234
      POSTGRES_DB: postgres
    ports: ["15433:5432"]

  postgres:
    build: ./docker/postgres
    image: dbtower-postgres:16-hypopg
    container_name: dbtower-postgres
    environment:
      POSTGRES_PASSWORD: dbtower1234
      POSTGRES_DB: sample
    ports: ["15432:5432"]
    volumes:
      - postgres-data:/var/lib/postgresql/data
      - ./docker/postgres-init.sql:/docker-entrypoint-initdb.d/init.sql

  mssql:
    image: mcr.microsoft.com/mssql/server:2022-latest
    ports: ["11433:1433"]

  mongo:
    image: mongo:7
    container_name: dbtower-mongo
    ports: ["17017:27017"]
    volumes:
      - mongo-data:/data/db

  minio:
    image: quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z
    container_name: dbtower-minio
    command: server /data --console-address ":9001"
    ports: ["19000:9000", "19001:9001"]
    volumes:
      - minio-data:/data

  aiops-redis:
    image: redis:7.4-alpine
    profiles: ["aiops"]
    ports: ["16379:6379"]

volumes:
  mysql-data:
  postgres-data:
  mongo-data:
  minio-data:
`;

describe('engineOfImage', () => {
  it('레지스트리 접두사와 태그를 빼고 알려진 엔진을 찾는다', () => {
    expect(engineOfImage('postgres:17-alpine')).toBe('postgres');
    expect(engineOfImage('apache/kafka:3.8.0')).toBe('kafka');
    expect(engineOfImage('quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z')).toBe('minio');
    expect(engineOfImage('pgvector/pgvector:pg16')).toBe('postgres');
  });

  it('포트가 있는 사설 레지스트리 주소에서도 마지막 경로 조각으로 엔진을 찾는다(레지스트리:포트의 콜론을 태그 구분자로 잘못 보지 않는다)', () => {
    expect(engineOfImage('localhost:5000/postgres:16')).toBe('postgres');
    expect(engineOfImage('registry.internal:5000/team/redis:7-alpine')).toBe('redis');
    // 태그가 없어도(레지스트리:포트만 있는 경우) 마지막 조각(postgres)으로 찾는다
    expect(engineOfImage('localhost:5000/postgres')).toBe('postgres');
  });

  it('알려지지 않은 이미지는 undefined다(mssql·oracle·관측성 도구 등)', () => {
    expect(engineOfImage('mcr.microsoft.com/mssql/server:2022-latest')).toBeUndefined();
    expect(engineOfImage('gvenzl/oracle-free:23-slim-faststart')).toBeUndefined();
    expect(engineOfImage('prom/mysqld-exporter:v0.16.0')).toBeUndefined();
    expect(engineOfImage('grafana/grafana:11.2.0')).toBeUndefined();
  });
});

describe('isProdComposeFile', () => {
  it('prod·production이 들어간 파일 이름만 운영용으로 본다', () => {
    expect(isProdComposeFile('docker-compose.prod.yml')).toBe(true);
    expect(isProdComposeFile('docker-compose.production.yml')).toBe(true);
    expect(isProdComposeFile('docker-compose.yml')).toBe(false);
    expect(isProdComposeFile('compose.yaml')).toBe(false);
    expect(isProdComposeFile('docker-compose.perf.yml')).toBe(false);
  });
});

describe('importSupportingServices', () => {
  it('pay: mysql·redis·kafka만 가져오고 build·profiles가 있는 것(debezium·prometheus·app)은 뺀다', () => {
    const result = importSupportingServices(PAY_COMPOSE, 'compose.yaml');
    expect(result.services.map((service) => service.name).sort()).toEqual(['kafka', 'mysql', 'redis']);
    expect(result.skipped.map((entry) => entry.name).sort()).toEqual(['app', 'debezium', 'prometheus']);

    const mysql = result.services.find((service) => service.name === 'mysql')!;
    expect(mysql.engine).toBe('mysql');
    expect(mysql.environment).toEqual({ MYSQL_DATABASE: 'becommerce', MYSQL_USER: 'becommerce', MYSQL_PASSWORD: 'becommerce', MYSQL_ROOT_PASSWORD: 'root' });
    expect(mysql.healthcheck).toBeDefined();
    // 호스트 포트 발행은 가져오지 않는다(타입에 ports가 아예 없다)
    expect('ports' in mysql).toBe(false);
  });

  it('edumeet: app은 잘 알려진 인프라 이미지가 아니라 뺀다. container_name·networks·호스트 바인드 마운트는 버린다', () => {
    const result = importSupportingServices(EDUMEET_COMPOSE, 'docker-compose.yml');
    expect(result.services.map((service) => service.name).sort()).toEqual(['mysql', 'redis']);
    expect(result.skipped.find((entry) => entry.name === 'app')).toBeDefined();

    const redis = result.services.find((service) => service.name === 'redis')!;
    expect(redis.command).toBe('redis-server --appendonly yes');
    // ./redis_data 바인드 마운트는 이름 있는 볼륨이 아니라서 빠진다
    expect(redis.volumes).toEqual({});

    // mysql은 env_file(.env)로만 자격 증명을 받는다 — 이름만 기록하고 내용은 절대 읽지 않는다(environment는 비어 있다)
    const mysql = result.services.find((service) => service.name === 'mysql')!;
    expect(mysql.envFiles).toEqual(['.env']);
    expect(mysql.environment).toEqual({});
    expect(redis.envFiles).toEqual([]);
  });

  it('dbtower: build가 있는 postgres는 빼고, verify-postgres(build 없음)·mongo·minio는 가져온다. mssql·profiles 있는 aiops-redis는 뺀다', () => {
    const result = importSupportingServices(DBTOWER_COMPOSE, 'docker-compose.yml');
    const names = result.services.map((service) => service.name).sort();
    expect(names).toEqual(['minio', 'mongo', 'mysql', 'verify-postgres']);
    expect(result.skipped.map((entry) => entry.name).sort()).toEqual(['aiops-redis', 'mssql', 'postgres']);

    const mongo = result.services.find((service) => service.name === 'mongo')!;
    // 컨테이너 경로의 마지막 조각(db)을 라벨로 쓴다
    expect(mongo.volumes).toEqual({ 'mongo-db': '/data/db' });

    const minio = result.services.find((service) => service.name === 'minio')!;
    expect(minio.command).toBe('server /data --console-address ":9001"');
    expect(minio.volumes).toEqual({ 'minio-data': '/data' });
  });

  it('depends_on은 같이 가져온 서비스만 남긴다(앱이나 뺀 서비스에 대한 의존은 버린다)', () => {
    const compose = `
services:
  db:
    image: postgres:17-alpine
  cache:
    image: redis:7-alpine
    depends_on:
      db: { condition: service_healthy }
      web: { condition: service_started }
`;
    const result = importSupportingServices(compose, 'compose.yaml');
    const cache = result.services.find((service) => service.name === 'cache')!;
    expect(cache.dependsOn).toEqual(['db']);
  });

  it('YAML이 깨졌거나 services가 없으면 빈 결과를 돌려준다(던지지 않는다)', () => {
    expect(importSupportingServices('not: [valid', 'x.yaml')).toEqual({ services: [], skipped: [] });
    expect(importSupportingServices('name: only\n', 'x.yaml')).toEqual({ services: [], skipped: [] });
  });
});

describe('proposePostgresService', () => {
  it('SQL 식별자로 다듬은 이름으로 postgres 서비스를 만들고 이유를 남긴다', () => {
    const service = proposePostgresService('My-App', 'api에 JPA+postgresql 의존성이 있어 제안합니다');
    expect(service.proposed).toBe(true);
    expect(service.environment).toEqual({ POSTGRES_DB: 'my_app', POSTGRES_USER: 'my_app', POSTGRES_PASSWORD: 'my_app' });
    expect(service.name).toBe('db');
    expect(service.reason).toContain('JPA');
  });
});

describe('suggestsPostgresNeed', () => {
  it('Spring은 JPA와 postgresql 드라이버가 함께 있어야 한다', () => {
    expect(suggestsPostgresNeed('spring-boot', "implementation 'org.springframework.boot:spring-boot-starter-data-jpa'\nruntimeOnly 'org.postgresql:postgresql'")).toBe(true);
    expect(suggestsPostgresNeed('spring-boot', "implementation 'org.springframework.boot:spring-boot-starter-data-jpa'")).toBe(false);
  });

  it('FastAPI는 psycopg나 (SQLAlchemy + postgres)가 있어야 한다', () => {
    expect(suggestsPostgresNeed('fastapi', 'psycopg2-binary==2.9.9')).toBe(true);
    expect(suggestsPostgresNeed('fastapi', 'sqlalchemy==2.0\npostgres')).toBe(true);
    expect(suggestsPostgresNeed('fastapi', 'sqlalchemy==2.0')).toBe(false);
  });
});

describe('detectEnvReferences', () => {
  it('Spring datasource·redis·kafka 설정 문구를 찾는다', () => {
    const refs = detectEnvReferences('spring.datasource.url=jdbc:postgresql://localhost:5432/app\nspring.data.redis.host=localhost\nspring.kafka.bootstrap-servers=localhost:9092');
    expect(refs).toEqual({ postgres: true, mysql: false, redis: true, kafka: true });
  });

  it('아무것도 없으면 모두 false다', () => {
    expect(detectEnvReferences('NEXT_PUBLIC_API_BASE_URL=http://localhost:8080')).toEqual({ postgres: false, mysql: false, redis: false, kafka: false });
  });
});

describe('wireAppEnvironment', () => {
  // 접속 정보는 인프라 서비스의 "실제" 환경 변수에서 읽는다(지어내지 않는다) — 제안한 postgres는 우리가 이 환경 변수를 채워 뒀으므로 같은 경로를 탄다
  const infra: WirableInfraService[] = [
    { name: 'db', engine: 'postgres', environment: { POSTGRES_DB: 'orders', POSTGRES_USER: 'orders', POSTGRES_PASSWORD: 'orders-secret' } },
    { name: 'cache', engine: 'redis', environment: {} },
    { name: 'broker', engine: 'kafka', environment: { KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://localhost:9092,INTERNAL://broker:29092' } },
  ];

  it('Spring은 실제 POSTGRES_*와 Kafka 광고 리스너 값으로 채운다(고정값 app/app을 지어내지 않는다)', () => {
    const result = wireAppEnvironment('spring-boot', { postgres: true, mysql: false, redis: true, kafka: true }, infra);
    expect(result.environment).toEqual({
      SPRING_DATASOURCE_URL: 'jdbc:postgresql://db:5432/orders',
      SPRING_DATASOURCE_USERNAME: 'orders',
      SPRING_DATASOURCE_PASSWORD: 'orders-secret',
      SPRING_DATA_REDIS_HOST: 'cache',
      // INTERNAL 리스너(broker:29092)가 컨테이너 사이 주소다. PLAINTEXT(localhost:9092)는 호스트 전용이라 쓰면 컨테이너 안에서 접속이 안 된다
      SPRING_KAFKA_BOOTSTRAP_SERVERS: 'broker:29092',
    });
    expect(result.dependsOn.sort()).toEqual(['broker', 'cache', 'db']);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('FastAPI는 DATABASE_URL·REDIS_HOST/REDIS_URL·KAFKA_BOOTSTRAP_SERVERS를 쓴다', () => {
    const result = wireAppEnvironment('fastapi', { postgres: true, mysql: false, redis: true, kafka: false }, infra);
    expect(result.environment).toEqual({
      DATABASE_URL: 'postgresql://orders:orders-secret@db:5432/orders',
      REDIS_HOST: 'cache',
      REDIS_URL: 'redis://cache:6379',
    });
  });

  it('맞는 인프라가 없으면 아무것도 채우지 않는다', () => {
    const result = wireAppEnvironment('spring-boot', { postgres: true, mysql: false, redis: false, kafka: false }, []);
    expect(result.environment).toEqual({});
    expect(result.dependsOn).toEqual([]);
  });

  it('mysql은 MYSQL_USER/PASSWORD가 없으면(전용 계정 없이 root만 쓰는 compose) root + MYSQL_ROOT_PASSWORD로 내려간다', () => {
    const result = wireAppEnvironment('spring-boot', { postgres: false, mysql: true, redis: false, kafka: false }, [
      { name: 'db', engine: 'mysql', environment: { MYSQL_DATABASE: 'app', MYSQL_ROOT_PASSWORD: 'root-secret' } },
    ]);
    expect(result.environment).toEqual({
      SPRING_DATASOURCE_URL: 'jdbc:mysql://db:3306/app',
      SPRING_DATASOURCE_USERNAME: 'root',
      SPRING_DATASOURCE_PASSWORD: 'root-secret',
    });
  });

  it('mariadb 변형 환경 변수(MARIADB_*)도 같은 방식으로 읽는다', () => {
    const result = wireAppEnvironment('fastapi', { postgres: false, mysql: true, redis: false, kafka: false }, [
      { name: 'db', engine: 'mariadb', environment: { MARIADB_DATABASE: 'app', MARIADB_USER: 'app', MARIADB_PASSWORD: 'secret' } },
    ]);
    expect(result.environment.DATABASE_URL).toBe('mysql://app:secret@db:3306/app');
  });

  it('${VAR:-기본값} 치환은 기본값을 쓴다(호스트 셸 환경에 실제로 있는 값은 알 수 없다)', () => {
    const result = wireAppEnvironment('fastapi', { postgres: true, mysql: false, redis: false, kafka: false }, [
      { name: 'db', engine: 'postgres', environment: { POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: '${POSTGRES_PASSWORD:-devsecret}' } },
    ]);
    expect(result.environment.DATABASE_URL).toBe('postgresql://app:devsecret@db:5432/app');
  });

  it('계정을 못 찾으면(MYSQL_USER도 MYSQL_ROOT_PASSWORD도 없음) 값을 지어내지 않고 depends_on·메모만 남긴다', () => {
    const result = wireAppEnvironment('spring-boot', { postgres: false, mysql: true, redis: false, kafka: false }, [
      { name: 'db', engine: 'mysql', environment: { MYSQL_DATABASE: 'app' } },
    ]);
    expect(result.environment).toEqual({});
    expect(result.dependsOn).toEqual(['db']);
    expect(result.notes.some((note) => note.includes('찾지 못해'))).toBe(true);
  });

  it('command의 --port/-p로 바꾼 포트를 따른다(redis·postgres)', () => {
    const redisResult = wireAppEnvironment('fastapi', { postgres: false, mysql: false, redis: true, kafka: false }, [
      { name: 'cache', engine: 'redis', environment: {}, command: ['redis-server', '--port', '6380'] },
    ]);
    expect(redisResult.environment.REDIS_URL).toBe('redis://cache:6380');

    const postgresResult = wireAppEnvironment('fastapi', { postgres: true, mysql: false, redis: false, kafka: false }, [
      { name: 'db', engine: 'postgres', environment: { POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'app' }, command: 'postgres -p 5433' },
    ]);
    expect(postgresResult.environment.DATABASE_URL).toBe('postgresql://app:app@db:5433/app');
  });

  it('pay 픽스처(mysql·kafka)를 끝까지 통과시키면 실제 compose 값과 같은 환경 변수가 나온다', () => {
    const imported = importSupportingServices(PAY_COMPOSE, 'compose.yaml').services;
    const result = wireAppEnvironment('spring-boot', { postgres: false, mysql: true, redis: true, kafka: true }, imported);
    expect(result.environment).toEqual({
      SPRING_DATASOURCE_URL: 'jdbc:mysql://mysql:3306/becommerce',
      SPRING_DATASOURCE_USERNAME: 'becommerce',
      SPRING_DATASOURCE_PASSWORD: 'becommerce',
      SPRING_DATA_REDIS_HOST: 'redis',
      // kafka:29092(INTERNAL)가 컨테이너 사이 주소다. 9092(PLAINTEXT)로 광고된 것은 localhost용이라 골라지지 않는다
      SPRING_KAFKA_BOOTSTRAP_SERVERS: 'kafka:29092',
    });
  });
});

describe('databaseCredentialsFor', () => {
  it('postgres는 POSTGRES_USER·POSTGRES_DB가 없으면 공식 이미지 기본값(postgres/postgres)으로 내려간다', () => {
    expect(databaseCredentialsFor('postgres', {})).toEqual({ database: 'postgres', user: 'postgres', password: undefined });
    expect(databaseCredentialsFor('postgres', { POSTGRES_USER: 'app' })).toEqual({ database: 'app', user: 'app', password: undefined });
  });

  it('mysql/mariadb가 아니면 undefined다(redis·kafka 등은 이 함수로 자격을 만들지 않는다)', () => {
    expect(databaseCredentialsFor('redis', { MYSQL_DATABASE: 'app' })).toBeUndefined();
  });
});

describe('needsDevDefaultCredentials·withDevDefaultCredentials (edumeet: env_file(.env)만 있고 environment가 없는 경우)', () => {
  it('mysql이 environment 없이 env_file만 있으면 개발용 기본값이 필요하다고 본다', () => {
    expect(needsDevDefaultCredentials({ engine: 'mysql', environment: {} })).toBe(true);
    expect(needsDevDefaultCredentials({ engine: 'postgres', environment: {} })).toBe(true);
    // redis는 이 판단 대상이 아니다(자격 증명 없이도 뜬다)
    expect(needsDevDefaultCredentials({ engine: 'redis', environment: {} })).toBe(false);
  });

  it('비밀번호를 구할 수 있으면 필요 없다고 본다', () => {
    expect(needsDevDefaultCredentials({ engine: 'mysql', environment: { MYSQL_DATABASE: 'app', MYSQL_ROOT_PASSWORD: 'root' } })).toBe(false);
    expect(needsDevDefaultCredentials({ engine: 'postgres', environment: { POSTGRES_PASSWORD: 'secret' } })).toBe(false);
  });

  it('mysql에 개발용 기본값(app/app/app, root)을 채우고 메모를 남긴다 — 없는 키만 채운다', () => {
    const service = infraFixture({ name: 'mysql', engine: 'mysql', environment: {}, envFiles: ['.env'] });
    const filled = withDevDefaultCredentials(service, '원래 compose는 env_file(.env)로 받는데 저장소에 없어 개발용 값을 넣었습니다');
    expect(filled.environment).toEqual({ MYSQL_DATABASE: 'app', MYSQL_USER: 'app', MYSQL_PASSWORD: 'app', MYSQL_ROOT_PASSWORD: 'root' });
    expect(filled.notes).toEqual(['원래 compose는 env_file(.env)로 받는데 저장소에 없어 개발용 값을 넣었습니다']);
  });

  it('postgres에 개발용 기본값(app/app/app)을 채운다', () => {
    const service = infraFixture({ name: 'db', engine: 'postgres', environment: {}, envFiles: ['.env'] });
    const filled = withDevDefaultCredentials(service, '메모');
    expect(filled.environment).toEqual({ POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'app' });
  });

  it('일부만 있으면(MYSQL_DATABASE는 실제 값) 그 키는 그대로 두고 나머지만 채운다', () => {
    const service = infraFixture({ name: 'mysql', engine: 'mysql', environment: { MYSQL_DATABASE: 'becommerce' } });
    const filled = withDevDefaultCredentials(service, '메모');
    expect(filled.environment).toEqual({ MYSQL_DATABASE: 'becommerce', MYSQL_USER: 'app', MYSQL_PASSWORD: 'app', MYSQL_ROOT_PASSWORD: 'root' });
  });

  it('채운 뒤에는 databaseCredentialsFor가 usable한 자격 증명을 돌려준다(개발용 기본값도 정상적으로 배선에 쓰인다)', () => {
    const filled = withDevDefaultCredentials(infraFixture({ name: 'mysql', engine: 'mysql', environment: {}, envFiles: ['.env'] }), '메모');
    expect(databaseCredentialsFor('mysql', filled.environment)).toEqual({ database: 'app', user: 'app', password: 'app' });
  });
});

describe('withDefaultHealthcheck', () => {
  it('healthcheck가 없는 postgres/mysql/redis에 기본 healthcheck를 붙인다(자격 증명은 이미 채워져 있어야 한다)', () => {
    const postgres = withDefaultHealthcheck(infraFixture({ name: 'db', engine: 'postgres', environment: { POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: 'app' } }));
    expect(postgres.healthcheck).toEqual({ test: ['CMD-SHELL', 'pg_isready -U app -d app'], interval: '2s', timeout: '3s', retries: 30 });

    const mysql = withDefaultHealthcheck(infraFixture({ name: 'mysql', engine: 'mysql', environment: { MYSQL_DATABASE: 'app', MYSQL_USER: 'app', MYSQL_PASSWORD: 'app' } }));
    expect(mysql.healthcheck).toEqual({ test: ['CMD', 'mysqladmin', 'ping', '-h', 'localhost', '-uapp', '-papp'], interval: '5s', timeout: '3s', retries: 10 });

    const redis = withDefaultHealthcheck(infraFixture({ name: 'cache', engine: 'redis' }));
    expect(redis.healthcheck).toEqual({ test: ['CMD', 'redis-cli', 'ping'], interval: '2s', timeout: '3s', retries: 10 });
  });

  it('이미 healthcheck가 있으면 그대로 둔다', () => {
    const service = infraFixture({ name: 'cache', engine: 'redis', healthcheck: { test: ['CMD', 'custom'] } });
    expect(withDefaultHealthcheck(service).healthcheck).toEqual({ test: ['CMD', 'custom'] });
  });

  it('mysql/mariadb가 아직 비밀번호를 못 구했으면(개발용 기본값을 채우기 전) healthcheck를 붙이지 않는다', () => {
    const service = infraFixture({ name: 'mysql', engine: 'mysql', environment: {} });
    expect(withDefaultHealthcheck(service).healthcheck).toBeUndefined();
  });

  it('알려진 엔진이 아니면(kafka 등) 붙이지 않는다', () => {
    expect(withDefaultHealthcheck(infraFixture({ name: 'broker', engine: 'kafka' })).healthcheck).toBeUndefined();
  });
});

describe('databaseSpecFor', () => {
  it('postgres이고 POSTGRES_DB·POSTGRES_USER가 SQL 식별자면 databases: 항목을 만든다', () => {
    expect(databaseSpecFor({ engine: 'postgres', environment: { POSTGRES_DB: 'app', POSTGRES_USER: 'app' } })).toEqual({ database: 'app', user: 'app' });
  });

  it('postgres가 아니거나 값이 없거나 SQL 식별자가 아니면 undefined다', () => {
    expect(databaseSpecFor({ engine: 'mysql', environment: { MYSQL_DATABASE: 'app', MYSQL_USER: 'app' } })).toBeUndefined();
    expect(databaseSpecFor({ engine: 'postgres', environment: { POSTGRES_DB: 'app' } })).toBeUndefined();
    expect(databaseSpecFor({ engine: 'postgres', environment: { POSTGRES_DB: '1bad-name', POSTGRES_USER: 'app' } })).toBeUndefined();
  });
});
