/**
 * 테스트 탭(ADR-084)의 실행 단계 — 템플릿·실행기에 맞는 테스트 명령을 만들고, 컨테이너 안에 남긴 보고서를
 * 모아오는 명령도 함께 만든다. 순수 함수만 둔다(샌드박스 호출 없음) — studio의 서버 쪽 코드가
 * `sandbox.exec(service, plan.command)`로 실행하고 `sandbox.exec(service, plan.collect)`로 보고서를 모은다.
 */

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

/** 컨테이너 안 임시 보고서 경로. 서비스 소스 트리 밖(/tmp)이라 다른 파일과 부딪히지 않는다 */
export const JEST_LIKE_REPORT_PATH = '/tmp/b-studio-test-report.json';
export const PYTEST_REPORT_PATH = '/tmp/b-studio-test-report.xml';
/** Gradle/Maven은 출력 경로를 정할 수 없어(관례 경로에 남긴다) 찾아서 모은다 */
const GRADLE_REPORT_GLOB = 'build/test-results/test/*.xml';
const MAVEN_REPORT_GLOB = 'target/surefire-reports/*.xml';
/** 여러 보고서 파일을 한 번의 exec로 모아올 때 경계로 쓰는 표지. 실제 보고서 내용에 나타날 일이 없는 문자열이다 */
const REPORT_BOUNDARY = '@@@b-studio-test-report@@@';

function collectGlobCommand(glob: string): string[] {
  return ['sh', '-c', `for f in ${glob}; do [ -f "$f" ] && { echo '${REPORT_BOUNDARY}'"$f"; cat "$f"; echo; }; done`];
}

/**
 * runner·대상에 맞는 테스트 실행 명령과 보고서 수거 명령을 만든다.
 * `wrapper`는 서비스 폴더에 Gradle·Maven 래퍼(gradlew·mvnw)가 있는지다. 없으면 이미지의 gradle·mvn을 쓴다(주지 않으면 이전 동작: Gradle은 래퍼, Maven은 mvn) —
 * 폴더 열기가 래퍼 없는 Spring 서비스를 gradle 이미지로 띄우기 때문이다(pay 복제본에서 `./gradlew`가 없어 실패했다)
 */
export function buildTestRunPlan(runner: Runner, target?: TestTarget, { wrapper }: { wrapper?: boolean } = {}): TestRunPlan {
  switch (runner) {
    case 'gradle': {
      const command = [wrapper === false ? 'gradle' : './gradlew', 'test', '--no-daemon', '--console=plain'];
      if (target?.className) command.push('--tests', target.testName ? `${target.className}.${target.testName}` : target.className);
      return { command, collect: collectGlobCommand(GRADLE_REPORT_GLOB), format: 'junit-xml' };
    }
    case 'maven': {
      const command = [wrapper === true ? './mvnw' : 'mvn', '-q', 'test'];
      if (target?.className) command.push(`-Dtest=${target.testName ? `${target.className}#${target.testName}` : target.className}`);
      return { command, collect: collectGlobCommand(MAVEN_REPORT_GLOB), format: 'junit-xml' };
    }
    case 'vitest': {
      const command = ['npx', 'vitest', 'run', '--reporter=json', `--outputFile=${JEST_LIKE_REPORT_PATH}`];
      if (target?.file) command.push(target.file);
      if (target?.testName) command.push('-t', target.testName);
      return { command, collect: ['cat', JEST_LIKE_REPORT_PATH], format: 'jest-json' };
    }
    case 'jest': {
      const command = ['npx', 'jest', '--json', `--outputFile=${JEST_LIKE_REPORT_PATH}`];
      if (target?.file) command.push(target.file);
      if (target?.testName) command.push('-t', target.testName);
      return { command, collect: ['cat', JEST_LIKE_REPORT_PATH], format: 'jest-json' };
    }
    case 'pytest': {
      const command = ['pytest', `--junitxml=${PYTEST_REPORT_PATH}`];
      if (target?.file) {
        const node = target.testName ? `${target.file}::${target.className ? `${target.className}::` : ''}${target.testName}` : target.file;
        command.push(node);
      }
      return { command, collect: ['cat', PYTEST_REPORT_PATH], format: 'junit-xml' };
    }
  }
}

/** collectGlobCommand의 stdout을 파일별로 나눈다. 경계 표지가 없으면(단일 cat 결과) 파일 하나로 본다 */
export function splitCollectedReports(stdout: string, singleFileLabel = 'report'): Array<{ file: string; content: string }> {
  if (!stdout.includes(REPORT_BOUNDARY)) {
    const trimmed = stdout.trim();
    return trimmed ? [{ file: singleFileLabel, content: trimmed }] : [];
  }
  const parts: Array<{ file: string; content: string }> = [];
  const marker = new RegExp(`${REPORT_BOUNDARY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(.*)\\n`, 'g');
  const matches = [...stdout.matchAll(marker)];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i]!.index! + matches[i]![0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : stdout.length;
    parts.push({ file: matches[i]![1]!.trim(), content: stdout.slice(start, end).trim() });
  }
  return parts;
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
  const template = input.template.toLowerCase();
  if (template.includes('spring')) return input.hasPomXml ? 'maven' : 'gradle';
  if (template.includes('fastapi') || template.includes('python') || template.includes('django') || template.includes('flask')) return 'pytest';
  if (template.includes('next') || template.includes('vite') || template.includes('react') || template.includes('node')) {
    const deps = { ...(input.packageJson?.dependencies ?? {}), ...(input.packageJson?.devDependencies ?? {}) };
    if (deps.vitest) return 'vitest';
    if (deps.jest) return 'jest';
    const testScript = input.packageJson?.scripts?.test ?? '';
    if (/\bvitest\b/.test(testScript)) return 'vitest';
    if (/\bjest\b/.test(testScript)) return 'jest';
    return undefined;
  }
  return undefined;
}

export function runnerLabel(runner: Runner): string {
  switch (runner) {
    case 'gradle':
      return 'Gradle (JUnit)';
    case 'maven':
      return 'Maven (JUnit)';
    case 'vitest':
      return 'Vitest';
    case 'jest':
      return 'Jest';
    case 'pytest':
      return 'pytest';
  }
}
