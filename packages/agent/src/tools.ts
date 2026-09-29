import type Anthropic from '@anthropic-ai/sdk';
import { describeUsage, type Sandbox, type StartOptions } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { summarizeContract } from './contract-diff';
import type { Note, NoteKind } from './coordination';
import type { DesignSource } from './design';
import { checkToolPolicy, type ApprovalRequest, type ExecutionPolicy, type PolicyDecision } from './policy';
import { servicesForFiles } from './services';
import {
  clipCommandOutput,
  clipText,
  COMMAND_OUTPUT_BUDGET,
  createToolResultCache,
  dedupeResult,
  HTTP_BODY_BUDGET,
  invalidateReadCache,
  isHtmlContent,
  LEAN_SUCCESS_OUTPUT_BUDGET,
  LOGS_OUTPUT_LIMIT,
  READ_FILE_BUDGET,
  visibleHtml,
  type SelfCheckMode,
  type ToolResultCache,
} from './tool-output';
import type { ContractFetcher } from './verify';
import type { Workspace } from './workspace';

type BetaTool = Anthropic.Beta.BetaTool;

const COMMAND_TIMEOUT_MS = 180_000;
const HTTP_TIMEOUT_MS = 30_000;
/** ask_user: 질문 문장 길이와 선택지 개수·길이 상한. 좁게 잡아 화면 카드가 깨지지 않게 한다 */
const ASK_QUESTION_MAX = 300;
const ASK_OPTION_MAX = 80;
const ASK_OPTIONS_MIN = 2;
const ASK_OPTIONS_MAX = 4;

/** ask_user 도구가 남기는 질문. 러너는 이걸 보고 실행을 끝내 사용자 답을 다음 요청으로 받는다 */
export interface AskUserQuestion {
  question: string;
  options: string[];
  /** 직접 입력도 허용하는지 */
  allowOther: boolean;
  /**
   * propose_mode가 남긴 제안(ADR-068). 있으면 첫 선택지가 "이 방식으로 넘기기"이고, 화면은 그 요청으로 비교·계획을 만든다.
   * 두 번째 선택지("한 명으로 계속")는 보통 답처럼 대화를 이어 간다
   */
  proposal?: ModeProposal;
}

/** 에이전트가 제안하는 다른 방식. split=나눠서 병렬, fleet=여러 명 비교 */
export interface ModeProposal {
  mode: 'split' | 'fleet';
  /** 비교·계획에 넘길 요청(사용자 요청을 그대로 또는 다듬어서) */
  request: string;
}

/** propose_mode 선택지. 화면이 첫 선택지를 "넘기기" 버튼으로 그린다 */
export const PROPOSAL_OPTIONS: Record<ModeProposal['mode'], readonly [string, string]> = {
  split: ['나눠서 병렬로 하기', '한 명으로 계속'],
  fleet: ['여러 안 비교하기', '한 명으로 계속'],
};
/** 넘길 요청 길이 상한 */
const PROPOSAL_REQUEST_MAX = 2_000;

/** buildTools 옵션. interactive가 아니면(레인·벤치·CLI) 도구 목록이 지금과 같다 */
export interface ToolBuildOptions {
  /** 주면 조율 도구 두 개(post_note·read_notes)를 더한다. 없으면 도구 목록이 지금과 같다(기본값: 공유 없음) */
  board?: BoardAccess;
  /**
   * 프로젝트가 허용 도구 목록을 정했으면 조율 도구도 그 목록에 있어야 한다(기존 규칙 그대로).
   * 목록에 없으면 도구를 아예 넣지 않는다 — 모델이 막히는 도구를 보지 않게.
   */
  allowedTools?: readonly string[];
  /** 세션이 Figma 디자인을 설정했을 때 디자인 도구를 더한다 */
  design?: boolean;
  /** 단일 세션의 사용자 요청일 때만 ask_user를 더한다 */
  interactive?: boolean;
}

/**
 * 조율 게시판을 레인 신원으로 감싼 것. Board를 직접 넘기지 않고 도구가 쓸 수 있는 두 동작만 노출한다.
 * 어떤 레인으로 쓰고 읽는지는 실행기가 정하고 모델은 바꿀 수 없다.
 */
export interface BoardAccess {
  post(input: { kind: NoteKind; body: string; refs?: string[] }): { ok: true; note: Note } | { ok: false; reason: string };
  read(options: { kinds?: readonly NoteKind[] }): { notes: Note[]; truncated: boolean; reason?: string };
  lane: string;
  task?: string;
  /** false면 모델은 읽기만 한다(기본 true). buildTools가 post_note를 목록에서 뺀다 */
  modelWrites?: boolean;
}

export interface ToolBuildOptions {
  /** 주면 조율 도구 두 개(post_note·read_notes)를 더한다. 없으면 도구 목록이 지금과 같다(기본값: 공유 없음) */
  board?: BoardAccess;
  /**
   * 프로젝트가 허용 도구 목록을 정했으면 조율 도구도 그 목록에 있어야 한다(기존 규칙 그대로).
   * 목록에 없으면 도구를 아예 넣지 않는다 — 모델이 막히는 도구를 보지 않게.
   */
  allowedTools?: readonly string[];
  /** 세션이 디자인(Figma)을 설정했을 때만 디자인 도구 두 개(design_frames·design_frame)를 더한다 */
  design?: boolean;
}

export interface ToolContext {
  project: LoadedProject;
  workspace: Workspace;
  sandbox: Sandbox;
  fetcher: ContractFetcher;
  signal?: AbortSignal;
  /** 조율 게시판. 있을 때만 조율 도구가 목록에 오른다 */
  board?: BoardAccess;
  /** 재시작 중 서비스 상태(바뀐 포트 포함)를 밖으로 알린다 */
  onServiceStatus?: StartOptions['onStatus'];
  /** 질문 모드. 파일을 바꾸거나 명령을 실행하는 도구와 조회가 아닌 HTTP 호출을 거부한다 */
  readOnly?: boolean;
  /** Figma 디자인 자료원. 세션이 디자인을 설정했을 때만 넘어온다. 없으면 디자인 도구가 목록에 없다 */
  design?: DesignSource;
  /** ask_user가 남긴 질문. 러너가 이걸 받으면 실행을 끝내고 사용자 답을 기다린다. 없으면 ask_user가 목록에 없다 */
  onQuestion?: (question: AskUserQuestion) => void;
  /** 모델이 호출한 도구를 실행기에서 먼저 검사한다 */
  policy?: ExecutionPolicy;
  /** 승인 흐름에서 발급한 일회성 토큰. 토큰 값은 로그에 기록하지 않는다 */
  approvalToken?: string;
  /** UI나 CLI가 사람의 승인을 연결할 수 있는 선택적 훅 */
  requestApproval?: (request: ApprovalRequest) => Promise<boolean>;
  /** 허용·차단 결정을 구조화해 감사 로그에 남긴다 */
  onPolicyDecision?: (decision: PolicyDecision) => void;
  /**
   * 실행 단위 도구 결과 캐시. 러너가 실행(runAgent 한 번)마다 새로 만들어 넘긴다.
   * 같은 도구·같은 입력의 결과가 앞과 완전히 같으면 본문 대신 참조를 돌려 결과 글자를 줄인다.
   * 넘기지 않으면 executeTool이 이 컨텍스트에 하나 만들어 쓴다(러너가 컨텍스트를 실행 내내 재사용할 때).
   */
  toolResults?: ToolResultCache;
  /**
   * 샌드박스가 필요한 도구(SANDBOX_TOOLS)를 처음 실행하기 직전에 부른다. 세션을 지연 기동할 때만 넘긴다.
   * 없으면 이미 켜져 있다고 보고 그냥 실행한다(레인·플릿·벤치·CLI 경로).
   */
  ensureSandbox?: () => Promise<void>;
  /** 자가 확인 범위(기본 full). lean이면 성공한 run_in_service 출력을 LEAN_SUCCESS_OUTPUT_BUDGET으로 줄인다 */
  selfCheck?: SelfCheckMode;
}

/** 질문 모드에서 거부하는 도구. 게시판에 쓰는 post_note도 상태를 바꾸므로 포함한다(읽기 read_notes는 허용) */
const CHANGING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'run_in_service', 'restart_service', 'post_note']);
/** 성공하면 읽기 캐시를 비우는 쓰기 도구. 같은 경로를 다시 읽으면 내용이 달라졌을 수 있다 */
export const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);

/**
 * 샌드박스(컨테이너)가 있어야 실행되는 도구. 세션을 지연 기동하는 경우, 이 도구를 처음 부를 때 샌드박스를 켠다
 * (executeTool의 `ensureSandbox`). 새 도구를 더할 때 분류를 빠뜨리지 않도록 tools.test.ts가 모든 도구가
 * SANDBOX_TOOLS나 LOCAL_TOOLS 중 하나에 들어 있는지 확인한다.
 */
export const SANDBOX_TOOLS: ReadonlySet<string> = new Set([
  'run_in_service',
  'restart_service',
  'service_logs',
  'service_stats',
  'http_request',
  'call_external_api',
  'get_contract',
]);

/** 샌드박스 없이 작업 공간·게시판·디자인·되묻기만 다루는 도구. 샌드박스를 켜지 않는다 */
export const LOCAL_TOOLS: ReadonlySet<string> = new Set([
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'delete_file',
  'post_note',
  'read_notes',
  'design_frames',
  'design_frame',
  'ask_user',
  'propose_mode',
]);
const READ_METHODS = new Set(['GET', 'HEAD']);
const READ_ONLY_TOOL = 'Question mode is read-only, so this tool is disabled. Describe the change as a plan instead; the user can approve it with "이대로 만들기".';
const READ_ONLY_METHOD = 'Question mode allows only GET and HEAD requests. Describe the change as a plan instead.';

export interface ToolOutcome {
  ok: boolean;
  content: string;
  /** 자르기 전 결과 글자 수. 잘랐을 때만 넣는다(안 넣으면 content 길이와 같다). 토큰 탭의 "원래 글자"에 쓴다 */
  rawChars?: number;
}

/**
 * 에이전트 도구 목록. 프로젝트마다 고정이라 프롬프트 캐시를 깨지 않는다.
 * bash 하나로 뭉치지 않고 행동별 도구로 나눈 이유:
 *  - 파일 쓰기는 작업 공간 규칙(경로 제한, 덮어쓰기 충돌)을 강제해야 한다
 *  - 바뀐 파일을 기록해야 검증 게이트가 재시작할 서비스를 고를 수 있다
 * strict 모드는 선택 필드가 없는 스키마에서 가장 안전하므로 모든 필드를 필수로 둔다.
 * design을 넘기면(세션이 Figma 디자인을 설정했을 때) 디자인 도구를 더하고, 아니면 목록이 지금과 같다.
 * interactive를 넘기면(단일 세션의 사용자 요청일 때) ask_user를 더한다. 레인·벤치·CLI는 넘기지 않아 목록이 그대로다
 */
export function buildTools(project: LoadedProject, options: ToolBuildOptions = {}): BetaTool[] {
  const services = project.managed.map(([name]) => name);
  const contractServices = project.managed.filter(([, service]) => service.contract).map(([name]) => name);
  const service = { type: 'string', enum: services, description: 'Managed service name' };

  const tools = [
    tool('list_files', 'List files and directories under a project directory. Generated directories and secrets are hidden.', {
      path: { type: 'string', description: 'Directory relative to the project root. Use "." for the root.' },
      depth: { type: 'integer', description: 'How many directory levels to descend (1-6).' },
    }),
    tool('read_file', 'Read a UTF-8 text file from the project.', {
      path: { type: 'string', description: 'File path relative to the project root.' },
    }),
    tool('write_file', 'Create or overwrite a file. Parent directories are created.', {
      path: { type: 'string', description: 'File path relative to the project root.' },
      content: { type: 'string', description: 'Full file content.' },
    }),
    tool('edit_file', 'Replace one exact, unique occurrence of old_text with new_text in a file.', {
      path: { type: 'string', description: 'File path relative to the project root.' },
      old_text: { type: 'string', description: 'Exact text to replace. Must appear exactly once; include surrounding lines if needed.' },
      new_text: { type: 'string', description: 'Replacement text.' },
    }),
    tool('delete_file', 'Delete a file from the project. Use it only when the request asks for the file to be removed.', {
      path: { type: 'string', description: 'Project-relative file path' },
    }),
    tool('run_in_service', 'Run a command inside a service container (working directory is the service root). Times out after 3 minutes; do not start long-running servers.', {
      service,
      command: { type: 'array', items: { type: 'string' }, description: 'Program and arguments, e.g. ["./gradlew", "test"]. No shell expansion.' },
    }),
    tool('restart_service', 'Rebuild and restart a service, then wait until it is ready.', { service }),
    tool('service_logs', 'Show recent log lines of a service.', {
      service,
      lines: { type: 'integer', description: 'Number of recent lines (1-400).' },
    }),
    tool(
      'service_stats',
      'Show CPU and memory usage, limits, and exit status of every container in the sandbox, including supporting services such as the database. Exit code 137 or "memory limit exceeded" means the container ran out of memory.',
      {},
    ),
    tool('http_request', 'Send an HTTP request to a running service.', {
      service,
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      path: { type: 'string', description: 'Path starting with "/", including any query string.' },
      body: { type: 'string', description: 'JSON request body, or an empty string for none.' },
    }),
  ];

  const apis = (project.external ?? []).map(([name]) => name);
  if (apis.length > 0) {
    tools.push(
      tool(
        'call_external_api',
        'Call a registered internal API through the b-studio policy proxy. The same access rules, authentication, and response masking apply as when service code calls http://<api>/.',
        {
          api: { type: 'string', enum: apis, description: 'Registered API name' },
          method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] },
          path: { type: 'string', description: 'Path starting with "/", including any query string.' },
          body: { type: 'string', description: 'JSON request body, or an empty string for none.' },
        },
      ),
    );
  }

  if (contractServices.length > 0) {
    tools.push(
      tool('get_contract', "Summarize the service's current OpenAPI contract (operations and schemas), extracted from the running server.", {
        service: { type: 'string', enum: contractServices, description: 'Service that exposes an OpenAPI contract' },
      }),
    );
  }

  // 조율 도구는 조율을 켠 실행(board가 있는 실행)에만 넣는다. 기본값은 공유 없음이라 목록이 지금과 같다.
  // 허용 도구 목록이 있는 프로젝트에서 그 목록에 없으면 넣지 않아, 모델이 막힐 도구를 보지 않게 한다.
  if (options.board) {
    const isAllowed = (name: string) => !options.allowedTools || options.allowedTools.includes(name);
    // S2·S5처럼 읽기만 하는 전략(board.modelWrites === false)에서는 post_note를 넣지 않는다
    if (isAllowed('post_note') && options.board.modelWrites !== false) {
      tools.push(
        tool(
          'post_note',
          'Post a short note to the coordination board shared by parallel lanes: interface contracts (refs required) and environment facts. Verification failures are written by the platform, not by the model, so failure is not offered here.',
          {
            kind: { type: 'string', enum: ['contract', 'fact'], description: 'Note kind. Send "contract" for interface agreements, "fact" for environment facts.' },
            body: { type: 'string', description: 'Short note body (up to 2048 bytes). Do not paste diffs or reasoning.' },
            refs: { type: 'array', items: { type: 'string' }, description: 'File paths or checkpoint references. contract notes need at least one; send [] when there is nothing to point at.' },
          },
        ),
      );
    }
    if (isAllowed('read_notes')) {
      tools.push(
        tool('read_notes', 'Read notes posted by other lanes on the coordination board. Notes come back newest first, ordered by priority (failure > contract > fact).', {
          kinds: { type: 'array', items: { type: 'string', enum: ['contract', 'failure', 'fact'] }, description: 'Kinds to read. Send [] to read every kind.' },
        }),
      );
    }
  }
  if (options.design) {
    tools.push(
      tool('design_frames', 'List the Figma design frames (page, id, name, size). Use an id with design_frame.', {}),
      tool(
        'design_frame',
        'Summarize a Figma frame: structure, auto layout, colors, corner radius, and text styles. Saves the frame PNG as an artifact and returns only its reference path; the image itself is not sent to the model.',
        { id: { type: 'string', description: 'Frame id from design_frames.' } },
      ),
    );
  }

  if (options.interactive) {
    tools.push(
      tool(
        'ask_user',
        'Ask the user to choose before building, only when the request is ambiguous and the result would change a lot. Ask once, before making changes. Do not ask when a reasonable guess is enough. Calling this ends the run; the user answers with a follow-up request that continues this conversation.',
        {
          question: { type: 'string', description: `One short question (max ${ASK_QUESTION_MAX} characters).` },
          options: { type: 'array', items: { type: 'string' }, description: `Two to four short choices (each max ${ASK_OPTION_MAX} characters).` },
          allowOther: { type: 'boolean', description: 'true to also let the user type a free-form answer.' },
        },
      ),
      tool(
        'propose_mode',
        'Offer to hand this request to several agents instead of doing it alone. Use rarely, before making changes: "split" when the work clearly divides into independent parts in different services that can be built at the same time (for example an API and a page that only share a contract); "fleet" when the user asks for alternatives or the right design is genuinely open and comparing two or three independent attempts is worth the extra cost. Most requests should simply be done yourself. Calling this ends the run; the user either accepts (the studio starts the split or comparison) or answers "continue alone" in a follow-up request.',
        {
          mode: { type: 'string', enum: ['split', 'fleet'], description: 'split = divide into parallel lanes; fleet = compare independent attempts.' },
          reason: { type: 'string', description: `One short sentence in the user's language explaining why (max ${ASK_QUESTION_MAX} characters).` },
          request: { type: 'string', description: `The request to hand over, in the user's language (max ${PROPOSAL_REQUEST_MAX} characters). Usually the user's request as is.` },
        },
      ),
    );
  }
  return tools;
}

function tool(name: string, description: string, properties: Record<string, unknown>): BetaTool {
  return {
    name,
    description,
    strict: true,
    input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  };
}

export async function executeTool(name: string, input: unknown, context: ToolContext): Promise<ToolOutcome> {
  try {
    // 질문 모드의 제한도 실행기에서 강제하고 감사 로그에 한 번만 남긴다
    if (context.readOnly && CHANGING_TOOLS.has(name)) {
      const denied = { tool: name, decision: 'deny' as const, reason: 'question mode is read-only' };
      context.onPolicyDecision?.(denied);
      return failure(READ_ONLY_TOOL);
    }
    const decision = checkToolPolicy(name, input, context.policy, context.approvalToken);
    if (decision.decision === 'deny' && decision.reason?.includes('requires an explicit approval') && context.requestApproval) {
      const approved = await context.requestApproval({ tool: name, summary: summarizeApproval(name, input) });
      if (!approved) {
        const denied = { tool: name, decision: 'deny' as const, reason: 'approval was not granted' };
        context.onPolicyDecision?.(denied);
        return failure(`blocked by execution policy: ${denied.reason}`);
      }
      context.onPolicyDecision?.({ tool: name, decision: 'allow', reason: 'approval was granted' });
    } else if (decision.decision === 'deny') {
      context.onPolicyDecision?.(decision);
      return failure(`blocked by execution policy: ${decision.reason}`);
    } else {
      context.onPolicyDecision?.(decision);
    }
    const args = asRecord(input);
    // 샌드박스가 필요한 도구의 첫 호출이면 여기서 켠다(켜는 동안 기다린다). 없으면 그냥 실행한다
    if (context.ensureSandbox && SANDBOX_TOOLS.has(name)) await context.ensureSandbox();
    const outcome = await runTool(name, args, context);
    // 같은 도구·같은 입력의 결과가 앞과 완전히 같으면 본문을 참조로 바꾼다(실행 단위). 모든 러너가 이 한 곳을 지나간다
    const cache = (context.toolResults ??= createToolResultCache());
    if (outcome.ok && WRITE_TOOLS.has(name)) invalidateReadCache(cache);
    // rawChars는 도구가 잘랐을 때만 넣는다. 러너가 이벤트로 보낼 때 content 길이로 채운다
    const content = dedupeResult(cache, name, input, outcome.content);
    return content === outcome.content ? outcome : { ...outcome, content };
  } catch (error) {
    return failure(describe(error));
  }
}

/** 도구별 실행. 예산 자르기와 반복 대체 같은 공통 처리는 executeTool이 맡는다 */
async function runTool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolOutcome> {
  const { workspace, sandbox, signal } = context;
  switch (name) {
    case 'list_files': {
      const entries = await workspace.list(string(args, 'path'), clamp(integer(args, 'depth'), 1, 6));
      return success(entries.length > 0 ? entries.join('\n') : '(empty)');
    }
    case 'read_file': {
      // 파일은 앞에서부터 읽는 경우가 많아 앞쪽 위주로 자른다
      const raw = sandbox.redact(await workspace.read(string(args, 'path')));
      return { ok: true, content: clipText(raw, READ_FILE_BUDGET), rawChars: raw.length };
    }
    case 'write_file': {
      const file = string(args, 'path');
      await workspace.write(file, string(args, 'content'));
      return success(`wrote ${file}`);
    }
    case 'edit_file': {
      const file = string(args, 'path');
      await workspace.edit(file, string(args, 'old_text'), string(args, 'new_text'));
      return success(`edited ${file}`);
    }
    case 'delete_file': {
      const file = string(args, 'path');
      await workspace.remove(file);
      return success(`deleted ${file}`);
    }
    case 'run_in_service': {
      const result = await sandbox.exec(serviceName(context, args), stringArray(args, 'command'), {
        signal: withTimeout(signal, COMMAND_TIMEOUT_MS),
      });
      // stdout과 stderr를 합쳐 한 예산으로 자른다. 테스트·빌드 로그의 실패 요약이 뒤에 있어 뒤쪽을 더 남긴다
      const raw = `exit code ${result.exitCode}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`;
      // lean이면 성공한 명령은 짧게 돌려준다. 실패는 원인을 봐야 하므로 기본 예산 그대로다
      const budget = context.selfCheck === 'lean' && result.exitCode === 0 ? LEAN_SUCCESS_OUTPUT_BUDGET : COMMAND_OUTPUT_BUDGET;
      return { ok: result.exitCode === 0, content: clipCommandOutput(raw, budget), rawChars: raw.length };
    }
    case 'restart_service': {
      const target = serviceName(context, args);
      try {
        // 방금 쓴 파일을 샌드박스가 보기 전에 재시작하면 옛 코드가 빌드된다
        const owned = workspace.changedFiles().filter((file) => servicesForFiles(context.project, [file]).services[0] === target);
        await sandbox.sync(owned, { signal });
        const endpoint = await sandbox.restart(target, { signal, onStatus: context.onServiceStatus });
        return success(`${target} is ready at ${endpoint.url}`);
      } catch (error) {
        return failure(`${describe(error)}\n--- recent logs\n${clipText(await tailLogs(sandbox, target, 60), LOGS_OUTPUT_LIMIT)}`);
      }
    }
    case 'service_logs': {
      const target = serviceName(context, args);
      // 줄 수 상한(1-400)은 그대로 두고 글자 상한만 지금 값을 유지한다
      const raw = await tailLogs(sandbox, target, clamp(integer(args, 'lines'), 1, 400));
      return { ok: true, content: clipText(raw, LOGS_OUTPUT_LIMIT), rawChars: raw.length };
    }
    case 'service_stats': {
      const usage = await sandbox.stats();
      return success(usage.length > 0 ? usage.map(describeUsage).join('\n') : '(no containers)');
    }
    case 'http_request':
      return await httpRequest(context, args);
    case 'call_external_api': {
      const api = string(args, 'api');
      if (!(context.project.external ?? []).some(([name]) => name === api)) throw new ToolInputError(`Unknown API: ${api}`);
      if (context.readOnly && !READ_METHODS.has(string(args, 'method'))) return failure(READ_ONLY_METHOD);
      const body = string(args, 'body');
      const result = await sandbox.callExternal(
        api,
        { method: string(args, 'method'), path: string(args, 'path'), body: body || undefined },
        { via: 'agent', signal: withTimeout(signal, HTTP_TIMEOUT_MS) },
      );
      const policy =
        result.decision === 'deny'
          ? `blocked by b-studio policy: ${result.reason}`
          : result.masked > 0
            ? `${result.masked} field value(s) masked by b-studio policy`
            : 'allowed, nothing masked';
      const raw = context.sandbox.redact(result.body);
      return {
        ok: result.decision === 'allow',
        content: `HTTP ${result.status}\ncontent-type: ${result.contentType ?? 'unknown'}\npolicy: ${policy}\n\n${clipBody(raw, result.contentType ?? undefined)}`,
        rawChars: raw.length,
      };
    }
    case 'get_contract': {
      const target = serviceName(context, args);
      const contract = context.project.managed.find(([serviceKey]) => serviceKey === target)?.[1].contract;
      if (!contract) return failure(`${target} does not expose a contract`);
      const endpoint = await sandbox.endpoint(target);
      return success(sandbox.redact(summarizeContract(await context.fetcher(new URL(contract.extract, endpoint.url).toString()))));
    }
    case 'design_frames': {
      if (!context.design) return failure('Design is not configured for this session');
      const frames = await context.design.frames();
      return success(frames.length > 0 ? frames.map((frame) => `${frame.id}\t${frame.page}\t${frame.name}\t${frame.width}x${frame.height}`).join('\n') : '(no frames)');
    }
    case 'design_frame': {
      if (!context.design) return failure('Design is not configured for this session');
      const id = string(args, 'id');
      const frame = await context.design.frame(id);
      const artifact = await context.design.saveArtifact(`design ${id}`, frame.png);
      return success(`${frame.summary}\n\nframe PNG saved as artifact: ${artifact} (the image is not sent to the model)`);
    }
    case 'ask_user': {
      if (!context.onQuestion) return failure('This run cannot ask the user a question.');
      const question = string(args, 'question').trim();
      if (question.length === 0 || question.length > ASK_QUESTION_MAX) return failure(`"question" must be 1-${ASK_QUESTION_MAX} characters`);
      const options = stringArray(args, 'options').map((option) => option.trim());
      if (options.length < ASK_OPTIONS_MIN || options.length > ASK_OPTIONS_MAX) return failure(`"options" must have ${ASK_OPTIONS_MIN}-${ASK_OPTIONS_MAX} choices`);
      if (options.some((option) => option.length === 0 || option.length > ASK_OPTION_MAX)) return failure(`each option must be 1-${ASK_OPTION_MAX} characters`);
      if (new Set(options).size !== options.length) return failure('"options" must not repeat a choice');
      context.onQuestion({ question, options, allowOther: boolean(args, 'allowOther') });
      // 이 결과를 받은 모델이 곧바로 멈추도록, 도구가 끝났다는 사실과 멈추라는 지시를 함께 돌려준다
      return success('Question sent to the user. End this run now and wait for their answer; do not call any more tools.');
    }
    case 'propose_mode': {
      if (!context.onQuestion) return failure('This run cannot propose another mode.');
      const mode = string(args, 'mode');
      if (mode !== 'split' && mode !== 'fleet') return failure('"mode" must be "split" or "fleet"');
      const reason = string(args, 'reason').trim();
      if (reason.length === 0 || reason.length > ASK_QUESTION_MAX) return failure(`"reason" must be 1-${ASK_QUESTION_MAX} characters`);
      const request = string(args, 'request').trim();
      if (request.length === 0 || request.length > PROPOSAL_REQUEST_MAX) return failure(`"request" must be 1-${PROPOSAL_REQUEST_MAX} characters`);
      context.onQuestion({ question: reason, options: [...PROPOSAL_OPTIONS[mode]], allowOther: false, proposal: { mode, request } });
      return success('Proposal sent to the user. End this run now and wait for their choice; do not call any more tools.');
    }
    case 'post_note': {
      const board = context.board;
      if (!board) return failure('이 실행에는 조율 게시판이 없습니다');
      const result = board.post({ kind: asNoteKind(string(args, 'kind')), body: string(args, 'body'), refs: optionalStringArray(args, 'refs') });
      return result.ok ? success(`posted ${result.note.id} (${result.note.kind})`) : failure(result.reason);
    }
    case 'read_notes': {
      const board = context.board;
      if (!board) return failure('이 실행에는 조율 게시판이 없습니다');
      const kinds = asNoteKinds(optionalStringArray(args, 'kinds'));
      const { notes, truncated, reason } = board.read({ kinds: kinds.length > 0 ? kinds : undefined });
      const lines = notes.map(formatNote);
      if (truncated) lines.push(`[... ${reason ?? '읽기 상한으로 일부만 돌려줬습니다'} ...]`);
      return success(lines.length > 0 ? lines.join('\n') : '(no notes)');
    }
    default:
      return failure(`Unknown tool: ${name}`);
  }
}

function summarizeApproval(name: string, input: unknown): string {
  if (name === 'run_in_service' && typeof input === 'object' && input !== null) {
    const args = input as Record<string, unknown>;
    const service = typeof args.service === 'string' ? args.service : 'unknown service';
    const command = Array.isArray(args.command) ? args.command.filter((value): value is string => typeof value === 'string').join(' ') : '';
    return `run ${command} in ${service}`;
  }
  if ((name === 'write_file' || name === 'edit_file' || name === 'delete_file') && typeof input === 'object' && input !== null) {
    const file = (input as Record<string, unknown>).path;
    return `${name} ${typeof file === 'string' ? file : 'a file'}`;
  }
  return name;
}

async function httpRequest(context: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = serviceName(context, args);
  const method = string(args, 'method');
  if (context.readOnly && !READ_METHODS.has(method)) return failure(READ_ONLY_METHOD);
  const requestPath = string(args, 'path');
  if (!requestPath.startsWith('/')) return failure('path must start with "/"');
  const body = string(args, 'body');

  const endpoint = await context.sandbox.endpoint(target);
  const url = new URL(requestPath, endpoint.url);
  // "//other-host/..." 같은 경로는 URL 해석에서 호스트가 바뀐다. 서비스 밖으로 요청하지 못하게 막는다
  if (url.origin !== new URL(endpoint.url).origin) return failure('path must stay on the service host');
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body || undefined,
    redirect: 'manual',
    signal: withTimeout(context.signal, HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? 'unknown';
  // 서비스가 응답에 환경 변수 값을 그대로 담아 보낼 수 있다
  const raw = context.sandbox.redact(text);
  // 4xx/5xx도 요청 자체는 수행됐으므로 정상 결과로 돌려주고 판단은 모델에게 맡긴다
  return { ok: true, content: `HTTP ${response.status}\ncontent-type: ${contentType}\n\n${clipBody(raw, contentType)}`, rawChars: raw.length };
}

/** HTTP 응답 본문을 예산에 맞춘다. HTML이면 태그를 벗긴 "보이는 글자"를 기준으로 한다(개발 서버 HTML이 13,430자였다) */
function clipBody(body: string, contentType: string | undefined): string {
  return clipText(isHtmlContent(contentType, body) ? visibleHtml(body) : body, HTTP_BODY_BUDGET);
}

async function tailLogs(sandbox: Sandbox, service: string, lines: number): Promise<string> {
  const collected: string[] = [];
  for await (const line of sandbox.logs({ services: [service], tail: lines, follow: false })) collected.push(line.text);
  // 자르기는 부르는 쪽에서 예산에 맞춰 한다(service_logs·restart_service가 같은 값을 다른 상한으로 쓴다)
  return collected.length > 0 ? collected.join('\n') : '(no logs)';
}

function serviceName({ project }: ToolContext, args: Record<string, unknown>): string {
  const name = string(args, 'service');
  if (!project.managed.some(([serviceKey]) => serviceKey === name)) throw new ToolInputError(`Unknown service: ${name}`);
  return name;
}

class ToolInputError extends Error {}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new ToolInputError('Tool input must be an object');
  return input as Record<string, unknown>;
}

function string(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new ToolInputError(`"${key}" must be a string`);
  return value;
}

function integer(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new ToolInputError(`"${key}" must be an integer`);
  return value;
}

function boolean(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (typeof value !== 'boolean') throw new ToolInputError(`"${key}" must be a boolean`);
  return value;
}

function stringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string')) {
    throw new ToolInputError(`"${key}" must be a non-empty array of strings`);
  }
  return value;
}

/** 없으면 빈 배열. 조율 도구의 refs·kinds처럼 비어 있을 수 있는 배열에 쓴다 */
function optionalStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new ToolInputError(`"${key}" must be an array of strings`);
  return value;
}

const NOTE_KINDS: readonly NoteKind[] = ['contract', 'failure', 'fact'];

function asNoteKind(value: string): NoteKind {
  if (!(NOTE_KINDS as readonly string[]).includes(value)) throw new ToolInputError(`Unknown note kind: ${value}`);
  return value as NoteKind;
}

function asNoteKinds(values: string[]): NoteKind[] {
  return values.map(asNoteKind);
}

/** 읽은 메모를 짧은 텍스트로: `[kind·priority] 작성 레인: 본문 (refs)` */
function formatNote(note: Note): string {
  const refs = note.refs.length > 0 ? ` (${note.refs.join(', ')})` : '';
  return `[${note.kind}·${note.priority}] ${note.author.lane}: ${note.body}${refs}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function success(content: string): ToolOutcome {
  return { ok: true, content };
}

function failure(content: string): ToolOutcome {
  return { ok: false, content };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
