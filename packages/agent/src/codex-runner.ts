import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { Thread, ThreadEvent, ThreadOptions, Usage } from '@openai/codex-sdk';
import type { Effort } from './anthropic-client';
import { serialQueue } from './claude-code-runner';
import type { EscalationPolicy } from './escalation';
import { VerificationGate } from './gate';
import { emptyUsage, formatSteering, takeSteering, type AgentEvent, type AgentResult, type AgentUsage, type RunAgentOptions, type RunMetrics } from './loop';
import { startToolServer } from './mcp-http-server';
import { loadProjectGuide } from './project-guide';
import { buildAskRequest, buildSystemPrompt, projectGuideSection } from './prompts';
import { createToolResultCache } from './tool-output';
import { buildTools, executeTool, SANDBOX_TOOLS, WRITE_TOOLS, type AskUserQuestion, type ToolContext, type ToolOutcome } from './tools';
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

/**
 * 실제 SDK는 처음 실행할 때 불러온다. `@openai/codex-sdk`는 ESM 전용(`exports`에 `import`만)이라,
 * CommonJS로 옮겨지는 경로(예: tsx로 도는 벤치가 `@b-studio/agent`를 require)에서 정적 import가 모듈 해석 오류를 낸다.
 * 동적 import는 두 방식 모두에서 동작하고, codex 모드를 쓰지 않는 실행은 이 패키지를 아예 불러오지 않는다
 */
const DEFAULT_SDK: CodexSdk = {
  startThread: ({ config, env, options }) => {
    let thread: Thread | undefined;
    return {
      get id() {
        return thread?.id ?? null;
      },
      async runStreamed(input, runOptions) {
        if (!thread) {
          const { Codex } = await import('@openai/codex-sdk');
          thread = new Codex({ config, env }).startThread(options);
        }
        return thread.runStreamed(input, runOptions);
      },
    };
  },
};

export interface CodexRunOptions extends Omit<RunAgentOptions, 'client' | 'conversation' | 'escalation'> {
  /**
   * 이전 요청의 Codex 스레드 id.
   * 설치된 TS SDK에는 `codex exec fork`를 부르는 경로가 없어 이어받기를 지원하지 않는다. 값을 주면 오류를 낸다.
   */
  resume?: string;
  /** 넘기지 않으면 로그인한 계정의 기본 모델을 쓴다 */
  model?: string;
  /** 이 러너는 모델 승격을 지원하지 않는다. 받으면 무시하지 않고 경고 이벤트를 한 번 알린다 */
  escalation?: EscalationPolicy;
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
    interactive = false,
    intent = 'build',
    research = false,
    steering,
  } = options;
  signal?.throwIfAborted();
  if (resume) {
    throw new Error('Codex는 이어받기를 지원하지 않습니다: 설치된 SDK에 대화를 갈라 이어받는(fork) 경로가 없습니다');
  }
  const ask = intent === 'ask';
  // codex 러너는 이번에 승격을 구현하지 않는다. 옵션을 조용히 무시하지 않고 한 번 알린다
  if (options.escalation) onEvent({ type: 'warning', message: '로컬 ChatGPT Agent 러너는 모델 승격을 지원하지 않습니다. 승격 옵션을 무시합니다' });

  const workspace = new Workspace(project.root);
  // 질문 모드는 파일을 바꾸지 않으므로 계약 기준을 잡거나 게이트를 돌리지 않는다.
  // 지연 기동 세션(ensureSandbox)은 게이트를 여기서 만들지 않고, 첫 파일 변경·샌드박스 도구 때 샌드박스를 켠 뒤에 만든다
  let gate: VerificationGate | undefined;
  let gatePromise: Promise<VerificationGate> | undefined;
  const gateFor = (): Promise<VerificationGate> =>
    (gatePromise ??= VerificationGate.create({ project, sandbox, workspace, allowBreaking, maxVerifyAttempts, verify: options.verify, fetcher, pageFetcher, browserRunner, signal, onServiceStatus, onEvent }));
  if (!ask && !options.ensureSandbox) gate = await gateFor();
  // 프로젝트 루트(project.root — 아래 workdir은 Codex 전용 빈 임시 폴더라 여기 쓰지 않는다)의 AGENTS.md를 읽는다(ADR-077)
  const guide = await loadProjectGuide(project);
  const context: ToolContext = {
    project,
    selfCheck: options.selfCheck,
    workspace,
    sandbox,
    fetcher,
    signal,
    onServiceStatus,
    readOnly: ask,
    onQuestion: (question) => {
      asked = question;
      onEvent({ type: 'question', ...question });
    },
    // 직접 만든 루프와 같은 기본값. 없으면 studio.yaml의 워크플로 정책이 이 경로에만 빠진다
    policy: options.policy ?? executionPolicyFor(project),
    approvalToken: options.approvalToken,
    requestApproval: options.requestApproval,
    board: options.board,
    onPolicyDecision: (decision) => onEvent({ type: 'policy', ...decision }),
    // 실행 단위 도구 결과 캐시. 같은 도구·같은 입력의 결과가 반복되면 본문 대신 참조를 넣는다
    toolResults: createToolResultCache(),
    // 지연 기동 세션이면 샌드박스 도구를 실행하기 직전에 켠다(핸들러가 게이트 생성까지 한다)
    ...(options.ensureSandbox ? { ensureSandbox: options.ensureSandbox } : {}),
  };
  // 조율 게시판은 Claude Code 러너와 같게, 켠 실행에만 도구를 더한다
  const specs = buildTools(project, {
    ...(options.board ? { board: options.board, allowedTools: context.policy?.allowedTools } : {}),
    interactive,
  });
  const toolName = (name: string) => `mcp__${SERVER}__${name}`;

  // 도구 호출은 모델이 낸 순서대로 하나씩 실행한다. 로컬 Claude Agent 러너와 같은 큐를 쓴다
  const serial = serialQueue();
  // 실행 지표. modelMs는 모델 응답 대기가 SDK 안(하위 프로세스)에서 일어나 이 러너가 관찰하지 못하므로 0으로 둔다.
  // 0은 "재지 않음"이고, 전체 시간에서 도구·게이트 시간을 뺀 추측값을 넣지 않는다
  const metrics: RunMetrics = { modelCalls: 0, maxContextTokens: 0, modelMs: 0, toolMs: 0, gateMs: 0, ...(guide ? { guideChars: guide.charsUsed } : {}) };

  // Codex 작업 폴더는 실행마다 만드는 빈 임시 폴더다. project.root를 넘기면 모델이 apply_patch로 작업 공간을 직접 바꿀 수 있다
  const workdir = await mkdtemp(path.join(tmpdir(), WORKDIR_PREFIX));
  let toolServer: Awaited<ReturnType<typeof startToolServer>> | undefined;
  let codexHome: string | undefined;
  let result: CodexRunResult | undefined;
  const usage = emptyUsage();
  let completedTurns = 0;
  let lastText = '';
  let threadId: string | undefined;
  // ask_user가 남긴 질문. 있으면 이 턴이 끝날 때 실행을 끝내고 사용자 답을 기다린다
  let asked: AskUserQuestion | undefined;

  const finish = (status: AgentResult['status'], summary: string, question?: AskUserQuestion): void => {
    result = {
      status,
      summary,
      changedFiles: workspace.changedFiles(),
      ...(question ? { question } : {}),
      report: gate?.report,
      checks: gate?.checks,
      passedStages: gate ? [...gate.passedStages] : undefined,
      ...(options.verify === 'light' ? { verify: 'light' as const } : {}),
      ...(gate && gate.skippedStages.length > 0 ? { skippedStages: [...gate.skippedStages] } : {}),
      verifyAttempts: gate?.attempts ?? 0,
      turns: completedTurns,
      usage,
      metrics: { ...metrics },
      threadId,
    };
    onEvent(status === 'failed' ? { type: 'failed', result } : { type: 'done', result });
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
          // 지연 기동 세션: 첫 파일 변경·샌드박스 도구일 때 샌드박스를 켠다. 게이트(계약 기준)는 그 뒤에 만들어진다
          if (options.ensureSandbox && (SANDBOX_TOOLS.has(name) || WRITE_TOOLS.has(name))) {
            await options.ensureSandbox();
            gate = await gateFor();
          }
          const toolStarted = performance.now();
          const outcome = await executeTool(name, args, context);
          metrics.toolMs += Math.round(performance.now() - toolStarted);
          onEvent({ type: 'tool_result', name, ok: outcome.ok, content: outcome.content, chars: outcome.content.length, rawChars: outcome.rawChars ?? outcome.content.length });
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
    let pending = `${buildSystemPrompt(project, { toolName, selfCheck: options.selfCheck })}${workflowContext(project)}${projectGuideSection(guide)}\n\n${ask ? buildAskRequest(request, { toolName, ...(research ? { research: { webToolsAvailable: false } } : {}) }) : request}`;
    let announced = false;

    for (let turn = 1; turn <= maxTurns; turn++) {
      signal?.throwIfAborted();
      onEvent({ type: 'turn', turn });
      // Codex는 턴 사이에만 지시를 넣을 수 있다. 다음 턴 입력 뒤에 붙여 게이트 피드백보다 뒤에 오게 한다
      const steeringTexts = takeSteering(steering);
      if (steeringTexts.length > 0) {
        pending = `${pending}\n\n${formatSteering(steeringTexts)}`;
        onEvent({ type: 'steer_applied', count: steeringTexts.length });
      }
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
              onEvent({ type: 'session', backend: BACKEND, model: model ?? '계정 기본 모델', effort });
            }
            break;

          case 'turn.completed': {
            // Codex 이벤트는 모델 호출 단위가 아니라 턴 단위라 턴 수로 센다
            completedTurns += 1;
            metrics.modelCalls = completedTurns;
            addUsage(usage, event.usage);
            const turnContext = contextTokens(event.usage);
            metrics.maxContextTokens = Math.max(metrics.maxContextTokens, turnContext);
            onEvent({ type: 'tokens', usage: { ...usage } });
            // 턴 하나의 사용량. 누적값(tokens)과 달리 턴별 컨텍스트 증가를 볼 수 있다
            onEvent({
              type: 'turn_usage',
              turn: completedTurns,
              inputTokens: event.usage.input_tokens,
              outputTokens: event.usage.output_tokens,
              cacheReadTokens: event.usage.cached_input_tokens ?? 0,
              cacheWriteTokens: event.usage.cache_write_input_tokens ?? 0,
              contextTokens: turnContext,
            });
            break;
          }

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

      // 되묻고 멈추기: 질문이 나오면 이 턴이 끝날 때 멈춘다.
      // Codex는 대화를 이어받지 못하므로 다음 요청은 codex.recent 요약 맥락으로 이어진다(studio가 붙인다).
      // 질문 전에 파일을 바꿨다면 그 변경도 게이트를 돌린다(변경이 없으면 돌리지 않는다)
      if (asked) {
        const openGate = gate;
        if (openGate && workspace.changedFiles().length > 0) {
          const gateStarted = performance.now();
          await openGate.check();
          metrics.gateMs += Math.round(performance.now() - gateStarted);
        }
        finish('awaiting_input', asked.question, asked);
        break;
      }

      // 모델이 턴을 끝냈다 → 질문이면 답이 곧 결과이고, 만들기면 검증 게이트.
      // 지연 기동 세션이 아무것도 바꾸지 않았으면 게이트가 없다 → 샌드박스 없이 끝난다
      const activeGate = gate;
      if (!activeGate) {
        finish('done', lastText);
        break;
      }
      const gateStarted = performance.now();
      const outcome = await activeGate.check();
      metrics.gateMs += Math.round(performance.now() - gateStarted);
      if (outcome.kind === 'pass') {
        if (activeGate.verified) onEvent({ type: 'stage', stage: 'checkpoint', source: 'platform' });
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
