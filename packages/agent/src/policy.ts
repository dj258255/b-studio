import path from 'node:path';
import { encodeLoneSurrogates, native } from '@b-studio/sandbox';

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

/** Windows면 역슬래시도 구분자다. 판정은 Rust가 하고 플랫폼 값만 여기서 넘긴다 */
const BACKSLASH_SEP = path.sep === '\\';

/**
 * 도구 호출 전에 실행기에서 판단하는 정책의 판정은 Rust(crates/bstudio-guard/src/path_policy.rs, ADR-191 3단계 3q)가 하고, 아래는 같은 이름·시그니처의 껍데기다.
 * 판정의 규칙(허용 도구와 읽기 도구 함의, 쓰기 범위와 보호 경로, 금지 명령과 셸 감싸기, `gradle --stop`, 승인)은 그쪽 문서 주석에 있다.
 * 여기에 남기는 것은 형 변환뿐이다: 알 수 없는 입력(`unknown`)에서 `path`·`command`를 꺼내고, 기본 금지 명령 목록(위 상수)을 넘긴다.
 * 정책의 모양이 어긋나면 Rust가 던지고, 부르는 쪽(tools.ts)은 던진 것을 실패로 돌려 도구를 실행하지 않는다
 */
export function isToolAllowed(tool: string, allowedTools: readonly string[]): boolean {
  return native.isToolAllowed(tool, [...allowedTools]);
}

export function checkToolPolicy(
  tool: string,
  input: unknown,
  policy: ExecutionPolicy | undefined,
  approvalToken: string | undefined,
): PolicyDecision {
  const policyJson = policy
    ? JSON.stringify({
        allowedTools: policy.allowedTools,
        deniedCommands: policy.deniedCommands,
        requireApprovalFor: policy.requireApprovalFor,
        // 경로 셋(파일·보호 경로·쓰기 범위)은 같은 규칙으로 단사 인코딩해 보낸다. 짝 없는 서로게이트가 경계에서 모두 U+FFFD가 되면 허용 목록인 쓰기 범위가
        // 다른 폴더를 범위 안으로 읽는다(트러블슈팅 166). 셋을 함께 바꿔야 보호 경로 비교도 옛 구현과 같다
        protectedPaths: policy.protectedPaths?.map(encodeLoneSurrogates),
        writablePaths: policy.writablePaths?.map(encodeLoneSurrogates),
      })
    : 'null';
  const decided = JSON.parse(
    native.checkToolPolicy(tool, encodeLoneSurrogates(fileInput(input)), commandInput(input), policyJson, typeof approvalToken === 'string' ? approvalToken : undefined, [...DEFAULT_DENIED_COMMANDS], BACKSLASH_SEP),
  ) as { decision: 'allow' | 'deny'; reason?: string };
  return decided.reason === undefined ? { tool, decision: decided.decision } : { tool, decision: decided.decision, reason: decided.reason };
}

/** 승인 토큰은 호출자가 별도 흐름에서 발급했다는 사실만 전달한다. 값 자체는 감사 이벤트에 남기지 않는다. */
export function hasApprovalToken(token: string | undefined): boolean {
  return native.hasApprovalToken(typeof token === 'string' ? token : undefined);
}

function commandInput(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return [];
  const command = (input as Record<string, unknown>).command;
  // 구멍 난 배열(`every`가 건너뛴다)은 빈 글자로 채운다. JSON으로 보내면 null이 되어 문자열 배열로 읽히지 않는다
  return Array.isArray(command) && command.every((value) => typeof value === 'string') ? Array.from(command as Array<string | undefined>, (value) => value ?? '') : [];
}

function fileInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const file = (input as Record<string, unknown>).path;
  // 받은 그대로 돌려준다. 역슬래시를 여기서 구분자로 바꾸면 POSIX의 실제 경로와 어긋난다(path-names.ts)
  return typeof file === 'string' ? file : '';
}

/**
 * 도구 호출 전 차단, 리뷰 단계의 사후 확인, Pi 확장이 같은 규칙으로 보호 경로를 판정하도록 공유한다.
 * 거부 목록이다: 넓게 맞춘다(path-names.ts). 꼴을 맞출 수 없는 경로나 규칙은 보호되는 쪽으로 본다
 */
export function isProtectedPath(file: string, candidate: string): boolean {
  return native.isProtectedPath(file, candidate, BACKSLASH_SEP);
}

/**
 * 파일이 쓰기 범위(허용 목록) 안에 있는지. **좁게 맞춘다**(트러블슈팅 126): 표기만 정리하고 이름은 글자 그대로 비교한다.
 * 꼴을 맞출 수 없는 경로나 범위는 범위 밖으로 본다. 허용 목록은 모르면 막는다
 */
export function isWithinScope(file: string, scope: string): boolean {
  // 허용 목록이라 짝 없는 서로게이트가 U+FFFD로 합쳐지지 않게 단사로 바꿔 보낸다(트러블슈팅 166). 보호 경로는 거부 목록이라 합쳐지면 더 막을 뿐이다
  return native.isWithinScope(encodeLoneSurrogates(file), encodeLoneSurrogates(scope), BACKSLASH_SEP);
}
