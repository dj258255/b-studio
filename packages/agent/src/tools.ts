import type Anthropic from '@anthropic-ai/sdk';
import { describeUsage, type Sandbox, type StartOptions } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { summarizeContract } from './contract-diff';
import type { DesignSource } from './design';
import { checkToolPolicy, type ApprovalRequest, type ExecutionPolicy, type PolicyDecision } from './policy';
import { servicesForFiles } from './services';
import {
  clipCommandOutput,
  clipText,
  createToolResultCache,
  dedupeResult,
  HTTP_BODY_BUDGET,
  invalidateReadCache,
  isHtmlContent,
  LOGS_OUTPUT_LIMIT,
  READ_FILE_BUDGET,
  visibleHtml,
  type ToolResultCache,
} from './tool-output';
import type { ContractFetcher } from './verify';
import type { Workspace } from './workspace';

type BetaTool = Anthropic.Beta.BetaTool;

const COMMAND_TIMEOUT_MS = 180_000;
const HTTP_TIMEOUT_MS = 30_000;

export interface ToolContext {
  project: LoadedProject;
  workspace: Workspace;
  sandbox: Sandbox;
  fetcher: ContractFetcher;
  signal?: AbortSignal;
  /** 재시작 중 서비스 상태(바뀐 포트 포함)를 밖으로 알린다 */
  onServiceStatus?: StartOptions['onStatus'];
  /** 질문 모드. 파일을 바꾸거나 명령을 실행하는 도구와 조회가 아닌 HTTP 호출을 거부한다 */
  readOnly?: boolean;
  /** Figma 디자인 자료원. 세션이 디자인을 설정했을 때만 넘어온다. 없으면 디자인 도구가 목록에 없다 */
  design?: DesignSource;
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
}

/** 질문 모드에서 거부하는 도구 */
const CHANGING_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'run_in_service', 'restart_service']);
/** 성공하면 읽기 캐시를 비우는 쓰기 도구. 같은 경로를 다시 읽으면 내용이 달라졌을 수 있다 */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);
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
 * design을 넘기면(세션이 Figma 디자인을 설정했을 때) 디자인 도구를 더하고, 아니면 목록이 지금과 같다
 */
export function buildTools(project: LoadedProject, options: { design?: boolean } = {}): BetaTool[] {
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
      return { ok: result.exitCode === 0, content: clipCommandOutput(raw), rawChars: raw.length };
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

function stringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string')) {
    throw new ToolInputError(`"${key}" must be a non-empty array of strings`);
  }
  return value;
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
