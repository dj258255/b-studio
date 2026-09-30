/**
 * "제출 준비" 패널(ADR-080)의 점검표. 과제 채점 기준(요구사항 완료·클론 후 실행·테스트·README·깨끗한 커밋 기록·비밀 값 없음)을
 * 하나씩 확인하는 순수 함수 모음이다. 프로젝트 폴더(파일시스템)와 세션이 이미 들고 있는 정보(체크포인트·커밋·저장소 상태)만 받고,
 * 세션·샌드박스·요청은 모르므로 임시 폴더 픽스처로 테스트할 수 있다. 서버 조립(apps/studio/lib/server/sessions.ts)이
 * 세션에서 이 입력을 만들어 넘긴다.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export type ChecklistStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface ChecklistFix {
  /** 버튼 문구 */
  label: string;
  /** 대화 입력창에 채울 요청 글(대화 입력창은 채우기만 하고 자동으로 보내지 않는다) */
  prefill: string;
}

export interface ChecklistItem {
  id: string;
  title: string;
  status: ChecklistStatus;
  /** 한국어 짧은 이유 */
  reason: string;
  fix?: ChecklistFix;
}

export interface SubmissionScore {
  passed: number;
  /** skip은 세지 않는다(해당 없음) */
  total: number;
}

export interface SubmissionReport {
  items: ChecklistItem[];
  score: SubmissionScore;
}

/** studio.yaml의 managed 서비스 중 이 점검표가 필요로 하는 최소 정보 */
export interface ChecklistService {
  name: string;
  /** 'nextjs' | 'vite' | 'spring-boot' | 'fastapi' 같은 서비스 템플릿 문자열 */
  template: string;
  /** 프로젝트 루트 기준 서비스 폴더. 루트 바로 아래면 '.' */
  path: string;
  port: number;
}

export interface ChecklistCommit {
  subject: string;
  stat: { insertions: number; deletions: number };
}

export interface ChecklistRepository {
  hasRemote: boolean;
  pushed: boolean;
}

export interface SubmissionInputs {
  /** 프로젝트 폴더(세션 작업 복사본) 경로 */
  root: string;
  services: ChecklistService[];
  hasDatabase: boolean;
  /** 최신 체크포인트가 통과한 단계 목록. 체크포인트가 없으면 undefined */
  latestPassedStages?: string[];
  pendingFilesCount: number;
  /** 원격 저장소가 없는 세션(로컬 전용)이면 undefined */
  repository?: ChecklistRepository;
  /** 세션 시작 이후 커밋(체크포인트). 오래된 것부터 */
  commits: ChecklistCommit[];
  /**
   * 명세 탭(ADR-079)이 지금 계산한 요구사항 상태. 있으면 docs/requirements.md의 저장 당시 상태 줄 대신 이것을 쓴다
   * (파일의 상태 줄은 저장할 때 값이라 시간이 지나면 낡는다)
   */
  requirements?: ChecklistRequirement[];
}

export interface ChecklistRequirement {
  id: string;
  title: string;
  priority: 'must' | 'should' | 'could';
  /** 명세 탭의 상태. '검증됨'만 끝난 것으로 본다 */
  status: string;
}

const BACKEND_TEMPLATES = new Set(['spring-boot', 'fastapi']);
const FRONTEND_TEMPLATES = new Set(['nextjs', 'vite']);

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.next', 'build', 'dist', 'target', 'out',
  '.gradle', '.venv', 'venv', '__pycache__', 'coverage', '.turbo', '.b-studio',
]);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.eot',
  '.zip', '.jar', '.class', '.pdf', '.so', '.dylib', '.dll', '.exe', '.wasm',
]);
const LOCK_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'uv.lock', 'gradle-wrapper.jar', 'gradlew', 'gradlew.bat']);
const MAX_FILE_BYTES = 1_000_000;

/** 프로젝트 폴더 안의 파일을 생성물·의존성 폴더는 뺴고 전부 상대 경로로 나열한다(트리 순회 순서는 보장하지 않는다) */
async function listFiles(root: string, dir = root, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(root, full, out);
    else out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

async function readTextSafe(file: string): Promise<string | undefined> {
  const info = await stat(file).catch(() => undefined);
  if (!info || info.size > MAX_FILE_BYTES) return undefined;
  return readFile(file, 'utf8').catch(() => undefined);
}

function serviceRole(template: string): 'backend' | 'frontend' | undefined {
  if (BACKEND_TEMPLATES.has(template)) return 'backend';
  if (FRONTEND_TEMPLATES.has(template)) return 'frontend';
  return undefined;
}

function servicePrefix(service: ChecklistService): string {
  return service.path === '.' ? '' : `${service.path}/`;
}

// ---------------------------------------------------------------------------
// 1. 요구사항 (docs/requirements.md)
// ---------------------------------------------------------------------------

function parseRequirementsDoc(text: string): { total: number; unresolved: number } {
  let total = 0;
  let unresolved = 0;
  for (const line of text.split('\n')) {
    const checkbox = /^\s*-\s*\[([ xX])\]/.exec(line);
    if (checkbox) {
      total++;
      if (checkbox[1] === ' ') unresolved++;
      continue;
    }
    const status = /상태\s*[:：]\s*(.+)/.exec(line);
    if (status) {
      total++;
      if (!/^(완료|통과|검증됨|done|pass(ed)?|ok|verified)(\W|$)/i.test(status[1]!.trim())) unresolved++;
    }
  }
  return { total, unresolved };
}

/** 명세 탭이 계산한 상태로 판정한다. must가 하나라도 검증되지 않았으면 실패, should·could만 남았으면 경고 */
function requirementsFromLive(id: string, title: string, live: readonly ChecklistRequirement[]): ChecklistItem {
  const open = live.filter((requirement) => requirement.status !== '검증됨');
  if (open.length === 0) return { id, title, status: 'pass', reason: `요구사항 ${live.length}개가 모두 검증됐습니다.` };
  const mustOpen = open.filter((requirement) => requirement.priority === 'must');
  const list = (items: readonly ChecklistRequirement[]) =>
    items
      .slice(0, 5)
      .map((requirement) => `${requirement.id} ${requirement.title}(${requirement.status})`)
      .join(', ') + (items.length > 5 ? ` 외 ${items.length - 5}개` : '');
  if (mustOpen.length > 0) {
    return { id, title, status: 'fail', reason: `필수 요구사항 ${mustOpen.length}개가 아직 검증되지 않았습니다: ${list(mustOpen)}` };
  }
  return { id, title, status: 'warn', reason: `선택 요구사항 ${open.length}개가 아직 검증되지 않았습니다: ${list(open)}` };
}

export async function checkRequirements(root: string, live?: readonly ChecklistRequirement[]): Promise<ChecklistItem> {
  const id = 'requirements';
  const title = '요구사항';
  if (live && live.length > 0) return requirementsFromLive(id, title, live);
  const text = await readTextSafe(path.join(root, 'docs', 'requirements.md'));
  if (text === undefined) {
    return { id, title, status: 'skip', reason: 'docs/requirements.md가 없어 건너뜁니다.' };
  }
  const { total, unresolved } = parseRequirementsDoc(text);
  if (total === 0) return { id, title, status: 'warn', reason: 'docs/requirements.md에서 체크박스나 "상태:" 항목을 찾지 못했습니다.' };
  if (unresolved === 0) return { id, title, status: 'pass', reason: `요구사항 ${total}개가 모두 완료·확인 상태입니다.` };
  if (unresolved === total) return { id, title, status: 'fail', reason: `요구사항 ${total}개 중 아직 확인된 항목이 없습니다.` };
  return { id, title, status: 'warn', reason: `요구사항 ${total}개 중 ${unresolved}개가 미완료·미검증입니다.` };
}

// ---------------------------------------------------------------------------
// 2. 테스트
// ---------------------------------------------------------------------------

const FRONTEND_TEST = /(^|\/)__tests__\/.+|\.(test|spec)\.[cm]?[jt]sx?$/i;
const BACKEND_JAVA_TEST = /(^|\/)src\/test\/(java|kotlin)\/.+\.(java|kt)$/i;
const BACKEND_PY_TEST = /(^|\/)tests?\/.+\.py$|(^|\/)test_[^/]+\.py$|_test\.py$/i;

function hasTestFiles(files: string[], service: ChecklistService): boolean {
  const prefix = servicePrefix(service);
  const inService = files.filter((file) => (prefix === '' ? true : file.startsWith(prefix)));
  if (service.template === 'fastapi') return inService.some((file) => BACKEND_PY_TEST.test(file));
  if (service.template === 'spring-boot') return inService.some((file) => BACKEND_JAVA_TEST.test(file));
  return inService.some((file) => FRONTEND_TEST.test(file));
}

export async function checkTests(root: string, services: ChecklistService[], latestPassedStages: string[] | undefined): Promise<ChecklistItem> {
  const id = 'tests';
  const title = '테스트';
  const roles = new Set(services.map((service) => serviceRole(service.template)).filter((role): role is 'backend' | 'frontend' => role !== undefined));
  if (roles.size === 0) return { id, title, status: 'skip', reason: '테스트 여부를 판단할 수 있는 템플릿(백엔드·프런트엔드)이 없습니다.' };

  const files = await listFiles(root);
  const missing = services.filter((service) => {
    const role = serviceRole(service.template);
    return role !== undefined && !hasTestFiles(files, service);
  });
  const gatePassed = (latestPassedStages ?? []).includes('test');

  if (missing.length === services.filter((service) => serviceRole(service.template) !== undefined).length) {
    return {
      id,
      title,
      status: 'fail',
      reason: `테스트 파일이 하나도 없습니다: ${missing.map((service) => service.name).join(', ')}.`,
      fix: testFix(missing),
    };
  }
  if (missing.length > 0) {
    return {
      id,
      title,
      status: 'warn',
      reason: `${missing.map((service) => service.name).join(', ')} 서비스에 테스트 파일이 없습니다.`,
      fix: testFix(missing),
    };
  }
  if (!gatePassed) {
    return { id, title, status: 'warn', reason: '테스트 파일은 있지만 최신 체크포인트가 test 단계를 통과한 기록이 없습니다.' };
  }
  return { id, title, status: 'pass', reason: '백엔드·프런트엔드 모두 테스트 파일이 있고 최신 체크포인트가 test 단계를 통과했습니다.' };
}

function testFix(missing: ChecklistService[]): ChecklistFix {
  const detail = missing
    .map((service) => {
      const role = serviceRole(service.template);
      const framework = service.template === 'fastapi' ? 'pytest' : service.template === 'spring-boot' ? 'JUnit' : 'Vitest';
      return `${service.name}(${role === 'backend' ? '백엔드' : '프런트엔드'}, ${framework})`;
    })
    .join(', ');
  return {
    label: '테스트 추가',
    prefill: `${detail}에 핵심 로직을 검증하는 단위 테스트를 추가해 주세요. 채점자가 clone 후 테스트 명령 하나로 결과를 확인할 수 있어야 합니다.`,
  };
}

// ---------------------------------------------------------------------------
// 3. 실행 (README 실행 방법 + 포트 일관성)
// ---------------------------------------------------------------------------

const RUN_COMMANDS: Record<string, RegExp> = {
  nextjs: /pnpm(\s+run)?\s+dev|npm\s+run\s+dev|yarn\s+dev|next\s+dev/i,
  vite: /pnpm(\s+run)?\s+dev|npm\s+run\s+dev|yarn\s+dev|vite/i,
  'spring-boot': /gradlew\s+bootRun|gradle\s+bootRun|mvn\s+spring-boot:run/i,
  fastapi: /uvicorn|fastapi\s+dev/i,
};
const DOCKER_COMPOSE_MENTION = /docker[ -]compose|docker\s+compose/i;

async function findReadme(root: string): Promise<string | undefined> {
  const entries = await readdir(root).catch(() => [] as string[]);
  const name = entries.find((entry) => /^readme(\.[a-z0-9]+)?$/i.test(entry));
  return name ? readTextSafe(path.join(root, name)) : undefined;
}

function readmeCoversService(readme: string, service: ChecklistService): boolean {
  const hasPort = readme.includes(String(service.port));
  const dockerCompose = DOCKER_COMPOSE_MENTION.test(readme);
  const runCommand = RUN_COMMANDS[service.template];
  return hasPort && (dockerCompose || (runCommand ? runCommand.test(readme) : false));
}

export async function checkRunInstructions(root: string, services: ChecklistService[]): Promise<ChecklistItem> {
  const id = 'run';
  const title = '실행';
  const readme = await findReadme(root);
  if (readme === undefined) {
    return { id, title, status: 'fail', reason: 'README가 없어 실행 방법을 확인할 수 없습니다.', fix: readmeFix(services) };
  }
  const missing = services.filter((service) => !readmeCoversService(readme, service));
  if (missing.length === 0) return { id, title, status: 'pass', reason: '모든 서비스의 실행 명령과 포트가 README에 있습니다.' };
  const detail = missing.map((service) => `${service.name}(포트 ${service.port})`).join(', ');
  if (missing.length === services.length) {
    return { id, title, status: 'fail', reason: `README에 실행 방법이나 포트가 보이지 않습니다: ${detail}.`, fix: readmeFix(services) };
  }
  return { id, title, status: 'warn', reason: `일부 서비스의 실행 방법이나 포트가 README에 없습니다: ${detail}.`, fix: readmeFix(services) };
}

function readmeFix(services: ChecklistService[]): ChecklistFix {
  const ports = services.map((service) => `${service.name}: ${service.port}`).join(', ');
  return {
    label: 'README 쓰기',
    prefill:
      'README.md를 아래 구조로 작성해 주세요.\n' +
      '1. 개요 — 프로젝트가 하는 일 한두 문단\n' +
      '2. 기술 스택 — 실제로 쓴 백엔드·프런트엔드·데이터베이스\n' +
      `3. 실행 방법 — docker compose 명령과 로컬 실행 명령을 실제 포트(${ports})와 함께\n` +
      '4. API 목록 — 실제 라우트와 메서드를 표로 정리\n' +
      '5. 화면 — 주요 화면 설명\n' +
      '6. 테스트 실행 — 백엔드·프런트엔드 테스트를 돌리는 명령\n' +
      '7. 설계 결정과 트레이드오프 — 고민한 지점과 선택 이유\n' +
      '8. 요구사항 대응표 — docs/requirements.md 링크와 요구사항별 구현 여부',
  };
}

// ---------------------------------------------------------------------------
// 4. 환경 변수 (.env.example)
// ---------------------------------------------------------------------------

const ENV_USAGE_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
  /@Value\(\s*"\$\{([A-Z][A-Z0-9_]*)/g,
  /System\.getenv\(\s*"([A-Z][A-Z0-9_]*)"/g,
  /os\.environ\.get\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
  /os\.environ\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
  /os\.getenv\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
];
const YAML_PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)(:[^}]*)?\}/g;
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.java', '.kt', '.py']);
const YAML_EXTENSIONS = new Set(['.yml', '.yaml', '.properties']);
const REAL_ENV_FILES = new Set(['.env', '.env.local', '.env.production', '.env.development']);

function collectMatches(text: string, patterns: RegExp[], names: Set<string>): void {
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) if (match[1]) names.add(match[1]);
  }
}

export async function checkEnvExample(root: string): Promise<ChecklistItem> {
  const id = 'env';
  const title = '환경 변수';
  const files = await listFiles(root);

  const tracked = files.filter((file) => REAL_ENV_FILES.has(path.basename(file)));
  if (tracked.length > 0) {
    return { id, title, status: 'fail', reason: `실제 값이 든 환경 변수 파일이 저장소에 있습니다: ${tracked.join(', ')}. .gitignore에 추가하고 지워 주세요.` };
  }

  const names = new Set<string>();
  for (const file of files) {
    const ext = path.extname(file);
    if (!SOURCE_EXTENSIONS.has(ext) && !YAML_EXTENSIONS.has(ext)) continue;
    const text = await readTextSafe(path.join(root, file));
    if (text === undefined) continue;
    collectMatches(text, ENV_USAGE_PATTERNS, names);
    if (YAML_EXTENSIONS.has(ext)) collectMatches(text, [YAML_PLACEHOLDER], names);
  }
  if (names.size === 0) return { id, title, status: 'skip', reason: '코드에서 환경 변수를 읽는 곳을 찾지 못했습니다.' };

  const hasExample = files.some((file) => /(^|\/)\.env\.(example|sample)$/i.test(file));
  if (hasExample) return { id, title, status: 'pass', reason: `.env.example이 있고, 코드가 읽는 환경 변수 ${names.size}개를 확인했습니다.` };
  return {
    id,
    title,
    status: 'warn',
    reason: `코드가 환경 변수 ${names.size}개(${[...names].slice(0, 5).join(', ')}${names.size > 5 ? ' 등' : ''})를 읽지만 .env.example이 없습니다.`,
    fix: {
      label: '.env.example 만들기',
      prefill: `.env.example 파일을 만들어 주세요. 코드에서 읽는 환경 변수(${[...names].join(', ')})를 모두 담되 실제 값 대신 예시 값이나 빈 값을 넣고, 실제 비밀 값이 든 .env는 커밋하지 마세요.`,
    },
  };
}

// ---------------------------------------------------------------------------
// 5. 데이터 (마이그레이션·시드)
// ---------------------------------------------------------------------------

const MIGRATION_MARKERS = [
  /(^|\/)db\/migration\//i,
  /(^|\/)db\/changelog\//i,
  /(^|\/)(data|schema)\.sql$/i,
  /(^|\/)prisma\/migrations\//i,
  /(^|\/)prisma\/seed\.[jt]s$/i,
  /(^|\/)drizzle\//i,
  /(^|\/)migrations\//i,
  /(^|\/)seeds?\/.+/i,
  /seed\.[jt]s$/i,
  /seed\.py$/i,
];

export async function checkSeedData(root: string, hasDatabase: boolean): Promise<ChecklistItem> {
  const id = 'data';
  const title = '데이터';
  if (!hasDatabase) return { id, title, status: 'skip', reason: '데이터베이스 서비스가 없습니다.' };
  const files = await listFiles(root);
  const found = files.some((file) => MIGRATION_MARKERS.some((marker) => marker.test(file)));
  if (found) return { id, title, status: 'pass', reason: '마이그레이션이나 시드 데이터를 찾았습니다.' };
  return {
    id,
    title,
    status: 'warn',
    reason: '마이그레이션·시드 데이터를 찾지 못했습니다. 클론 후 빈 화면일 수 있습니다.',
    fix: {
      label: '시드 데이터 만들기',
      prefill:
        '채점자가 clone 후 바로 데이터를 볼 수 있도록, 여러 번 실행해도 같은 결과가 되는(idempotent) 시드 스크립트를 만들고 ' +
        '한 번의 명령(docker compose up 뒤 자동 실행되거나 별도 스크립트 하나)으로 마이그레이션과 시드 데이터가 함께 들어가게 해주세요.',
    },
  };
}

// ---------------------------------------------------------------------------
// 6. 비밀 값
// ---------------------------------------------------------------------------

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'AWS 액세스 키', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub 토큰', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: '개인 키', pattern: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'Slack 토큰', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: '비밀번호·시크릿 대입', pattern: /(password|passwd|secret|api[_-]?key)\s*[:=]\s*['"][^'"\s]{6,}['"]/i },
];
const EXAMPLE_FILE = /(^|\/)\.env\.(example|sample|template)$|\.(example|sample)\.[a-z]+$|example|sample/i;
/**
 * 테스트·픽스처 코드. 여기 있는 비밀번호·시크릿은 테스트용 고정값이라 제출물의 비밀 값 유출이 아니다
 * (pay 복제본에서 18건 중 대부분이 src/test의 JWT·웹훅 테스트 시크릿이었다)
 */
const TEST_OR_FIXTURE_FILE = /(^|\/)(src\/test|tests?|__tests__|fixtures?|__mocks__|mocks?|testdata)\/|\.(test|spec)\.[cm]?[jt]sx?$|(Test|Tests|IT|Spec)\.(java|kt)$|_test\.(py|go)$|(^|\/)test_[^/]+\.py$/;

export async function checkSecrets(root: string): Promise<ChecklistItem> {
  const id = 'secrets';
  const title = '비밀 값';
  const files = await listFiles(root);
  const leaks: string[] = [];
  for (const file of files) {
    if (EXAMPLE_FILE.test(file) || TEST_OR_FIXTURE_FILE.test(file)) continue;
    const ext = path.extname(file);
    if (BINARY_EXTENSIONS.has(ext) || LOCK_FILES.has(path.basename(file))) continue;
    const text = await readTextSafe(path.join(root, file));
    if (text === undefined) continue;
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      const hit = SECRET_PATTERNS.find(({ pattern }) => pattern.test(line));
      if (hit) leaks.push(`${file}:${index + 1} (${hit.name})`);
    }
  }
  if (leaks.length === 0) return { id, title, status: 'pass', reason: '추적한 파일에서 비밀 값 패턴을 찾지 못했습니다.' };
  return {
    id,
    title,
    status: 'fail',
    reason: `비밀 값으로 보이는 문자열이 있습니다: ${leaks.slice(0, 10).join(', ')}${leaks.length > 10 ? ` 외 ${leaks.length - 10}건` : ''}.`,
    fix: {
      label: '비밀 값 빼기',
      prefill: `다음 위치에 비밀 값으로 보이는 문자열이 있습니다: ${leaks.slice(0, 10).join(', ')}. 이 값을 코드에서 지우고 환경 변수로 읽도록 바꿔 주세요. .env.example에는 값 없이 키 이름만 남기고, 실제 값은 커밋하지 않는 .env에 두세요.`,
    },
  };
}

// ---------------------------------------------------------------------------
// 7. 커밋 기록
// ---------------------------------------------------------------------------

const CONVENTIONAL_SUBJECT = /^(feat|fix|test|docs|refactor|chore)(\([^)]+\))?: .+/;
const KOREAN_IMPERATIVE = /[가-힣]+(다|음|함)\.?$/;
const LOW_EFFORT_SUBJECT = /^(wip|tmp|temp|asdf|저장|수정|save|checkpoint)\W*\d*$/i;
const MAX_SUBJECT_CHARS = 72;
/** 이 아래 규모의 세션은 커밋 하나가 커도 "독차지"로 보지 않는다(작은 세션은 커밋이 하나뿐인 게 자연스럽다) */
const DOMINANCE_MIN_LINES = 50;
const DOMINANCE_RATIO = 0.8;

function commitSubjectIssue(subject: string): string | undefined {
  const trimmed = subject.trim();
  if (trimmed.length > MAX_SUBJECT_CHARS) return `${MAX_SUBJECT_CHARS}자를 넘습니다(${trimmed.length}자): "${trimmed}"`;
  if (LOW_EFFORT_SUBJECT.test(trimmed)) return `의미 없는 제목입니다: "${trimmed}"`;
  if (!CONVENTIONAL_SUBJECT.test(trimmed) && !KOREAN_IMPERATIVE.test(trimmed)) {
    return `타입 접두어(feat/fix/test/docs/refactor/chore)나 명확한 한국어 서술형이 아닙니다: "${trimmed}"`;
  }
  return undefined;
}

export async function checkCommitHistory(commits: ChecklistCommit[]): Promise<ChecklistItem> {
  const id = 'commits';
  const title = '커밋 기록';
  if (commits.length === 0) return { id, title, status: 'skip', reason: '아직 요청을 보내지 않았습니다.' };

  const issues = commits.map((commit) => commitSubjectIssue(commit.subject)).filter((issue): issue is string => issue !== undefined);
  if (issues.length > 0) {
    return { id, title, status: 'fail', reason: `커밋 제목 규칙을 따르지 않는 커밋이 ${issues.length}개 있습니다: ${issues.slice(0, 3).join('; ')}.` };
  }

  const totalLines = commits.reduce((sum, commit) => sum + commit.stat.insertions + commit.stat.deletions, 0);
  if (totalLines > DOMINANCE_MIN_LINES) {
    const dominant = commits.find((commit) => (commit.stat.insertions + commit.stat.deletions) / totalLines > DOMINANCE_RATIO);
    if (dominant) {
      const ratio = Math.round(((dominant.stat.insertions + dominant.stat.deletions) / totalLines) * 100);
      return { id, title, status: 'warn', reason: `커밋 "${dominant.subject}" 하나가 전체 변경의 ${ratio}%를 차지합니다. 더 작은 단위로 나누는 편이 기록을 읽기 좋습니다.` };
    }
  }
  return { id, title, status: 'pass', reason: `커밋 ${commits.length}개 모두 제목 규칙을 따릅니다.` };
}

// ---------------------------------------------------------------------------
// 8. 작업 트리·원격
// ---------------------------------------------------------------------------

export async function checkWorkingTree(pendingFilesCount: number, repository: ChecklistRepository | undefined): Promise<ChecklistItem> {
  const id = 'working-tree';
  const title = '작업 트리·원격';
  if (pendingFilesCount > 0) {
    return { id, title, status: 'fail', reason: `체크포인트로 저장하지 않은 변경이 ${pendingFilesCount}개 있습니다.` };
  }
  if (!repository) return { id, title, status: 'skip', reason: '원격 저장소와 연결되지 않은 세션입니다.' };
  if (!repository.pushed) return { id, title, status: 'warn', reason: '체크포인트는 있지만 아직 원격 브랜치에 올리지 않았습니다.' };
  return { id, title, status: 'pass', reason: '작업 트리가 깨끗하고 최신 체크포인트를 원격에 올렸습니다.' };
}

// ---------------------------------------------------------------------------
// 9. 문서 (README 구성)
// ---------------------------------------------------------------------------

/** 제목 앞의 번호("3. ", "3) ")까지 허용한다. 실제 README(pay)의 "### 3. 테스트"를 놓치던 것을 고쳤다 */
const HEADING = String.raw`^#{1,4}\s*(?:\d+[.)]\s*)?`;
const README_SECTIONS: Array<{ label: string; pattern: RegExp }> = [
  { label: '개요', pattern: new RegExp(`${HEADING}(개요|소개|요약|핵심\\s*결과|overview|introduction|about|summary)`, 'im') },
  { label: '실행 방법', pattern: new RegExp(`${HEADING}(실행|시작하기|빠른\\s*시작|설치|how to run|getting started|quick ?start|setup|installation|run)`, 'im') },
  { label: 'API', pattern: new RegExp(`${HEADING}(api\\b|엔드포인트|endpoints?|swagger|openapi|rest\\b)`, 'im') },
  { label: '테스트', pattern: new RegExp(`${HEADING}(테스트|test(ing|s)?)`, 'im') },
  { label: '설계 결정', pattern: new RegExp(`${HEADING}(설계|아키텍처|트레이드오프|결정|architecture|design|trade-?offs?)`, 'im') },
];

/** 첫 제목 바로 아래에 소개 문단이 있으면 개요가 있다고 본다(많은 README가 "개요" 제목 없이 소개로 시작한다) */
function hasIntroParagraph(readme: string): boolean {
  const lines = readme.split('\n');
  const first = lines.findIndex((line) => /^#\s/.test(line));
  if (first === -1) return false;
  for (const line of lines.slice(first + 1)) {
    if (/^#{1,6}\s/.test(line)) return false;
    const text = line.replace(/!\[[^\]]*\]\([^)]*\)|\[!\[.*$|<[^>]+>/g, '').trim();
    if (text.length >= 20) return true;
  }
  return false;
}

export async function checkReadmeSections(root: string, services: ChecklistService[]): Promise<ChecklistItem> {
  const id = 'docs';
  const title = '문서';
  const readme = await findReadme(root);
  if (readme === undefined) return { id, title, status: 'fail', reason: 'README가 없습니다.', fix: readmeFix(services) };
  const missing = README_SECTIONS.filter((section) => !section.pattern.test(readme) && !(section.label === '개요' && hasIntroParagraph(readme))).map((section) => section.label);
  if (missing.length === 0) return { id, title, status: 'pass', reason: '개요·실행 방법·API·테스트·설계 결정 항목이 README에 모두 있습니다.' };
  return { id, title, status: 'warn', reason: `README에 없는 항목: ${missing.join(', ')}.`, fix: readmeFix(services) };
}

// ---------------------------------------------------------------------------
// 조립
// ---------------------------------------------------------------------------

export async function buildSubmissionChecklist(inputs: SubmissionInputs): Promise<SubmissionReport> {
  const items = await Promise.all([
    checkRequirements(inputs.root, inputs.requirements),
    checkTests(inputs.root, inputs.services, inputs.latestPassedStages),
    checkRunInstructions(inputs.root, inputs.services),
    checkEnvExample(inputs.root),
    checkSeedData(inputs.root, inputs.hasDatabase),
    checkSecrets(inputs.root),
    checkCommitHistory(inputs.commits),
    checkWorkingTree(inputs.pendingFilesCount, inputs.repository),
    checkReadmeSections(inputs.root, inputs.services),
  ]);
  return { items, score: scoreOf(items) };
}

export function scoreOf(items: readonly ChecklistItem[]): SubmissionScore {
  const scored = items.filter((item) => item.status !== 'skip');
  return { passed: scored.filter((item) => item.status === 'pass').length, total: scored.length };
}
