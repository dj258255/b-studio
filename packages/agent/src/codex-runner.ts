import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { Codex, type ThreadEvent, type ThreadOptions, type Usage } from '@openai/codex-sdk';
import type { Effort } from './anthropic-client';
import { serialQueue } from './claude-code-runner';
import { VerificationGate } from './gate';
import { emptyUsage, type AgentEvent, type AgentResult, type AgentUsage, type RunAgentOptions, type RunMetrics } from './loop';
import { startToolServer } from './mcp-http-server';
import { buildAskRequest, buildSystemPrompt } from './prompts';
import { buildTools, executeTool, type ToolContext, type ToolOutcome } from './tools';
import { fetchContract } from './verify';
import { executionPolicyFor, workflowContext } from './workflow';
import { Workspace } from './workspace';

/** Codex 설정에서 MCP 서버를 부르는 이름. 모델에게 보이는 도구 이름이 `mcp__b_studio__<도구>`가 된다(0단계 근거: 바이너리 문자열) */
const SERVER = 'b_studio';
/** MCP bearer 토큰을 넘기는 환경 변수 이름. 토큰 값은 로그에 남기지 않는다 */
const TOKEN_ENV = 'B_STUDIO_MCP_TOKEN';
/** 화면 표기. 제품 이름을 그대로 쓰지 않는다(로컬 Claude Agent 러너와 같은 규칙) */
const BACKEND = '로컬 ChatGPT Agent';

/** 실행마다 만드는 Codex 작업 폴더의 접두어 */
const WORKDIR_PREFIX = 'b-studio-codex-';
/** 실행마다 만드는 임시 CODEX_HOME의 접두어. Codex가 사용자 설정 대신 이 폴더를 읽는다 */
const CODEX_HOME_PREFIX = 'b-studio-codex-home-';

/**
 * Codex에 `--config`로 넘길 설정 트리.
 * SDK가 같은 모양(CodexConfigObject)을 쓰지만 타입으로는 내보내지 않아 여기서 같은 모양을 정의한다.
 */
export type CodexConfig = { [key: string]: CodexConfigValue };
type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfig;

/** 실제 SDK와 테스트용 가짜를 바꿔 끼우는 지점 */
export interface CodexSdk {
  /**
   * Codex 클라이언트를 만들어 스레드를 시작한다. 설정·환경은 실행마다 달라지므로 여기서 받는다.
   * `~/.codex/config.toml`은 건드리지 않고 넘긴 값만 `--config`로 덮어쓴다.
   */
  startThread(input: { config: CodexConfig; env: Record<string, string>; options: ThreadOptions }): CodexThread;
}

/** SDK의 Thread에서 러너가 쓰는 부분만 추린 것 */
export interface CodexThread {
  readonly id: string | null;
  runStreamed(input: string, options?: { signal?: AbortSignal }): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}

const DEFAULT_SDK: CodexSdk = {
  startThread: ({ config, env, options }) => new Codex({ config, env }).startThread(options),
};

export interface CodexRunOptions extends Omit<RunAgentOptions, 'client' | 'conversation'> {
  /**
   * 이전 요청의 Codex 스레드 id.
   * 설치된 TS SDK에는 `codex exec fork`를 부르는 경로가 없어 이어받기를 지원하지 않는다. 값을 주면 오류를 낸다.
   */
  resume?: string;
  /** 넘기지 않으면 로그인한 계정의 기본 모델을 쓴다 */
  model?: string;
  effort?: Effort;
  sdk?: CodexSdk;
}

export interface CodexRunResult extends AgentResult {
  /** 이번 실행이 만든 스레드. 이어받기를 지원하지 않으므로 다음 요청에 쓰지 않는다 */
  threadId?: string;
}

/**
 * 이 PC에 ChatGPT 구독으로 로그인한 Codex CLI로 요청을 처리한다. API 키가 없어도 개인 구독으로 돌릴 수 있다.
 *
 * 도구 경계를 세 겹으로 막는다.
 *  1. 실행마다 빈 임시 `CODEX_HOME`을 만들어 사용자 `~/.codex`를 읽지 않게 한다(로그인 파일만 심볼릭 링크로 빌려온다).
 *     그대로 두면 사용자가 등록한 MCP 서버(serena 등에는 파일 편집 도구가 있다)·플러그인·스킬·전역 AGENTS.md가
 *     모델에 실려 b-studio 도구를 거치지 않고 작업 공간을 바꿀 수 있다. 로컬 Claude Agent 러너의 `settingSources: []`와 같은 목적이다.
 *  2. 셸 도구를 끄고(`features.shell_tool=false`), `apply_patch`는 끄는 설정이 없어
 *     작업 폴더를 실행마다 만드는 빈 임시 폴더 + 읽기 전용 샌드박스 + 승인 never로 막는다.
 *  3. 실제 변경은 b-studio 도구(MCP 서버)만 호스트의 작업 공간에 쓴다.
 *
 * 완료 판정은 직접 만든 루프와 같은 검증 게이트가 한다. 턴이 끝날 때마다 게이트를 돌리고, 실패하면 결과를 다음 턴에 넣는다.
 */
export async function runCodexAgent(options: CodexRunOptions): Promise<CodexRunResult> {
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
    pageFetcher,
    browserRunner,
    resume,
    model,
    effort,
    sdk = DEFAULT_SDK,
    intent = 'build',
  } = options;
  signal?.throwIfAborted();
  if (resume) {
    throw new Error('Codex는 이어받기를 지원하지 않습니다: 설치된 SDK에 대화를 갈라 이어받는(fork) 경로가 없습니다');
  }
  const ask = intent === 'ask';

  const workspace = new Workspace(project.root);
  // 질문 모드는 파일을 바꾸지 않으므로 계약 기준을 잡거나 게이트를 돌리지 않는다
  const gate = ask
    ? undefined
    : await VerificationGate.create({ project, sandbox, workspace, allowBreaking, maxVerifyAttempts, fetcher, pageFetcher, browserRunner, signal, onServiceStatus, onEvent });
  const context: ToolContext = {
    project,
    workspace,
    sandbox,
    fetcher,
    signal,
    onServiceStatus,
    readOnly: ask,
    // 직접 만든 루프와 같은 기본값. 없으면 studio.yaml의 워크플로 정책이 이 경로에만 빠진다
    policy: options.policy ?? executionPolicyFor(project),
    approvalToken: options.approvalToken,
    requestApproval: options.requestApproval,
    onPolicyDecision: (decision) => onEvent({ type: 'policy', ...decision }),
  };
  const specs = buildTools(project);
  const toolName = (name: string) => `mcp__${SERVER}__${name}`;

  // 도구 호출은 모델이 낸 순서대로 하나씩 실행한다. 로컬 Claude Agent 러너와 같은 큐를 쓴다
  const serial = serialQueue();
  // 실행 지표. modelMs는 모델 응답 대기가 SDK 안(하위 프로세스)에서 일어나 이 러너가 관찰하지 못하므로 0으로 둔다.
  // 0은 "재지 않음"이고, 전체 시간에서 도구·게이트 시간을 뺀 추측값을 넣지 않는다
  const metrics: RunMetrics = { modelCalls: 0, maxContextTokens: 0, modelMs: 0, toolMs: 0, gateMs: 0 };

  // Codex 작업 폴더는 실행마다 만드는 빈 임시 폴더다. project.root를 넘기면 모델이 apply_patch로 작업 공간을 직접 바꿀 수 있다
  const workdir = await mkdtemp(path.join(tmpdir(), WORKDIR_PREFIX));
  let toolServer: Awaited<ReturnType<typeof startToolServer>> | undefined;
  let codexHome: string | undefined;
  let result: CodexRunResult | undefined;
  const usage = emptyUsage();
  let completedTurns = 0;
  let lastText = '';
  let threadId: string | undefined;

  const finish = (status: AgentResult['status'], summary: string): void => {
    result = {
      status,
      summary,
      changedFiles: workspace.changedFiles(),
      report: gate?.report,
      checks: gate?.checks,
      passedStages: gate ? [...gate.passedStages] : undefined,
      verifyAttempts: gate?.attempts ?? 0,
      turns: completedTurns,
      usage,
      metrics: { ...metrics },
      threadId,
    };
    onEvent(status === 'done' ? { type: 'done', result } : { type: 'failed', result });
  };

  try {
    // 임시 CODEX_HOME. 작업 폴더와 다른 폴더다(Codex가 세션·로그를 여기에 쓰므로 작업 폴더와 섞지 않는다)
    codexHome = await mkdtemp(path.join(tmpdir(), CODEX_HOME_PREFIX));
    await linkAuthFile(codexHome);
    const home = codexHome;

    toolServer = await startToolServer({
      name: SERVER,
      specs,
      run: (name, args) =>
        serial(async (): Promise<ToolOutcome> => {
          // 취소한 뒤 대기열에 남은 호출은 파일을 건드리지 않고 끝낸다
          signal?.throwIfAborted();
          onEvent({ type: 'tool_call', name, input: args });
          const toolStarted = performance.now();
          const outcome = await executeTool(name, args, context);
          metrics.toolMs += Math.round(performance.now() - toolStarted);
          onEvent({ type: 'tool_result', name, ok: outcome.ok, content: outcome.content });
          return outcome;
        }),
    });

    const thread = sdk.startThread({
      // 설정 덮어쓰기로만 넘긴다. 사용자 config.toml은 바꾸지 않는다
      config: {
        features: { shell_tool: false },
        mcp_servers: { [SERVER]: { url: toolServer.url, bearer_token_env_var: TOKEN_ENV } },
      },
      // CODEX_HOME을 임시 폴더로 바꿔 사용자 ~/.codex(등록한 MCP 서버·플러그인·스킬·전역 AGENTS.md)를 읽지 않게 한다
      env: { ...processEnv(), [TOKEN_ENV]: toolServer.token, CODEX_HOME: home },
      options: {
        // 빈 임시 폴더 + 읽기 전용 + 승인 없음. git 저장소가 아니므로 확인을 건너뛴다
        workingDirectory: workdir,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
        ...(model ? { model } : {}),
        ...(effort ? { modelReasoningEffort: effort } : {}),
      },
    });

    // Codex SDK에는 systemPrompt 옵션이 없어 프로젝트 규칙·도구 이름을 첫 사용자 메시지 앞에 붙인다.
    // (설정의 developer_instructions로 넘기는 방법도 있으나 내장 도구 안내를 덮어쓸 위험이 있어 쓰지 않았다)
    let pending = `${buildSystemPrompt(project, { toolName })}${workflowContext(project)}\n\n${ask ? buildAskRequest(request, { toolName }) : request}`;
    let announced = false;

    for (let turn = 1; turn <= maxTurns; turn++) {
      signal?.throwIfAborted();
      onEvent({ type: 'turn', turn });
      const { events } = await thread.runStreamed(pending, { signal });

      let failure: string | undefined;
      let text = '';
      for await (const event of events) {
        if (thread.id) threadId = thread.id;
        switch (event.type) {
          case 'thread.started':
            threadId = event.thread_id;
            // 턴마다 다시 올 수 있으므로 실행마다 한 번만 알린다
            if (!announced) {
              announced = true;
              onEvent({ type: 'session', backend: BACKEND, model: model ?? '계정 기본 모델' });
            }
            break;

          case 'turn.completed':
            // Codex 이벤트는 모델 호출 단위가 아니라 턴 단위라 턴 수로 센다
            completedTurns += 1;
            metrics.modelCalls = completedTurns;
            addUsage(usage, event.usage);
            metrics.maxContextTokens = Math.max(metrics.maxContextTokens, contextTokens(event.usage));
            onEvent({ type: 'tokens', usage: { ...usage } });
            break;

          case 'turn.failed':
            failure = classifyFailure(event.error.message);
            break;

          case 'error':
            failure = classifyFailure(event.message);
            break;

          case 'item.completed':
            if (event.item.type === 'agent_message') {
              text = event.item.text;
              onEvent({ type: 'text', text });
            }
            break;
        }
      }

      if (failure) {
        finish('failed', failure);
        break;
      }
      if (text) lastText = text;

      // 모델이 턴을 끝냈다 → 질문이면 답이 곧 결과이고, 만들기면 검증 게이트
      if (!gate) {
        finish('done', lastText);
        break;
      }
      const gateStarted = performance.now();
      const outcome = await gate.check();
      metrics.gateMs += Math.round(performance.now() - gateStarted);
      if (outcome.kind === 'pass') {
        if (gate.verified) onEvent({ type: 'stage', stage: 'checkpoint', source: 'platform' });
        finish('done', lastText);
        break;
      }
      if (outcome.kind === 'exhausted') {
        finish('failed', outcome.summary);
        break;
      }
      lastText = '';
      pending = outcome.feedback;
    }
    if (!result) finish('failed', `최대 턴 수(${maxTurns})를 넘었습니다`);
  } finally {
    // 프로세스를 닫아도 이미 시작한 도구 핸들러는 이어서 돈다. 호출한 쪽이 변경을 되돌리기 전에 끝나기를 기다린다
    await serial.idle();
    await toolServer?.close();
    // 심볼릭 링크만 지운다. 링크가 가리키는 원본 auth.json은 그대로 남는다
    if (codexHome) await rm(codexHome, { recursive: true, force: true }).catch(() => {});
    // Codex가 작업 폴더에 남긴 것이 있어도 작업 공간과 무관하므로 통째로 지운다
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }

  signal?.throwIfAborted();
  if (!result) throw new Error('Codex가 결과를 보내지 않고 종료됐습니다');
  return result;
}

/**
 * 샌드박스를 띄우기 전에 이 PC의 Codex CLI가 로그인돼 있는지 확인한다.
 * `codex login status`만 부르므로 모델 호출도, 사용량도 쓰지 않는다. 토큰·계정 정보는 읽지 않는다.
 */
export async function preflightCodex(
  { command = 'codex', timeoutMs = 60_000 }: { command?: string; timeoutMs?: number } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await run(command, ['login', 'status'], timeoutMs);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Codex CLI에 로그인돼 있지 않습니다. 터미널에서 "codex"를 실행해 "Sign in with ChatGPT"로 로그인하세요. (${describe(error)})` };
  }
}

/**
 * Codex `turn.completed.usage`를 실행 누적값에 더한다.
 *
 * 근거(약함): SDK 타입 주석이 각 필드를 "used during the turn"으로 설명하고, 턴마다 별도 `codex exec` 프로세스를 띄운다.
 * 실측하지 못했다(0단계에서 계정이 사용 한도에 걸려 모델 호출 불가). 누적으로 밝혀지면 덮어쓰기로 바꿔야 하며,
 * 그러지 않으면 토큰이 두 번 세어진다. 자세한 근거는 `.delegate/codex-probe.md`.
 */
function addUsage(total: AgentUsage, usage: Usage): void {
  total.inputTokens += usage.input_tokens;
  total.outputTokens += usage.output_tokens;
  total.cacheReadTokens += usage.cached_input_tokens ?? 0;
  total.cacheWriteTokens += usage.cache_write_input_tokens ?? 0;
}

/**
 * 한 턴의 입력 크기 = input + cache_read + cache_write.
 * Codex의 `input_tokens`가 캐시를 이미 포함하는지는 미확인이라 이중 계산일 수 있다(결과 파일에 남김).
 * 로컬 Claude Agent 러너의 contextTokens와 같은 규칙을 쓴다.
 */
function contextTokens(usage: Usage): number {
  return usage.input_tokens + (usage.cached_input_tokens ?? 0) + (usage.cache_write_input_tokens ?? 0);
}

/** 사용 한도 문구인지 본다. 실패 분류 기준은 이 한 곳에만 둔다 */
const USAGE_LIMIT = /usage[ _]limit|rate[ _]limit/i;

function classifyFailure(message: string): string {
  return USAGE_LIMIT.test(message) ? `ChatGPT 구독 사용 한도에 걸렸습니다: ${message}` : message;
}

function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return env;
}

/**
 * 로그인 파일만 임시 CODEX_HOME으로 빌려온다. 파일 내용을 읽거나 복사하지 않고 심볼릭 링크 하나만 만든다.
 * Codex가 토큰을 갱신하면 이 링크를 통해 원본 `~/.codex/auth.json`이 그대로 갱신되므로, 링크가 끊어지지 않는 한 로그인은 유지된다.
 * 파일이 원래 없으면 링크를 만들지 않고 진행한다. 그 실행은 로그인 오류로 끝나고 기존 실패 경로를 탄다.
 */
async function linkAuthFile(codexHome: string): Promise<void> {
  const auth = path.join(process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), 'auth.json');
  if (!(await exists(auth))) return;
  await symlink(auth, path.join(codexHome, 'auth.json'));
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  );
}

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
