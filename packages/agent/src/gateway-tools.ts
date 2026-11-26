import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { SERVER } from './claude-code-shared';
import { buildTools, SANDBOX_TOOLS } from './tools';
import { Workspace, WorkspaceError } from './workspace';

/** CLI에 여는 내장 도구. 호스트에서 명령을 돌리는 Bash는 넣지 않는다(명령은 MCP의 run_in_service로 컨테이너 안에서 돈다) */
export const GATEWAY_BUILTIN_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'] as const;

/** 관문 방식에서 MCP로 내주는 도구: 샌드박스가 있어야 도는 것만. 파일 도구는 CLI의 내장 도구가 대신한다 */
export function gatewayToolSpecs(project: LoadedProject): ReturnType<typeof buildTools> {
  return buildTools(project).filter((spec) => SANDBOX_TOOLS.has(spec.name));
}

/**
 * 세션 터미널(이슈 #673)에서 CLI가 대화를 시작할 때 받는 글. 훅의 덧붙임으로 들어가므로 짧게 쓴다.
 * 러너 방식과 다른 점만 적는다: 여기는 서비스가 도는 곳이 아니고, 커밋은 b-studio가 한다.
 * container는 CLI가 에이전트 컨테이너 안에서 돌고, host는 이 컴퓨터에서 돈다(그 차이만 글에 담는다)
 */
export function terminalGatewayNote(project: LoadedProject, mode: 'container' | 'host' = 'container'): string {
  const services = project.managed.map(([name]) => name);
  const tools = gatewayToolSpecs(project).map((spec) => `mcp__${SERVER}__${spec.name}`);
  if (mode === 'host') {
    return [
      '# b-studio',
      `이 작업 폴더는 b-studio 세션의 작업 복사본이고, 이 CLI는 이 컴퓨터에서 돈다. 프로젝트의 서비스(${services.join(', ') || '없음'})는 각자의 컨테이너에서 돌고, 같은 폴더가 그 안에 연결되어 있다.`,
      `빌드·테스트·서버 명령은 mcp__${SERVER}__run_in_service로 서비스 컨테이너 안에서 돌린다(검증 게이트가 보는 환경이 그쪽이다). 쓸 수 있는 b-studio 도구: ${tools.join(', ')}.`,
      '커밋하지 않는다. git commit·git push·git reset·git checkout·git stash로 기록이나 브랜치를 바꾸지 않는다. 체크포인트(커밋)는 턴이 끝난 뒤 b-studio가 검증을 통과시켜 남긴다.',
      '작업 폴더 밖의 파일을 바꾸지 않는다.',
      '검증이 실패하면 결과가 "Stop hook feedback"으로 돌아온다. 그것은 사용자의 새 요청이 아니라 검증 결과다. 고친 뒤 다시 턴을 끝낸다.',
      '끝내 통과하지 못하면 b-studio가 이번 요청의 변경을 되돌린다(기록에서 되살릴 수 있다).',
      '사용자에게 보이는 글은 한국어로 쓴다.',
    ].join('\n');
  }
  return [
    '# b-studio',
    `이 작업 폴더는 b-studio 세션의 작업 복사본이다. 프로젝트의 서비스(${services.join(', ') || '없음'})는 이 컨테이너가 아니라 각자의 컨테이너에서 돌고, 같은 폴더가 그 안에 연결되어 있다.`,
    `이 컨테이너에는 프로젝트의 런타임과 의존성이 없다. 빌드·테스트·서버 명령은 여기의 셸이 아니라 mcp__${SERVER}__run_in_service로 서비스 컨테이너 안에서 돌린다. 쓸 수 있는 b-studio 도구: ${tools.join(', ')}.`,
    '.git은 읽기 전용이다. 커밋하지 않는다. 턴을 끝내면 b-studio가 검증 게이트(서비스 재시작, API 계약, 선언한 확인)를 돌리고, 통과하면 체크포인트(커밋)를 남긴다.',
    '검증이 실패하면 결과가 "Stop hook feedback"으로 돌아온다. 그것은 사용자의 새 요청이 아니라 검증 결과다. 고친 뒤 다시 턴을 끝낸다.',
    '끝내 통과하지 못하면 b-studio가 이번 요청의 변경을 되돌린다(보관본은 남는다). 되돌렸다는 알림을 받으면 파일을 다시 읽는다.',
    '사용자에게 보이는 글은 한국어로 쓴다.',
  ].join('\n');
}

/** 내장 도구마다 경로가 들어 있는 입력 필드. 여기에 없는 내장 도구는 거절한다 */
const PATH_FIELDS: Readonly<Record<string, { required: readonly string[]; optional: readonly string[]; patterns: readonly string[] }>> = {
  Read: { required: ['file_path'], optional: [], patterns: [] },
  Edit: { required: ['file_path'], optional: [], patterns: [] },
  Write: { required: ['file_path'], optional: [], patterns: [] },
  Glob: { required: [], optional: ['path'], patterns: ['pattern'] },
  Grep: { required: [], optional: ['path'], patterns: ['glob'] },
};

/**
 * CLI가 도구를 쓰기 직전에 부른다(PreToolUse 훅). 거절할 이유를 돌려주고, 통과면 undefined다.
 * b-studio 도구(MCP)는 자기 정책이 있어 그대로 둔다. 내장 도구는 경로가 Workspace의 규칙을 지날 때만 통과시킨다.
 */
export async function guardBuiltinTool(workspace: Workspace, toolName: unknown, toolInput: unknown): Promise<string | undefined> {
  if (typeof toolName !== 'string') return '도구 이름을 읽지 못했습니다';
  if (toolName.startsWith(`mcp__${SERVER}__`)) return undefined;
  const fields = PATH_FIELDS[toolName];
  if (!fields) return `${toolName}: 이 세션에서 쓸 수 없는 도구입니다`;
  const input = typeof toolInput === 'object' && toolInput !== null ? (toolInput as Record<string, unknown>) : {};
  const realRoot = await realpath(workspace.root).catch(() => workspace.root);
  for (const field of [...fields.required, ...fields.optional]) {
    const value = input[field];
    if (value === undefined || value === null || value === '') {
      if (fields.required.includes(field)) return `${toolName}: ${field}가 없습니다`;
      continue;
    }
    if (typeof value !== 'string') return `${toolName}: ${field}를 읽지 못했습니다`;
    // 이 검사와 CLI가 같은 글자를 다른 경로로 읽으면 검사가 뜻이 없다. 그래서 풀이가 갈릴 수 있는 꼴은 받지 않는다:
    // 상대 경로와 "~"(CLI가 홈 폴더로 풀 수 있다), 정리되지 않은 경로("..", ".", 겹친 "/" — 글자로 정리한 결과와
    // 운영체제가 링크를 따라가며 푼 결과가 다르다). CLI의 파일 도구는 절대 경로를 쓰게 되어 있다
    if (!isCanonicalAbsolute(value)) return `${toolName}: ${value}는 받지 않습니다. 정리된 절대 경로만 쓸 수 있습니다`;
    const relative = relativeToRoot(value, workspace.root, realRoot);
    if (relative === undefined) return `${toolName}: ${value}는 프로젝트 밖 경로입니다`;
    // 프로젝트 루트 자체는 찾기 도구(Glob·Grep)의 시작점으로만 받는다
    if (relative === '') {
      if (fields.required.includes(field)) return `${toolName}: 프로젝트 루트 자체는 다룰 수 없습니다`;
      continue;
    }
    try {
      await workspace.assertToolPath(relative);
    } catch (error) {
      return `${toolName}: ${error instanceof WorkspaceError ? error.message : `${value}를 확인하지 못했습니다`}`;
    }
  }
  for (const field of fields.patterns) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !isConfinedPattern(value)) return `${toolName}: ${field}는 프로젝트 안의 상대 패턴만 쓸 수 있습니다`;
  }
  return undefined;
}

/** 쓰기 도구(내장 Edit·Write)의 대상 경로 필드 */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write']);

/**
 * 쓰기 직전의 훅이 통과시킨 파일 쓰기 도구의 대상 보호 경로 파일을 고정한다(Workspace.pinBeforeWrite, 이슈 #992).
 * guardBuiltinTool이 통과시킨 뒤에만 부른다. 고정하지 못해도 쓰기는 막지 않는다(그 파일은 바뀐 것으로 남는다)
 */
export async function pinBuiltinWrite(workspace: Workspace, toolName: unknown, toolInput: unknown): Promise<void> {
  if (typeof toolName !== 'string' || !WRITE_TOOLS.has(toolName)) return;
  const value = typeof toolInput === 'object' && toolInput !== null ? (toolInput as Record<string, unknown>).file_path : undefined;
  if (typeof value !== 'string' || !isCanonicalAbsolute(value)) return;
  const relative = relativeToRoot(value, workspace.root, await realpath(workspace.root).catch(() => workspace.root));
  if (relative === undefined || relative === '') return;
  await workspace.pinBeforeWrite(relative);
}

/** 다르게 풀릴 여지가 없는 절대 경로인가: 절대 경로이고, 정리해도 그대로이고, 끝에 구분자가 없다 */
function isCanonicalAbsolute(file: string): boolean {
  if (file.includes('\0') || !path.isAbsolute(file)) return false;
  return path.normalize(file) === file && (file === path.sep || !file.endsWith(path.sep));
}

/**
 * 찾기 패턴이 프로젝트 밖을 가리킬 수 없는가. 패턴은 시작 경로(검사한 경로나 작업 폴더)에 붙어 풀리므로,
 * 절대 경로·홈 폴더로 시작하거나 위로 올라가는 조각이 있으면 안 된다. 중괄호는 갈래마다 따로 풀리므로("{/etc,x}")
 * 갈래의 시작도 패턴의 시작과 똑같이 본다.
 */
function isConfinedPattern(pattern: string): boolean {
  if (pattern.includes('\0')) return false;
  if (/(^|[{,])\s*[\\/~]/.test(pattern)) return false;
  return !pattern.split(/[\\/{},]/).some((segment) => segment.trim() === '..');
}

/** 프로젝트 루트(또는 그 실제 위치) 아래의 절대 경로면 루트 기준 상대 경로로, 아니면 undefined */
function relativeToRoot(file: string, root: string, realRoot: string): string | undefined {
  for (const base of [root, realRoot]) {
    const relative = path.relative(base, file);
    if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) return relative;
  }
  return undefined;
}
