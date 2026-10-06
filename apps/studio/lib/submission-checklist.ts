/**
 * "제출 준비" 패널(ADR-080)의 점검표. 과제 채점 기준(요구사항 완료·클론 후 실행·테스트·README·깨끗한 커밋 기록·비밀 값 없음)을
 * 하나씩 확인하는 순수 함수 모음이다. 프로젝트 폴더(파일시스템)와 세션이 이미 들고 있는 정보(체크포인트·커밋·저장소 상태)만 받고,
 * 세션·샌드박스·요청은 모르므로 임시 폴더 픽스처로 테스트할 수 있다. 서버 조립(apps/studio/lib/server/sessions.ts)이
 * 세션에서 이 입력을 만들어 넘긴다.
 */
import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { DocEvidence } from '@b-studio/agent';

const execFileAsync = promisify(execFile);

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
  /** 이 커밋이 건드린 파일 수. 커밋이 하나뿐인 세션에서 "나누기엔 작다"를 줄 수만으로 판단하지 않고 파일 수로도 본다(없으면 줄 수만 본다) */
  filesChanged?: number;
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
  /**
   * "테스트" 탭(ADR-084)이 서비스마다 마지막으로 실행한 결과. 게이트가 test 단계를 통과한 기록이 없어도
   * (latestPassedStages에 'test'가 없어도) 사람이 테스트 탭에서 직접 돌려 지금 체크포인트에서 전부 통과했으면
   * 이 점검표도 통과로 본다(버그 리포트: 테스트 탭 실행이 증거로 치지 않던 문제). 서비스별로 하나씩, 없으면 그
   * 서비스는 "실행 기록 없음"으로 본다.
   */
  testEvidence?: ChecklistTestEvidence[];
  /**
   * "PR 만들기"가 올리고 나면 어차피 올린 상태가 될 것을 미리 반영한다(버그 리포트: 올리기 전 미리보기 본문은
   * "아직 올리지 않았다"고 9개 중 8개로 보여주는데, 실제로 PR을 만들면 그 사이 올라가 본문이 9/9로 나와
   * 미리보기와 실제 본문이 달랐다). true면 작업 트리가 깨끗한 한(pendingFilesCount === 0) 원격 올리기 항목을
   * "올렸다"로 본다 — 올리지 않은 상태를 그대로 보여 줘야 하는 저장소 탭의 "올리기 전 점검"에서는 생략한다
   */
  assumePushed?: boolean;
}

export interface ChecklistRequirement {
  id: string;
  title: string;
  priority: 'must' | 'should' | 'could';
  /** 명세 탭의 상태. '검증됨'만 끝난 것으로 본다 */
  status: string;
  /**
   * 검증됨을 만든 증거의 종류(ADR-103, requirementVerificationSource). 요구사항 항목이 "N개 중 M개 검증됨"
   * 말고도 사람 확인·문서 확인이 몇 개였는지 구분해 보여준다. 검증됨이 아니면 'none'
   */
  verifiedBy?: 'test' | 'docs' | 'manual' | 'none';
}

export interface ChecklistTestEvidence {
  /** studio.yaml의 서비스 이름(ChecklistService.name과 같은 값) */
  service: string;
  /** 지금 체크포인트(HEAD)에서 실행했고, 그 뒤로 커밋하지 않은 변경이 없는 실행인지 */
  matchesHead: boolean;
  counts: { pass: number; fail: number; skip: number; notRun: number };
  /** 실행 시각(ISO 8601). 사람이 읽는 안내 글에 쓴다 */
  at?: string;
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

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

async function isGitRepo(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { env: GIT_ENV });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * 원격에 올라갈 파일만 나열한다: git이 추적하는 파일(`--cached`) + 아직 추적되지 않았지만 `.gitignore`·
 * `.git/info/exclude`에 걸리지 않는 새 파일(`--others --exclude-standard`). b-studio가 만들고 추적에서 뺀
 * 생성 파일(예: compose.b-studio.yaml)은 원격에 올라가지 않으므로 비밀 값 점검 대상이 아니다(실측 세션
 * c55417ad, ADR-122) — 저장소를 clone한 사람은 이 로컬 생성물을 볼 수 없다.
 * git 저장소가 아니면 undefined를 돌려줘 호출부가 전체 파일 스캔(listFiles)으로 되돌아가게 한다
 */
async function listPushableFiles(root: string): Promise<string[] | undefined> {
  if (!(await isGitRepo(root))) return undefined;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
      { maxBuffer: 16 * 1024 * 1024, env: GIT_ENV },
    );
    return stdout
      .split('\0')
      .filter((entry) => entry.length > 0)
      .filter((file) => !file.split('/').some((segment) => EXCLUDED_DIRS.has(segment)));
  } catch {
    return undefined;
  }
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

const VERIFIED_BY_LABEL: Record<'test' | 'docs' | 'manual', string> = { test: '테스트/게이트', docs: '문서 확인', manual: '사람 확인' };

/**
 * "N개 검증됨" 뒤에 "(사람 확인 2개 · 문서 확인 1개)"처럼 테스트·게이트가 아닌 방법으로 검증된 개수를 덧붙인다.
 * 전부 테스트·게이트(또는 verifiedBy 정보가 없는 옛 호출)면 덧붙이지 않아 기존 문구를 그대로 지킨다(ADR-103) —
 * "요구사항 탭에서 이미 검증됐다고 나오는데 왜 점검표만 안 믿냐"는 버그 리포트의 반대쪽, "누가·무엇으로 검증했는지"를
 * 숨기지 않는다.
 */
function verificationBreakdownSuffix(verified: readonly ChecklistRequirement[]): string {
  const counts = { docs: 0, manual: 0 };
  for (const requirement of verified) {
    if (requirement.verifiedBy === 'docs') counts.docs++;
    else if (requirement.verifiedBy === 'manual') counts.manual++;
  }
  const parts = (['docs', 'manual'] as const).filter((kind) => counts[kind] > 0).map((kind) => `${VERIFIED_BY_LABEL[kind]} ${counts[kind]}개`);
  return parts.length > 0 ? ` (${parts.join(' · ')})` : '';
}

/** 명세 탭이 계산한 상태로 판정한다. must가 하나라도 검증되지 않았으면 실패, should·could만 남았으면 경고 */
function requirementsFromLive(id: string, title: string, live: readonly ChecklistRequirement[]): ChecklistItem {
  const open = live.filter((requirement) => requirement.status !== '검증됨');
  if (open.length === 0) {
    return { id, title, status: 'pass', reason: `요구사항 ${live.length}개가 모두 검증됐습니다.${verificationBreakdownSuffix(live)}` };
  }
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

/**
 * 게이트가 test 단계를 통과한 기록이 없을 때, 테스트 탭 실행 증거(ChecklistTestEvidence)로 대신 판정한다.
 * 역할(백엔드·프런트엔드)이 있는 서비스 전부가 지금 체크포인트에서 돈 실행이고 실패·미실행이 없어야 통과다.
 * 모자란 게 있으면 정확히 무엇이 모자란지 말한다(실패 > 체크포인트 불일치 > 미실행 > 실행 기록 없음 순).
 */
function testEvidenceVerdict(roleServices: ChecklistService[], testEvidence: ChecklistTestEvidence[]): ChecklistItem {
  const id = 'tests';
  const title = '테스트';
  const byService = new Map(testEvidence.map((evidence) => [evidence.service, evidence]));
  const notOnHead: string[] = [];
  const failing: string[] = [];
  const notRun: string[] = [];
  let passedTotal = 0;
  for (const service of roleServices) {
    const evidence = byService.get(service.name);
    if (!evidence || !evidence.matchesHead) {
      notOnHead.push(service.name);
      continue;
    }
    if (evidence.counts.fail > 0) failing.push(`${service.name}(실패 ${evidence.counts.fail}개)`);
    if (evidence.counts.notRun > 0) notRun.push(`${service.name}(미실행 ${evidence.counts.notRun}개)`);
    passedTotal += evidence.counts.pass;
  }
  if (failing.length > 0) {
    return { id, title, status: 'fail', reason: `테스트 탭 실행 결과에 실패한 테스트가 있습니다: ${failing.join(', ')}.` };
  }
  if (notOnHead.length > 0) {
    return {
      id,
      title,
      status: 'warn',
      reason: `${notOnHead.join(', ')} 서비스는 지금 체크포인트에서 실행한 테스트 탭 결과가 없습니다. 테스트 탭에서 "전체 실행"을 눌러 주세요.`,
    };
  }
  if (notRun.length > 0) {
    return { id, title, status: 'warn', reason: `테스트 탭 실행 뒤에 추가된 것으로 보이는, 아직 실행하지 않은 테스트가 있습니다: ${notRun.join(', ')}.` };
  }
  return { id, title, status: 'pass', reason: `백엔드·프런트엔드 모두 테스트 파일이 있고, 지금 체크포인트에서 실행한 테스트 탭 결과가 모두 통과했습니다(통과 ${passedTotal}개).` };
}

export async function checkTests(
  root: string,
  services: ChecklistService[],
  latestPassedStages: string[] | undefined,
  testEvidence?: ChecklistTestEvidence[],
): Promise<ChecklistItem> {
  const id = 'tests';
  const title = '테스트';
  const roleServices = services.filter((service) => serviceRole(service.template) !== undefined);
  if (roleServices.length === 0) return { id, title, status: 'skip', reason: '테스트 여부를 판단할 수 있는 템플릿(백엔드·프런트엔드)이 없습니다.' };

  const files = await listFiles(root);
  const missing = services.filter((service) => {
    const role = serviceRole(service.template);
    return role !== undefined && !hasTestFiles(files, service);
  });
  const gatePassed = (latestPassedStages ?? []).includes('test');

  if (missing.length === roleServices.length) {
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
    // 테스트 탭 실행 증거를 넘겨받았을 때만(세션 쪽이 조립해 준다) 더 자세히 판정한다 — 넘기지 않으면(옛 호출) 기존 문구 그대로다
    if (testEvidence !== undefined) return testEvidenceVerdict(roleServices, testEvidence);
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
    prefill: `${detail}에 핵심 로직을 검증하는 단위 테스트를 추가해 주세요. 다른 사람이 clone 후 테스트 명령 하나로 결과를 확인할 수 있어야 합니다.`,
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
/** Spring 등 앱이 직접 읽는 설정 파일. 여기의 \${VAR}만 앱 실행에 필요한 환경 변수로 본다 */
const APP_CONFIG_FILE = /(^|\/)(application|bootstrap)(-[\w.-]+)?\.(ya?ml|properties)$/;

/** 기본값이 없는 \${VAR}만 모은다. \${PORT:8080}·\${PORT:-8080}은 없어도 돌아간다 */
function collectRequiredPlaceholders(text: string, names: Set<string>): void {
  for (const match of text.matchAll(YAML_PLACEHOLDER)) {
    if (match[2] === undefined) names.add(match[1]!);
  }
}
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
    // 테스트 코드가 읽는 변수는 앱 실행에 필요한 것이 아니다
    if (TEST_OR_FIXTURE_FILE.test(file)) continue;
    const appConfig = APP_CONFIG_FILE.test(file);
    if (!SOURCE_EXTENSIONS.has(ext) && !appConfig) continue;
    const text = await readTextSafe(path.join(root, file));
    if (text === undefined) continue;
    if (SOURCE_EXTENSIONS.has(ext)) collectMatches(text, ENV_USAGE_PATTERNS, names);
    // compose·CI·모니터링 YAML의 치환 변수는 앱이 읽는 것이 아니다(pay에서 215개로 부풀었다). 앱 설정 파일만, 기본값 없는 것만 센다
    if (appConfig) collectRequiredPlaceholders(text, names);
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
        '다른 사람이 clone 후 바로 데이터를 볼 수 있도록, 여러 번 실행해도 같은 결과가 되는(idempotent) 시드 스크립트를 만들고 ' +
        '한 번의 명령(docker compose up 뒤 자동 실행되거나 별도 스크립트 하나)으로 마이그레이션과 시드 데이터가 함께 들어가게 해주세요.',
    },
  };
}

// ---------------------------------------------------------------------------
// 6. 비밀 값
// ---------------------------------------------------------------------------

type SecretSeverity = 'fail' | 'warn' | 'none';

interface SecretPattern {
  name: string;
  pattern: RegExp;
  /** 매치된 값(캡처 그룹 1)을 보고 심각도를 다시 매긴다. 없으면 매치 즉시 fail */
  classify?: (value: string) => SecretSeverity;
}

/** `${VAR}` 전체(기본값 없음) 또는 `${VAR:-기본값}`·`${VAR-기본값}`(기본값 있음) 전체로 이뤄진 값만 잡는다 */
const ENV_PLACEHOLDER_VALUE = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?:(:-|-)([^}]*))?\}$/;

/**
 * 기본값이 실제로 생성된 비밀처럼 보이는지(길고 문자 종류가 섞여 있는지). "community"·"postgres"·"changeme"
 * 같은 개발용 플레이스홀더는 짧은 한 단어라 걸리지 않고, 해시·토큰처럼 길고 대소문자·숫자·기호가 섞인 값만 잡는다
 * (ADR-122가 16자·문자 종류 2가지 이상 기준의 근거를 적어 둔다)
 */
function looksLikeGeneratedSecret(value: string): boolean {
  if (value.length < 16) return false;
  const categories = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((category) => category.test(value)).length;
  return categories >= 2;
}

/**
 * "password: ..." 같은 대입에서 값이 환경 변수 참조 전체인지 본다. 기본값 없는 참조(`${VAR}`)는 코드에 비밀 값이
 * 없다는 뜻이라 그대로 둔다(none). 기본값이 있으면 그 기본값만 평가해 짧은 개발용 플레이스홀더는 warn으로 낮추고,
 * 길고 무작위로 보이는 값은 그대로 fail로 둔다. 참조가 아니라 리터럴 문자열이면(하드코딩) 항상 fail이다
 */
function classifyPasswordAssignmentValue(value: string): SecretSeverity {
  const placeholder = ENV_PLACEHOLDER_VALUE.exec(value);
  if (!placeholder) return 'fail';
  const [, separator, fallback] = placeholder;
  if (separator === undefined || !fallback) return 'none';
  return looksLikeGeneratedSecret(fallback) ? 'fail' : 'warn';
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'AWS 액세스 키', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub 토큰', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: '개인 키', pattern: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'Slack 토큰', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  {
    name: '비밀번호·시크릿 대입',
    pattern: /(?:password|passwd|secret|api[_-]?key)\s*[:=]\s*['"]([^'"\s]{6,})['"]/i,
    classify: classifyPasswordAssignmentValue,
  },
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
  // 원격에 올라갈 파일만 본다(git 저장소가 아니면 listFiles로 전체를 본다, ADR-122)
  const files = (await listPushableFiles(root)) ?? (await listFiles(root));
  const failLeaks: string[] = [];
  const warnLeaks: string[] = [];
  for (const file of files) {
    if (EXAMPLE_FILE.test(file) || TEST_OR_FIXTURE_FILE.test(file)) continue;
    const ext = path.extname(file);
    if (BINARY_EXTENSIONS.has(ext) || LOCK_FILES.has(path.basename(file))) continue;
    const text = await readTextSafe(path.join(root, file));
    if (text === undefined) continue;
    const lines = text.split('\n');
    for (const [index, line] of lines.entries()) {
      for (const { name, pattern, classify } of SECRET_PATTERNS) {
        const match = pattern.exec(line);
        if (!match) continue;
        const severity = classify ? classify(match[1] ?? '') : 'fail';
        if (severity === 'none') continue;
        (severity === 'fail' ? failLeaks : warnLeaks).push(`${file}:${index + 1} (${name})`);
        break;
      }
    }
  }
  if (failLeaks.length === 0 && warnLeaks.length === 0) {
    return { id, title, status: 'pass', reason: '추적한 파일에서 비밀 값 패턴을 찾지 못했습니다.' };
  }
  if (failLeaks.length > 0) {
    return {
      id,
      title,
      status: 'fail',
      reason: `비밀 값으로 보이는 문자열이 있습니다: ${failLeaks.slice(0, 10).join(', ')}${failLeaks.length > 10 ? ` 외 ${failLeaks.length - 10}건` : ''}.`,
      fix: {
        label: '비밀 값 빼기',
        prefill: `다음 위치에 비밀 값으로 보이는 문자열이 있습니다: ${failLeaks.slice(0, 10).join(', ')}. 이 값을 코드에서 지우고 환경 변수로 읽도록 바꿔 주세요. .env.example에는 값 없이 키 이름만 남기고, 실제 값은 커밋하지 않는 .env에 두세요.`,
      },
    };
  }
  return {
    id,
    title,
    status: 'warn',
    reason: `환경 변수 기본값이 비밀 값처럼 보이는 곳이 있습니다: ${warnLeaks.slice(0, 10).join(', ')}${warnLeaks.length > 10 ? ` 외 ${warnLeaks.length - 10}건` : ''}. 개발용 기본값이면 괜찮지만, 실제 운영 값이면 지우고 환경 변수로만 공급해 주세요.`,
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
/**
 * 커밋이 세션 전체에서 하나뿐일 때, 그 한 커밋을 쪼개라고 권할 만큼 큰지 가르는 기준(줄 수·파일 수 중 하나라도
 * 넘으면 권한다). 커밋이 하나뿐인 것 자체는 문제가 아니다 — 한 요청짜리 작은 세션은 원래 커밋이 하나다(실측
 * 세션 c55417ad: 파일 3개, +60/-9=69줄인데도 "100%를 차지합니다" 경고가 항상 뜨던 오탐, ADR-122).
 * 300줄·파일 15개는 코드 리뷰 관행에서 "한 번에 제대로 리뷰하기 버거워지는" 문턱으로 흔히 언급되는 수치보다
 * 보수적으로 낮춰 잡았다(정확한 수치는 리뷰어·언어마다 다르므로 이 점검의 목적—"쪼개 볼까?"라고 묻는 것—에
 * 맞게 보수적으로 고른 값이다)
 */
const SINGLE_COMMIT_SPLIT_MIN_LINES = 300;
const SINGLE_COMMIT_SPLIT_MIN_FILES = 15;

function singleCommitTooBig(commit: ChecklistCommit): boolean {
  const lines = commit.stat.insertions + commit.stat.deletions;
  if (lines > SINGLE_COMMIT_SPLIT_MIN_LINES) return true;
  return commit.filesChanged !== undefined && commit.filesChanged > SINGLE_COMMIT_SPLIT_MIN_FILES;
}

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

  // 커밋이 하나뿐이면 "독차지" 개념 자체가 성립하지 않는다(비교할 다른 커밋이 없다) — 그 한 커밋이 충분히
  // 클 때만 쪼개라고 권한다
  if (commits.length === 1) {
    const [only] = commits;
    if (singleCommitTooBig(only!)) {
      const lines = only!.stat.insertions + only!.stat.deletions;
      return { id, title, status: 'warn', reason: `커밋 "${only!.subject}" 하나가 ${lines}줄을 바꿉니다. 더 작은 단위로 나누는 편이 기록을 읽기 좋습니다.` };
    }
    return { id, title, status: 'pass', reason: '커밋 1개가 제목 규칙을 따릅니다.' };
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

export async function checkWorkingTree(
  pendingFilesCount: number,
  repository: ChecklistRepository | undefined,
  { assumePushed = false }: { assumePushed?: boolean } = {},
): Promise<ChecklistItem> {
  const id = 'working-tree';
  const title = '작업 트리·원격';
  if (pendingFilesCount > 0) {
    return { id, title, status: 'fail', reason: `체크포인트로 저장하지 않은 변경이 ${pendingFilesCount}개 있습니다.` };
  }
  if (!repository) return { id, title, status: 'skip', reason: '원격 저장소와 연결되지 않은 세션입니다.' };
  // 올리기 전 미리보기(assumePushed): 작업 트리가 깨끗하면 "PR 만들기"를 누르는 순간 바로 올라간다 — 실제로
  // 만든 PR 본문(올린 뒤 계산)과 미리보기 본문이 이 항목 하나 때문에 달라 보이지 않게 미리 올린 것으로 본다
  if (!repository.pushed && !assumePushed) return { id, title, status: 'warn', reason: '체크포인트는 있지만 아직 원격 브랜치에 올리지 않았습니다.' };
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
// 10. 요구사항(kind: docs)의 인수 조건을 프로젝트 문서(README.md·docs/**\/*.md)와 맞춰 본다(ADR-103).
//
// 문서화를 요구하는 요구사항("README에 기술 선택·상태 설계를 설명한다")은 테스트·게이트가 돌지 않아 영원히
// "작업 중"에 머물던 버그를 고친다. 결정론적이고 설명 가능하게 두려고(모델을 부르지 않는다) 아주 단순한 규칙만
// 쓴다: 인수 조건 한 줄에서 조사를 뗀 명사형 낱말(키워드)을 뽑고, 문서를 "## 제목" 단위로 쪼갠 다음, 그 제목이나
// 바로 아래 문단에 그 낱말이 전부 있으면 "이 조건을 찾았다"고 본다. 못 찾은 조건은 그대로 "빠진 조건"으로 보여준다
// (근거를 숨기지 않는다 — 조건 중 일부만 맞아도 "검증됨"으로 부풀리지 않는다).
// ---------------------------------------------------------------------------

export interface DocMatchSource {
  /** "README.md" 또는 "docs/architecture.md"처럼 사람이 읽는 출처 이름 */
  path: string;
  content: string;
}

/** 조사(을/를/이/가/의/에서/에게/에는/에도/에/로/으로/와/과/은/는/도/만/까지/부터)를 낱말 끝에서 뗀다. 2글자보다 짧아지면 포기한다(의미가 날아간다) */
const TRAILING_PARTICLE = /(에서|에게|에는|에도|까지|부터|으로|이다|한다|했다|를|을|이|가|의|에|로|와|과|은|는|도|만)$/;
function stripTrailingParticle(word: string): string {
  const stripped = word.replace(TRAILING_PARTICLE, '');
  return stripped.length >= 2 ? stripped : word;
}

/**
 * 문서 매칭에서 의미 없는 흔한 동사·연결어와, "문서 자신"을 가리키는 낱말(README·리드미·문서 — 인수 조건이
 * "README에 ~~을 설명한다"처럼 적혀도 README 자신이 그 글자를 담고 있을 필요는 없다). 너무 흔해 어떤 제목에나
 * 걸려 매칭을 의미 없게 만든다
 */
const DOC_MATCH_STOPWORDS = new Set([
  '한다', '해야', '해야한다', '있다', '없다', '있어야', '되어야', '된다', '것', '수', '등', '및', '그리고', '또는', '혹은',
  '설명', '기재', '명시', '포함', '작성', '정리', '추가', '한다면', '하면', '위해', '통해', '대해', '대한',
  'readme', '리드미', '문서',
]);

/** 인수 조건 한 줄에서 매칭에 쓸 키워드를 뽑는다. 조사를 떼고 2글자 미만·불용어(대소문자 구분 없이)는 버린다(너무 흔해 아무 제목에나 걸린다) */
function acceptanceKeywords(acceptance: string): string[] {
  const words = acceptance
    .replace(/[.,!?()[\]{}:;"'`]/g, ' ')
    .split(/\s+/)
    .map((word) => stripTrailingParticle(word.trim()))
    .filter((word) => word.length >= 2 && !DOC_MATCH_STOPWORDS.has(word.toLowerCase()));
  return [...new Set(words)];
}

interface DocSection {
  heading: string;
  body: string;
}

/** 문서를 "#~###### 제목" 단위로 쪼갠다(제목이 없는 맨 앞부분은 heading: ''인 섹션 하나로 둔다) */
function splitDocSections(content: string): DocSection[] {
  const sections: DocSection[] = [];
  let heading = '';
  let body: string[] = [];
  const flush = () => {
    if (heading || body.length > 0) sections.push({ heading, body: body.join('\n') });
    body = [];
  };
  for (const line of content.split(/\r?\n/)) {
    const match = /^#{1,6}\s*(?:\d+[.)]\s*)?(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1]!;
      continue;
    }
    body.push(line);
  }
  flush();
  return sections;
}

/** 섹션(제목+문단)이 키워드를 전부 담고 있는지(대소문자 구분 없이, 부분 문자열 포함이면 된다) */
function sectionMatchesKeywords(section: DocSection, keywords: readonly string[]): boolean {
  const haystack = `${section.heading}\n${section.body}`.toLowerCase();
  return keywords.every((keyword) => haystack.includes(keyword.toLowerCase()));
}

/**
 * 요구사항의 인수 조건마다 docs(README.md·docs/**\/*.md)에서 그 내용을 설명하는 제목·문단을 찾는다(ADR-103).
 * 키워드가 하나도 안 남는 조건(불용어뿐인 아주 짧은 문장)은 찾을 수 없으므로 "빠진 조건"으로 둔다 — 억지로
 * 통과시키지 않는다. @b-studio/agent의 RequirementEvidence.docEvidence 모양 그대로 돌려준다.
 */
export function matchAcceptanceAgainstDocs(acceptance: readonly string[], docs: readonly DocMatchSource[]): DocEvidence {
  const sources = docs.map((doc) => ({ path: doc.path, sections: splitDocSections(doc.content) }));
  const matched: string[] = [];
  const missing: string[] = [];
  const matchedHeadingsByPath = new Map<string, Set<string>>();

  for (const line of acceptance) {
    const keywords = acceptanceKeywords(line);
    let found = false;
    if (keywords.length > 0) {
      for (const source of sources) {
        const hit = source.sections.find((section) => sectionMatchesKeywords(section, keywords));
        if (hit) {
          found = true;
          const headings = matchedHeadingsByPath.get(source.path) ?? new Set<string>();
          headings.add(hit.heading || source.path);
          matchedHeadingsByPath.set(source.path, headings);
          break;
        }
      }
    }
    if (found) matched.push(line);
    else missing.push(line);
  }

  const sourceSummary = [...matchedHeadingsByPath.entries()]
    .map(([sourcePath, headings]) => (headings.has(sourcePath) && headings.size === 1 ? sourcePath : `${sourcePath}(${[...headings].join(', ')})`))
    .join(' · ');

  return {
    matched,
    missing,
    satisfied: matched.length > 0 && missing.length === 0,
    ...(sourceSummary ? { sourceSummary } : {}),
  };
}

// ---------------------------------------------------------------------------
// 조립
// ---------------------------------------------------------------------------

export async function buildSubmissionChecklist(inputs: SubmissionInputs): Promise<SubmissionReport> {
  const items = await Promise.all([
    checkRequirements(inputs.root, inputs.requirements),
    checkTests(inputs.root, inputs.services, inputs.latestPassedStages, inputs.testEvidence),
    checkRunInstructions(inputs.root, inputs.services),
    checkEnvExample(inputs.root),
    checkSeedData(inputs.root, inputs.hasDatabase),
    checkSecrets(inputs.root),
    checkCommitHistory(inputs.commits),
    checkWorkingTree(inputs.pendingFilesCount, inputs.repository, { assumePushed: inputs.assumePushed }),
    checkReadmeSections(inputs.root, inputs.services),
  ]);
  return { items, score: scoreOf(items) };
}

export function scoreOf(items: readonly ChecklistItem[]): SubmissionScore {
  const scored = items.filter((item) => item.status !== 'skip');
  return { passed: scored.filter((item) => item.status === 'pass').length, total: scored.length };
}
