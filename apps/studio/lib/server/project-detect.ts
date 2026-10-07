/**
 * 아무 폴더나 프로젝트로 열 때(ADR-067), 폴더를 보고 스택을 알아내 b-studio가 돌릴 파일(studio.yaml·개발용 compose·Dockerfile)을 제안한다.
 *
 * 알아내는 스택(폴더 바로 아래와 한 단계 아래 폴더, 모노레포로 보이면 apps/services/packages 같은 컨테이너 폴더와
 * 이미 찾은 서비스 폴더 바로 아래까지 두 단계):
 *  - Next.js: package.json의 의존성에 next. 패키지 관리자는 잠금 파일로(pnpm·yarn·npm). package.json에 dev
 *    스크립트가 있으면(실제 저장소에서 흔한, NODE_ENV를 고정하는 scripts/dev.mjs 같은 래퍼) 직접 next/vite를
 *    부르지 않고 그 스크립트를 그대로 쓴다(포트는 PORT 환경 변수로 맞춘다)
 *  - Vite(React·Vue·Svelte 등): package.json의 의존성에 vite(Next가 아닐 때)
 *  - Spring Boot: build.gradle(.kts)에 org.springframework.boot, 또는 pom.xml에 spring-boot. 서비스 폴더에
 *    Gradle·Maven 래퍼(gradlew·mvnw)가 없으면 상위 폴더를 저장소 루트까지 거슬러 올라가 찾는다(실제 저장소에서
 *    확인한 구조: 래퍼는 저장소 루트에, Gradle 프로젝트 루트는 하위 폴더에 따로 있다) — 찾으면 그 래퍼가 있는
 *    폴더에서 `-p`(Gradle)·`-f`(Maven)로 서비스 폴더를 가리켜 실행하고, 이미지는 JDK만 있으면 된다(래퍼가
 *    배포판 버전을 스스로 받으므로 이미지에 든 Gradle·Maven 버전과 어긋날 일이 없다)
 *  - FastAPI: requirements.txt·pyproject.toml에 fastapi. 앱 모듈은 `X = FastAPI(`가 있는 파일에서
 *
 * 모노레포로 보이는 폴더(바로 아래가 단일 앱이 아닐 때)는 두 단계까지 더 본다: apps/services/packages 같은
 * 흔한 컨테이너 폴더 한 단계 아래, 그리고 이미 찾은 서비스 폴더 바로 아래의 또 다른 빌드(예: commerce/consumer-app
 * 처럼 백엔드 폴더 안에 선 별도 Gradle 프로젝트가 있는 경우). 뒤의 경우는 같은 저장소의 다른 서비스로 넣되
 * `defaultSelected: false`를 달아 사람이 서비스 선택에서 직접 켤 때까지는 기본으로 띄우지 않는다(ADR-083).
 * k6·tools·scripts·docs·examples·fixtures처럼 테스트·도구용으로 흔히 쓰는 폴더 이름은 보지 않고, 너무 많이
 * 잡히지 않게 서비스 수에 상한(MAX_DETECTED_SERVICES)을 둔다.
 *
 * ADR-067은 앱만 만들고 DB 같은 부가 서비스는 만들지 않아 첫 기동이 실패할 수 있었다(ADR-073).
 * 이제 앱 폴더에서 찾은 compose 파일(compose.yaml·docker-compose.yml 등)에서 postgres·redis·kafka 같은 잘 알려진 인프라
 * 이미지를 쓰는 서비스를 함께 가져오고(`@b-studio/spec`의 순수 함수, apps/studio는 `yaml` 패키지를 직접 물지 않는다),
 * compose가 없어도 Spring(JPA+postgresql)·FastAPI(psycopg·SQLAlchemy+postgres) 의존성이 있으면 postgres를 새로 제안한다.
 * 앱 설정(application.properties/yml, .env.example)에서 참조를 찾아 관리형 서비스에 접속 환경 변수도 채운다(추측이라 "확인:" 메모를 남긴다).
 *
 * 만드는 파일은 사용자 파일과 이름이 겹치지 않게 `studio.yaml`·`compose.b-studio.yaml`·서비스 폴더의 `Dockerfile.b-studio`다.
 * 쓰기는 이 모듈이 하지 않는다(제안만). 쓰는 쪽(project-registry)이 git 추적에서 빼 둔다.
 *
 * 컨테이너 마운트(ADR-088): 서비스 폴더만 마운트하면(예전 `./commerce:/app`) 실제 저장소의 멀티 모듈 Gradle·pnpm/npm
 * 워크스페이스·서비스 폴더 밖 공유 설정을 참조하는 빌드가 깨진다(`$rootDir/../docs`처럼). 그래서 모든 관리형 서비스가
 * 프로젝트 루트 전체를 `/workspace`로 마운트하고(`.:/workspace`), `working_dir`로 자기 서비스 폴더에서 실행한다.
 * 캐시 볼륨(예: Gradle 프로젝트 캐시·node_modules·build 출력)도 이 서비스 폴더 기준 경로로 옮기고, 의존성 캐시(Gradle
 * 홈·pnpm 스토어)는 워크스페이스 밖 절대 경로 그대로 둔다.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  corsEnvironmentFrom,
  databaseSpecFor,
  dependencyClosure,
  detectBackendUrlEnvFromAssignments,
  detectBackendUrlEnvFromCode,
  detectBackendUrlEnvFromEnvironment,
  detectEnvReferences,
  detectServerBackendUrlEnvFromCode,
  importSupportingServices,
  needsDevDefaultCredentials,
  originalComposeServiceFor,
  proposePostgresService,
  publicUrlPlaceholder,
  suggestsPostgresNeed,
  wireAppEnvironment,
  withDefaultHealthcheck,
  withDevDefaultCredentials,
  COMPOSE_FILE_CANDIDATES,
  isProdComposeFile,
  type ImportedInfraService,
  type InfraService,
  type WirableInfraService,
} from '@b-studio/spec';

export type { InfraService } from '@b-studio/spec';

export type DetectedTemplate = 'nextjs' | 'vite' | 'spring-boot' | 'fastapi';

export interface DetectedService {
  name: string;
  template: DetectedTemplate;
  /** 프로젝트 폴더 기준. 폴더 바로 아래면 '.' */
  path: string;
  port: number;
  preview: 'browser' | 'openapi';
  ready: { path: string; expectStatus?: number };
  contract?: string;
  /** Dockerfile 본문 */
  dockerfile: string;
  /**
   * compose 서비스에 더 붙일 볼륨(이름 → 컨테이너 경로). '/'로 시작하면 절대 경로(워크스페이스 밖 의존성 캐시,
   * 예: Gradle 홈·pnpm 스토어)로 그대로 쓰고, 아니면 이 서비스의 working_dir(`/workspace/<path>`) 기준 상대 경로로 본다
   * (예: Gradle 프로젝트 캐시·node_modules·build 출력)
   */
  volumes: Record<string, string>;
  /** 부가 서비스(DB 등) 접속 정보로 채운 환경 변수. 추측이라 notes에 "확인:" 메모가 함께 붙는다 */
  environment: Record<string, string>;
  /** 이 서비스가 기다릴 부가 서비스 이름(compose depends_on) */
  dependsOn: string[];
  /** 사람이 확인해야 할 추측 */
  notes: string[];
  /**
   * 기본 서비스 선택(ADR-083)에 넣을지. 생략하면 true(기본 켬). 이미 찾은 서비스 폴더 하위의 또 다른 빌드처럼,
   * 별도 서비스로는 넣지만 사람이 확인하고 켤 때까지 기본으로는 띄우고 싶지 않은 것에 false를 준다
   */
  defaultSelected?: boolean;
  /**
   * 이 서비스의 테스트 명령을 찾았으면(ADR-133) specYaml이 workflow.tests에 넣어 게이트의 test 단계가 실제로
   * 돈다. 없으면 undefined — workflow.tests에 아무것도 넣지 않고, 그래서 게이트가 test 단계 자체를 건너뛴다
   * (버그 리포트 104). command는 `docker compose exec`에 배열 그대로 넘어가는 exec 형태라 셸을 거치지 않는다 —
   * 래퍼가 다른 폴더에 있어 `cd`가 필요하면 `['sh', '-c', '...']`로 셸을 직접 지정한다(detectSpring의
   * springTestCommand 참고, Gradle 서브프로젝트가 상위 래퍼를 쓸 때)
   */
  testCommand?: { command: string[]; maxAttempts?: number };
  /**
   * Gradle 서비스의 테스트 JVM에 Mockito를 -javaagent로 붙이는 init 스크립트가 필요하면 true(ADR-134).
   * 샌드박스 컨테이너는 colima 공유 폴더(sshfs) 위에서 도는데, 공유 폴더 안 파일은 컨테이너 root가 만들어도
   * 소유자가 호스트 uid(501 등)로 보인다. HotSpot의 Attach Listener는 cwd의 `.attach_pid<pid>` 트리거 파일의
   * 소유자가 euid·root와 안 맞으면 무시하고 `/tmp`로도 넘어가지 않아, Mockito inline mock maker가 쓰는 JVM
   * self-attach가 항상 실패한다(도그푸딩 마찰 106). `composeYaml`이 true인 서비스에 compose `configs:`로
   * `GRADLE_USER_HOME/init.d/`에 `MOCKITO_AGENT_INIT_SCRIPT`를 심어, Mockito 공식 권장대로 attach 자체를
   * 건너뛰게 한다. Maven은 이번 범위 밖이다(ADR-134의 "검토한 선택지" 참고)
   */
  mockitoAgentInit?: boolean;
  /**
   * Gradle 서비스의 테스트 JVM에 힙·메타스페이스 상한을 거는 init 스크립트가 필요하면 true(ADR-138).
   * 샌드박스 서비스 컨테이너는 보통 메모리 한도를 걸지 않는데(이 함수는 resources: 블록을 만들지 않는다),
   * `--no-daemon`으로 돌리는 테스트 JVM의 기본 힙은 JVM 에르고노믹스가 "보이는 메모리"(컨테이너 한도가 없으면
   * colima VM 전체)의 1/4로 자동으로 잡는다. 같은 컨테이너에서 개발 서버(bootRun)가 이미 돌고 있으면 두 JVM의
   * 메모리 합이 VM의 남은 메모리를 넘어 커널이 컨테이너를 통째로 종료시킨다(도그푸딩 마찰 116). Maven은
   * mockitoAgentInit과 같은 이유로 이번 범위 밖이다(ADR-134의 "검토한 선택지" 참고 — surefire의 argLine은
   * 사용자 설정을 덮어쓸 위험이 있다)
   */
  testMemoryInit?: boolean;
}

export interface ProjectDetection {
  folder: string;
  name: string;
  /** 이미 studio.yaml이 있으면 그대로 쓴다(아무것도 만들지 않는다) */
  hasSpec: boolean;
  services: DetectedService[];
  /** 기존 compose에서 가져오거나 새로 제안한 부가 서비스(DB·캐시·메시지 큐 등, ADR-073) */
  infra: InfraService[];
  /** infra 중 앱 서비스가 실제로 기대는(닫힘) 이름(ADR-083). 폴더 열기 미리보기의 체크박스 기본값이다 — 아무도 기대지 않는 부가 서비스는 기본으로 켜지 않는다 */
  defaultInfra: string[];
  warnings: string[];
  /**
   * 프론트엔드가 백엔드 주소를 환경 변수로 받도록 자동으로 연결했으면(fix/frontend-backend-url) 남는다.
   * specYaml이 이 값으로 workflow.pageChecks 기본 확인(화면이 백엔드 호출에 실패하면 게이트가 잡는다)을 만든다
   */
  frontendBackendWiring?: { frontendService: string; backendService: string; backendProbePath: string };
}

export interface GeneratedFile {
  /** 프로젝트 폴더 기준 */
  path: string;
  content: string;
}

export const SPEC_FILE = 'studio.yaml';
export const GENERATED_COMPOSE = 'compose.b-studio.yaml';
export const GENERATED_DOCKERFILE = 'Dockerfile.b-studio';

/** 컨테이너 안에서 프로젝트 루트 전체를 마운트하는 자리(ADR-088). Dockerfile의 기본 WORKDIR이자 compose 바인드 마운트의 대상이다 */
export const CONTAINER_WORKSPACE_ROOT = '/workspace';

/** 서비스가 실제로 일하는 컨테이너 안 폴더. path가 '.'이면 워크스페이스 루트 자체다 */
function containerWorkDir(servicePath: string): string {
  return servicePath === '.' ? CONTAINER_WORKSPACE_ROOT : `${CONTAINER_WORKSPACE_ROOT}/${servicePath}`;
}

const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', 'build', 'dist', 'target', '.gradle', '.venv', 'venv', '__pycache__', '.idea', '.vscode']);
/** 테스트·예제·도구용으로 흔히 쓰는 폴더 이름. 서비스일 가능성이 낮아 두 단계 탐색에서도 보지 않는다 */
const NOISE_DIR_NAMES = new Set(['k6', 'tools', 'tool', 'scripts', 'script', 'docs', 'doc', 'examples', 'example', 'fixtures', 'fixture']);
/** 여러 서비스를 모아 두는 흔한 컨테이너 폴더 이름. 이 폴더 자신은 서비스가 아니고, 그 자식들을 한 단계 더 본다 */
const APP_CONTAINER_DIR_NAMES = new Set(['apps', 'services', 'packages']);
/** 한 프로젝트에서 찾는 서비스 수 상한. 두 단계 탐색이 너무 많이 잡지 않게 자른다 */
const MAX_DETECTED_SERVICES = 6;

/** 개발 서버가 쓰는 기본 프로젝트 캐시(.gradle)와 부딪히지 않게 Gradle 테스트가 따로 쓰는 캐시 디렉터리(ADR-133) */
const GRADLE_TEST_CACHE_DIR = '/tmp/gradle-test-cache';
/** workflow.tests에 명령을 넣을 때마다 서비스 notes에 함께 남기는 메모(ADR-133, 버그 리포트 104) — 게이트가
 *  실제로 이 명령을 test 단계에서 돌린다는 것과, 느리거나 외부 의존(Testcontainers 등)이 있으면 studio.yaml에서
 *  직접 좁히거나 뺄 수 있다는 것을 알린다 */
const TEST_GATE_NOTE = '게이트가 이 테스트를 test 단계에서 돌립니다. 너무 느리거나 외부 의존(Testcontainers 등)이 있으면 studio.yaml의 workflow.tests에서 좁히거나 지우세요';

/** Gradle 서비스의 GRADLE_USER_HOME(detectSpring의 Dockerfile ENV와 composeYaml의 init 스크립트 자리가 같이 쓴다) */
const GRADLE_USER_HOME = '/gradle-home';
/** compose 최상위 configs:의 이름(여러 Gradle 서비스가 같은 내용을 공유한다) */
const MOCKITO_AGENT_INIT_CONFIG_NAME = 'b_studio_mockito_agent_init';
/**
 * Gradle의 GRADLE_USER_HOME/init.d/*.gradle 자동 실행을 이용해, 테스트 JVM에 Mockito를 -javaagent로 붙이는
 * init 스크립트(ADR-134, 도그푸딩 마찰 106). 컨테이너는 colima 공유 폴더(sshfs) 안에서 도는데, 공유 폴더 안
 * 파일은 컨테이너 root가 만들어도 소유자가 호스트 uid로 보여 HotSpot의 Attach Listener가 cwd의
 * `.attach_pid<pid>` 트리거 파일을 무시한다(소유자가 안 맞음) — Mockito의 inline mock maker가 쓰는 JVM
 * self-attach가 항상 실패한다. Mockito 공식 권장대로 mockito-core를 javaagent로 붙여 attach 자체를 건너뛴다.
 * 이미 다른 방법으로 javaagent가 붙어 있으면(`allJvmArgs`로 확인) 다시 붙이지 않는다. 사용자 프로젝트 파일은
 * 건드리지 않는다 — Gradle이 이 경로를 자동으로 읽을 뿐이다. eclipse-temurin:*-jdk에서 실제로 돌려 확인했다:
 * 이 스크립트 없이 `./gradlew test`는 "Could not initialize inline Byte Buddy mock maker"로 실패하고,
 * 있으면 "added -javaagent:mockito-core-*.jar" 로그와 함께 통과한다.
 */
const MOCKITO_AGENT_INIT_SCRIPT = `// b-studio가 넣은 설정. 샌드박스 컨테이너는 colima 공유 폴더(sshfs) 안에서 도는데,
// 공유 폴더 안 파일은 소유자가 호스트 uid로 보여 HotSpot의 Attach Listener가 cwd의 .attach_pid<pid> 트리거 파일을
// 무시하고(소유자가 안 맞음) /tmp로 넘어가지도 않는다 — Mockito inline mock maker가 쓰는 JVM self-attach가
// 항상 실패한다. Mockito 공식 권장대로 mockito-core를 -javaagent로 붙여 attach 자체를 건너뛴다.
// 사용자 프로젝트 파일은 건드리지 않는다 — Gradle이 GRADLE_USER_HOME/init.d에서 자동으로 읽는 스크립트다.
allprojects {
  tasks.withType(Test).configureEach { t ->
    t.doFirst {
      if (t.allJvmArgs.any { it.startsWith('-javaagent:') && it.contains('mockito-core') }) return
      def jar = t.classpath.files.find { it.name ==~ /mockito-core-.*\\.jar/ }
      if (jar != null) {
        t.jvmArgs(["-javaagent:\${jar.absolutePath}"])
        logger.lifecycle("b-studio: added -javaagent:\${jar.name} to \${t.path} (JVM self-attach is blocked in the sandbox's shared-folder mount)")
      }
    }
  }
}
`;
/** mockitoAgentInit가 true인 서비스의 notes에 남기는 메모(ADR-134, 도그푸딩 마찰 106) */
const MOCKITO_AGENT_INIT_NOTE =
  'Mockito 같은 inline mock 라이브러리가 쓰는 JVM self-attach가 샌드박스의 공유 폴더 마운트에서는 항상 실패해(컨테이너 root가 만든 파일도 소유자가 호스트 uid로 보임), Gradle init 스크립트로 mockito-core를 -javaagent로 붙였습니다(GRADLE_USER_HOME/init.d). 사용자 프로젝트의 테스트 설정은 건드리지 않습니다';

/** compose 최상위 configs:의 이름(여러 Gradle 서비스가 같은 내용을 공유한다) */
const TEST_MEMORY_INIT_CONFIG_NAME = 'b_studio_test_memory_init';
/**
 * 테스트 JVM의 힙·메타스페이스 상한을 거는 Gradle init 스크립트(ADR-138, 도그푸딩 마찰 116). `--no-daemon`
 * 테스트는 Gradle 데몬 없이 바로 끝나지만, `Test` 태스크가 포크하는 테스트 워커 JVM의 힙은 사용자가 정하지
 * 않으면 JVM 에르고노믹스가 자동으로 잡는다(컨테이너 메모리 한도가 없으면 colima VM 전체 메모리 기준 1/4).
 * 같은 컨테이너에서 개발 서버(bootRun)가 이미 메모리를 쓰고 있으면 두 JVM의 합이 VM의 남은 메모리를 넘어
 * 커널 OOM killer가 컨테이너를 통째로 종료시킨다. 사용자가 이미 maxHeapSize·메타스페이스 크기를 정했으면
 * 덮어쓰지 않는다(Mockito 스크립트와 같은 원칙). 사용자 프로젝트 파일은 건드리지 않는다.
 */
const TEST_MEMORY_INIT_SCRIPT = `// b-studio가 넣은 설정. 테스트 워커 JVM의 기본 힙·메타스페이스 크기는 JVM 에르고노믹스가
// "보이는 메모리"(이 컨테이너는 메모리 한도를 걸지 않아 colima VM 전체 메모리)를 기준으로 자동으로 잡는다.
// 같은 컨테이너에서 개발 서버(bootRun)가 이미 돌고 있으면 두 JVM의 메모리 합이 VM의 남은 메모리를 넘어
// 커널이 컨테이너를 통째로 종료시킨다. 사용자가 이미 정한 값은 덮어쓰지 않는다.
allprojects {
  tasks.withType(Test).configureEach { t ->
    if (!t.maxHeapSize) t.maxHeapSize = '512m'
    if (!t.jvmArgs.any { it.startsWith('-XX:MaxMetaspaceSize') }) t.jvmArgs(['-XX:MaxMetaspaceSize=256m'])
  }
}
`;
/** testMemoryInit가 true인 서비스의 notes에 남기는 메모(ADR-138, 도그푸딩 마찰 116) */
const TEST_MEMORY_INIT_NOTE =
  '테스트 워커 JVM의 힙(512m)·메타스페이스(256m) 상한을 Gradle init 스크립트로 걸었습니다(GRADLE_USER_HOME/init.d). 기본값은 컨테이너 메모리 한도가 없을 때 VM 전체 메모리 기준으로 자동으로 잡혀, 개발 서버(bootRun)와 같은 컨테이너에서 돌면 메모리 한도를 넘어 컨테이너가 종료될 수 있었습니다. 이미 maxHeapSize를 정했으면 덮어쓰지 않고, 사용자 프로젝트의 테스트 설정은 건드리지 않습니다';

function isNoiseDirName(name: string): boolean {
  return NOISE_DIR_NAMES.has(name.toLowerCase());
}

export async function detectProject(folder: string, { ignoreExistingSpec = false }: { ignoreExistingSpec?: boolean } = {}): Promise<ProjectDetection> {
  const root = path.resolve(folder);
  const info = await stat(root).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`폴더가 아닙니다: ${root}`);
  const name = path.basename(root);
  // ignoreExistingSpec은 "생성 파일 다시 만들기"(ADR-101)가 쓴다: b-studio가 만든 studio.yaml이 이미 있어도
  // 그 파일이 없다고 치고 폴더를 처음 열 때처럼 다시 훑는다 — 그래야 그사이 생긴 탐지 개선(환경 변수 연결 등)이 반영된다
  if (!ignoreExistingSpec && (await exists(path.join(root, SPEC_FILE)))) return { folder: root, name, hasSpec: true, services: [], infra: [], defaultInfra: [], warnings: [] };

  const childDirNames = await childDirs(root);
  const depth1Names = childDirNames.filter((name) => !isNoiseDirName(name));
  const found: Array<Omit<DetectedService, 'name'>> = [];
  for (const relative of ['.', ...depth1Names]) {
    const service = await detectDir(root, path.join(root, relative), relative);
    if (service) found.push(service);
  }
  // 폴더 바로 아래가 앱이면(단일 앱 저장소) 하위 폴더에서 찾은 것은 그 앱의 일부일 가능성이 커서 버린다.
  // 아니면(모노레포로 보이면) 컨테이너 폴더·이미 찾은 서비스 하위까지 두 단계 더 본다
  const rootApp = found.find((service) => service.path === '.');
  const deepServices = rootApp ? [rootApp] : await withDeeperCandidates(root, depth1Names, found);
  const services = nameServices(deepServices.slice(0, MAX_DETECTED_SERVICES));
  const warnings: string[] = [];
  if (services.length === 0) {
    warnings.push('Next.js·Vite·Spring Boot·FastAPI 앱을 찾지 못했습니다. studio.yaml을 직접 쓰거나 지원하는 스택인지 확인하세요');
    return { folder: root, name, hasSpec: false, services, infra: [], defaultInfra: [], warnings };
  }

  const infra = await detectInfra(root, services, childDirNames);
  await wireServiceEnvironments(root, services, infra);
  await disableSpringDockerCompose(root, services);
  const frontendBackendWiring = await wireFrontendBackendUrl(root, services, childDirNames);
  // 서비스 선택(ADR-083)의 기본값과 같은 규칙: 앱 서비스가 기대는 부가 서비스 + 그 부가 서비스끼리의 기댐 닫힘.
  // 아무도 기대지 않는 부가 서비스(예: 가져왔지만 안 쓰는 카프카)는 기본으로 체크하지 않는다
  const defaultInfra = [...dependencyClosure(services.flatMap((service) => service.dependsOn), Object.fromEntries(infra.map((service) => [service.name, service.dependsOn])))];
  return { folder: root, name, hasSpec: false, services, infra, defaultInfra, warnings, ...(frontendBackendWiring ? { frontendBackendWiring } : {}) };
}

/**
 * 폴더 바로 아래가 단일 앱이 아닐 때(모노레포로 보일 때)만 부른다. 두 갈래를 더 본다:
 *  1. apps/services/packages 같은 흔한 컨테이너 폴더 한 단계 아래(예: apps/web) — 그 폴더 자신은 서비스가
 *     아니고 자식들이 실제 앱이다
 *  2. 이미 찾은 서비스 폴더(depth1Services, 아직 이 함수가 더하기 전) 바로 아래의 또 다른 빌드(예:
 *     commerce/consumer-app) — 같은 저장소의 다른 서비스로 넣되, 사람이 서비스 선택(ADR-083)에서 확인하고
 *     켤 때까지는 기본으로 띄우지 않는다(defaultSelected: false)
 * 두 갈래 모두 노이즈 폴더(NOISE_DIR_NAMES)는 건너뛰고, 중복 경로는 한 번만 더한다
 */
async function withDeeperCandidates(
  root: string,
  depth1Names: readonly string[],
  depth1Services: ReadonlyArray<Omit<DetectedService, 'name'>>,
): Promise<Array<Omit<DetectedService, 'name'>>> {
  const result = [...depth1Services];
  const seen = new Set(result.map((service) => service.path));

  const tryAdd = async (relative: string, decorate?: (service: Omit<DetectedService, 'name'>) => Omit<DetectedService, 'name'>): Promise<void> => {
    if (seen.has(relative)) return;
    seen.add(relative);
    const service = await detectDir(root, path.join(root, relative), relative);
    if (service) result.push(decorate ? decorate(service) : service);
  };

  for (const containerName of depth1Names) {
    if (!APP_CONTAINER_DIR_NAMES.has(containerName)) continue;
    const grandChildren = await childDirs(path.join(root, containerName));
    for (const childName of grandChildren) {
      if (isNoiseDirName(childName)) continue;
      await tryAdd(posixJoin(containerName, childName), (service) => ({ ...service, notes: [`${containerName}/ 폴더 아래에서 찾았습니다`, ...service.notes] }));
    }
  }

  for (const parent of depth1Services) {
    if (parent.path === '.') continue;
    const grandChildren = await childDirs(path.join(root, parent.path));
    for (const childName of grandChildren) {
      if (isNoiseDirName(childName)) continue;
      await tryAdd(posixJoin(parent.path, childName), (service) => ({
        ...service,
        defaultSelected: false,
        notes: [
          `${parent.path} 서비스 하위의 별도 빌드로 보여 기본으로는 띄우지 않습니다. 필요하면 서비스 선택에서 켜세요`,
          // 기본으로 안 뜨는 서비스를 workflow.tests에 넣으면 게이트가 docker compose exec할 컨테이너가 없어 test
          // 단계가 항상 실패한다 — 그래서 테스트 명령을 찾았어도(testCommand) workflow.tests에는 넣지 않는다(ADR-133)
          ...(service.testCommand ? ['테스트 명령도 찾았지만, 기본으로 띄우지 않는 서비스라 workflow.tests에는 넣지 않았습니다. 서비스 선택에서 켠 뒤 studio.yaml에 직접 추가하세요'] : []),
          ...service.notes,
        ],
      }));
    }
  }

  return result;
}

/**
 * 부가 서비스를 찾는다: 먼저 폴더의 compose 파일(root, 그다음 한 단계 아래)에서 잘 알려진 인프라 이미지를 가져오고,
 * 하나도 못 찾았으면 Spring(JPA+postgresql)·FastAPI(psycopg·SQLAlchemy+postgres) 의존성을 보아 postgres 하나를 새로 제안한다(프로젝트당 하나만)
 */
async function detectInfra(root: string, services: readonly DetectedService[], childDirNames: readonly string[]): Promise<InfraService[]> {
  const composeFile = await findComposeFile(root, childDirNames);
  if (composeFile) {
    const text = await readText(composeFile.absolute);
    if (text) return finalizeImportedInfra(root, composeFile.relative, importSupportingServices(text, composeFile.relative).services);
  }
  for (const service of services) {
    if (service.template !== 'spring-boot' && service.template !== 'fastapi') continue;
    const dependencyText = await appDependencyText(path.join(root, service.path), service.template);
    if (suggestsPostgresNeed(service.template, dependencyText)) {
      return [proposePostgresService(service.name, `${service.name}에서 postgres 관련 의존성(${service.template === 'spring-boot' ? 'JPA + postgresql 드라이버' : 'psycopg/SQLAlchemy'})을 찾았는데, 폴더에 부가 서비스를 선언한 compose 파일이 없어 새로 제안합니다`)];
    }
  }
  return [];
}

/**
 * 가져온 부가 서비스를 실제로 쓸 수 있게 다듬는다.
 *  - env_file(예: edumeet의 mysql처럼 .env로만 자격 증명을 받고 environment가 없는 경우)로는 값을 알 수 없어,
 *    공식 이미지가 비밀번호 없이는 기동을 거부하는 postgres/mysql/mariadb에 개발용 기본값을 채운다. .env 내용은 절대 읽지 않는다 —
 *    저장소에 있든 없든 세션 폴더 복사본에는 담기지 않으므로 같은 값을 채우되, 메모 문구만 다르게 한다
 *  - healthcheck가 없으면 기본 healthcheck를 붙인다(있어야 depends_on이 service_healthy를 써서, 앱이 DB가 뜨기 전에 시작해 죽는 경합을 막는다)
 */
async function finalizeImportedInfra(root: string, composeRelative: string, services: readonly ImportedInfraService[]): Promise<ImportedInfraService[]> {
  const composeDir = path.dirname(composeRelative);
  const result: ImportedInfraService[] = [];
  for (const service of services) {
    let next = service;
    if (needsDevDefaultCredentials(next)) {
      const envFileExists = next.envFiles.length > 0 && (await anyExists(root, composeDir, next.envFiles));
      next = withDevDefaultCredentials(next, devDefaultCredentialNote(next.envFiles, envFileExists));
    }
    result.push(withDefaultHealthcheck(next));
  }
  return result;
}

function devDefaultCredentialNote(envFiles: readonly string[], envFileExists: boolean): string {
  if (envFiles.length === 0) return '접속 정보(비밀번호 등)를 compose에서 찾지 못해 개발용 값을 넣었습니다';
  const files = envFiles.join(', ');
  // .env가 저장소에 있어도 세션 폴더 복사본에는 담기지 않는다(비밀값이라 절대 읽지 않는다) — 있고 없고에 따라 문구만 다르다
  return envFileExists
    ? `원래 compose는 env_file(${files})로 받는데, 샌드박스 복사본에는 .env가 들어가지 않아 개발용 값을 넣었습니다`
    : `원래 compose는 env_file(${files})로 받는데 저장소에 없어 개발용 값을 넣었습니다`;
}

async function anyExists(root: string, dir: string, fileNames: readonly string[]): Promise<boolean> {
  for (const fileName of fileNames) {
    if (await exists(path.join(root, dir, fileName))) return true;
  }
  return false;
}

/** compose.yaml → docker-compose.yml → ... 우선순위로 root와 한 단계 아래를 본다. 운영용(prod·production)은 개발용이 있으면 건너뛴다 */
async function findComposeFile(root: string, childDirNames: readonly string[]): Promise<{ absolute: string; relative: string } | undefined> {
  for (const dir of ['.', ...childDirNames]) {
    const found = await composeFileInDir(path.join(root, dir), dir);
    if (found) return found;
  }
  return undefined;
}

async function composeFileInDir(dir: string, relativeDir: string): Promise<{ absolute: string; relative: string } | undefined> {
  const present: string[] = [];
  for (const fileName of COMPOSE_FILE_CANDIDATES) {
    if (await exists(path.join(dir, fileName))) present.push(fileName);
  }
  if (present.length === 0) return undefined;
  const nonProd = present.filter((fileName) => !isProdComposeFile(fileName));
  const picked = (nonProd.length > 0 ? nonProd : present)[0]!;
  return { absolute: path.join(dir, picked), relative: relativeDir === '.' ? picked : posixJoin(relativeDir, picked) };
}

/** Spring은 build.gradle(.kts)·pom.xml, FastAPI는 requirements.txt·pyproject.toml의 원문(의존성 이름을 찾는 용도라 원문 그대로 충분하다) */
async function appDependencyText(dir: string, template: 'spring-boot' | 'fastapi'): Promise<string> {
  if (template === 'spring-boot') {
    return (await readText(path.join(dir, 'build.gradle.kts'))) ?? (await readText(path.join(dir, 'build.gradle'))) ?? (await readText(path.join(dir, 'pom.xml'))) ?? '';
  }
  return `${(await readText(path.join(dir, 'requirements.txt'))) ?? ''}\n${(await readText(path.join(dir, 'pyproject.toml'))) ?? ''}`;
}

/** 각 관리형 서비스의 설정에서 postgres·mysql·redis·kafka 참조를 찾아, 가져오거나 제안한 부가 서비스로 접속 환경 변수를 채운다(있으면 서비스에 바로 붙인다) */
async function wireServiceEnvironments(root: string, services: DetectedService[], infra: readonly InfraService[]): Promise<void> {
  if (infra.length === 0) return;
  // environment·command도 함께 넘긴다 — wireAppEnvironment가 실제 POSTGRES_*/MYSQL_* 값과 Kafka 광고 리스너를 읽어야 한다(지어내지 않는다)
  const byEngine: WirableInfraService[] = infra.map((service) => ({ name: service.name, engine: service.engine, environment: service.environment, command: service.command, notes: service.notes }));
  for (const service of services) {
    const configText = await appConfigText(root, service);
    const refs = detectEnvReferences(configText);
    const wiring = wireAppEnvironment(service.template, refs, byEngine);
    // 접속 정보를 못 채워도(계정을 못 찾음) depends_on과 "확인:" 메모는 남긴다 — 컨테이너 기동 순서는 여전히 의미가 있다
    if (wiring.dependsOn.length === 0 && Object.keys(wiring.environment).length === 0) continue;
    service.environment = wiring.environment;
    service.dependsOn = wiring.dependsOn;
    // specYaml이 notes를 "# 확인: ..." 형태로 찍으므로 여기서는 접두사 없이 그대로 쌓는다
    service.notes.push(...wiring.notes);
  }
}

/**
 * Spring Boot의 spring-boot-docker-compose 모듈을 끈다. 이 모듈은 개발 실행 때 앱이 직접 docker compose를 띄우려 하는데,
 * 샌드박스 안에는 compose 파일이 없어 "No Docker Compose file found"로 앱이 바로 죽는다(pay 복제본으로 실제 확인).
 * 샌드박스는 부가 서비스를 이미 띄우고 접속 정보까지 넣으므로 이 모듈이 할 일이 없다. start.spring.io의 "Docker Compose Support"가 넣는 흔한 의존성이다
 */
async function disableSpringDockerCompose(root: string, services: DetectedService[]): Promise<void> {
  for (const service of services) {
    if (service.template !== 'spring-boot') continue;
    const dependencyText = await appDependencyText(path.join(root, service.path), 'spring-boot');
    if (!/spring-boot-docker-compose/.test(dependencyText)) continue;
    service.environment = { ...service.environment, SPRING_DOCKER_COMPOSE_ENABLED: 'false' };
    service.notes.push('spring-boot-docker-compose가 있어 샌드박스에서는 끕니다(SPRING_DOCKER_COMPOSE_ENABLED=false). 부가 서비스는 b-studio가 띄웁니다');
  }
}

/**
 * 프론트엔드(Next.js·Vite) 코드가 읽는 소스 안의 흔한 자리. lib/api.ts(실제 저장소에서 확인한 자리, docs/decisions.md ADR-095 참고)를
 * 먼저 보고, 없으면 흔히 쓰는 몇 자리만 본다 — appConfigText와 같은 생각으로, 저장소 전체를 훑지 않고 알려진 자리만 본다.
 * next.config.*는 서버 컴포넌트가 아니라 빌드 설정이지만 rewrites 등에서 백엔드 주소를 그대로 읽는 경우가 많아 함께 본다(pay/apps/web 실측).
 */
const FRONTEND_API_CLIENT_CANDIDATES = [
  'lib/api.ts', 'lib/api.js', 'lib/api.tsx',
  'src/lib/api.ts', 'src/lib/api.js',
  'app/lib/api.ts', 'src/api.ts', 'src/config.ts', 'src/lib/config.ts',
  'next.config.ts', 'next.config.js', 'next.config.mjs',
  'vite.config.ts', 'vite.config.js',
  '.env.local', '.env',
];

/** .env.example·.env.local.example·README는 코드가 아니라 `KEY=value` 모양(dotenv·README의 실행 예시)이라 detectBackendUrlEnvFromAssignments로 따로 본다 */
const FRONTEND_ASSIGNMENT_FILE_CANDIDATES = ['.env.example', '.env.local.example', 'README.md'];

/** 알려진 자리에서 못 찾았을 때만 가볍게 더 훑는 소스 폴더(fix/detect-frontend-backend-env) */
const FRONTEND_SOURCE_SCAN_DIRS = ['app', 'src', 'lib', 'pages'];
/** 가볍게 훑을 때 보는 확장자. 스타일·이미지·타입 선언 등은 백엔드 주소를 읽을 일이 없어 뺀다 */
const FRONTEND_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
/** 한 서비스당 더 여는 파일 수 상한. "가볍게"를 지키려는 것이라 저장소가 커도 끝없이 읽지 않는다 */
const MAX_LIGHT_SCAN_FILES = 40;
/** 가볍게 훑는 폴더 깊이 상한(app/src/lib/pages 자신을 0으로 센다) */
const MAX_LIGHT_SCAN_DEPTH = 4;

/** README의 펜스 코드 블록(```...```) 본문만 모은다. 설명 글에 우연히 섞인 `KEY=value` 꼴은 보지 않으려는 것이다 */
function fencedCodeBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  for (const match of markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) blocks.push(match[1]!);
  return blocks;
}

/** serviceDir 아래 app/src/lib/pages를 바운드(깊이·파일 수) 두고 가볍게 훑어, 서비스 폴더 기준 상대 경로를 모은다 */
async function lightFrontendSourceFiles(serviceDir: string): Promise<string[]> {
  const files: string[] = [];
  async function collect(dir: string, relative: string, depth: number): Promise<void> {
    if (depth > MAX_LIGHT_SCAN_DEPTH || files.length >= MAX_LIGHT_SCAN_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_LIGHT_SCAN_FILES) return;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name) || isNoiseDirName(entry.name)) continue;
        await collect(path.join(dir, entry.name), posixJoin(relative, entry.name), depth + 1);
      } else if (FRONTEND_SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(posixJoin(relative, entry.name));
      }
    }
  }
  for (const top of FRONTEND_SOURCE_SCAN_DIRS) await collect(path.join(serviceDir, top), top, 0);
  return files;
}

/** 프론트엔드가 백엔드 주소를 받는 환경 변수 하나. visibility가 'public'이면 브라우저 번들에 박히는 이름(NEXT_PUBLIC_* 등)이라
 *  자리 표시자로 채우고, 'server'면 서버 쪽에서만 읽는 이름(예: SPRING_API)이라 컨테이너 사이 주소를 바로 적는다 */
interface FrontendBackendMatch {
  envKey: string;
  suffix: string;
  visibility: 'public' | 'server';
  /** 기본값에 적힌 포트. 백엔드 후보가 둘 이상일 때 어느 서비스인지 짝짓는 근거다 */
  port?: number;
  fromCompose: boolean;
  /** 코드·설정 파일에서 추정했으면 어느 파일인지(서비스 폴더 기준). notes에 근거로 남긴다 */
  sourceFile?: string;
}

/**
 * 프론트엔드 서비스 하나가 백엔드 주소를 어느 환경 변수로 받는지 찾는다(fix/frontend-backend-url, fix/detect-frontend-backend-env).
 * 1) 원본 compose(이미 있다면)에 그 서비스의 environment로 선언돼 있으면 그 값을 가장 믿는다(사람이 적어 둔 것이다).
 * 2) 없으면 알려진 자리(lib/api.ts·next.config.* 등)의 코드에서 `process.env.X` 접근을 찾는다 — 공개 접두사(NEXT_PUBLIC_ 등)가
 *    있으면 공개 변수로, 없고 이름에 API·BACKEND·SERVER·SPRING·URL·HOST·BASE 조각이 있으면서 http(s) 기본값이 같은 줄에 있으면
 *    서버 쪽 변수로 본다.
 * 3) 그래도 못 찾으면 .env.example·.env.local.example·README의 실행 예시(`KEY=value`)를, 그래도 못 찾으면 app/src/lib/pages를
 *    가볍게 더 훑는다(저장소 전체를 보지 않는다, MAX_LIGHT_SCAN_FILES).
 */
async function detectFrontendBackendRef(root: string, service: DetectedService, composeText: string | undefined): Promise<FrontendBackendMatch | undefined> {
  if (composeText) {
    const original = originalComposeServiceFor(composeText, service.path, service.name);
    const ref = original && detectBackendUrlEnvFromEnvironment(original.environment);
    if (ref) return { ...ref, visibility: 'public', fromCompose: true };
  }

  const serviceDir = path.join(root, service.path);
  const fromCode = (file: string, text: string): FrontendBackendMatch | undefined => {
    const publicRef = detectBackendUrlEnvFromCode(text);
    if (publicRef) return { ...publicRef, visibility: 'public', fromCompose: false, sourceFile: file };
    const serverRef = detectServerBackendUrlEnvFromCode(text);
    if (serverRef) return { ...serverRef, visibility: 'server', fromCompose: false, sourceFile: file };
    return undefined;
  };

  for (const file of FRONTEND_API_CLIENT_CANDIDATES) {
    const text = await readText(path.join(serviceDir, file));
    if (!text) continue;
    const match = fromCode(file, text);
    if (match) return match;
  }

  for (const file of FRONTEND_ASSIGNMENT_FILE_CANDIDATES) {
    const text = await readText(path.join(serviceDir, file));
    if (!text) continue;
    for (const block of file === 'README.md' ? fencedCodeBlocks(text) : [text]) {
      const assignment = detectBackendUrlEnvFromAssignments(block);
      if (assignment) return { envKey: assignment.envKey, suffix: assignment.suffix, port: assignment.port, visibility: assignment.public ? 'public' : 'server', fromCompose: false, sourceFile: file };
    }
  }

  for (const file of await lightFrontendSourceFiles(serviceDir)) {
    const text = await readText(path.join(serviceDir, file));
    if (!text) continue;
    const match = fromCode(file, text);
    if (match) return match;
  }

  return undefined;
}

/** 백엔드 후보가 둘 이상일 때 기본값의 포트로 어느 서비스인지 짝짓는다. 포트 정보가 없으면 처음 찾은 후보로(알려진 한계, ADR-095) */
function pickBackendCandidate(candidates: readonly DetectedService[], port: number | undefined): DetectedService | undefined {
  if (candidates.length <= 1) return candidates[0];
  if (port === undefined) return candidates[0];
  const matches = candidates.filter((candidate) => candidate.port === port);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * 폴더에 프론트엔드와 백엔드가 함께 있으면(풀스택), 프론트엔드가 읽는 백엔드 주소 환경 변수를 찾아 연결한다.
 * 공개 변수(NEXT_PUBLIC_* 등, visibility: 'public')는 실제 호스트 포트가 `docker compose up` 뒤에야 정해지므로
 * (샌드박스가 무작위로 고른다) 값 대신 자리 표시자(`${b-studio:services.<백엔드>.publicUrl}`)를 적어 두고
 * packages/sandbox가 띄우기 직전에 채운다. 서버 쪽 변수(visibility: 'server', 예: SPRING_API)는 브라우저 번들에 박히지
 * 않아 compose 네트워크 안 주소(`http://<백엔드 서비스>:<포트>`)를 바로 적는다 — 포트가 서비스 생성 시점에 이미 정해져 있다.
 * 백엔드가 CORS 허용 출처를 환경 변수로 받고 있었으면(원본 compose) 그 값도 그대로 가져온다.
 * defaultSelected가 false인 서비스(같은 서비스 폴더 하위의 또 다른 빌드 등, ADR-083)는 기본으로 띄우지 않는 보조 서비스라
 * 백엔드 후보에서 뺀다. 후보가 둘 이상이면 기본값의 포트로 짝을 맞추고, 그래도 못 정하면 채우지 않고 notes에 남긴다.
 */
async function wireFrontendBackendUrl(
  root: string,
  services: DetectedService[],
  childDirNames: readonly string[],
): Promise<ProjectDetection['frontendBackendWiring']> {
  const frontend = services.find((service) => service.template === 'nextjs' || service.template === 'vite');
  const backendCandidates = services.filter(
    (service) => service !== frontend && service.defaultSelected !== false && (service.template === 'spring-boot' || service.template === 'fastapi' || service.template === 'nextjs' || service.template === 'vite'),
  );
  if (!frontend || backendCandidates.length === 0) return undefined;

  const composeFile = await findComposeFile(root, childDirNames);
  const composeText = composeFile ? await readText(composeFile.absolute) : undefined;

  const found = await detectFrontendBackendRef(root, frontend, composeText);
  if (!found) return undefined;

  const backend = pickBackendCandidate(backendCandidates, found.port);
  if (!backend) {
    frontend.notes.push(`변수 ${found.envKey}가 백엔드 주소로 보이지만 어느 서비스인지 몰라 채우지 않았습니다`);
    return undefined;
  }

  const value = found.visibility === 'server' ? `http://${backend.name}:${backend.port}${found.suffix}` : `${publicUrlPlaceholder(backend.name)}${found.suffix}`;
  frontend.environment = { ...frontend.environment, [found.envKey]: value };
  if (!frontend.dependsOn.includes(backend.name)) frontend.dependsOn = [...frontend.dependsOn, backend.name];
  frontend.notes.push(
    `${frontend.name}가 ${backend.name} 주소를 ${found.envKey}로 받습니다 — ` +
      (found.visibility === 'server' ? `컨테이너 사이 주소(${value})로 바로 연결합니다` : '샌드박스 주소로 자동 연결합니다') +
      (found.fromCompose ? '' : ` (원본 compose에 선언돼 있지 않아 코드에서 추정했습니다${found.sourceFile ? `: ${found.sourceFile}의 기본값` : ''}. 다른 변수를 쓰면 ${found.envKey} 대신 studio.yaml의 값을 고치세요)`),
  );

  if (composeText) {
    const originalBackend = originalComposeServiceFor(composeText, backend.path, backend.name);
    const cors = originalBackend ? corsEnvironmentFrom(originalBackend.environment) : {};
    if (Object.keys(cors).length > 0) {
      backend.environment = { ...backend.environment, ...cors };
      backend.notes.push(`CORS 허용 출처 설정을 원본 compose(${composeFile!.relative})에서 그대로 가져왔습니다: ${Object.keys(cors).join(', ')}`);
    }
  }

  return { frontendService: frontend.name, backendService: backend.name, backendProbePath: backend.ready.path };
}

async function appConfigText(root: string, service: DetectedService): Promise<string> {
  const dir = path.join(root, service.path);
  if (service.template === 'spring-boot') {
    const resources = path.join(dir, 'src/main/resources');
    const props = (await readText(path.join(resources, 'application.properties'))) ?? '';
    const yml = (await readText(path.join(resources, 'application.yml'))) ?? (await readText(path.join(resources, 'application.yaml'))) ?? '';
    return `${props}\n${yml}`;
  }
  const envExample = await firstExisting(dir, ['.env.example', '.env.sample', '.env.local.example']);
  if (service.template === 'fastapi') {
    return `${(await readText(path.join(dir, 'requirements.txt'))) ?? ''}\n${(await readText(path.join(dir, 'pyproject.toml'))) ?? ''}\n${envExample}`;
  }
  return envExample;
}

async function firstExisting(dir: string, fileNames: readonly string[]): Promise<string> {
  for (const fileName of fileNames) {
    const text = await readText(path.join(dir, fileName));
    if (text) return text;
  }
  return '';
}

/** 서비스 이름: 폴더 바로 아래면 역할(web/api), 하위 폴더면 폴더 이름. compose 이름 규칙에 맞추고 겹치지 않게 한다 */
function nameServices(found: ReadonlyArray<Omit<DetectedService, 'name'>>): DetectedService[] {
  const used = new Set<string>();
  return found.map((service) => {
    const base = service.path === '.' ? (service.template === 'nextjs' || service.template === 'vite' ? 'web' : 'api') : sanitize(path.basename(service.path));
    let name = base || 'app';
    for (let index = 2; used.has(name); index++) name = `${base}-${index}`;
    used.add(name);
    return { name, ...service };
  });
}

/** studio.yaml의 이름 규칙(소문자로 시작, 소문자·숫자·-)에 맞춘다. 맞출 수 없으면 빈 문자열 */
export function sanitize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/g, '')
    .replace(/-{2,}/g, '-');
}

async function detectDir(root: string, dir: string, relative: string): Promise<Omit<DetectedService, 'name'> | undefined> {
  return (await detectNode(root, dir, relative)) ?? (await detectSpring(root, dir, relative)) ?? (await detectFastApi(dir, relative));
}

/** Next.js 또는 Vite 앱. Next가 있으면 Next로 본다 */
async function detectNode(root: string, dir: string, relative: string): Promise<Omit<DetectedService, 'name'> | undefined> {
  const pkg = await readJson(path.join(dir, 'package.json'));
  if (!pkg) return undefined;
  const deps = { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.devDependencies as Record<string, string> | undefined) };
  const template: DetectedTemplate | undefined = deps.next ? 'nextjs' : deps.vite ? 'vite' : undefined;
  if (!template) return undefined;
  // pnpm/npm/yarn 워크스페이스(ADR-088)의 구성원이면 잠금 파일이 저장소 루트에 있어, 그 루트 매니저·잠금 파일로 설치해야 한다
  const workspaceManager = relative === '.' ? undefined : await workspaceRootManager(root);
  const manager = workspaceManager ?? (await packageManager(dir, pkg));
  const lockless = manager === 'npm' && !(await exists(path.join(workspaceManager ? root : dir, 'package-lock.json')));
  const install = lockless ? 'npm install' : { pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile', npm: 'npm ci' }[manager];
  const exec = { pnpm: 'pnpm exec', yarn: 'yarn', npm: 'npx' }[manager];
  const port = template === 'nextjs' ? 3000 : 5173;
  const devFlags = template === 'nextjs' ? `--hostname 0.0.0.0 --port ${port}` : `--host 0.0.0.0 --port ${port} --strictPort`;
  // package.json에 dev 스크립트가 있으면 그 스크립트를 그대로 쓴다 — 직접 next/vite를 부르면 사용자 스크립트가 하는 일
  // (실제 저장소에서 확인한 사례: NODE_ENV=development를 고정하는 scripts/dev.mjs 래퍼)이 통째로 사라진다. 포트는
  // PORT 환경 변수로 맞추고, 스크립트가 next·vite를 바로 부르면 `--` 뒤 플래그도 그대로 전달된다(무시해도 해롭지 않다)
  const scripts = pkg.scripts as Record<string, unknown> | undefined;
  const hasDevScript = typeof scripts?.dev === 'string';
  const runDev = { pnpm: 'pnpm run dev', yarn: 'yarn run dev', npm: 'npm run dev' }[manager];
  const dev = hasDevScript ? `${runDev} -- ${devFlags}` : template === 'nextjs' ? `${exec} next dev ${devFlags}` : `${exec} vite ${devFlags}`;
  const notes: string[] = [];
  if (lockless) notes.push('잠금 파일이 없어 npm install로 설치합니다(버전이 달라질 수 있습니다)');
  if (hasDevScript) notes.push('package.json의 dev 스크립트를 그대로 씁니다. 포트는 PORT 환경 변수로 맞춥니다(스크립트가 다른 방식으로 포트를 읽으면 studio.yaml의 port에 맞추세요)');
  // package.json에 test 스크립트가 있을 때만 게이트 test 단계에 넣는다(ADR-133) — 없는데 넣으면 "npm test"가
  // 스크립트를 못 찾아 바로 실패한다
  const hasTestScript = typeof scripts?.test === 'string';
  const runTest = { pnpm: ['pnpm', 'run', 'test'], yarn: ['yarn', 'run', 'test'], npm: ['npm', 'run', 'test'] }[manager];
  const testCommand = hasTestScript ? { command: runTest } : undefined;
  if (testCommand) {
    notes.push(TEST_GATE_NOTE);
    // watch 모드로 끝나지 않는 스크립트(예: CI 환경 변수가 없으면 계속 지켜보는 react-scripts test)면 게이트가
    // 10분 타임아웃 뒤에야 실패로 알린다 — 미리 알린다
    notes.push('한 번 실행하고 끝나는 형태가 아니면(예: CI 환경 변수가 없을 때 watch 모드로 멈추는 react-scripts test) 10분 타임아웃 뒤에야 실패로 알립니다. 필요하면 test 스크립트를 한 번 실행하고 끝나는 형태로 맞추세요');
  }
  // 워크스페이스 구성원은 루트에서 설치하고(잠금 파일이 거기 있다) 서비스 폴더로 돌아와 개발 서버를 띄운다
  const command = workspaceManager
    ? `cd ${CONTAINER_WORKSPACE_ROOT} && ${install} && cd ${containerWorkDir(relative)} && exec ${dev}`
    : `${install} && exec ${dev}`;
  if (workspaceManager) notes.push(`pnpm/npm/yarn 워크스페이스로 보여 의존성 설치를 저장소 루트에서 합니다(잠금 파일이 루트에 있습니다)`);
  return {
    template,
    path: relative,
    port,
    preview: 'browser',
    ready: { path: '/' },
    dockerfile: [
      '# b-studio가 만든 개발용 이미지. 소스는 compose에서 마운트하고 의존성은 컨테이너 안에서 설치한다',
      'FROM node:22-bookworm-slim',
      '',
      'RUN corepack enable',
      `WORKDIR ${CONTAINER_WORKSPACE_ROOT}`,
      'ENV NEXT_TELEMETRY_DISABLED=1 \\',
      '    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \\',
      // pnpm은 저장소를 마운트한 소스 폴더(워크스페이스 루트) 안에 만들 수 있다. 사용자 폴더와 체크포인트에 섞이지 않게 컨테이너 볼륨에 둔다
      '    npm_config_update_notifier=false \\',
      '    npm_config_store_dir=/cache/pnpm',
      '',
      `EXPOSE ${port}`,
      `CMD ["sh", "-c", "${command}"]`,
      '',
    ].join('\n'),
    volumes: { 'node-modules': 'node_modules', ...(template === 'nextjs' ? { next: '.next' } : {}), ...(manager === 'pnpm' ? { 'pnpm-store': '/cache/pnpm' } : {}) },
    environment: hasDevScript ? { PORT: String(port) } : {},
    dependsOn: [],
    notes,
    ...(testCommand ? { testCommand } : {}),
  };
}

/** 저장소 루트가 pnpm/npm/yarn 워크스페이스면 그 관리자를 돌려준다. 서비스 자신이 루트일 때는 부르지 않는다(워크스페이스 개념이 없다) */
async function workspaceRootManager(root: string): Promise<'pnpm' | 'yarn' | 'npm' | undefined> {
  if (await exists(path.join(root, 'pnpm-workspace.yaml'))) return 'pnpm';
  const rootPkg = await readJson(path.join(root, 'package.json'));
  if (!rootPkg || !('workspaces' in rootPkg)) return undefined;
  return packageManager(root, rootPkg);
}

async function packageManager(dir: string, pkg: Record<string, unknown>): Promise<'pnpm' | 'yarn' | 'npm'> {
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : undefined;
  if (declared === 'pnpm' || declared === 'yarn' || declared === 'npm') return declared;
  if (await exists(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(dir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

async function detectSpring(root: string, dir: string, relative: string): Promise<Omit<DetectedService, 'name'> | undefined> {
  const gradleFile = (await exists(path.join(dir, 'build.gradle.kts'))) ? 'build.gradle.kts' : (await exists(path.join(dir, 'build.gradle'))) ? 'build.gradle' : undefined;
  const gradle = gradleFile ? await readText(path.join(dir, gradleFile)) : undefined;
  const pom = await readText(path.join(dir, 'pom.xml'));
  const isGradle = gradle?.includes('org.springframework.boot') ?? false;
  const isMaven = !isGradle && (pom?.includes('spring-boot') ?? false);
  if (!isGradle && !isMaven) return undefined;
  const build = (isGradle ? gradle : pom) ?? '';
  const java = javaVersion(build) ?? 21;
  const port = (await springPort(dir)) ?? 8080;
  const notes: string[] = [];
  const actuator = build.includes('spring-boot-starter-actuator');
  const springdoc = build.includes('springdoc-openapi');
  const ready = actuator ? { path: '/actuator/health' } : springdoc ? { path: '/v3/api-docs' } : { path: '/', expectStatus: 404 };
  if (!actuator && !springdoc) notes.push('상태 확인 경로를 몰라 "/"가 404를 돌려주면 준비된 것으로 봅니다. actuator를 넣거나 studio.yaml의 ready를 고치세요');
  const wrapperName = isGradle ? 'gradlew' : 'mvnw';
  // 서비스 폴더 자신에 래퍼가 없으면 상위 폴더를 저장소 루트까지 거슬러 올라가 찾는다(실제 저장소에서 확인한 구조:
  // 래퍼는 저장소 루트에, Gradle·Maven 프로젝트 루트는 하위 폴더에 따로 있다. 1번 문제)
  const wrapperDir = await findWrapperDir(root, dir, wrapperName);
  const wrapper = wrapperDir !== undefined;
  const wrapperRelative = wrapperDir ? toPosixPath(path.relative(root, wrapperDir)) || '.' : undefined;
  // 래퍼가 이 폴더가 아니라 상위 폴더에 있으면, 그 폴더로 옮겨 가 `-p`(Gradle)·`-f`(Maven)로 이 서비스 폴더를 가리켜 실행한다.
  // 둘 다 리액터(다중 모듈 선언) 관계와 무관하게 "이 디렉터리가 프로젝트다"로 동작해, commerce처럼 자기 settings.gradle은
  // 있지만 gradlew가 없는 독립 빌드에도, 진짜 멀티 모듈 서브프로젝트에도 똑같이 먹힌다
  const usesAncestorWrapper = wrapper && wrapperRelative !== relative;
  // 서브프로젝트가 상위 래퍼를 쓸 때(usesAncestorWrapper) bootRun·test 둘 다 "래퍼 폴더로 옮겨 가 -p/-f로
  // 서비스 폴더를 가리켜 실행"하는 같은 경로를 쓰므로 한 번만 계산해 둔다
  const subPath = usesAncestorWrapper ? toPosixPath(path.relative(wrapperDir!, dir)) : undefined;
  const wrapperWorkDir = usesAncestorWrapper ? containerWorkDir(wrapperRelative!) : undefined;
  let run: string;
  let runIsShell = false;
  if (usesAncestorWrapper) {
    const cmd = isGradle ? `./gradlew -p ${subPath} bootRun --no-daemon --console=plain` : `./mvnw -f ${subPath} spring-boot:run -q`;
    run = `cd ${wrapperWorkDir} && exec ${cmd}`;
    runIsShell = true;
  } else {
    run = isGradle
      ? wrapper
        ? '["./gradlew", "bootRun", "--no-daemon", "--console=plain"]'
        : '["gradle", "bootRun", "--no-daemon", "--console=plain"]'
      : wrapper
        ? '["./mvnw", "-q", "spring-boot:run"]'
        : '["mvn", "-q", "spring-boot:run"]';
  }
  const image = wrapper ? `eclipse-temurin:${java}-jdk` : isGradle ? `gradle:jdk${java}` : `maven:3-eclipse-temurin-${java}`;
  const testCommand = springTestCommand({ isGradle, usesAncestorWrapper, wrapper, subPath, wrapperWorkDir });
  // Maven은 범위 밖이다(ADR-134) — surefire의 argLine을 건드리면 사용자가 이미 쓰는 argLine 설정을 지울 위험이 있다
  const mockitoAgentInit = isGradle && testCommand !== undefined;
  // 같은 조건(Gradle + 테스트 명령 찾음)에서 테스트 JVM 메모리도 상한을 건다(ADR-138)
  const testMemoryInit = isGradle && testCommand !== undefined;
  if (testCommand) {
    notes.push(TEST_GATE_NOTE);
    if (mockitoAgentInit) notes.push(MOCKITO_AGENT_INIT_NOTE);
    if (testMemoryInit) notes.push(TEST_MEMORY_INIT_NOTE);
  }
  if (!wrapper) {
    notes.push(`이 폴더와 상위 폴더 어디에도 ${isGradle ? 'Gradle' : 'Maven'} 래퍼가 없어 ${image} 이미지의 도구로 실행합니다. 이미지의 버전이 실제 쓰는 버전과 다르면 빌드가 달라질 수 있습니다`);
  } else if (usesAncestorWrapper) {
    notes.push(
      `${isGradle ? 'Gradle' : 'Maven'} 래퍼가 이 폴더에 없어 ${wrapperRelative === '.' ? '저장소 루트' : wrapperRelative}의 래퍼로 실행합니다: ${isGradle ? `./gradlew -p ${toPosixPath(path.relative(wrapperDir!, dir))} bootRun` : `./mvnw -f ${toPosixPath(path.relative(wrapperDir!, dir))} spring-boot:run`}`,
    );
  }
  // 래퍼를 찾았으면(자기 폴더든 상위 폴더든) 다중 모듈 여부와 무관하게 바로 위에서 이미 제대로 실행하므로,
  // 래퍼가 아예 없을 때만 "서브프로젝트일 수 있다"는 안내가 의미가 있다(그래도 추측이라 돌려만 본다)
  if (!wrapper && isGradle && relative !== '.' && !(await exists(path.join(dir, 'settings.gradle.kts'))) && !(await exists(path.join(dir, 'settings.gradle')))) {
    if (await isGradleSubproject(root, relative)) {
      notes.push(
        '저장소 루트의 settings.gradle(.kts)이 이 폴더를 서브프로젝트로 포함하는 것으로 보입니다. ' +
          '지금은 이 폴더에서 바로 실행합니다 — 루트에만 Gradle 래퍼·settings.gradle이 있는 진짜 멀티 모듈 빌드라면 ' +
          '실패할 수 있으니, studio.yaml의 path를 저장소 루트로 옮기고 bootRun·test 명령에 `:' + relative + ':작업`처럼 서브프로젝트 경로를 직접 적으세요',
      );
    }
  }
  return {
    template: 'spring-boot',
    path: relative,
    port,
    preview: springdoc ? 'openapi' : 'browser',
    ready: { ...ready },
    ...(springdoc ? { contract: '/v3/api-docs' } : {}),
    dockerfile: [
      '# b-studio가 만든 개발용 이미지. 소스는 compose에서 마운트하고, 의존성은 첫 기동 때 받는다(프록시 설정은 샌드박스가 넣는다)',
      `FROM ${image}`,
      '',
      `WORKDIR ${CONTAINER_WORKSPACE_ROOT}`,
      ...(isGradle ? [`ENV GRADLE_USER_HOME=${GRADLE_USER_HOME}`, ''] : []),
      `EXPOSE ${port}`,
      runIsShell ? `CMD ["sh", "-c", "${run}"]` : `CMD ${run}`,
      '',
    ].join('\n'),
    volumes: isGradle ? { 'gradle-home': GRADLE_USER_HOME, 'gradle-project': '.gradle', build: 'build' } : { 'maven-home': '/root/.m2', target: 'target' },
    environment: {},
    dependsOn: [],
    notes: [...notes, '첫 기동은 의존성을 받느라 몇 분 걸릴 수 있습니다'],
    ...(testCommand ? { testCommand, ...(mockitoAgentInit ? { mockitoAgentInit: true } : {}), ...(testMemoryInit ? { testMemoryInit: true } : {}) } : {}),
  };
}

/**
 * Gradle·Maven 테스트 명령(ADR-133). bootRun과 같은 래퍼 경로 규칙을 따른다:
 *  - 래퍼가 서비스 폴더 자신에 있으면 그 폴더에서 바로 돈다(`./gradlew test`·`./mvnw test`)
 *  - 래퍼가 상위 폴더에 있으면(usesAncestorWrapper) 그 폴더로 옮겨 가 `-p`(Gradle)·`-f`(Maven)로 서비스 폴더를
 *    가리킨다. workflow.tests의 command는 docker compose exec에 배열 그대로 실행돼(ADR-133) `cd`를 못 쓰므로
 *    `['sh', '-c', '...']`로 셸을 직접 지정한다(bootRun의 Dockerfile CMD가 이미 쓰는 패턴과 같다)
 *  - 래퍼가 아예 없으면(이미지의 gradle·mvn 도구로 돈다) 명령만 그 도구 이름으로 바꾼다
 * Gradle은 개발 서버(bootRun)가 기본 프로젝트 캐시(.gradle)를 계속 쓰고 있어, 테스트가 같은 캐시를 쓰면 잠금이
 * 부딪힌다(examples/orders/studio.yaml의 api-unit 참고) — `--project-cache-dir`로 테스트 전용 캐시를 따로 쓰고,
 * 첫 실행은 의존성을 받느라 느리거나 잠금 대기로 실패할 수 있어 maxAttempts: 2로 한 번 재시도한다. Maven은 같은
 * 종류의 캐시 잠금 보고가 없어 재시도를 더하지 않는다
 */
function springTestCommand(options: {
  isGradle: boolean;
  usesAncestorWrapper: boolean;
  wrapper: boolean;
  subPath: string | undefined;
  wrapperWorkDir: string | undefined;
}): { command: string[]; maxAttempts?: number } | undefined {
  const { isGradle, usesAncestorWrapper, wrapper, subPath, wrapperWorkDir } = options;
  if (isGradle) {
    const gradleArgs = ['test', '--no-daemon', '--console=plain', '--project-cache-dir', GRADLE_TEST_CACHE_DIR];
    const command = usesAncestorWrapper
      ? ['sh', '-c', `cd ${wrapperWorkDir} && ./gradlew -p ${subPath} ${gradleArgs.join(' ')}`]
      : wrapper
        ? ['./gradlew', ...gradleArgs]
        : ['gradle', ...gradleArgs];
    return { command, maxAttempts: 2 };
  }
  const command = usesAncestorWrapper
    ? ['sh', '-c', `cd ${wrapperWorkDir} && ./mvnw -f ${subPath} test`]
    : wrapper
      ? ['./mvnw', 'test']
      : ['mvn', 'test'];
  return { command };
}

/** 저장소 루트의 settings.gradle(.kts)이 이 폴더 이름을 서브프로젝트로 포함하는지(`include 'commerce'`, `include(":commerce")` 등) */
async function isGradleSubproject(root: string, relative: string): Promise<boolean> {
  const settings = (await readText(path.join(root, 'settings.gradle.kts'))) ?? (await readText(path.join(root, 'settings.gradle')));
  if (!settings) return false;
  const escaped = relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`['"]:?${escaped}['"]`).test(settings);
}

/** dir부터 root까지(포함) 거슬러 올라가며 wrapperName(gradlew·mvnw) 파일이 있는 첫 폴더. 없으면 undefined */
async function findWrapperDir(root: string, dir: string, wrapperName: string): Promise<string | undefined> {
  const rootResolved = path.resolve(root);
  let current = path.resolve(dir);
  for (;;) {
    if (await exists(path.join(current, wrapperName))) return current;
    if (current === rootResolved) return undefined;
    current = path.dirname(current);
  }
}

/** path.relative 결과를 항상 '/' 구분자로(Dockerfile·셸 명령에 그대로 쓰는 문자열이라 윈도 경로 구분자가 섞이면 안 된다) */
function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function javaVersion(build: string): number | undefined {
  const match =
    build.match(/JavaLanguageVersion\.of\((\d+)\)/) ??
    build.match(/JavaVersion\.VERSION_(\d+)/) ??
    build.match(/sourceCompatibility\s*=\s*['"]?(\d+)/) ??
    build.match(/<java\.version>(\d+)<\/java\.version>/);
  const version = match ? Number(match[1]) : undefined;
  return version && version >= 8 ? version : undefined;
}

async function springPort(dir: string): Promise<number | undefined> {
  const resources = path.join(dir, 'src/main/resources');
  const properties = await readText(path.join(resources, 'application.properties'));
  const yaml = (await readText(path.join(resources, 'application.yml'))) ?? (await readText(path.join(resources, 'application.yaml')));
  const match = properties?.match(/^\s*server\.port\s*=\s*(\d+)/m) ?? yaml?.match(/server:\s*\n\s+port:\s*(\d+)/);
  return match ? Number(match[1]) : undefined;
}

async function detectFastApi(dir: string, relative: string): Promise<Omit<DetectedService, 'name'> | undefined> {
  const requirements = await readText(path.join(dir, 'requirements.txt'));
  const pyproject = await readText(path.join(dir, 'pyproject.toml'));
  const hasFastApi = /(^|\n)\s*fastapi\b/i.test(requirements ?? '') || /["']fastapi/i.test(pyproject ?? '') || /(^|\n)\s*fastapi\s*=/i.test(pyproject ?? '');
  if (!hasFastApi) return undefined;
  const entry = await fastApiModule(dir);
  const notes: string[] = [];
  if (!entry.found) notes.push('FastAPI 앱을 만드는 파일을 찾지 못해 main:app으로 실행합니다. 다르면 Dockerfile.b-studio를 고치세요');
  const install = requirements ? 'pip install --no-cache-dir -r requirements.txt' : 'pip install --no-cache-dir uv && uv pip install --system -r pyproject.toml';
  // pytest 의존성이 있을 때만 workflow.tests에 넣는다(ADR-133) — 없으면 "pytest: command not found"로 바로 실패한다.
  // requirements.txt·pyproject.toml 원문만 보는 것은 hasFastApi와 같은 생각(저장소를 훑지 않고 알려진 자리만 본다)
  const dependencyText = `${requirements ?? ''}\n${pyproject ?? ''}`;
  const hasPytest = /(^|\n)\s*pytest\b/i.test(requirements ?? '') || /["']pytest/i.test(pyproject ?? '') || /(^|\n)\s*pytest\s*=/i.test(pyproject ?? '');
  const testCommand = hasPytest ? { command: ['pytest'] } : undefined;
  if (testCommand) {
    notes.push(TEST_GATE_NOTE);
    // Testcontainers는 도커-인-도커가 필요해 샌드박스 컨테이너 안에서는 도커 소켓이 없으면 실패한다 — 미리 알린다
    if (/testcontainers/i.test(dependencyText)) {
      notes.push('Testcontainers 의존성을 찾았습니다. 테스트가 도커를 더 띄우려 하면(도커-인-도커) 샌드박스 안에서는 도커 소켓이 없어 실패할 수 있습니다 — 그러면 workflow.tests에서 이 테스트를 빼세요');
    }
  }
  return {
    template: 'fastapi',
    path: relative,
    port: 8000,
    preview: 'openapi',
    ready: { path: '/openapi.json' },
    contract: '/openapi.json',
    dockerfile: [
      '# b-studio가 만든 개발용 이미지. 소스는 compose에서 마운트하고 의존성은 컨테이너 안에서 설치한다',
      'FROM python:3.12-slim',
      '',
      `WORKDIR ${CONTAINER_WORKSPACE_ROOT}`,
      'ENV PYTHONDONTWRITEBYTECODE=1 PIP_DISABLE_PIP_VERSION_CHECK=1',
      '',
      'EXPOSE 8000',
      `CMD ["sh", "-c", "${install} && exec uvicorn ${entry.target} --reload --host 0.0.0.0 --port 8000"]`,
      '',
    ].join('\n'),
    volumes: {},
    environment: {},
    dependsOn: [],
    notes,
    ...(testCommand ? { testCommand } : {}),
  };
}

async function fastApiModule(dir: string): Promise<{ target: string; found: boolean }> {
  for (const file of ['main.py', 'app.py', 'app/main.py', 'src/main.py', 'api/main.py']) {
    const text = await readText(path.join(dir, file));
    const match = text?.match(/^(\w+)\s*=\s*FastAPI\(/m);
    if (match) return { target: `${file.replace(/\.py$/, '').replaceAll('/', '.')}:${match[1]}`, found: true };
  }
  return { target: 'main:app', found: false };
}

/** 제안한 서비스로 만들 파일. 이미 studio.yaml이 있으면 아무것도 만들지 않는다 */
export function generateFiles(detection: ProjectDetection): GeneratedFile[] {
  if (detection.hasSpec || detection.services.length === 0) return [];
  const files: GeneratedFile[] = [
    { path: SPEC_FILE, content: specYaml(detection) },
    { path: GENERATED_COMPOSE, content: composeYaml(detection.services, detection.infra) },
  ];
  for (const service of detection.services) files.push({ path: posixJoin(service.path, GENERATED_DOCKERFILE), content: service.dockerfile });
  return files;
}

function specYaml(detection: ProjectDetection): string {
  const lines = [
    '# b-studio가 폴더를 보고 만든 설정. 이 파일과 compose.b-studio.yaml·Dockerfile.b-studio는 git 추적에서 빼 두었습니다.',
    '# 틀린 추측이 있으면 고쳐도 됩니다. 팀과 나누려면 .git/info/exclude에서 빼고 커밋하세요',
    'version: 1',
    `name: ${sanitize(detection.name) || 'project'}`,
    `compose: ${GENERATED_COMPOSE}`,
    '',
    'services:',
  ];
  for (const service of detection.services) {
    lines.push(`  ${service.name}:`, '    source: managed', `    template: ${service.template}`, `    path: ${yamlString(service.path)}`, `    port: ${service.port}`, `    preview: ${service.preview}`);
    const ready = [`path: ${service.ready.path}`, ...(service.ready.expectStatus ? [`expectStatus: ${service.ready.expectStatus}`] : []), `timeoutSeconds: ${service.template === 'spring-boot' ? 900 : 300}`];
    lines.push(`    ready: { ${ready.join(', ')} }`);
    if (service.contract) lines.push(`    contract: { extract: ${service.contract} }`);
    for (const note of service.notes) lines.push(`    # 확인: ${note}`);
  }
  lines.push(...databasesYaml(detection.infra));
  lines.push(...workflowYaml(detection.services, detection.frontendBackendWiring));
  lines.push('');
  return lines.join('\n');
}

/**
 * workflow: 절 하나를 만든다. 두 가지가 이 절에 들어갈 수 있고(YAML에 같은 최상위 키가 두 번 나오면 뒤엣것만
 * 적용되므로 반드시 한 함수에서 합쳐 하나로 내보낸다), 둘 다 없으면 workflow: 자체를 만들지 않는다:
 *  - tests: 서비스 폴더에서 테스트 명령을 찾았으면(detectNode·detectSpring·detectFastApi의 testCommand, ADR-133)
 *    여기 넣는다. workflowStages()(packages/agent/src/workflow.ts)가 이 배열이 비어 있지 않을 때만 test 단계를
 *    기본 흐름에 끼워 넣으므로, 비어 있으면(이 함수를 아예 안 부르거나 tests가 없으면) 게이트가 test 단계
 *    자체를 건너뛴다 — JUnit·pytest 등을 에이전트가 run_in_service로 스스로 돌려도 체크포인트 트레일러에
 *    Workflow-Passed: test가 남지 않던 문제(버그 리포트 104)가 여기서 생겼다. defaultSelected: false인
 *    서비스(같은 서비스 폴더 하위의 또 다른 빌드, ADR-083)는 기본 서비스 선택에서 빠져 컨테이너가 뜨지
 *    않으므로 뺀다 — 넣으면 게이트가 `docker compose exec`할 컨테이너가 없어 test 단계가 항상 실패한다
 *  - pageChecks: 프론트엔드→백엔드 주소를 자동 연결했으면(fix/frontend-backend-url) 화면이 떠도 API 호출이
 *    깨지는 것을 검증 게이트가 잡도록 기본 화면 확인 하나. 헤드리스 브라우저를 쓸 수 없는 샌드박스에서는
 *    fallbackProbe가 대신 백엔드 주소로 HTTP 확인만 한다(packages/agent/src/gate.ts)
 * 다시 만들려면(studio.yaml을 직접 더 고치고 싶으면) studio.yaml·compose.b-studio.yaml과 각 서비스 폴더의
 * Dockerfile.b-studio를 지우고 폴더를 다시 열면 된다
 */
function workflowYaml(services: readonly DetectedService[], wiring: ProjectDetection['frontendBackendWiring']): string[] {
  const tests = services.flatMap((service) =>
    service.testCommand && service.defaultSelected !== false ? [{ name: `${service.name}-test`, service: service.name, ...service.testCommand }] : [],
  );
  if (tests.length === 0 && !wiring) return [];
  const lines: string[] = ['', 'workflow:'];
  if (tests.length > 0) {
    lines.push('  # 서비스 폴더에서 찾은 테스트 명령입니다(위 서비스의 "확인:" 메모 참고). 게이트가 test 단계에서 돌립니다');
    lines.push('  tests:');
    for (const test of tests) {
      const parts = [`name: ${test.name}`, `service: ${test.service}`, `command: ${JSON.stringify(test.command)}`, ...(test.maxAttempts ? [`maxAttempts: ${test.maxAttempts}`] : [])];
      lines.push(`    - { ${parts.join(', ')} }`);
    }
  }
  if (wiring) {
    lines.push(
      '  # 프론트엔드가 백엔드 주소를 자동으로 연결해 받습니다(위 서비스의 "확인:" 메모 참고). 화면은 뜨는데 API 호출만 깨지는',
      '  # 경우를 검증 게이트가 잡도록 기본 화면 확인을 하나 만들었습니다',
      '  pageChecks:',
      `    - { service: ${wiring.frontendService}, path: /, mode: browser, fallbackProbe: { service: ${wiring.backendService}, path: ${yamlString(wiring.backendProbePath)} } }`,
    );
  }
  return lines;
}

/** postgres 부가 서비스 중 databases: 요건(POSTGRES_DB·POSTGRES_USER가 SQL 식별자)에 맞는 것만 체크포인트 스냅샷 대상으로 적는다 */
function databasesYaml(infra: readonly InfraService[]): string[] {
  const entries = infra.flatMap((service) => {
    const spec = databaseSpecFor(service);
    return spec ? [[service.name, spec] as const] : [];
  });
  if (entries.length === 0) return [];
  const lines = ['', '# 체크포인트마다 상태를 저장해, 파일을 되돌릴 때 스키마와 데이터도 같은 시점으로 되돌린다', 'databases:'];
  for (const [name, spec] of entries) lines.push(`  ${name}: { engine: postgres, database: ${spec.database}, user: ${spec.user} }`);
  return lines;
}

function composeYaml(services: readonly DetectedService[], infra: readonly InfraService[]): string {
  const lines = ['# b-studio가 만든 개발용 compose. 샌드박스가 이 파일로 서비스를 띄운다', 'services:'];
  const volumes: string[] = [];
  let usesMockitoAgentInit = false;
  let usesTestMemoryInit = false;
  for (const service of services) {
    const context = service.path === '.' ? '.' : `./${service.path}`;
    const workDir = containerWorkDir(service.path);
    lines.push(`  ${service.name}:`, `    build: { context: ${context}, dockerfile: ${GENERATED_DOCKERFILE} }`, `    working_dir: ${workDir}`);
    const initConfigs: string[] = [];
    if (service.mockitoAgentInit) {
      usesMockitoAgentInit = true;
      initConfigs.push(`      - source: ${MOCKITO_AGENT_INIT_CONFIG_NAME}`, `        target: ${GRADLE_USER_HOME}/init.d/b-studio-mockito-agent.gradle`);
    }
    if (service.testMemoryInit) {
      usesTestMemoryInit = true;
      initConfigs.push(`      - source: ${TEST_MEMORY_INIT_CONFIG_NAME}`, `        target: ${GRADLE_USER_HOME}/init.d/b-studio-test-memory.gradle`);
    }
    if (initConfigs.length > 0) lines.push('    configs:', ...initConfigs);
    if (Object.keys(service.environment).length > 0) {
      lines.push('    environment:');
      for (const [key, value] of Object.entries(service.environment)) lines.push(`      ${key}: ${yamlString(value)}`);
    }
    // 프로젝트 루트 전체를 마운트한다(ADR-088) — 서비스 폴더만 마운트하면 멀티 모듈 빌드·워크스페이스·폴더 밖 공유 설정 참조가 깨진다
    lines.push('    volumes:', `      - .:${CONTAINER_WORKSPACE_ROOT}`);
    for (const [volume, target] of Object.entries(service.volumes)) {
      const name = `${service.name}-${volume}`;
      const containerPath = target.startsWith('/') ? target : posixJoin(workDir, target);
      lines.push(`      - ${name}:${containerPath}`);
      volumes.push(name);
    }
    if (service.dependsOn.length > 0) {
      // 조건 있는 항목과 없는 항목이 섞이면 목록 문법과 맵 문법을 함께 쓸 수 없어(잘못된 YAML) 모두 맵 문법으로 통일한다
      lines.push('    depends_on:');
      for (const dep of service.dependsOn) {
        const depInfra = infra.find((candidate) => candidate.name === dep);
        lines.push(`      ${dep}: { condition: ${depInfra?.healthcheck ? 'service_healthy' : 'service_started'} }`);
      }
    }
  }
  if (infra.length > 0) {
    lines.push('', '  # studio.yaml에 없는 부가 서비스: 샌드박스와 함께 뜨고 함께 사라진다 (기존 compose에서 가져오거나 새로 제안했습니다)');
    for (const service of infra) {
      lines.push(`  ${service.name}:`, service.proposed ? `    # 확인: ${service.reason}` : `    # ${service.sourceFile}에서 가져왔습니다`);
      for (const note of service.notes) lines.push(`    # 확인: ${note}`);
      lines.push(`    image: ${service.image}`);
      if (Object.keys(service.environment).length > 0) {
        lines.push('    environment:');
        for (const [key, value] of Object.entries(service.environment)) lines.push(`      ${key}: ${yamlString(value)}`);
      }
      if (service.command !== undefined) lines.push(`    command: ${JSON.stringify(service.command)}`);
      if (service.healthcheck) {
        lines.push('    healthcheck:');
        for (const [key, value] of Object.entries(service.healthcheck)) lines.push(`      ${key}: ${typeof value === 'string' ? yamlString(value) : JSON.stringify(value)}`);
      }
      if (Object.keys(service.volumes).length > 0) {
        lines.push('    volumes:');
        for (const [name, target] of Object.entries(service.volumes)) {
          lines.push(`      - ${name}:${target}`);
          volumes.push(name);
        }
      }
      if (service.dependsOn.length > 0) lines.push('    depends_on:', ...service.dependsOn.map((dep) => `      - ${dep}`));
    }
  }
  if (volumes.length > 0) lines.push('', 'volumes:', ...volumes.map((volume) => `  ${volume}:`));
  if (usesMockitoAgentInit || usesTestMemoryInit) {
    // Swarm이 아닌 일반 compose에서도 configs:는 파일로 그대로 마운트된다(docker compose 2.23.1+에서 확인). 여러
    // Gradle 서비스가 같은 init 스크립트를 공유하므로 내용은 여기 한 번만 쓴다(서비스 쪽은 source 이름만 가리킨다)
    lines.push('', 'configs:');
    if (usesMockitoAgentInit) {
      lines.push(`  ${MOCKITO_AGENT_INIT_CONFIG_NAME}:`, '    content: |');
      // compose는 파일 안의 ${...}를 환경 변수로 치환하려 들어, Groovy 문자열 보간(${jar.absolutePath})이 그대로 있으면
      // "invalid interpolation format"으로 compose 전체가 뜨지 않는다. $를 $$로 적어야 컨테이너 안 파일에 $ 하나로 들어간다
      for (const line of MOCKITO_AGENT_INIT_SCRIPT.split('\n')) lines.push(line.length > 0 ? `      ${line.replaceAll('$', '$$$$')}` : '');
    }
    if (usesTestMemoryInit) {
      lines.push(`  ${TEST_MEMORY_INIT_CONFIG_NAME}:`, '    content: |');
      for (const line of TEST_MEMORY_INIT_SCRIPT.split('\n')) lines.push(line.length > 0 ? `      ${line.replaceAll('$', '$$$$')}` : '');
    }
  }
  lines.push('');
  return lines.join('\n');
}

function posixJoin(dir: string, file: string): string {
  return dir === '.' ? file : `${dir.replace(/\/+$/, '')}/${file}`;
}

function yamlString(value: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : JSON.stringify(value);
}

async function childDirs(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !IGNORED_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

async function readText(file: string): Promise<string | undefined> {
  return readFile(file, 'utf8').catch(() => undefined);
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(file);
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
