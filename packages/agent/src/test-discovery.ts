/**
 * 테스트 탭(ADR-084)의 발견 단계 — 세션 작업 복사본의 테스트 파일에서 실제 테스트 케이스를 한 줄 한 줄 읽어 낸다.
 *
 * 순수 함수만 둔다(파일 IO 없음) — studio의 서버 쪽 코드가 파일을 읽어 이 모듈에 내용을 넘기고,
 * 판정은 Rust(crates/bstudio-guard/src/test_discovery.rs, ADR-191 3단계)가 한다. 이 파일은 같은 이름·시그니처의 껍데기다.
 * 정규식 기반의 가벼운 토큰화로 스위트(클래스·describe)·테스트(메서드·it/test·def test_)를
 * 줄 번호와 함께 트리로 뽑는다. 지원 프레임워크: JUnit4/5(Java·Kotlin), Vitest/Jest/Playwright(ts/js/tsx/jsx), pytest.
 * 포맷이 흔들려도(들여쓰기, 줄바꿈 위치) 최대한 잡아내되, 완벽한 파서가 아니므로 못 잡는 형태는 조용히 건너뛴다.
 */

import { decodeNative, encodeNative, native } from '@b-studio/sandbox';

export type TestFramework = 'junit' | 'vitest' | 'jest' | 'playwright' | 'pytest';

export interface DiscoveredTestCase {
  /** 실행기(gradle --tests, jest -t 등)에 넘길 이름 */
  name: string;
  /** 사람이 보는 이름. @DisplayName이나 it()/test()의 문자열. 없으면 name과 같다 */
  displayName: string;
  line: number;
  skipped: boolean;
  /** 이름·표시 이름에서 찾은 요구사항 id(R1 등) */
  requirementIds: string[];
  /**
   * 이 테스트에 걸린 실행 환경 조건부 표시의 정적 추정(다그푸딩 마찰 152): JUnit `@Tag("…")`·`@Testcontainers`·
   * `@EnabledIf…`/`@DisabledIf…` 류, pytest의 스킵·파라미터화가 아닌 커스텀 마커(`@pytest.mark.integration` 등).
   * 게이트의 기본 test 태스크가 이런 테스트를 제외하도록 설정돼 있을 수 있다는 뜻일 뿐, 실제로 돌았는지는 이것만으로
   * 알 수 없다 — "이유 추정"으로만 쓴다(findUnexecutedTests, requirements.ts). 없으면 undefined(빈 배열을 넣지 않는다)
   */
  envConditionalReasons?: string[];
}

export interface DiscoveredSuite {
  name: string;
  displayName: string;
  line: number;
  /** 스위트 자체가 꺼져 있는지(@Disabled 클래스, describe.skip 등). 개별 테스트의 skipped와 별개다 */
  skipped: boolean;
  suites: DiscoveredSuite[];
  tests: DiscoveredTestCase[];
  /** 클래스(스위트) 자체에 걸린 실행 환경 조건부 표시. 안의 모든 테스트가 물려받는다(flattenDiscoveredFile) */
  envConditionalReasons?: string[];
}

export interface DiscoveredFile {
  path: string;
  framework: TestFramework;
  /** 파일 최상위 스위트(클래스, 최상위 describe) */
  suites: DiscoveredSuite[];
  /** 어느 스위트에도 속하지 않은 최상위 테스트(예: describe 없이 쓴 it()) */
  tests: DiscoveredTestCase[];
}

/** 이름·표시 이름 글자에서 요구사항 id(R1, R2…)·시나리오 id(R4.1…)를 찾는다. 중복은 뺀다. 요구사항 id(R1)뿐 아니라 시나리오 id(R4.1)도 통째로 한 토큰으로 잡는다(requirements.ts의 REQUIREMENT_MENTION_PATTERN과 같은 모양) */
export function extractRequirementIds(text: string): string[] {
  return native.extractRequirementIds(text);
}

/**
 * 묶음(describe·클래스) 제목 경로에 단 id까지 합쳐 테스트 하나의 id를 구한다. `describe('R11.2: …')` 아래 `it('…')`처럼
 * 시나리오 id를 묶음 제목에만 다는 것은 vitest·jest에서 흔한 쓰기 방식이라, 묶음 제목의 id는 그 안의 모든 테스트의 id다
 * (중첩 묶음은 바깥 것까지). 테스트 자신의 제목에 단 id가 앞에 오고, 묶음 id는 바깥에서 안쪽 순서로 뒤따르며,
 * 같은 id를 둘 다에서 받아도 한 번만 센다. 발견 단계(flattenDiscoveredFile)와 보고서 단계(sessions.ts)가 같은 규칙을 쓴다
 */
export function extractRequirementIdsWithSuites(suitePath: readonly string[] | undefined, title: string): string[] {
  return native.extractRequirementIdsWithSuites(suitePath ? [...suitePath] : undefined, title);
}

/** JUnit 4/5 테스트 파일(Java·Kotlin)에서 클래스(@Nested 포함)·테스트 메서드를 찾는다 */
export function discoverJunitFile(filePath: string, content: string): DiscoveredFile {
  return JSON.parse(native.discoverJunitFile(filePath, content)) as DiscoveredFile;
}

/** 파일 내용에서 프레임워크를 짐작한다(@playwright/test import가 있으면 playwright, vitest import가 있으면 vitest, 그 밖은 jest로 본다) */
export function detectJsFramework(content: string): TestFramework {
  return native.detectJsFramework(content) as TestFramework;
}

/** Vitest/Jest/Playwright 테스트 파일에서 describe·it/test를 찾는다. 제목 문자열은 같은 줄에 있다고 가정한다(여러 줄 제목은 지원하지 않는다) */
export function discoverJsFile(filePath: string, content: string, framework?: TestFramework): DiscoveredFile {
  return JSON.parse(native.discoverJsFile(filePath, content, framework)) as DiscoveredFile;
}

/** pytest 테스트 파일(test_*.py, *_test.py)에서 class Test*와 def test_*를 찾는다. 들여쓰기로 중첩을 판단한다(탭은 스페이스 하나로 센다) */
export function discoverPytestFile(filePath: string, content: string): DiscoveredFile {
  return JSON.parse(native.discoverPytestFile(filePath, content)) as DiscoveredFile;
}

/** 경로만 보고 테스트 파일로 볼지 정한다. 세 프레임워크의 관례적인 이름 규칙을 모두 본다 */
export function isTestFilePath(filePath: string): boolean {
  return native.isTestFilePath(filePath);
}

/** 경로·내용을 보고 알맞은 파서로 테스트를 찾는다. 테스트 파일로 보이지 않으면 undefined */
export function discoverTestsInFile(filePath: string, content: string): DiscoveredFile | undefined {
  const json = native.discoverTestsInFile(filePath, content);
  return json ? (JSON.parse(json) as DiscoveredFile) : undefined;
}

/** 파일의 스위트·테스트 트리를 한 줄씩 펴서 화면이 그리기 쉬운 평평한 목록으로 만든다 */
export interface FlatDiscoveredTest extends DiscoveredTestCase {
  file: string;
  /** 바깥 → 안쪽 순서의 스위트 이름(사람이 읽는 표시 이름) */
  suitePath: string[];
  suiteSkipped: boolean;
}

export function flattenDiscoveredFile(file: DiscoveredFile): FlatDiscoveredTest[] {
  return JSON.parse(native.flattenDiscoveredFile(JSON.stringify(file))) as FlatDiscoveredTest[];
}
