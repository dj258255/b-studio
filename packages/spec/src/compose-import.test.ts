import { describe, expect, it } from 'vitest';
import {
  databaseSpecFor,
  detectEnvReferences,
  engineOfImage,
  importSupportingServices,
  isProdComposeFile,
  proposePostgresService,
  suggestsPostgresNeed,
  wireAppEnvironment,
} from './compose-import';

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
  const infra = [
    { name: 'db', engine: 'postgres' as const },
    { name: 'cache', engine: 'redis' as const },
    { name: 'broker', engine: 'kafka' as const },
  ];

  it('Spring은 SPRING_DATASOURCE_*·SPRING_DATA_REDIS_HOST·SPRING_KAFKA_BOOTSTRAP_SERVERS를 채운다', () => {
    const result = wireAppEnvironment('spring-boot', { postgres: true, mysql: false, redis: true, kafka: true }, infra);
    expect(result.environment).toMatchObject({
      SPRING_DATASOURCE_URL: 'jdbc:postgresql://db:5432/app',
      SPRING_DATA_REDIS_HOST: 'cache',
      SPRING_KAFKA_BOOTSTRAP_SERVERS: 'broker:9092',
    });
    expect(result.dependsOn.sort()).toEqual(['broker', 'cache', 'db']);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it('FastAPI는 DATABASE_URL·REDIS_HOST/REDIS_URL·KAFKA_BOOTSTRAP_SERVERS를 쓴다', () => {
    const result = wireAppEnvironment('fastapi', { postgres: true, mysql: false, redis: true, kafka: false }, infra);
    expect(result.environment).toEqual({
      DATABASE_URL: 'postgresql://app:app@db:5432/app',
      REDIS_HOST: 'cache',
      REDIS_URL: 'redis://cache:6379',
    });
  });

  it('맞는 인프라가 없으면 아무것도 채우지 않는다', () => {
    const result = wireAppEnvironment('spring-boot', { postgres: true, mysql: false, redis: false, kafka: false }, []);
    expect(result.environment).toEqual({});
    expect(result.dependsOn).toEqual([]);
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
