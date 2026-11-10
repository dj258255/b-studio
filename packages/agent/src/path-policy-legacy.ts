import path from 'node:path';

/**
 * path-names.ts·policy.ts의 판정 함수를 Rust로 옮기면서(ADR-191 3q) 옮기기 전 TS 구현을 그대로 둔 기준 복사본이다. 차등·벡터 시험만 쓴다.
 * 바뀐 곳은 둘뿐이다: `normalizeProjectPath`의 `path.sep`을 인자(`sep`)로 받아 Windows 판도 견주고, `checkToolPolicy`가 기본 금지 명령 목록을 인자로 받는다.
 * 지우지 않는다 — 시험이 기준으로 삼는다.
 */

export const LEGACY_DENIED_COMMANDS = [
  'git push',
  'git reset --hard',
  'git clean',
  'kubectl',
  'helm',
  'terraform apply',
  'terraform destroy',
  'docker',
  'podman',
  'psql',
  'mysql',
  'redis-cli',
  'mongosh',
] as const;

export interface LegacyPolicy {
  allowedTools?: readonly string[];
  deniedCommands?: readonly string[];
  requireApprovalFor?: readonly string[];
  protectedPaths?: readonly string[];
  writablePaths?: readonly string[];
}
export interface LegacyDecision {
  tool: string;
  decision: 'allow' | 'deny';
  reason?: string;
}

export function normalizeProjectPath(file: string, { lenientSeparators = false }: { lenientSeparators?: boolean } = {}, sep: string = path.sep): string | undefined {
  if (file.includes('\0')) return undefined;
  let slashed = file;
  if (file.includes('\\')) {
    if (sep !== '\\' && !lenientSeparators) return undefined;
    slashed = file.replaceAll('\\', '/');
  }
  if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) return undefined;
  const normalized = path.posix.normalize(slashed).replace(/\/$/, '');
  if (normalized === '.' || normalized === '') return '';
  if (normalized === '..' || normalized.startsWith('../')) return undefined;
  return normalized;
}

export function foldName(segment: string): string {
  const folded = segment
    .normalize('NFKD')
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .toUpperCase()
    .toLowerCase()
    .normalize('NFKC');
  // 점과 공백뿐인 이름은 그대로 둔다(빈 이름으로 만들지 않는다)
  const trimmed = folded.replace(/[. ]+$/, '');
  return trimmed === '' ? folded : trimmed;
}

export function canonicalProjectPath(file: string, options: { lenientSeparators?: boolean } = {}, sep: string = path.sep): string | undefined {
  const normalized = normalizeProjectPath(file, options, sep);
  if (normalized === undefined || normalized === '') return normalized;
  return normalized.split('/').map(foldName).join('/');
}

const GRADLE_STOP = /(?:^|[\s;&|(])(?:\S*\/)?gradlew?(?=\s)[^;&|]*\s--stop(?:\s|$)/;

const IMPLIED_BY: Readonly<Record<string, readonly string[]>> = { read_lines: ['read_file'], search_files: ['read_file', 'list_files'] };

const PATH_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);

export function isToolAllowed(tool: string, allowedTools: readonly string[]): boolean {
  if (allowedTools.includes(tool)) return true;
  const implied = IMPLIED_BY[tool];
  return implied !== undefined && implied.every((required) => allowedTools.includes(required));
}

export function checkToolPolicy(
  tool: string,
  input: unknown,
  policy: LegacyPolicy | undefined,
  approvalToken: string | undefined,
  sep: string = path.sep,
): LegacyDecision {
  if (policy?.allowedTools && !isToolAllowed(tool, policy.allowedTools)) {
    return { tool, decision: 'deny', reason: `tool '${tool}' is not in the allowed tool list` };
  }

  // 경로 정책이 있는데 경로가 프로젝트 밖으로 나가면(`../x`, 절대 경로) 범위를 따질 것도 없이 거절한다
  if (PATH_WRITE_TOOLS.has(tool) && (policy?.writablePaths || policy?.protectedPaths?.length) && normalizeProjectPath(fileInput(input), {}, sep) === undefined) {
    return { tool, decision: 'deny', reason: 'path leaves the project' };
  }

  if (PATH_WRITE_TOOLS.has(tool) && policy?.writablePaths) {
    const file = fileInput(input);
    if (!policy.writablePaths.some((candidate) => isWithinScope(file, candidate, sep))) {
      return { tool, decision: 'deny', reason: `path is outside this task's writable scope: ${policy.writablePaths.join(', ')}` };
    }
  }

  if (PATH_WRITE_TOOLS.has(tool) && policy?.protectedPaths?.length) {
    const file = fileInput(input);
    const protectedPath = policy.protectedPaths.find((candidate) => isProtectedPath(file, candidate, sep));
    if (protectedPath) {
      return { tool, decision: 'deny', reason: `path is protected by execution policy: ${protectedPath}` };
    }
  }

  if (tool === 'run_in_service') {
    const command = commandInput(input);
    const denied = [...LEGACY_DENIED_COMMANDS, ...(policy?.deniedCommands ?? [])].find((rule) => {
      const tokens = splitRule(rule);
      return startsWithTokens(command, tokens) || (isShellWrapper(command) && containsCommand(command, tokens));
    });
    if (denied) return { tool, decision: 'deny', reason: `command is blocked by execution policy: ${denied}` };
    if (GRADLE_STOP.test(command.join(' '))) {
      return {
        tool,
        decision: 'deny',
        reason: 'gradle --stop is blocked: it stops the Gradle daemon that runs this service (bootRun) and takes the service down. Use restart_service to restart the service instead',
      };
    }
  }

  if (policy?.requireApprovalFor?.includes(tool) && !hasApprovalToken(approvalToken)) {
    return { tool, decision: 'deny', reason: 'this tool requires an explicit approval before execution' };
  }

  return { tool, decision: 'allow' };
}

export function hasApprovalToken(token: string | undefined): boolean {
  return typeof token === 'string' && token.trim().length > 0;
}

function commandInput(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return [];
  const command = (input as Record<string, unknown>).command;
  return Array.isArray(command) && command.every((value) => typeof value === 'string') ? command : [];
}

function fileInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const file = (input as Record<string, unknown>).path;
  // 받은 그대로 돌려준다. 역슬래시를 여기서 구분자로 바꾸면 POSIX의 실제 경로와 어긋난다(path-names.ts)
  return typeof file === 'string' ? file : '';
}

export function isProtectedPath(file: string, candidate: string, sep: string = path.sep): boolean {
  // 거부 목록이다: 넓게 맞춘다(path-names.ts). 받은 문자열을 그대로 접두사로 비교하면 같은 파일의 다른 표기가 지나간다 —
  // `web/../.github/workflows/x`, `.github//workflows/x`, 대소문자를 구분하지 않는 볼륨의 `.GITHUB/workflows/x`(트러블슈팅 125)
  const target = canonicalProjectPath(file, {}, sep);
  const rule = canonicalProjectPath(candidate, { lenientSeparators: true }, sep);
  // 꼴을 맞출 수 없는 경로나 규칙은 보호되는 쪽으로 본다. 거부 목록은 모르면 막는다
  if (target === undefined || rule === undefined) return true;
  // 프로젝트 전체를 가리키는 규칙(`.`)은 모든 경로를 덮는다
  if (rule === '') return true;
  return target === rule || target.startsWith(`${rule}/`) || (rule.startsWith('.') && target.startsWith(`${rule}.`));
}

export function isWithinScope(file: string, scope: string, sep: string = path.sep): boolean {
  const target = normalizeProjectPath(file, {}, sep);
  const rule = normalizeProjectPath(scope, { lenientSeparators: true }, sep);
  if (target === undefined || rule === undefined) return false;
  if (rule === '') return true;
  return target === rule || target.startsWith(`${rule}/`);
}

function splitRule(rule: string): string[] {
  return rule.trim().split(/\s+/).filter(Boolean);
}

function startsWithTokens(command: readonly string[], rule: readonly string[]): boolean {
  if (rule.length === 0 || command.length < rule.length || !command[0]) return false;
  const executable = path.basename(command[0]);
  const normalized = [executable, ...command.slice(1)];
  return rule.every((token, index) => normalized[index] === token);
}

function isShellWrapper(command: readonly string[]): boolean {
  const executable = command[0] ? path.basename(command[0]) : '';
  return ['sh', 'bash', 'zsh', 'fish', 'dash', 'env', 'cmd', 'powershell', 'pwsh'].includes(executable);
}

function containsCommand(command: readonly string[], rule: readonly string[]): boolean {
  const escaped = rule.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
  return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(command.slice(1).join(' '));
}
