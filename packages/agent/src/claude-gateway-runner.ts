import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { describeAccount, serialQueue, type ClaudeCodeResult, type ClaudeCodeRunOptions } from './claude-code-runner';
import { fetchContract } from './verify';
import { recheckGateOnMaxTurns, VerificationGate, type GateOutcome } from './gate';
import { emptyUsage, type AgentResult, type AgentUsage, type RunMetrics } from './loop';
import { startToolServer, tokenMatches } from './mcp-http-server';
import { loadProjectGuide } from './project-guide';
import { projectGuideSection, withLanguageReminder } from './prompts';
import { createToolResultCache } from './tool-output';
import { buildTools, executeTool, SANDBOX_TOOLS, type ToolContext } from './tools';
import { executionPolicyFor } from './workflow';
import { Workspace, WorkspaceError } from './workspace';
import type { LoadedProject } from '@b-studio/spec';

/**
 * 러너 대신 CLI에 관문만 붙이는 실험 경로(이슈 #670, E17).
 *
 * `runClaudeCodeAgent`는 Claude Code의 기본 도구를 모두 끄고 b-studio 도구만 주며, 턴이 끝날 때 러너가 게이트를 돈다.
 * 여기서는 `claude` CLI를 세션 작업 복사본에서 그대로 띄운다. 파일은 CLI의 내장 도구(Read·Edit·Write·Glob·Grep)가
 * 직접 고치고, b-studio는 두 군데에서만 붙는다:
 *  - 샌드박스 도구(run_in_service 등)를 루프백 HTTP MCP로 내준다. 호스트 셸(Bash)은 주지 않는다.
 *  - 에이전트가 멈출 때 Stop 훅이 루프백 서버를 불러 검증 게이트를 돈다. 실패하면 사유를 돌려줘 이어서 고치게 한다.
 *
 * CLI의 내장 도구는 b-studio의 파일 도구(Workspace)를 거치지 않고 호스트의 파일 시스템을 직접 만진다. 그래서 두 겹으로 가둔다:
 *  - CLI 자신의 권한: 편집 자동 수락 모드(acceptEdits)는 작업 폴더 안의 편집만 받아들이고, 밖의 읽기·쓰기는 권한을 물어야 해서
 *    headless에서는 거절된다. 내장 도구를 허용 목록(--allowedTools)에 넣지 않는다 — 넣으면 경로와 무관하게 허용된다
 *    (실측 CLI 2.1.296: 허용 목록에 Read·Write를 넣자 /etc/hosts를 읽고 작업 폴더 밖에 파일을 썼다).
 *  - PreToolUse 훅: 도구를 쓰기 직전에 Workspace와 같은 규칙으로 경로를 본다(프로젝트 밖, 링크 경유, .git·.env·생성물).
 *    작업 복사본의 .git은 호스트의 git이 그대로 믿으므로(.git/config, 훅) 여기에 쓰면 호스트에서 코드가 실행된다.
 *    이 훅은 닫힌 쪽으로 실패한다: 검사 서버에 닿지 못하면 거절한다.
 *
 * 훅은 에이전트에게 실패를 돌려주는 통로일 뿐이고 판정의 근거가 아니다. 훅이 불리지 않았거나(턴 상한, 훅 명령 실패)
 * 통과한 뒤에 파일이 또 바뀌었으면 CLI가 끝난 뒤 러너가 게이트를 한 번 더 돈다. 그 결과가 실행의 결과다.
 */

/** CLI에 여는 내장 도구. 호스트에서 명령을 돌리는 Bash는 넣지 않는다(명령은 MCP의 run_in_service로 컨테이너 안에서 돈다) */
export const GATEWAY_BUILTIN_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'] as const;

const SERVER = 'b-studio';
const BACKEND = 'Claude Code CLI 관문';
const GATE_TOKEN_ENV = 'B_STUDIO_GATE_TOKEN';
const MCP_TOKEN_ENV = 'B_STUDIO_MCP_TOKEN';
/** 훅 명령이 게이트를 기다리는 시간(초). 게이트 한 번이 수 분 걸릴 수 있다(E14: 141~254초) */
const STOP_HOOK_TIMEOUT_SECONDS = 3600;
/** 도구 호출 전 경로 검사가 답을 기다리는 시간(초). 파일 몇 개의 상태를 보는 짧은 일이다 */
const PRE_TOOL_HOOK_TIMEOUT_SECONDS = 20;
const MAX_HOOK_BODY_BYTES = 4 * 1024 * 1024;

/** PreToolUse 훅의 거절 출력 */
function preToolDeny(reason: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClaudeGatewayRunOptions extends ClaudeCodeRunOptions {
  /**
   * 작업 복사본에서 마지막 체크포인트 이후 바뀐 파일(프로젝트 루트 기준). CLI는 b-studio 도구를 거치지 않고 파일을 고치므로
   * 러너는 이것으로만 변경을 안다. 게이트는 자기가 아는 변경이 없으면 검증 없이 통과하므로(gate.ts), 이 목록이 빠지면
   * 검증하지 않은 변경이 체크포인트가 된다.
   */
  pendingFiles: () => Promise<readonly string[]>;
  /** 실행할 CLI 명령(기본 `claude`). 테스트가 가짜 CLI를 끼우는 자리 */
  cliCommand?: readonly string[];
}

/** 관문 방식에서 MCP로 내주는 도구: 샌드박스가 있어야 도는 것만. 파일 도구는 CLI의 내장 도구가 대신한다 */
export function gatewayToolSpecs(project: LoadedProject): ReturnType<typeof buildTools> {
  return buildTools(project).filter((spec) => SANDBOX_TOOLS.has(spec.name));
}

/** CLI가 받는 지시문 덧붙임. Claude Code의 기본 지시문은 그대로 두고 b-studio에서만 다른 점을 적는다 */
function gatewayNote(toolNames: readonly string[]): string {
  return [
    '# b-studio',
    '이 작업 폴더는 b-studio 세션의 작업 복사본이다. 서비스는 컨테이너에서 돌고 이 폴더가 그 안에 연결되어 있다.',
    `호스트 셸은 없다. 빌드·테스트 같은 명령은 mcp__${SERVER}__run_in_service로 서비스 컨테이너 안에서 돌린다. 쓸 수 있는 b-studio 도구: ${toolNames.map((name) => `mcp__${SERVER}__${name}`).join(', ')}.`,
    '턴을 끝내면 b-studio가 검증 게이트(서비스 재시작, API 계약, 선언한 확인)를 돌린다. 실패하면 결과가 "Stop hook feedback"으로 돌아온다. 그것은 사용자의 새 요청이 아니라 검증 결과다. 고친 뒤 다시 턴을 끝낸다.',
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
    // 찾는 패턴으로 프로젝트 밖을 가리키지 못하게 한다
    if (typeof value !== 'string' || path.isAbsolute(value) || value.startsWith('~') || value.split(/[\\/]/).includes('..')) {
      return `${toolName}: ${field}는 프로젝트 안의 상대 패턴만 쓸 수 있습니다`;
    }
  }
  return undefined;
}

/** CLI는 절대 경로를 준다. 프로젝트 루트(또는 그 실제 위치) 아래면 루트 기준 상대 경로로, 아니면 undefined */
function relativeToRoot(file: string, root: string, realRoot: string): string | undefined {
  if (!path.isAbsolute(file)) return file;
  for (const base of [root, realRoot]) {
    const relative = path.relative(base, file);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return relative;
  }
  return undefined;
}

/** 바뀐 파일을 작업 공간(게이트가 보는 목록)에 옮긴다. 내용이 그대로인 파일은 다시 알리지 않는다 */
class ChangeTracker {
  readonly #workspace: Workspace;
  readonly #pendingFiles: () => Promise<readonly string[]>;
  /** 파일 → 마지막으로 게이트에 알린 때의 지문 */
  readonly #tracked = new Map<string, string>();
  /** 실행 전부터 있던, 게이트가 다루지 않는 경로 → 그때의 지문. 그대로면 이번 실행의 탓이 아니다 */
  readonly #toleratedRejects = new Map<string, string>();
  #started = false;

  constructor(workspace: Workspace, pendingFiles: () => Promise<readonly string[]>) {
    this.#workspace = workspace;
    this.#pendingFiles = pendingFiles;
  }

  /**
   * 지금의 변경을 게이트에 알린다. changed는 지난번 이후 새로 바뀐 파일, rejected는 이번 실행에서 바뀌었는데 게이트가
   * 다룰 수 없는 경로(비밀 파일, 생성물, 프로젝트 밖)다. rejected를 건너뛰면 검증하지 않은 파일이 체크포인트에 들어간다.
   */
  async sync(): Promise<{ changed: string[]; rejected: string[] }> {
    const first = !this.#started;
    this.#started = true;
    const changed: string[] = [];
    const rejected: string[] = [];
    for (const file of await this.#pendingFiles()) {
      if (file.endsWith('/')) continue;
      const print = await fingerprint(path.resolve(this.#workspace.root, file));
      if (this.#tracked.get(file) === print) continue;
      try {
        this.#workspace.trackExternalChanges([file]);
        this.#tracked.set(file, print);
        changed.push(file);
      } catch {
        if (first) this.#toleratedRejects.set(file, print);
        else if (this.#toleratedRejects.get(file) !== print) rejected.push(file);
      }
    }
    return { changed: changed.sort(), rejected: rejected.sort() };
  }
}

async function fingerprint(absolute: string): Promise<string> {
  try {
    const info = await stat(absolute);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return 'missing';
  }
}

interface StopHookInput {
  stop_hook_active?: unknown;
  last_assistant_message?: unknown;
}

interface PreToolHookInput {
  tool_name?: unknown;
  tool_input?: unknown;
}

type HookInput = StopHookInput & PreToolHookInput;
type HookHandler = (input: HookInput) => Promise<Record<string, unknown>>;

interface HookServer {
  /** 뒤에 /stop, /pre-tool을 붙여 부른다 */
  url: string;
  token: string;
  close(): Promise<void>;
}

/** 훅 명령이 부르는 루프백 서버. 요청 본문은 CLI가 훅에 준 JSON, 응답은 CLI가 훅의 출력으로 읽을 JSON이다 */
async function startHookServer(routes: Readonly<Record<string, HookHandler>>): Promise<HookServer> {
  const token = randomBytes(24).toString('hex');
  const http = createServer((req, res) => {
    void handleHook(req, res, token, routes);
  });
  http.on('clientError', (_error, socket) => socket.destroy());
  // 게이트가 도는 동안 연결을 끊지 않는다
  http.requestTimeout = 0;
  http.headersTimeout = 0;
  await listen(http);
  const address = http.address();
  if (address === null || typeof address === 'string') throw new Error('게이트 훅 서버가 포트를 열지 못했습니다');
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    async close() {
      if (closed) return;
      closed = true;
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function handleHook(req: IncomingMessage, res: ServerResponse, token: string, routes: Readonly<Record<string, HookHandler>>): Promise<void> {
  const reply = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!LOOPBACK_HOSTS.has(host)) return reply(403, { error: '루프백에서만 접근할 수 있습니다' });
  if (!tokenMatches(req.headers.authorization, token)) return reply(401, { error: 'unauthorized' });
  const handler = req.method === 'POST' && req.url && Object.hasOwn(routes, req.url) ? routes[req.url] : undefined;
  if (!handler) return reply(404, { error: 'not found' });
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_HOOK_BODY_BYTES) return reply(413, { error: 'too large' });
      chunks.push(chunk);
    }
    let input: HookInput = {};
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (typeof parsed === 'object' && parsed !== null) input = parsed as HookInput;
    } catch {
      // 훅 입력을 읽지 못해도 검증은 돈다. 입력은 요약에만 쓴다
    }
    reply(200, await handler(input));
  } catch (error) {
    // 5xx로 답한다. Stop 훅은 CLI가 멈추게 두고(판정은 마지막 검증이 한다), PreToolUse 훅은 명령이 실패를 거절로 바꾼다(-f)
    reply(500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** CLI의 stream-json 한 줄. SDK의 메시지와 같은 꼴이지만 여기서는 필요한 필드만 본다 */
interface CliMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  claude_code_version?: string;
  parent_tool_use_id?: string | null;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  stop_reason?: string;
  duration_api_ms?: number;
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
  message?: {
    id?: string;
    content?: unknown;
    usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
  };
  compact_metadata?: { trigger: 'manual' | 'auto'; pre_tokens: number; post_tokens?: number; duration_ms?: number };
}

function resultFailure(message: CliMessage): string | undefined {
  switch (message.subtype) {
    case 'success':
      if (message.is_error) return `모델 호출이 실패했습니다: ${message.result ?? ''}`;
      if (message.stop_reason === 'refusal') return '모델이 요청을 거절했습니다';
      return undefined;
    case 'error_max_turns':
      return 'Claude Code의 최대 턴 수를 넘었습니다';
    case 'error_max_budget_usd':
      return 'Claude Code의 비용 한도를 넘었습니다';
    default:
      return `Claude Code 실행 중 오류가 났습니다${message.errors && message.errors.length > 0 ? `: ${message.errors.join('; ')}` : ''}`;
  }
}

function usageOf(models: NonNullable<CliMessage['modelUsage']>): AgentUsage {
  const usage = emptyUsage();
  for (const model of Object.values(models)) {
    usage.inputTokens += model.inputTokens ?? 0;
    usage.outputTokens += model.outputTokens ?? 0;
    usage.cacheReadTokens += model.cacheReadInputTokens ?? 0;
    usage.cacheWriteTokens += model.cacheCreationInputTokens ?? 0;
  }
  return usage;
}

function rejectedFeedback(rejected: readonly string[]): string {
  return [
    '[b-studio 검증 게이트] 게이트가 검증할 수 없는 경로가 이번 실행에서 바뀌어 통과시키지 않았습니다.',
    ...rejected.slice(0, 20).map((file) => `- ${file}`),
    ...(rejected.length > 20 ? [`- 외 ${rejected.length - 20}개`] : []),
    '비밀 파일(.env 등)이나 생성물은 체크포인트에 넣지 않습니다. 필요 없는 파일이면 지우고, 생성물이면 .gitignore에 넣은 뒤 턴을 끝내세요.',
  ].join('\n');
}

export async function runClaudeGatewayAgent(options: ClaudeGatewayRunOptions): Promise<ClaudeCodeResult> {
  const {
    request,
    project,
    sandbox,
    allowBreaking = false,
    maxTurns = 60,
    maxVerifyAttempts = 3,
    signal,
    onEvent = () => {},
    onServiceStatus,
    fetcher = fetchContract,
    resume,
    model,
    effort,
    account,
    env: processEnv = process.env,
    cliCommand = ['claude'],
  } = options;
  signal?.throwIfAborted();
  // 질문은 파일을 바꾸지 않아 관문이 할 일이 없다. 러너 방식이 맡는다
  if (options.intent === 'ask') throw new Error('관문 방식은 질문 모드를 받지 않습니다');
  const [command, ...commandArgs] = cliCommand;
  if (!command) throw new Error('실행할 CLI 명령이 없습니다');
  // 지연 기동 세션이면 먼저 켠다. 계약 기준은 아직 바뀌지 않은 코드에서 잡아야 한다
  if (options.ensureSandbox) await options.ensureSandbox();

  const workspace = new Workspace(project.root);
  workspace.beginRun(options.requirementsBaseline);
  const tracker = new ChangeTracker(workspace, options.pendingFiles);
  // 실행 전부터 작업 트리에 있던 변경도 검증 대상이다(ADR-131)
  await tracker.sync();

  const gate = await VerificationGate.create({
    project,
    sandbox,
    workspace,
    allowBreaking,
    maxVerifyAttempts,
    verify: options.verify,
    allowCheckChanges: options.allowCheckChanges,
    fetcher,
    pageFetcher: options.pageFetcher,
    browserRunner: options.browserRunner,
    saveArtifact: options.saveArtifact,
    onBrowserFrame: options.onBrowserFrame,
    signal,
    onServiceStatus,
    onEvent,
  });
  const guide = await loadProjectGuide(project);
  const metrics: RunMetrics = { modelCalls: 0, maxContextTokens: 0, toolMs: 0, gateMs: 0, ...(guide ? { guideChars: guide.charsUsed } : {}) };
  const context: ToolContext = {
    project,
    selfCheck: options.selfCheck,
    workspace,
    sandbox,
    fetcher,
    signal,
    onServiceStatus,
    policy: options.policy ?? executionPolicyFor(project),
    approvalToken: options.approvalToken,
    requestApproval: options.requestApproval,
    onPolicyDecision: (decision) => onEvent({ type: 'policy', ...decision }),
    toolResults: createToolResultCache(),
  };
  const specs = gatewayToolSpecs(project);
  const serial = serialQueue();

  /** 게이트를 한 번 돈다. 훅과 마지막 검증이 함께 쓴다. 게이트가 다루지 못하는 경로가 바뀌었으면 게이트를 돌리기 전에 막는다 */
  let rejectedAttempts = 0;
  let lastOutcome: GateOutcome | undefined;
  /** 재시도 상한을 다 썼다. 더 막지 않고 실패로 끝낸다 */
  let exhausted: string | undefined;
  const check = serialQueue();
  const runGate = (): Promise<GateOutcome> =>
    check(async () => {
      const started = performance.now();
      try {
        const { rejected } = await tracker.sync();
        if (rejected.length > 0) {
          rejectedAttempts += 1;
          const feedback = rejectedFeedback(rejected);
          lastOutcome = rejectedAttempts >= maxVerifyAttempts ? { kind: 'exhausted', summary: `게이트가 검증할 수 없는 경로가 남아 통과시키지 않았습니다: ${rejected.slice(0, 5).join(', ')}` } : { kind: 'retry', feedback };
        } else {
          lastOutcome = await gate.check();
        }
        if (lastOutcome.kind === 'exhausted') exhausted = lastOutcome.summary;
        return lastOutcome;
      } finally {
        metrics.gateMs += Math.round(performance.now() - started);
      }
    });

  let lastText = '';
  const tools = await startToolServer({
    specs,
    name: SERVER,
    run: (name, args) =>
      serial(async () => {
        signal?.throwIfAborted();
        onEvent({ type: 'tool_call', name, input: args });
        const started = performance.now();
        const outcome = await executeTool(name, args, context);
        metrics.toolMs += Math.round(performance.now() - started);
        onEvent({ type: 'tool_result', name, ok: outcome.ok, content: outcome.content, chars: outcome.content.length, rawChars: outcome.rawChars ?? outcome.content.length });
        return outcome;
      }),
  });
  const hook = await startHookServer({
    '/stop': async (input) => {
      if (typeof input.last_assistant_message === 'string' && input.last_assistant_message.trim()) lastText = input.last_assistant_message.trim();
      // 상한을 다 쓴 뒤에는 막지 않는다. 막으면 CLI가 끝나지 않는다
      if (exhausted !== undefined) return {};
      const outcome = await runGate();
      if (outcome.kind === 'retry') return { decision: 'block', reason: outcome.feedback };
      return {};
    },
    '/pre-tool': async (input) => {
      const denied = await guardBuiltinTool(workspace, input.tool_name, input.tool_input);
      // 통과면 아무 결정도 돌려주지 않는다. 허용할지는 CLI의 권한(작업 폴더 가두기)이 한 번 더 정한다
      if (denied === undefined) return {};
      onEvent({ type: 'warning', message: `막은 도구 호출 — ${denied}` });
      return preToolDeny(`[b-studio] ${denied}`);
    },
  });

  const usage = emptyUsage();
  const messageIds = new Set<string>();
  let sessionId: string | undefined;
  let resultMessage: CliMessage | undefined;
  let stderrTail = '';
  let announced = false;
  const handleMessage = (message: CliMessage): void => {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init' && !announced) {
          announced = true;
          onEvent({ type: 'session', backend: `${BACKEND} (CLI ${message.claude_code_version ?? '?'})`, model: message.model ?? model ?? '기본 모델', auth: account ? describeAccount(account) : undefined, ...(effort ? { effort } : {}) });
        }
        if (message.subtype === 'compact_boundary' && message.compact_metadata) {
          const { trigger, pre_tokens, post_tokens, duration_ms } = message.compact_metadata;
          onEvent({ type: 'context_compacted', trigger, preTokens: pre_tokens, ...(post_tokens !== undefined ? { postTokens: post_tokens } : {}), ...(duration_ms !== undefined ? { durationMs: duration_ms } : {}) });
        }
        break;
      case 'assistant': {
        if (message.parent_tool_use_id || !message.message?.id) break;
        const messageUsage = message.message.usage;
        const turnContext = messageUsage ? (messageUsage.input_tokens ?? 0) + (messageUsage.cache_read_input_tokens ?? 0) + (messageUsage.cache_creation_input_tokens ?? 0) : 0;
        metrics.maxContextTokens = Math.max(metrics.maxContextTokens, turnContext);
        if (!messageIds.has(message.message.id)) {
          messageIds.add(message.message.id);
          const turn = messageIds.size;
          onEvent({ type: 'turn', turn });
          if (messageUsage) {
            onEvent({
              type: 'turn_usage',
              turn,
              inputTokens: messageUsage.input_tokens ?? 0,
              outputTokens: messageUsage.output_tokens ?? 0,
              cacheReadTokens: messageUsage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: messageUsage.cache_creation_input_tokens ?? 0,
              contextTokens: turnContext,
            });
          }
        }
        const blocks = Array.isArray(message.message.content) ? (message.message.content as Array<{ type?: string; text?: string; name?: string; input?: unknown }>) : [];
        for (const block of blocks) {
          // 내장 도구의 호출도 화면이 따라갈 수 있게 남긴다. b-studio 도구는 MCP 쪽에서 이미 남긴다
          if (block.type === 'tool_use' && block.name && !block.name.startsWith(`mcp__${SERVER}__`)) onEvent({ type: 'tool_call', name: block.name, input: block.input });
        }
        const text = blocks
          .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
          .join('\n')
          .trim();
        if (text) {
          onEvent({ type: 'text', text });
          lastText = text;
        }
        break;
      }
      case 'result': {
        resultMessage = message;
        if (message.modelUsage) {
          Object.assign(usage, usageOf(message.modelUsage));
          metrics.usageByModel = Object.fromEntries(Object.entries(message.modelUsage).map(([name, value]) => [name, usageOf({ [name]: value })]));
        }
        if (typeof message.duration_api_ms === 'number' && Number.isFinite(message.duration_api_ms) && message.duration_api_ms >= 0) metrics.modelMs = Math.round(message.duration_api_ms);
        onEvent({ type: 'tokens', usage: { ...usage } });
        break;
      }
    }
  };

  const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-gateway-'));
  try {
    const settingsPath = path.join(dir, 'settings.json');
    const mcpPath = path.join(dir, 'mcp.json');
    // 토큰은 파일에 쓰지 않는다. CLI 프로세스의 환경 변수로만 넘기고, 훅 명령과 MCP 설정은 그 이름만 적는다
    const post = (route: string, seconds: number, flags: string): string =>
      `curl ${flags} --max-time ${seconds} -X POST -H 'content-type: application/json' -H "authorization: Bearer $${GATE_TOKEN_ENV}" --data-binary @- ${hook.url}${route}`;
    const stopCommand = post('/stop', STOP_HOOK_TIMEOUT_SECONDS, '-sS');
    // 닫힌 쪽으로 실패한다: 검사 서버에 닿지 못했거나 서버가 오류로 답하면(-f) 거절을 출력한다. 출력이 없으면 CLI는 도구를 그대로 쓴다
    const preToolCommand = `${post('/pre-tool', PRE_TOOL_HOOK_TIMEOUT_SECONDS, '-fsS')} || printf '%s' '${JSON.stringify(preToolDeny('[b-studio] 경로 검사에 닿지 못해 도구 호출을 거절했습니다'))}'`;
    await writeFile(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: preToolCommand, timeout: PRE_TOOL_HOOK_TIMEOUT_SECONDS + 5 }] }],
            Stop: [{ hooks: [{ type: 'command', command: stopCommand, timeout: STOP_HOOK_TIMEOUT_SECONDS }] }],
          },
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await writeFile(mcpPath, JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url: tools.url, headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` } } } }, null, 2), { mode: 0o600 });

    // 허용 목록에는 b-studio 도구만 넣는다. 내장 도구를 넣으면 CLI가 경로와 무관하게 허용한다(머리 주석의 실측)
    const allowed = specs.map((spec) => `mcp__${SERVER}__${spec.name}`);
    // 요청 글과 프로젝트 안내는 인자로 넘기지 않는다. 둘 다 바깥에서 온 글일 수 있고(이슈 본문, 저장소의 AGENTS.md),
    // "--"로 시작하면 CLI가 옵션으로 읽는다. 요청은 표준 입력으로, 지시문 덧붙임은 파일로 넘긴다
    const notePath = path.join(dir, 'system-prompt.md');
    await writeFile(notePath, gatewayNote(specs.map((spec) => spec.name)) + projectGuideSection(guide), { mode: 0o600 });
    const args = [
      ...commandArgs,
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      // 명령·코드를 돌리는 내장 도구와 WebFetch를 CLI 쪽에서도 뺀다(--tools가 이미 고르지만, 새 도구가 생겨도 열리지 않게 한 겹 더 둔다)
      '--restricted',
      '--tools',
      GATEWAY_BUILTIN_TOOLS.join(','),
      '--allowedTools',
      allowed.join(','),
      // 작업 폴더 안의 편집만 받아들인다. 밖의 읽기·쓰기는 권한을 물어야 하고, 물을 사람이 없는 -p에서는 거절된다
      '--permission-mode',
      'acceptEdits',
      '--mcp-config',
      mcpPath,
      '--strict-mcp-config',
      '--settings',
      settingsPath,
      // 사용자 전역·프로젝트 설정(훅, 플러그인)은 싣지 않는다. 프로젝트 안내(AGENTS.md)는 아래 덧붙임으로 넣는다
      '--setting-sources',
      '',
      '--append-system-prompt-file',
      notePath,
      '--max-turns',
      String(maxTurns),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
      // 이어받을 대화의 id는 CLI가 준 값만 받는다(UUID 꼴이 아니면 인자에 넣지 않는다)
      ...(resume && SESSION_ID.test(resume) ? ['--resume', resume, '--fork-session'] : []),
    ];
    const child = spawn(command, args, {
      cwd: project.root,
      env: { ...processEnv, [GATE_TOKEN_ENV]: hook.token, [MCP_TOKEN_ENV]: tools.token, CLAUDE_AGENT_SDK_CLIENT_APP: 'b-studio' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // 입력 쪽이 먼저 닫혀도(CLI가 바로 끝난 경우) 실행 전체가 예외로 죽지 않게 한다. 실패는 종료 코드와 결과 메시지로 드러난다
    child.stdin.on('error', () => {});
    child.stdin.end(withLanguageReminder(request));
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    const onAbort = (): void => {
      child.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // 준비하는 동안 취소가 먼저 왔으면 리스너가 불리지 않는다
    if (signal?.aborted) onAbort();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });

    try {
      for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        if (!line.trim()) continue;
        let message: CliMessage;
        try {
          message = JSON.parse(line) as CliMessage;
        } catch {
          continue;
        }
        if (message.session_id) sessionId = message.session_id;
        handleMessage(message);
      }
      const code = await exited;
      signal?.throwIfAborted();
      if (!resultMessage) throw new Error(`Claude Code CLI가 결과를 보내지 않고 끝났습니다 (종료 코드 ${code ?? '없음'})${stderrTail.trim() ? `: ${stderrTail.trim().split('\n').slice(-3).join(' / ')}` : ''}`);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited.catch(() => {});
    }

  } finally {
    await Promise.allSettled([tools.close(), hook.close(), rm(dir, { recursive: true, force: true })]);
    // 이미 시작한 도구 호출과 게이트가 끝나기를 기다린다. 부르는 쪽이 변경을 되돌리기 전이어야 한다
    await serial.idle();
    await check.idle();
  }

  const finish = (status: AgentResult['status'], summary: string, failureReason?: AgentResult['failureReason']): ClaudeCodeResult => {
    metrics.modelCalls = messageIds.size;
    const result: ClaudeCodeResult = {
      status,
      summary,
      changedFiles: workspace.changedFiles(),
      report: gate.report,
      checks: gate.checks,
      ...(gate.lastOutcome ? { gateOutcome: gate.lastOutcome } : {}),
      passedStages: [...gate.passedStages],
      ...(options.verify === 'light' ? { verify: 'light' as const } : {}),
      ...(gate.skippedStages.length > 0 ? { skippedStages: [...gate.skippedStages] } : {}),
      verifyAttempts: gate.attempts,
      turns: messageIds.size,
      usage,
      metrics: { ...metrics },
      sessionId,
      ...(failureReason ? { failureReason } : {}),
    };
    onEvent(status === 'failed' ? { type: 'failed', result } : { type: 'done', result });
    return result;
  };

  const failure = resultFailure(resultMessage!);
  // 모델 호출이 오류로 끝났으면 게이트를 돌리지 않는다(러너 방식과 같다). 턴 상한만 마지막 검증의 결과를 따른다(ADR-131)
  if (failure && resultMessage!.subtype !== 'error_max_turns') return finish('failed', failure);
  if (exhausted !== undefined) return finish('failed', exhausted, failure ? 'max_turns' : undefined);

  // 마지막 검증. 훅이 통과시킨 상태 그대로면 다시 돌리지 않는다. 훅이 불리지 않았거나, 막힌 채 끝났거나,
  // 통과한 뒤에 파일이 또 바뀌었으면 여기서 한 번 더 돈다 — 이 결과가 실행의 결과다
  const after = await tracker.sync();
  const settled = lastOutcome?.kind === 'pass' && after.changed.length === 0 && after.rejected.length === 0;
  if (failure) {
    // 턴 상한: 안내 문구와 판정은 러너 방식과 같은 함수가 만든다. 게이트가 다루지 못하는 경로가 남았으면 통과시키지 않는다
    if (after.rejected.length > 0) return finish('failed', `최대 턴 수(${maxTurns})를 넘었습니다. ${rejectedFeedback(after.rejected)}`, 'max_turns');
    const started = performance.now();
    const recheck = settled ? { pass: true, summary: `최대 턴 수(${maxTurns})를 넘었습니다. 다만 지금까지의 변경이 검증 게이트를 통과해 체크포인트로 남깁니다(요청의 일부만 끝났을 수 있습니다).` } : await recheckGateOnMaxTurns(gate, maxTurns, onEvent);
    metrics.gateMs += Math.round(performance.now() - started);
    return finish(recheck.pass ? 'done' : 'failed', recheck.summary, recheck.pass ? undefined : 'max_turns');
  }
  if (!settled) {
    const outcome = await runGate();
    if (outcome.kind !== 'pass') {
      const detail = outcome.kind === 'retry' ? outcome.feedback : outcome.summary;
      return finish('failed', `CLI가 끝난 뒤의 마지막 검증을 통과하지 못했습니다.\n\n${detail}`);
    }
  }
  if (gate.verified) onEvent({ type: 'stage', stage: 'checkpoint', source: 'platform' });
  return finish('done', lastText);
}

