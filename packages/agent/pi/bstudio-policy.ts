/**
 * Pi bridge for b-studio.
 *
 * Load with: pi -e packages/agent/pi/bstudio-policy.ts
 * 환경 변수는 studio.yaml에서 만든다: `piPolicyEnvironment(project)` (packages/agent/src/workflow.ts)
 *
 * 이 확장은 안내·조기 차단 계층이다. bash 명령은 셸 문법으로 얼마든지 숨길 수 있으므로 보안 경계가 아니다.
 * 보안 경계는 b-studio 도구 게이트와 샌드박스이고, 완료 판정은 검증 게이트가 한다.
 */
import path from 'node:path';
import { checkToolPolicy, DEFAULT_DENIED_COMMANDS, type ExecutionPolicy } from '../src/policy';

/** Pi 확장 API 중 이 확장이 쓰는 부분만 적었다. API가 늘어나도 이 확장은 영향받지 않는다 */
export interface PiExtensionApi {
  on(event: 'before_agent_start', handler: (event: { systemPrompt: string }) => { systemPrompt: string } | undefined): void;
  on(event: 'tool_call', handler: (event: PiToolCall) => { block: true; reason: string } | undefined): void;
}

export interface PiToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

export interface PiPolicyConfig {
  workflow: string;
  protectedPaths: string[];
  deniedCommands: string[];
  /** 프로젝트 루트. Pi 도구는 절대 경로도 받으므로 보호 경로와 비교하기 전에 상대 경로로 바꾼다 */
  cwd: string;
}

export function configFromEnvironment(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): PiPolicyConfig {
  const list = (name: string) =>
    (env[name] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  const denied = list('BSTUDIO_DENIED_COMMANDS');
  return {
    workflow: env.BSTUDIO_WORKFLOW ?? 'plan → implement → run → contract_check → review → checkpoint',
    protectedPaths: list('BSTUDIO_PROTECTED_PATHS'),
    // 환경 변수를 넘기지 않아도 기본 차단 목록은 빠지지 않게 한다
    deniedCommands: [...new Set([...DEFAULT_DENIED_COMMANDS, ...denied])],
    cwd,
  };
}

/**
 * Pi 내장 도구 호출을 b-studio 도구 정책의 같은 규칙으로 판정한다.
 * write·edit → write_file, bash → 셸 래퍼로 감싼 run_in_service (명령 문자열 전체에서 차단 규칙을 찾는다)
 */
export function evaluatePiToolCall(call: PiToolCall, config: PiPolicyConfig): { block: true; reason: string } | undefined {
  const policy: ExecutionPolicy = { protectedPaths: config.protectedPaths, deniedCommands: config.deniedCommands };

  if (call.toolName === 'write' || call.toolName === 'edit') {
    const raw = typeof call.input.path === 'string' ? call.input.path : '';
    const relative = path.relative(config.cwd, path.resolve(config.cwd, raw)).replaceAll('\\', '/');
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      return block(`프로젝트 밖 파일 '${raw}'은 수정할 수 없습니다`);
    }
    const decision = checkToolPolicy('write_file', { path: relative }, policy, undefined);
    return decision.decision === 'deny' ? block(decision.reason ?? '보호 경로') : undefined;
  }

  if (call.toolName === 'bash' || call.toolName === 'powershell') {
    const command = typeof call.input.command === 'string' ? call.input.command : '';
    const decision = checkToolPolicy('run_in_service', { command: ['bash', '-lc', command] }, policy, undefined);
    return decision.decision === 'deny' ? block(decision.reason ?? '차단된 명령') : undefined;
  }

  return undefined;
}

export function workflowGuidance(config: PiPolicyConfig): string {
  return `\n\n[b-studio] 이 작업은 플랫폼 검증 대상입니다.
워크플로: ${config.workflow}
완료 선언은 완료 판정이 아닙니다. 서비스 재시작·API 계약·테스트·리뷰는 b-studio가 직접 실행합니다.
보호 경로: ${config.protectedPaths.join(', ') || '없음'}
차단되면 우회하지 말고 사람 승인이 필요한 변경으로 보고하세요.\n`;
}

function block(reason: string): { block: true; reason: string } {
  return { block: true, reason: `b-studio policy: ${reason}` };
}

export default function bstudioPolicy(pi: PiExtensionApi, config: PiPolicyConfig = configFromEnvironment()): void {
  pi.on('before_agent_start', (event) => ({ systemPrompt: `${event.systemPrompt}${workflowGuidance(config)}` }));
  pi.on('tool_call', (event) => evaluatePiToolCall(event, config));
}
