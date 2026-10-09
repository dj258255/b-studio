import { canonicalProjectPath } from './path-names';
import path from 'node:path';

/** 도구 호출 전에 실행기에서 판단하는 정책. 모델 프롬프트의 지침과 달리 우회할 수 없다. */
export interface ExecutionPolicy {
  /** 지정하면 이 목록에 있는 도구만 실행한다. 생략하면 buildTools(project)의 전체 도구를 쓴다. */
  allowedTools?: readonly string[];
  /** 추가로 차단할 명령의 첫 토큰 시퀀스. 예: ['make release', 'npm publish'] */
  deniedCommands?: readonly string[];
  /** 지정한 도구는 실행 전에 호출자의 승인을 받아야 한다. */
  requireApprovalFor?: readonly string[];
  /** 에이전트가 수정할 수 없는 프로젝트 상대 경로 접두사 */
  protectedPaths?: readonly string[];
  /** 지정하면 이 경로(와 하위 경로) 안에서만 파일을 쓸 수 있다. 작업 분해에서 레인끼리 변경이 겹치지 않게 한다 */
  writablePaths?: readonly string[];
}

export interface ApprovalRequest {
  tool: string;
  /** 승인을 요청할 때 표시할 안전한 요약. 파일 내용·시크릿은 포함하지 않는다. */
  summary: string;
}

export interface PolicyDecision {
  tool: string;
  decision: 'allow' | 'deny';
  reason?: string;
}

export const DEFAULT_DENIED_COMMANDS = [
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

/**
 * 서비스 컨테이너 안의 `gradle --stop`·`./gradlew --stop`. bootRun으로 서비스를 돌리는 Gradle 데몬까지 멈춰 서비스가
 * 내려간다(도그푸딩 버그 리포트: 에이전트가 조사하다 `./gradlew --stop`을 돌려 commerce 메인 프로세스가 exit 1로
 * 죽었다). 토큰 접두사 규칙(DEFAULT_DENIED_COMMANDS)은 `./gradlew -p commerce --stop`처럼 사이에 옵션이 낀 꼴을
 * 못 잡아 따로 본다. 명령 구분자(; & |)를 넘어가지는 않아, `./gradlew test; echo --stop` 같은 다른 명령의 인자는 무시한다.
 */
const GRADLE_STOP = /(?:^|[\s;&|(])(?:\S*\/)?gradlew?(?=\s)[^;&|]*\s--stop(?:\s|$)/;

/** 경로 정책(쓰기 범위·보호 경로)이 걸리는 도구. 파일을 만드는 것과 지우는 것을 같게 본다 */
const PATH_WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);

export function checkToolPolicy(
  tool: string,
  input: unknown,
  policy: ExecutionPolicy | undefined,
  approvalToken: string | undefined,
): PolicyDecision {
  if (policy?.allowedTools && !policy.allowedTools.includes(tool)) {
    return { tool, decision: 'deny', reason: `tool '${tool}' is not in the allowed tool list` };
  }

  // 경로 정책이 있는데 경로가 프로젝트 밖으로 나가면(`../x`, 절대 경로) 범위를 따질 것도 없이 거절한다
  if (PATH_WRITE_TOOLS.has(tool) && (policy?.writablePaths || policy?.protectedPaths?.length) && canonicalProjectPath(fileInput(input)) === undefined) {
    return { tool, decision: 'deny', reason: 'path leaves the project' };
  }

  if (PATH_WRITE_TOOLS.has(tool) && policy?.writablePaths) {
    const file = fileInput(input);
    if (!policy.writablePaths.some((candidate) => isProtectedPath(file, candidate))) {
      return { tool, decision: 'deny', reason: `path is outside this task's writable scope: ${policy.writablePaths.join(', ')}` };
    }
  }

  if (PATH_WRITE_TOOLS.has(tool) && policy?.protectedPaths?.length) {
    const file = fileInput(input);
    const protectedPath = policy.protectedPaths.find((candidate) => isProtectedPath(file, candidate));
    if (protectedPath) {
      return { tool, decision: 'deny', reason: `path is protected by execution policy: ${protectedPath}` };
    }
  }

  if (tool === 'run_in_service') {
    const command = commandInput(input);
    const denied = [...DEFAULT_DENIED_COMMANDS, ...(policy?.deniedCommands ?? [])].find((rule) => {
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

/** 승인 토큰은 호출자가 별도 흐름에서 발급했다는 사실만 전달한다. 값 자체는 감사 이벤트에 남기지 않는다. */
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
  return typeof file === 'string' ? file.replaceAll('\\', '/') : '';
}

/** 도구 호출 전 차단, 리뷰 단계의 사후 확인, Pi 확장이 같은 규칙으로 보호 경로를 판정하도록 공유한다 */
export function isProtectedPath(file: string, candidate: string): boolean {
  // 받은 문자열을 그대로 접두사로 비교하면 같은 파일의 다른 표기가 지나간다: `web/../.github/workflows/x`, `.github//workflows/x`,
  // 그리고 대소문자를 구분하지 않는 볼륨의 `.GITHUB/workflows/x`(트러블슈팅 125). 둘 다 같은 꼴로 맞춘 뒤 비교한다
  const target = canonicalProjectPath(file);
  const rule = canonicalProjectPath(candidate);
  // 루트 밖으로 나가는 경로는 어느 범위에도 속하지 않는다. 그런 경로의 거절은 checkToolPolicy와 작업 공간이 따로 한다
  if (target === undefined || rule === undefined) return false;
  // 프로젝트 전체를 가리키는 규칙(`.`)은 모든 경로를 덮는다
  if (rule === '') return true;
  return target === rule || target.startsWith(`${rule}/`) || (rule.startsWith('.') && target.startsWith(`${rule}.`));
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
