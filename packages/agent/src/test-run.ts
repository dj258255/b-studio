/**
 * 테스트 탭(ADR-084)의 실행 단계 — 템플릿·실행기에 맞는 테스트 명령을 만들고, 컨테이너 안에 남긴 보고서를
 * 모아오는 명령도 함께 만든다. 순수 함수만 둔다(샌드박스 호출 없음) — studio의 서버 쪽 코드가
 * `sandbox.exec(service, plan.command)`로 실행하고 `sandbox.exec(service, plan.collect)`로 보고서를 모은다.
 *
 * 판정은 Rust(crates/bstudio-guard/src/test_run.rs, ADR-191 3단계 3d)가 한다. 이 파일은 같은 이름·시그니처의 껍데기와 타입 선언이다.
 */

import { encodeNative, native } from '@b-studio/sandbox';

export type Runner = 'gradle' | 'maven' | 'vitest' | 'jest' | 'pytest';

/** 좁혀서 돌릴 대상. 아무것도 없으면 서비스의 테스트 전체를 돌린다 */
export interface TestTarget {
  /** 서비스 폴더 기준 상대 경로(JS/TS, pytest에서 쓴다) */
  file?: string;
  /** JVM 전용: Gradle --tests, Maven -Dtest에 쓸 정규화된 클래스명(예: com.example.OrderServiceTest 또는 중첩 클래스 포함 OrderServiceTest$WhenCancelled) */
  className?: string;
  /** 메서드/테스트 이름(JVM은 메서드 이름, JS는 -t 패턴, pytest는 노드 id의 테스트 이름) */
  testName?: string;
}

export interface TestRunPlan {
  /** 서비스 컨테이너 안에서 실행할 명령(sandbox.exec의 command 인자와 같은 모양 — 셸을 거치지 않는다) */
  command: string[];
  /** 실행 뒤 보고서를 모아오는 명령. stdout을 splitCollectedReports로 나눈다 */
  collect: string[];
  /** 보고서 형식. test-results.ts의 파서를 고르는 데 쓴다 */
  format: 'junit-xml' | 'jest-json';
}

/** 상수는 Rust가 정한 값을 읽는다(crates/bstudio-guard/src/test_run.rs). 컨테이너 안 임시 보고서 경로는 서비스 소스 트리 밖(/tmp)이라 다른 파일과 부딪히지 않는다 */
const CONSTANTS = JSON.parse(native.testRunConstants()) as { jestLikeReportPath: string; pytestReportPath: string; containerProjectRoot: string };
export const JEST_LIKE_REPORT_PATH: string = CONSTANTS.jestLikeReportPath;
export const PYTEST_REPORT_PATH: string = CONSTANTS.pytestReportPath;

/**
 * runner·대상에 맞는 테스트 실행 명령과 보고서 수거 명령을 만든다.
 * `wrapper`는 서비스 폴더에 Gradle·Maven 래퍼(gradlew·mvnw)가 있는지다. 없으면 이미지의 gradle·mvn을 쓴다(주지 않으면 이전 동작: Gradle은 래퍼, Maven은 mvn) —
 * 폴더 열기가 래퍼 없는 Spring 서비스를 gradle 이미지로 띄우기 때문이다(pay 복제본에서 `./gradlew`가 없어 실패했다)
 * `extraReportRoots`는 이 서비스의 `includes`(ADR-139, studio.yaml)가 가리키는 서비스 폴더 밖 경로들 — 컨테이너
 * 안에서 그 경로로도 접근할 수 있는 절대/상대 경로를 호출하는 쪽이 만들어 준다. Gradle 멀티 모듈 빌드에서
 * `-p <서비스 폴더> test`가 그 서브프로젝트의 테스트도 함께 돌리지만(ADR-139), 보고서는 서브프로젝트 자신의
 * build/test-results 아래에 남아 서비스 폴더만 보면 놓친다(도그푸딩 마찰 135) — 그 경로의 보고서도 같이 모은다
 */
export function buildTestRunPlan(
  runner: Runner,
  target?: TestTarget,
  { wrapper, extraReportRoots = [] }: { wrapper?: boolean; extraReportRoots?: readonly string[] } = {},
): TestRunPlan {
  return JSON.parse(native.buildTestRunPlan(runner, target?.file, target?.className, target?.testName, wrapper, [...extraReportRoots])) as TestRunPlan;
}

/** 서비스 컨테이너 안에서 프로젝트 루트를 마운트한 자리. studio의 CONTAINER_WORKSPACE_ROOT(ADR-088)와 같아야 한다 */
export const CONTAINER_PROJECT_ROOT: string = CONSTANTS.containerProjectRoot;

/** 서비스의 `includes`(ADR-139)를 컨테이너 안 보고서 경로의 뿌리로 바꾼다. 보고서를 모으는 쪽(studio)과 비우는 쪽(게이트)이 같은 경로를 보게 한 곳에 둔다 */
export function reportRootsForIncludes(includes: readonly string[] = [], root: string = CONTAINER_PROJECT_ROOT): string[] {
  return native.reportRootsForIncludes([...includes], root);
}

/**
 * `collect`가 읽는 보고서 자리를 실행기와 상관없이 모두 지우는 명령(#756). 게이트가 선언된 테스트를 돌리기 직전에 보낸다.
 * 게이트의 테스트 명령(사용자 스크립트)이 이 자리에 보고서를 남기지 않으면, 테스트 탭이 예전에 남긴 보고서나 에이전트가
 * 실행 중에 만든 파일이 그대로 모여 새 체크포인트의 근거가 되기 때문이다. 고정 경로와 상수 glob만 따옴표 없이 두고,
 * `extraReportRoots`는 수거와 같은 규칙(reportGlobExprs)으로 걸러 감싼다
 */
export function clearTestReportsCommand(extraReportRoots: readonly string[] = []): string[] {
  return native.clearTestReportsCommand([...extraReportRoots]);
}

/** collectGlobCommand의 stdout을 파일별로 나눈다. 경계 표지가 없으면(단일 cat 결과) 파일 하나로 본다 */
export function splitCollectedReports(stdout: string, singleFileLabel = 'report'): Array<{ file: string; content: string }> {
  return JSON.parse(native.splitCollectedReports(stdout, singleFileLabel)) as Array<{ file: string; content: string }>;
}

// ---------------------------------------------------------------------------
// 실행기 판별
// ---------------------------------------------------------------------------

export interface PackageJsonInfo {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface DetectRunnerInput {
  /** studio.yaml services.<name>.template (예: spring-boot, nextjs, vite, fastapi) */
  template: string;
  /** 서비스 폴더에 pom.xml이 있는지(Spring Boot를 Gradle 대신 Maven으로 쓰는 프로젝트) */
  hasPomXml?: boolean;
  /** 서비스 폴더의 package.json(있으면). vitest/jest 중 어느 것을 쓰는지 여기서 가른다 */
  packageJson?: PackageJsonInfo;
}

/** studio.yaml의 template과 서비스 폴더 힌트(package.json, pom.xml 유무)로 실행기를 고른다. 판별 못 하면 undefined */
export function detectRunner(input: DetectRunnerInput): Runner | undefined {
  const packageJson = input.packageJson === undefined ? undefined : encodeNative(input.packageJson);
  return (native.detectRunner(input.template, input.hasPomXml, packageJson) ?? undefined) as Runner | undefined;
}

export function runnerLabel(runner: Runner): string {
  return native.runnerLabel(runner);
}
