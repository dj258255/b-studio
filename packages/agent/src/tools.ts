import type Anthropic from '@anthropic-ai/sdk';
import type { Sandbox } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { summarizeContract } from './contract-diff';
import { servicesForFiles } from './services';
import type { ContractFetcher } from './verify';
import type { Workspace } from './workspace';

type BetaTool = Anthropic.Beta.BetaTool;

const MAX_OUTPUT_CHARS = 30_000;
const COMMAND_TIMEOUT_MS = 180_000;
const HTTP_TIMEOUT_MS = 30_000;

export interface ToolContext {
  project: LoadedProject;
  workspace: Workspace;
  sandbox: Sandbox;
  fetcher: ContractFetcher;
  signal?: AbortSignal;
}

export interface ToolOutcome {
  ok: boolean;
  content: string;
}

/**
 * 에이전트 도구 목록. 프로젝트마다 고정이라 프롬프트 캐시를 깨지 않는다.
 * bash 하나로 뭉치지 않고 행동별 도구로 나눈 이유:
 *  - 파일 쓰기는 작업 공간 규칙(경로 제한, 덮어쓰기 충돌)을 강제해야 한다
 *  - 바뀐 파일을 기록해야 검증 게이트가 재시작할 서비스를 고를 수 있다
 * strict 모드는 선택 필드가 없는 스키마에서 가장 안전하므로 모든 필드를 필수로 둔다.
 */
export function buildTools(project: LoadedProject): BetaTool[] {
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
    tool('run_in_service', 'Run a command inside a service container (working directory is the service root). Times out after 3 minutes; do not start long-running servers.', {
      service,
      command: { type: 'array', items: { type: 'string' }, description: 'Program and arguments, e.g. ["./gradlew", "test"]. No shell expansion.' },
    }),
    tool('restart_service', 'Rebuild and restart a service, then wait until it is ready.', { service }),
    tool('service_logs', 'Show recent log lines of a service.', {
      service,
      lines: { type: 'integer', description: 'Number of recent lines (1-400).' },
    }),
    tool('http_request', 'Send an HTTP request to a running service.', {
      service,
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      path: { type: 'string', description: 'Path starting with "/", including any query string.' },
      body: { type: 'string', description: 'JSON request body, or an empty string for none.' },
    }),
  ];

  if (contractServices.length > 0) {
    tools.push(
      tool('get_contract', "Summarize the service's current OpenAPI contract (operations and schemas), extracted from the running server.", {
        service: { type: 'string', enum: contractServices, description: 'Service that exposes an OpenAPI contract' },
      }),
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
  const { workspace, sandbox, signal } = context;
  try {
    const args = asRecord(input);
    switch (name) {
      case 'list_files': {
        const entries = await workspace.list(string(args, 'path'), clamp(integer(args, 'depth'), 1, 6));
        return success(entries.length > 0 ? entries.join('\n') : '(empty)');
      }
      case 'read_file':
        return success(truncate(await workspace.read(string(args, 'path'))));
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
      case 'run_in_service': {
        const result = await sandbox.exec(serviceName(context, args), stringArray(args, 'command'), {
          signal: withTimeout(signal, COMMAND_TIMEOUT_MS),
        });
        const output = `exit code ${result.exitCode}\n--- stdout\n${truncate(result.stdout)}\n--- stderr\n${truncate(result.stderr)}`;
        return { ok: result.exitCode === 0, content: output };
      }
      case 'restart_service': {
        const target = serviceName(context, args);
        try {
          // 방금 쓴 파일을 샌드박스가 보기 전에 재시작하면 옛 코드가 빌드된다
          const owned = workspace.changedFiles().filter((file) => servicesForFiles(context.project, [file]).services[0] === target);
          await sandbox.sync(owned, { signal });
          const endpoint = await sandbox.restart(target, { signal });
          return success(`${target} is ready at ${endpoint.url}`);
        } catch (error) {
          return failure(`${describe(error)}\n--- recent logs\n${await tailLogs(sandbox, target, 60)}`);
        }
      }
      case 'service_logs': {
        const target = serviceName(context, args);
        return success(await tailLogs(sandbox, target, clamp(integer(args, 'lines'), 1, 400)));
      }
      case 'http_request':
        return await httpRequest(context, args);
      case 'get_contract': {
        const target = serviceName(context, args);
        const contract = context.project.managed.find(([serviceKey]) => serviceKey === target)?.[1].contract;
        if (!contract) return failure(`${target} does not expose a contract`);
        const endpoint = await sandbox.endpoint(target);
        return success(summarizeContract(await context.fetcher(new URL(contract.extract, endpoint.url).toString())));
      }
      default:
        return failure(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return failure(describe(error));
  }
}

async function httpRequest(context: ToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const target = serviceName(context, args);
  const method = string(args, 'method');
  const requestPath = string(args, 'path');
  if (!requestPath.startsWith('/')) return failure('path must start with "/"');
  const body = string(args, 'body');

  const endpoint = await context.sandbox.endpoint(target);
  const response = await fetch(new URL(requestPath, endpoint.url), {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body || undefined,
    redirect: 'manual',
    signal: withTimeout(context.signal, HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? 'unknown';
  // 4xx/5xx도 요청 자체는 수행됐으므로 정상 결과로 돌려주고 판단은 모델에게 맡긴다
  return success(`HTTP ${response.status}\ncontent-type: ${contentType}\n\n${truncate(text)}`);
}

async function tailLogs(sandbox: Sandbox, service: string, lines: number): Promise<string> {
  const collected: string[] = [];
  for await (const line of sandbox.logs({ services: [service], tail: lines, follow: false })) collected.push(line.text);
  return collected.length > 0 ? truncate(collected.join('\n')) : '(no logs)';
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

/** 잘라낸 사실을 숨기지 않고 표시한다 */
function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.8);
  const tail = max - head;
  return `${text.slice(0, head)}\n[... ${text.length - max} characters truncated ...]\n${text.slice(-tail)}`;
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
