import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import type { Effort } from './anthropic-client';
import { serialQueue } from './claude-code-runner';
import type { EscalationPolicy } from './escalation';
import { recheckGateOnMaxTurns, VerificationGate } from './gate';
import { emptyUsage, type AgentEvent, type AgentResult, type AgentUsage, type RunAgentOptions, type RunMetrics } from './loop';
import { startToolServer } from './mcp-http-server';
import { loadProjectGuide } from './project-guide';
import { buildAskRequest, buildSystemPrompt, projectGuideSection } from './prompts';
import { buildTools, executeTool, SANDBOX_TOOLS, WRITE_TOOLS, type ToolContext, type ToolOutcome } from './tools';
import { fetchContract } from './verify';
import { executionPolicyFor, workflowContext } from './workflow';
import { syncExternalChanges, Workspace } from './workspace';

/** MCP 서버 이름. 모델에게 보이는 도구 이름이 `mcp__b_studio__<도구>`가 된다(0단계 근거: `cmd mcp list`·명령 문서) */
const SERVER = 'b_studio';
/** MCP bearer 토큰을 넘기는 환경 변수 이름. 토큰 값은 파일·로그에 남기지 않는다 */
const TOKEN_ENV = 'B_STUDIO_MCP_TOKEN';
/** 화면 표기. 제품 이름을 그대로 쓰지 않는다(로컬 Claude Agent·ChatGPT 러너와 같은 규칙) */
const BACKEND = '로컬 Command Code Agent';
/** 실제 실행할 CLI. 이 PC에 로그인돼 있는 `cmd`를 그대로 쓴다 */
const COMMAND = 'cmd';

/** 실행마다 만드는 작업 폴더(cwd)의 접두어 */
const WORKDIR_PREFIX = 'b-studio-commandcode-';
/** 실행마다 만드는 임시 HOME의 접두어. cmd가 사용자 설정 대신 이 폴더를 읽는다 */
const HOME_PREFIX = 'b-studio-commandcode-home-';

/** 사용 한도 문구 판정. 실패 분류 기준은 이 한 곳에만 둔다 */
const USAGE_LIMIT = /usage[ _]limit|rate[ _]limit/i;

/** NDJSON 진행 줄에 실리는 `cmd`의 이벤트. 필요한 것만 좁혀 정의한다 */
interface CommandCodeEvent {
  type: string;
  [key: string]: unknown;
}

interface CommandCodeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** `--output-format json`의 마지막 결과 줄 */
interface CommandCodeResultLine {
  subtype?: 'success' | 'error' | 'max_turns';
  sessionId?: string;
  stopReason?: string;
  usage?: CommandCodeUsage;
  durationMs?: number;
  finalText?: string;
  error?: string;
}

/** 하위 프로세스 실행 결과. NDJSON 줄 스트림과 종료 코드를 돌려준다 */
export interface CommandCodeProcessResult {
  /** stdout의 NDJSON 줄 스트림. 한 줄에 한 객체 */
  lines: AsyncIterable<string>;
  /** 프로세스 종료 코드 */
  exitCode: Promise<number>;
  /** 실패 이유 보강용 stderr. 없으면 결과 줄의 error만 쓴다 */
  stderr?: () => Promise<string>;
}

/**
 * 하위 프로세스 실행을 바꿔 끼우는 지점. 실제로는 `cmd`를 띄우고, 테스트는 가짜를 넣는다.
 * 인자·환경·cwd를 받아 NDJSON 줄 스트림과 종료 코드를 돌려준다.
 */
export interface CommandCodeProcess {
  run(input: { args: string[]; cwd: string; env: Record<string, string>; signal?: AbortSignal }): CommandCodeProcessResult;
}

const DEFAULT_PROCESS: CommandCodeProcess = {
  run({ args, cwd, env, signal }) {
    // stdin은 닫아 둔다: 파이프를 열어 두면 cmd가 파이프 입력을 기다린다. stdout만 NDJSON으로 읽는다
    // env는 문자열 맵이면 충분한데, 소비자(studio)의 tsconfig는 Next가 NODE_ENV를 필수로 좁힌 ProcessEnv를 쓴다. 그래서 여기서 맞춰 넘긴다
    const child = spawn(COMMAND, args, { cwd, env: env as unknown as NodeJS.ProcessEnv, signal, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessByStdio<null, Readable, Readable>;
    child.stdout.setEncoding('utf8');
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const lines = (async function* (): AsyncGenerator<string> {
      const reader = readline.createInterface({ input: child.stdout });
      try {
        for await (const line of reader) yield line;
      } finally {
        reader.close();
      }
    })();
    const exitCode = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    // signal이 끊기면 spawn이 이 child에 'error'(AbortError)를 낸다. 호출하는 쪽은 NDJSON 줄(`lines`)을
    // 다 읽은 뒤에야 `exitCode`를 기다리므로, 그 사이에 이 Promise가 먼저 거부되면 아직 아무도 받지 않은
    // 상태가 된다 — Node 기본값(처리하지 않은 거부 → 예외로 격상)이 전체 프로세스를 죽인다(실측: AbortError로
    // 벤치 프로세스가 종료 코드 1로 죽음). 빈 catch로 "처리됨"만 표시해 두고, 실제 값은 그대로 아래 `await exitCode`가 받는다
    exitCode.catch(() => {});
    return { lines, exitCode, stderr: async () => stderr };
  },
};

export interface CommandCodeRunOptions extends Omit<RunAgentOptions, 'client' | 'conversation' | 'escalation'> {
  /** 이전 실행의 Command Code 세션 id. 주면 `--resume <id> --fork-session`으로 갈라 이어받는다(Codex와 달리 지원) */
  resume?: string;
  /** 넘기지 않으면 로그인한 계정의 기본 모델(DeepSeek)을 쓴다 */
  model?: string;
  /** 이 러너는 모델 승격을 지원하지 않는다. 받으면 무시하지 않고 경고 이벤트를 한 번 알린다(codex 러너와 같다) */
  escalation?: EscalationPolicy;
  /** 노력 단계. 넘기면 `--effort <level>`로 전달한다(0단계 근거: `cmd --help`, `low|medium|high|xhigh|max`) */
  effort?: Effort;
  /**
   * 세션마다 고정된 상태 폴더. 주면 HOME을 `<stateDir>/home`, 작업 폴더(cwd)를 `<stateDir>/work`로 고정한다.
   *
   * **왜 필요한가.** cmd는 대화 세션을 `$HOME/.commandcode/projects/<cwd를 바꾼 이름>/` 아래에 저장한다.
   * 실행마다 HOME과 cwd가 바뀌면 다음 실행이 `--resume`으로 세션을 찾지 못한다(실측: `No session "…" found to resume.`).
   * 같은 실행 안의 게이트 재시도는 HOME·cwd가 같아 그대로 되지만, **다음 실행**(같은 레인의 다음 작업, 사용자의 후속 요청)은 안 된다.
   * 그래서 이어받으려면 두 값이 실행 사이에도 같아야 하고, 그 자리를 정하는 것이 이 옵션이다.
   *
   * 임시 HOME을 쓰는 목적(사용자 설정·스킬·훅·등록한 MCP 서버가 모델에 실리지 않게 격리)은 그대로 지켜진다.
   * 여전히 사용자의 `~/.commandcode/auth.json`만 심볼릭 링크로 빌려오고, 작업 폴더는 실행마다 비운다.
   *
   * 주지 않으면 예전처럼 실행마다 임시 폴더를 만들고 끝나면 지운다(그때는 `resume`을 넘겨도 이어받지 못한다).
   */
  stateDir?: string;
  /** 하위 프로세스 실행을 바꿔 끼우는 지점(테스트용 가짜) */
  process?: CommandCodeProcess;
}

export interface CommandCodeRunResult extends AgentResult {
  /** 이번 실행이 만든 세션. 다음 요청에 `resume`으로 넘겨 갈라 이어받을 수 있다 */
  sessionId?: string;
}

/**
 * 이 PC에 로그인한 Command Code CLI(`cmd`)로 요청을 처리한다. API 키 없이 개인 계정(DeepSeek·무료 모델)으로 돌릴 수 있다.
 *
 * 도구 경계를 세 겹으로 막는다.
 *  1. 빈 HOME(`stateDir`을 주면 세션마다 고정된 `<stateDir>/home`, 아니면 실행마다 만드는 임시 폴더)을 쓰고
 *     사용자 `~/.commandcode/auth.json`만 심볼릭 링크로 빌려온다.
 *     그대로 두면 사용자 설정·스킬·mods·taste·등록한 MCP 서버(파일 편집 도구를 가진 것 포함)가 모델에 실려
 *     b-studio 도구를 거치지 않고 작업 공간을 바꿀 수 있다. Codex 러너의 임시 `CODEX_HOME`과 같은 목적이다.
 *  2. 작업 폴더(cwd)를 빈 폴더(`stateDir`을 주면 `<stateDir>/work`를 비워서, 아니면 실행마다 만드는 임시 폴더)로 두고, 그 폴더의 `.commandcode/settings.json`에
 *     `permissions.allow: ["mcp__b_studio__*"]`만 둔다. 헤드리스 기본은 승인이 필요한 모든 호출(파일 쓰기·셸·
 *     allow 규칙 없는 MCP)을 거부하므로, b-studio 도구만 통과한다. `--yolo`·`--tools-all`은 절대 붙이지 않는다.
 *  3. 실제 변경은 b-studio 도구(MCP 서버)만 호스트의 작업 공간에 쓴다.
 *
 * 완료 판정은 직접 만든 루프·Codex 러너와 같은 검증 게이트가 한다. `cmd -p` 한 번이 모델 턴 하나이고,
 * 턴이 끝날 때마다 게이트를 돌리고 실패하면 같은 세션을 `--resume <id> --fork-session`으로 이어 피드백을 넣는다.
 *
 * **이어받기에는 `stateDir`이 필요하다.** `resume`은 같은 실행 안의 재시도에는 그대로 쓰이고, 실행 사이(다음 작업,
 * 후속 요청)를 이으려면 HOME과 cwd가 같아야 한다. 상태 폴더 없이 `resume`만 받으면 이어받을 수 없으므로
 * `--resume`을 넘기지 않고 새 대화로 시작하며 warning 이벤트 한 번으로 알린다(조용히 실패시키지 않는다).
 *
 * 레인 조율 게시판(`board`)은 codex·claude-code 러너와 같은 규칙으로 받는다: 넘어오면 `buildTools`에 넘겨
 * post_note·read_notes를 도구 목록에 더하고(S2·S5처럼 읽기 전용이면 post_note는 뺀다), 실행 컨텍스트에도 실어
 * `executeTool`이 그 레인 신원으로 게시판을 읽고 쓰게 한다(이슈 #428, E12).
 *
 * 아직 다른 러너가 받는 것을 받지 않는다: 되묻기(`interactive`), 실행 중 지시(`steering`).
 * 도구 목록을 만들 때 그 옵션들이 빠지고, 지시는 넣어도 실행 끝에 적용되지 못한 것으로 안내된다.
 * 모델 승격(`escalation`)은 타입으로는 받지만 지원하지 않는다 — 무시하지 않고 warning 이벤트로 알린다(codex 러너와 같다).
 */
export async function runCommandCodeAgent(options: CommandCodeRunOptions): Promise<CommandCodeRunResult> {
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
    stateDir,
    process: proc = DEFAULT_PROCESS,
    intent = 'build',
    research = false,
  } = options;
  signal?.throwIfAborted();
  const ask = intent === 'ask';

  // 이어받기를 요청했는데 상태 폴더가 없으면 이어받을 수 없다(HOME·cwd가 실행마다 달라져 cmd가 세션을 찾지 못한다).
  // 조용히 실패시키지 않고 한 번 알린 뒤 새 대화로 시작한다
  const canResume = resume !== undefined && stateDir !== undefined;
  if (resume !== undefined && stateDir === undefined) {
    onEvent({ type: 'warning', message: '이 실행은 이전 대화를 이어받지 못합니다: 상태 폴더 없음' });
  }
  // 이 러너는 모델 승격을 지원하지 않는다. 받으면 무시하지 않고 경고 이벤트를 한 번 알린다(codex 러너와 같은 규칙).
  // 벤치는 --escalate-to를 claude-code에서만 받으므로 여기까지 오지 않지만, 옵션을 직접 넘기는 경로도 조용히 넘기지 않는다
  if (options.escalation) onEvent({ type: 'warning', message: '로컬 Command Code Agent 러너는 모델 승격을 지원하지 않습니다. 승격 옵션을 무시합니다' });

  const workspace = new Workspace(project.root);
  // 요구사항 문서의 기준을 고정한다(게이트가 사람 확인 기록 위조를 견주는 기준, ADR-157). 호출자가 마지막 체크포인트의
  // 문서를 넘겼으면 그것을, 아니면 지금 디스크의 문서를 쓴다
  workspace.beginRun(options.requirementsBaseline);
  // 이번 실행 전부터 작업 트리에 있던 변경(보관본 되살리기 등)을 먼저 알려, 에이전트가 이번 실행에서 파일을
  // 하나도 건드리지 않아도 게이트가 "검증할 변경 없음"으로 건너뛰지 않게 한다(ADR-131)
  if (options.externalChanges?.length) syncExternalChanges(workspace, options.externalChanges);
  // 질문 모드는 파일을 바꾸지 않으므로 계약 기준을 잡거나 게이트를 돌리지 않는다.
  // 지연 기동 세션(ensureSandbox)은 게이트를 여기서 만들지 않고, 첫 파일 변경·샌드박스 도구 때 샌드박스를 켠 뒤에 만든다
  let gate: VerificationGate | undefined;
  let gatePromise: Promise<VerificationGate> | undefined;
  const gateFor = (): Promise<VerificationGate> =>
    (gatePromise ??= VerificationGate.create({ project, sandbox, workspace, allowBreaking, maxVerifyAttempts, verify: options.verify, fetcher, pageFetcher, browserRunner, signal, onServiceStatus, onEvent }));
  if (!ask && !options.ensureSandbox) gate = await gateFor();
  // 프로젝트 루트(project.root)의 AGENTS.md를 읽는다(ADR-077). 이 러너의 자체 workdir과는 다른 폴더다
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
    // 직접 만든 루프와 같은 기본값. 없으면 studio.yaml의 워크플로 정책이 이 경로에만 빠진다
    policy: options.policy ?? executionPolicyFor(project),
    approvalToken: options.approvalToken,
    requestApproval: options.requestApproval,
    board: options.board,
    onPolicyDecision: (decision) => onEvent({ type: 'policy', ...decision }),
    // 지연 기동 세션이면 샌드박스 도구를 실행하기 직전에 켠다(핸들러가 게이트 생성까지 한다)
    ...(options.ensureSandbox ? { ensureSandbox: options.ensureSandbox } : {}),
  };
  // 조율 게시판은 Claude Code·Codex 러너와 같게, 켠 실행에만 도구를 더한다
  const specs = buildTools(project, { ...(options.board ? { board: options.board, allowedTools: context.policy?.allowedTools } : {}) });
  const toolName = (name: string) => `mcp__${SERVER}__${name}`;
  const isStudioTool = (name: string) => name.startsWith(`mcp__${SERVER}__`);

  // 도구 호출은 모델이 낸 순서대로 하나씩 실행한다. 로컬 Claude Agent·Codex 러너와 같은 큐를 쓴다
  const serial = serialQueue();
  // 실행 지표. modelMs는 그 이벤트에 시간이 있을 때만 더한다(한 번도 없으면 비워 둔다 = "재지 않음")
  const metrics: RunMetrics = { modelCalls: 0, maxContextTokens: 0, toolMs: 0, gateMs: 0, ...(guide ? { guideChars: guide.charsUsed } : {}) };

  // 작업 폴더(cwd). project.root를 cwd로 주면 모델이 내장 도구로 작업 공간을 직접 바꿀 수 있다.
  // 상태 폴더를 주면 그 아래 고정 경로를 쓴다 — cmd가 세션을 cwd로 찾으므로 다음 실행에서도 같아야 이어받는다
  const workdir = stateDir ? path.join(stateDir, 'work') : await mkdtemp(path.join(tmpdir(), WORKDIR_PREFIX));
  let toolServer: Awaited<ReturnType<typeof startToolServer>> | undefined;
  let home: string | undefined;
  let result: CommandCodeRunResult | undefined;
  const usage = emptyUsage();
  // 모델 이름별 사용량(벤치·스튜디오 사용량 집계가 CLI 레인 사용량을 모델별로 더하는 자리, 이슈 #428).
  // 이 러너는 실행 내내 모델을 하나만 쓰므로(승격 미지원) usage와 같은 객체를 참조로 공유해 갱신을 한 곳에서만 한다.
  // 모델을 고르지 않았으면(계정 기본) 백엔드 이름으로 키를 만든다
  metrics.usageByModel = { [model ?? 'commandcode:default']: usage };
  let completedTurns = 0;
  let lastText = '';
  /** 이어받기·재시도에 쓰는 현재 세션 id. 첫 턴은 이어받을 수 있을 때만 options.resume에서 시작한다 */
  let sessionId: string | undefined = canResume ? resume : undefined;
  let announced = false;
  // b-studio 도구가 아닌 호출을 한 번만 기록한다
  const foreignTools = new Set<string>();
  // 원인 2(E12b, 08:02~08:36 멈춘 레인) 대응: 레인이 중단·시간 초과로 끝날 때 마지막으로 무엇을 하고 있었는지
  // 남긴다. 그 사고에서는 MCP 도구 호출이 아니라 완료된 도구 결과 뒤 다음 모델 턴이 32분 동안 조용했다 —
  // 재현하지 못했으므로(실 CLI 호출 금지) 다음에 같은 일이 나면 여기 남긴 사실로 가릴 수 있게 한다
  let lastToolCall: { name: string; input: unknown; at: number } | undefined;
  let pendingToolCall: { name: string; input: unknown; at: number } | undefined;
  let currentTurn = 0;
  let turnStartedAt = 0;

  const finish = (status: AgentResult['status'], summary: string, failureReason?: AgentResult['failureReason']): void => {
    result = {
      status,
      summary,
      changedFiles: workspace.changedFiles(),
      report: gate?.report,
      checks: gate?.checks,
      ...(gate?.lastOutcome ? { gateOutcome: gate.lastOutcome } : {}),
      passedStages: gate ? [...gate.passedStages] : undefined,
      ...(options.verify === 'light' ? { verify: 'light' as const } : {}),
      ...(gate && gate.skippedStages.length > 0 ? { skippedStages: [...gate.skippedStages] } : {}),
      verifyAttempts: gate?.attempts ?? 0,
      turns: completedTurns,
      usage,
      metrics: { ...metrics },
      sessionId,
      ...(failureReason ? { failureReason } : {}),
    };
    onEvent(status === 'done' ? { type: 'done', result } : { type: 'failed', result });
  };

  /**
   * b-studio 도구가 아닌 도구 이벤트를 실제 일어난 일대로 감사 기록한다.
   *  - `tool_denied` → `policy` deny(거부)
   *  - `tool_running` 뒤 `tool_completed`/`tool_errored` → `policy` allow(내장 도구가 b-studio 도구 밖에서 실제 실행됨)
   * `tool_running`만으로는 결정을 알 수 없으므로 결과 이벤트에서 기록한다. 호출 하나(toolCallId)당 한 번만 남긴다.
   * (b-studio MCP 도구는 서버 핸들러가 이미 tool_call/tool_result로 알리므로 여기서는 건드리지 않는다)
   */
  const recordForeignTool = (event: CommandCodeEvent): void => {
    const name = typeof event.toolName === 'string' ? event.toolName : '';
    if (!name || isStudioTool(name)) return;
    const id = typeof event.toolCallId === 'string' ? event.toolCallId : name;
    if (foreignTools.has(id)) return;
    switch (event.type) {
      case 'tool_denied':
        foreignTools.add(id);
        onEvent({ type: 'policy', tool: name, decision: 'deny', reason: typeof event.denyMessage === 'string' ? event.denyMessage : 'Command Code가 이 도구 호출을 거부했습니다' });
        break;
      case 'tool_completed':
      case 'tool_errored':
        foreignTools.add(id);
        onEvent({ type: 'policy', tool: name, decision: 'allow', reason: '내장 도구가 실행됨(b-studio 도구 밖)' });
        break;
      default:
        // tool_running 등은 아직 결정이 아니다. 완료·오류·거부 이벤트에서 기록한다
        break;
    }
  };

  try {
    toolServer = await startToolServer({
      name: SERVER,
      specs,
      run: (name, args) =>
        serial(async (): Promise<ToolOutcome> => {
          // 취소한 뒤 대기열에 남은 호출은 파일을 건드리지 않고 끝낸다
          signal?.throwIfAborted();
          onEvent({ type: 'tool_call', name, input: args });
          const toolStarted = performance.now();
          lastToolCall = { name, input: args, at: toolStarted };
          pendingToolCall = lastToolCall;
          // 지연 기동 세션: 첫 파일 변경·샌드박스 도구일 때 샌드박스를 켠다. 게이트(계약 기준)는 그 뒤에 만들어진다
          if (options.ensureSandbox && (SANDBOX_TOOLS.has(name) || WRITE_TOOLS.has(name))) {
            await options.ensureSandbox();
            gate = await gateFor();
          }
          const outcome = await executeTool(name, args, context);
          pendingToolCall = undefined;
          metrics.toolMs += Math.round(performance.now() - toolStarted);
          onEvent({ type: 'tool_result', name, ok: outcome.ok, content: outcome.content });
          return outcome;
        }),
    });

    // 고정 작업 폴더는 실행 시작 때 안을 비운다. "빈 작업 폴더" 성질(모델이 여기서 만든 파일이 프로젝트에 반영되지 않는다)을 그대로 유지한다
    if (stateDir) await emptyDirectory(workdir);
    // 작업 폴더(cwd)에 실행별 MCP 설정과 허용 규칙을 둔다. 사용자 설정은 건드리지 않는다
    await writeFile(path.join(workdir, '.mcp.json'), mcpJson(toolServer.url));
    await mkdir(path.join(workdir, '.commandcode'), { recursive: true });
    await writeFile(path.join(workdir, '.commandcode', 'settings.json'), settingsJson());

    // HOME. 상태 폴더를 주면 고정한다(cmd가 세션·프로젝트 기록을 여기 아래에 쓴다).
    // 작업 폴더와 다른 폴더다(cmd가 세션·로그를 여기에 쓰므로 작업 폴더와 섞지 않는다)
    home = stateDir ? path.join(stateDir, 'home') : await mkdtemp(path.join(tmpdir(), HOME_PREFIX));
    await mkdir(home, { recursive: true });
    await linkAuthFile(home);

    // cmd에는 systemPrompt 자리가 없어 프로젝트 규칙·도구 이름을 첫 사용자 메시지 앞에 붙인다
    let pending = `${buildSystemPrompt(project, { toolName, selfCheck: options.selfCheck })}${workflowContext(project)}${projectGuideSection(guide)}\n\n${ask ? buildAskRequest(request, { toolName, ...(research ? { research: { webToolsAvailable: false } } : {}) }) : request}`;

    for (let turn = 1; turn <= maxTurns; turn++) {
      signal?.throwIfAborted();
      onEvent({ type: 'turn', turn });
      currentTurn = turn;
      turnStartedAt = performance.now();
      // 이 턴에서 모델이 아직 도구를 부르지 않았을 수 있다(예: 다음 모델 응답을 기다리는 동안 멈춤 — E12b 실측).
      // 그 경우 아래 진단 메시지는 "도구 호출 없음"으로 남아, 도구가 아니라 모델 호출 쪽에서 멈췄다는 단서가 된다
      pendingToolCall = undefined;

      const { lines, exitCode, stderr } = proc.run({ args: commandArgs({ pending, sessionId, model, effort, maxTurns }), cwd: workdir, env: { ...processEnv(), HOME: home, [TOKEN_ENV]: toolServer.token }, signal });
      // 아래 NDJSON 줄(`lines`)을 다 읽기 전까지는 `exitCode`를 기다리지 않는다. 그 사이 signal이 끊겨
      // `exitCode`가 먼저 거부되면(`process` 구현이 DEFAULT_PROCESS든 테스트 가짜든) 아직 아무도 받지 않은
      // 상태가 되어 Node가 처리하지 않은 거부를 예외로 격상시켜 프로세스 전체를 죽인다(실측). `proc.run`
      // 구현과 무관하게 여기서 한 번 더 "처리됨"으로 표시해 둔다(실제 값은 그대로 아래 `await exitCode`가 받는다)
      exitCode.catch(() => {});

      let failure: string | undefined;
      let turnText = '';
      let resultLine: CommandCodeResultLine | undefined;

      for await (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: { type?: string; event?: CommandCodeEvent } & CommandCodeResultLine;
        try {
          parsed = JSON.parse(trimmed) as typeof parsed;
        } catch {
          // NDJSON이 아닌 줄(경고 등)은 무시한다
          continue;
        }
        if (parsed.type === 'result') {
          resultLine = parsed;
          continue;
        }
        if (parsed.type !== 'event' || !parsed.event) continue;
        switch (parsed.event.type) {
          case 'run_start':
            if (typeof parsed.event.sessionId === 'string') sessionId = parsed.event.sessionId;
            // 턴마다 다시 올 수 있으므로 실행마다 한 번만 알린다
            if (!announced) {
              announced = true;
              onEvent({ type: 'session', backend: BACKEND, model: model ?? '계정 기본 모델', effort });
            }
            break;
          case 'model_request_end': {
            metrics.modelCalls += 1;
            metrics.maxContextTokens = Math.max(metrics.maxContextTokens, contextTokens(parsed.event.usage as CommandCodeUsage));
            const ms = durationOf(parsed.event);
            if (ms !== undefined) metrics.modelMs = (metrics.modelMs ?? 0) + Math.round(ms);
            break;
          }
          case 'message_end': {
            const text = messageText(parsed.event.content);
            if (text) {
              turnText = text;
              onEvent({ type: 'text', text });
            }
            break;
          }
          case 'tool_running':
          case 'tool_completed':
          case 'tool_errored':
          case 'tool_denied':
            recordForeignTool(parsed.event);
            break;
          default:
            break;
        }
      }

      const code = await exitCode;
      const stderrText = stderr ? await stderr().catch(() => '') : '';
      const message = (resultLine?.error ?? stderrText).trim();

      // 사용량은 결과 줄의 값(이 실행 합계)을 더한다. 0단계 probe 결론: 실행 단위 합계, 세션 누적 아님
      addUsage(usage, resultLine?.usage);
      onEvent({ type: 'tokens', usage: { ...usage } });

      // 실패로 끝난 실행은 완료된 턴으로 세지 않는다(Codex 러너와 같은 규칙)
      if (resultLine?.subtype === 'error') failure = classifyFailure({ exitCode: code, message, maxTurns });
      else if (code !== 0) failure = classifyFailure({ exitCode: code, message, maxTurns });
      if (failure) {
        // Command Code 자신이 턴 상한(종료 코드 8)으로 끝냈어도, 바로 실패로 끝내지 않고 지금까지의 변경이
        // 게이트를 통과하는지 한 번 더 본다(ADR-131). 다른 실패 사유는 그대로 바로 끝낸다
        if (code === 8) {
          const gateStarted = performance.now();
          const recheck = await recheckGateOnMaxTurns(gate, maxTurns, onEvent);
          metrics.gateMs += Math.round(performance.now() - gateStarted);
          if (recheck.pass) finish('done', recheck.summary);
          else finish('failed', recheck.summary, 'max_turns');
          break;
        }
        finish('failed', failure);
        break;
      }
      completedTurns += 1;

      const text = resultLine?.finalText || turnText;
      if (text) lastText = text;

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
      // 게이트 실패 → 같은 세션을 갈라 이어받아 피드백을 넣는다
      lastText = '';
      pending = outcome.feedback;
    }
    if (!result) {
      // 턴 상한에 걸렸다. 바로 실패로 끝내지 않고 지금까지의 변경이 게이트를 통과하는지 한 번 더 본다(ADR-131)
      const gateStarted = performance.now();
      const recheck = await recheckGateOnMaxTurns(gate, maxTurns, onEvent);
      metrics.gateMs += Math.round(performance.now() - gateStarted);
      if (recheck.pass) finish('done', recheck.summary);
      else finish('failed', recheck.summary, 'max_turns');
    }
  } finally {
    // 원인 2 대응 진단: 중단(시간 초과 포함)으로 끝나면 마지막으로 무엇을 하고 있었는지 한 줄 남긴다.
    // result가 이미 났으면(정상 종료) 남기지 않는다 — 중단이 아니라 끝난 뒤의 signal 상태일 수 있다
    if (signal?.aborted && !result) {
      const waitedMs = turnStartedAt > 0 ? Math.round(performance.now() - turnStartedAt) : undefined;
      const toolDetail = pendingToolCall
        ? `대기 중이던 도구 호출: ${pendingToolCall.name}(${summarizeToolInput(pendingToolCall.input)}), 호출 후 ${Math.round(performance.now() - pendingToolCall.at)}ms`
        : lastToolCall
          ? `마지막으로 끝난 도구 호출: ${lastToolCall.name}(${summarizeToolInput(lastToolCall.input)}). 그 뒤로는 도구를 부르지 않았다(다음 모델 응답을 기다리는 중이었을 수 있다)`
          : '도구 호출 기록이 없다(첫 모델 응답을 기다리는 중이었을 수 있다)';
      onEvent({
        type: 'warning',
        message: `${currentTurn}번째 턴(시작 후 ${waitedMs ?? '?'}ms)에서 중단됐습니다. ${toolDetail}`,
      });
    }
    // 프로세스를 닫아도 이미 시작한 도구 핸들러는 이어서 돈다. 호출한 쪽이 변경을 되돌리기 전에 끝나기를 기다린다
    await serial.idle();
    await toolServer?.close();
    // 상태 폴더를 쓰면 HOME·작업 폴더를 지우지 않는다. cmd가 세션을 HOME 아래(`$HOME/.commandcode/projects/<cwd 이름>`)에
    // 두므로 지우면 다음 실행이 이어받지 못한다. 주지 않았을 때만 예전처럼 임시 폴더를 지운다
    if (!stateDir) {
      // 심볼릭 링크만 지운다. 링크가 가리키는 원본 auth.json은 그대로 남는다
      if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
      // cmd가 작업 폴더에 남긴 것(세션 파일·로그)이 있어도 작업 공간과 무관하므로 통째로 지운다
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }

  signal?.throwIfAborted();
  if (!result) throw new Error('Command Code가 결과를 보내지 않고 종료됐습니다');
  return result;
}

/** `cmd -p` 한 번의 인자. `--yolo`·`--tools-all`은 쓰지 않는다: 헤드리스 기본 차단을 그대로 유지해야 b-studio 도구 경계가 선다 */
function commandArgs(input: { pending: string; sessionId?: string; model?: string; effort?: Effort; maxTurns: number }): string[] {
  const args = ['-p', input.pending, '--output-format', 'json', '--skip-onboarding', '--no-auto-update', '--no-skills', '--max-turns', String(input.maxTurns)];
  if (input.model) args.push('-m', input.model);
  if (input.effort) args.push('--effort', input.effort);
  if (input.sessionId) args.push('--resume', input.sessionId, '--fork-session');
  return args;
}

/**
 * 실행별 `.mcp.json`. 토큰 값이 아니라 환경 변수 참조(`${B_STUDIO_MCP_TOKEN}`)를 적어 파일에 비밀이 남지 않게 한다.
 * cmd는 http 헤더의 `${VAR}`를 런타임에 해석한다(0단계 근거: `cmd mcp get`에서 헤더 유지 확인).
 */
function mcpJson(url: string): string {
  const config = { mcpServers: { [SERVER]: { transport: 'http', url, headers: { Authorization: `Bearer \${${TOKEN_ENV}}` } } } };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** 프로젝트 설정(작업 폴더 `.commandcode/settings.json`). b-studio 도구만 허용 규칙으로 연다. 쓰기·셸 허용 규칙은 두지 않는다 */
function settingsJson(): string {
  return `${JSON.stringify({ permissions: { allow: [`mcp__${SERVER}__*`] } }, null, 2)}\n`;
}

/** 한 `model_request_end`의 입력 크기 = input + cache_read + cache_write. 로컬 Claude Agent·Codex 러너와 같은 규칙 */
function contextTokens(usage: CommandCodeUsage | undefined): number {
  return (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0);
}

function addUsage(total: AgentUsage, usage: CommandCodeUsage | undefined): void {
  total.inputTokens += usage?.inputTokens ?? 0;
  total.outputTokens += usage?.outputTokens ?? 0;
  total.cacheReadTokens += usage?.cacheReadTokens ?? 0;
  total.cacheWriteTokens += usage?.cacheWriteTokens ?? 0;
}

/** 이벤트에 시간이 실려 있으면 그 값, 없으면 undefined("재지 않음") */
function durationOf(event: CommandCodeEvent): number | undefined {
  for (const key of ['durationMs', 'elapsedMs', 'modelMs']) {
    const value = event[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** 중단 진단 메시지에 도구 호출 입력을 짧게 적는다. 비밀을 남기지 않으려고 길이만 자르고 값은 그대로 보여준다(비밀은 애초에 입력에 오지 않는다) */
function summarizeToolInput(input: unknown): string {
  try {
    const text = JSON.stringify(input) ?? String(input);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return '(직렬화할 수 없는 입력)';
  }
}

/** message_end의 content에서 텍스트 블록만 이어 붙인다 */
function messageText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text' && typeof (block as { text?: unknown }).text === 'string' ? [(block as { text: string }).text] : []))
    .join('\n')
    .trim();
}

/** 실패 분류. 종료 코드와 결과 줄 문구를 함께 본다(0단계: 종료 코드 5/10/3/8, usage limit 문구) */
function classifyFailure({ exitCode, message, maxTurns }: { exitCode: number; message: string; maxTurns: number }): string {
  const detail = message || `종료 코드 ${exitCode}`;
  if (exitCode === 5 || USAGE_LIMIT.test(message)) return `Command Code 사용 한도에 걸렸습니다: ${detail}`;
  if (exitCode === 10) return `Command Code 크레딧이 부족합니다: ${detail}`;
  if (exitCode === 3) return `Command Code에 로그인돼 있지 않습니다. 터미널에서 "${COMMAND} login"으로 로그인하세요`;
  if (exitCode === 8) return `최대 턴 수(${maxTurns})를 넘었습니다`;
  if (message) return message;
  return `Command Code가 종료 코드 ${exitCode}로 끝났습니다`;
}

/**
 * 샌드박스를 띄우기 전에 이 PC의 Command Code CLI가 로그인돼 있는지 확인한다.
 * `cmd status`만 부르므로 모델 호출도, 사용량도 쓰지 않는다. 토큰·계정 정보는 읽지 않는다.
 * (0단계 실측: 로그인 상태면 종료 코드 0, 아니면 1)
 */
export async function preflightCommandCode(
  { command = COMMAND, timeoutMs = 60_000 }: { command?: string; timeoutMs?: number } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await run(command, ['status'], timeoutMs);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Command Code CLI에 로그인돼 있지 않습니다. 터미널에서 "${command}"를 실행해 로그인하세요. (${describe(error)})` };
  }
}

export interface CommandCodeModel {
  id: string;
  description: string;
  group: string;
  free: boolean;
  isDefault: boolean;
}

/** `cmd --list-models` 텍스트를 파싱한다. 그룹 헤더와 `id  설명` 줄만 골라낸다(순수 함수). 같은 id가 여러 그룹에 나오면 첫 줄을 남기고, Decision models 그룹은 뺀다 */
export function parseCommandCodeModels(text: string): CommandCodeModel[] {
  const models = new Map<string, CommandCodeModel>();
  let group = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    // 첫 줄·꼬리말·사용 예시는 모델이 아니다
    if (line.startsWith('Available models')) continue;
    if (line.startsWith('Docs:')) continue;
    if (line.startsWith('cmd ')) continue;
    if (line.includes('Pass the full id')) continue;
    const match = /^(\S+)\s{2,}(.+)$/.exec(line);
    if (!match) {
      group = line.trim();
      continue;
    }
    const id = match[1]!;
    const description = match[2]!.trim();
    // Decision models(예: typesafe/jev)은 채팅·도구 호출 모델이 아니라 헤드리스 전용이라 목록에서 뺀다
    if (group.startsWith('Decision models')) continue;
    if (!models.has(id)) {
      models.set(id, { id, description, group, free: description.startsWith('FREE') || id.includes(':free') || group === 'Stealth', isDefault: /\(default\)$/.test(description) });
    }
  }
  return [...models.values()];
}

/** 이 PC에서 쓸 수 있는 모델 목록. `cmd --list-models` 텍스트를 파싱한다(모델 호출 없음) */
export async function listCommandCodeModels({ command = COMMAND, timeoutMs = 60_000 }: { command?: string; timeoutMs?: number } = {}): Promise<CommandCodeModel[]> {
  return parseCommandCodeModels(await run(command, ['--list-models'], timeoutMs));
}

function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return env;
}

/** 사용자 홈. 테스트가 process.env.HOME을 바꿔 원본 auth.json 위치를 바꿔 끼울 수 있다 */
function userHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

/** 고정 작업 폴더를 빈 상태로 만든다. 지난 실행이 남긴 모델 산출물과 cmd 설정을 지우고 새로 만든다 */
async function emptyDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

/**
 * 로그인 파일만 HOME으로 빌려온다. 파일 내용을 읽거나 복사하지 않고 심볼릭 링크 하나만 만든다.
 * cmd가 토큰을 갱신하면 이 링크를 통해 원본 `~/.commandcode/auth.json`이 그대로 갱신되므로, 링크가 끊어지지 않는 한 로그인은 유지된다.
 * 파일이 원래 없으면 링크를 만들지 않고 진행한다. 그 실행은 로그인 오류로 끝나고 기존 실패 경로를 탄다.
 *
 * 상태 폴더를 쓰면 같은 HOME을 다시 쓰므로 링크가 남아 있다. 매번 확인해 **없을 때만** 만든다(있으면 그대로 둔다).
 */
async function linkAuthFile(home: string): Promise<void> {
  const target = path.join(home, '.commandcode', 'auth.json');
  if (await exists(target)) return;
  const source = path.join(userHome(), '.commandcode', 'auth.json');
  if (!(await exists(source))) return;
  await mkdir(path.join(home, '.commandcode'), { recursive: true });
  await symlink(source, target);
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  );
}

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
