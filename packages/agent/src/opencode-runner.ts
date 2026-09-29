import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { serialQueue } from './claude-code-runner';
import type { EscalationPolicy } from './escalation';
import { VerificationGate } from './gate';
import { emptyUsage, type AgentEvent, type AgentResult, type AgentUsage, type RunAgentOptions, type RunMetrics } from './loop';
import { startToolServer } from './mcp-http-server';
import { buildAskRequest, buildSystemPrompt } from './prompts';
import { buildTools, executeTool, SANDBOX_TOOLS, WRITE_TOOLS, type ToolContext, type ToolOutcome } from './tools';
import { fetchContract } from './verify';
import { executionPolicyFor, workflowContext } from './workflow';
import { Workspace } from './workspace';

/** MCP 서버 이름. 모델에게 보이는 도구 이름이 `mcp__b_studio__<도구>`가 된다(0단계 근거: `opencode models`·`debug config`) */
const SERVER = 'b_studio';
/** MCP bearer 토큰을 넘기는 환경 변수 이름. 토큰 값은 파일·로그에 남기지 않는다 */
const TOKEN_ENV = 'B_STUDIO_MCP_TOKEN';
/** 화면 표기. 제품 이름을 그대로 쓰지 않는다(로컬 Claude Agent·Codex 러너와 같은 규칙) */
const BACKEND = '로컬 OpenCode Agent';
/** 실제 실행할 CLI. 이 PC에 설치된 `opencode`를 그대로 쓴다 */
const COMMAND = 'opencode';
/** 실행마다 만드는 작업 폴더(cwd)의 접두어 */
const WORKDIR_PREFIX = 'b-studio-opencode-';
/** 실행마다 만드는 임시 HOME의 접두어. opencode가 사용자 설정 대신 이 폴더를 읽는다 */
const HOME_PREFIX = 'b-studio-opencode-home-';
/** 실행마다 설정에 넣는 전용 에이전트 이름. 내장 도구를 모두 거부하고 b-studio 도구만 허용한다 */
const AGENT = 'b-studio';

/**
 * 무료 Zen 티어가 b-studio 구성을 거절할 때의 문구. 403으로 온다(3단계 실측: 내장 도구 구성을 좁히면 발생).
 *
 * b-studio는 "모델은 b-studio 도구만 쓴다"는 경계를 지키려고 내장 도구를 모두 끈다. 그 구성이 무료 Zen 티어에서 거절되므로,
 * 이 검사를 통과하려고 경계를 풀지 않는다 — 보안 후퇴이고 제공자 정책 우회다. 대신 이 사실을 그대로 알리고 재시도하지 않는다.
 */
const PROVIDER_GATE = /free tier can only be used from within opencode/i;
/** 무료 Zen 거절을 사람에게 설명하는 요약(한국어). 이 오류는 재시도하지 않는다 */
export const OPENCODE_PROVIDER_GATE_MESSAGE =
  'OpenCode 무료(Zen) 모델은 내장 도구를 끈 b-studio 구성에서 거절됩니다. `opencode auth login`으로 제공자에 로그인하고 그 제공자의 모델을 고르세요';
/** `listOpenCodeModels`가 무료 Zen 모델에 붙이는 쓸 수 없음 이유 */
export const OPENCODE_FREE_UNUSABLE_REASON = '무료 Zen 티어는 b-studio 구성(내장 도구 끔)을 거절합니다';
/** 모델을 고르지 않았을 때의 오류. 기본 모델을 추측하지 않는다(무료 Zen 모델을 기본값으로 두지 않는다) */
export const OPENCODE_MODEL_REQUIRED = 'OpenCode 모델을 골라야 합니다. -m <provider/model> 또는 B_STUDIO_OPENCODE_MODEL로 지정하세요';

/** 사용 한도 문구 판정. 실패 분류 기준은 이 한 곳에만 둔다(0단계: 종료 코드는 0/1/130뿐이고 한도·인증은 문구로 구분) */
const USAGE_LIMIT = /usage[ _]limit|rate[ _]limit|too many requests|\b429\b|사용 한도/i;
/** 크레딧 부족 문구 */
const INSUFFICIENT_CREDIT = /insufficient credits?|out of credits|크레딧이 부족/i;
/** 로그인·인증 실패 문구 */
const AUTH_FAILURE = /not authenticated|unauthorized|\b401\b|please (log|sign) ?in|no credentials|credentials/i;

/**
 * 오류 이벤트를 받은 뒤 자식이 스스로 끝나기를 기다리는 상한.
 * opencode는 이 오류 뒤에 종료하지 않고 멈출 수 있으므로(3단계 관찰) 이 시간 안에 마무리하고 자식을 죽인다.
 */
const EXIT_GRACE_MS = 2_000;

/** NDJSON 진행 줄에 실리는 opencode의 이벤트(`step_start`/`text`/`tool_use`/`step_finish`/`error`). 필요한 것만 좁혀 정의한다 */
interface OpenCodeEvent {
  type?: string;
  sessionID?: string;
  part?: OpenCodePart;
  /** `error` 이벤트에 실리는 실패 정보 */
  error?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

interface OpenCodePart {
  type?: string;
  sessionID?: string;
  text?: string;
  tool?: string;
  callID?: string;
  reason?: string;
  cost?: number;
  tokens?: OpenCodeUsage;
  time?: { start?: number; end?: number };
  state?: { status?: string; input?: unknown; output?: unknown; metadata?: unknown; title?: string };
}

interface OpenCodeUsage {
  total?: number;
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

/** 하위 프로세스 실행 결과. NDJSON 줄 스트림과 종료 코드를 돌려준다 */
export interface OpenCodeProcessResult {
  /** stdout의 NDJSON 줄 스트림. 한 줄에 한 객체 */
  lines: AsyncIterable<string>;
  /** 프로세스 종료 코드 */
  exitCode: Promise<number>;
  /** 실패 이유 보강용 stderr. 결과 줄이 없으므로 실패 분류에 쓴다 */
  stderr?: () => Promise<string>;
}

/**
 * 하위 프로세스 실행을 바꿔 끼우는 지점. 실제로는 `opencode`를 띄우고, 테스트는 가짜를 넣는다.
 * 인자·환경·cwd를 받아 NDJSON 줄 스트림과 종료 코드를 돌려준다.
 */
export interface OpenCodeProcess {
  run(input: { args: string[]; cwd: string; env: Record<string, string>; signal?: AbortSignal }): OpenCodeProcessResult;
}

const DEFAULT_PROCESS: OpenCodeProcess = {
  run({ args, cwd, env, signal }) {
    // stdin은 닫아 둔다: 파이프를 열어 두면 opencode가 파이프 입력을 기다린다. stdout만 NDJSON으로 읽는다
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
    return { lines, exitCode, stderr: async () => stderr };
  },
};

export interface OpenCodeRunOptions extends Omit<RunAgentOptions, 'client' | 'conversation' | 'escalation'> {
  /** 이전 실행의 opencode 세션 id. 주면 `--session <id> --fork`로 갈라 이어받는다 */
  resume?: string;
  /** 필수. 모델은 항상 `-m`으로 명시한다. 없으면 OPENCODE_MODEL_REQUIRED 오류를 낸다(기본 모델을 추측하지 않는다) */
  model?: string;
  /** 이 러너는 모델 승격을 지원하지 않는다. 받으면 무시하지 않고 경고 이벤트를 한 번 알린다(codex·Command Code 러너와 같다) */
  escalation?: EscalationPolicy;
  /**
   * 사용자 로그인 파일(`~/.local/share/opencode/auth.json`)을 임시 HOME으로 심볼릭 링크로 빌려온다. 기본 true.
   * 무료 Zen 모델은 이 구성에서 거절되므로(PROVIDER_GATE) 로그인한 제공자의 모델을 쓰는 것이 정상 경로다.
   * 파일이 없으면 링크하지 않는다(판단은 파일 존재만 본다). 파일을 읽거나 복사하지 않고 링크만 만든다.
   */
  linkAuth?: boolean;
  /**
   * 세션마다 고정된 상태 폴더. 주면 HOME(과 그 아래 XDG 경로들)을 `<stateDir>/home`, 작업 폴더(cwd)를 `<stateDir>/work`로 고정한다.
   *
   * **왜 필요한가.** OpenCode는 세션과 런타임 DB를 `$XDG_DATA_HOME/opencode/opencode.db`에 둔다. 실행마다 HOME·XDG가 바뀌면
   * 다음 실행이 `--session <id>`로 그 세션을 찾지 못한다(Command Code의 `No session … found to resume`와 같은 문제).
   * 같은 실행 안의 게이트 재시도는 HOME·cwd가 같아 그대로 되지만, **다음 실행**(같은 레인의 다음 작업, 사용자의 후속 요청)은 안 된다.
   *
   * 임시 HOME을 쓰는 목적(사용자 설정·플러그인·외부 스킬이 모델에 실리지 않게 격리)은 그대로 지켜진다.
   * 여전히 `linkAuth`일 때 사용자의 로그인 파일만 심볼릭 링크로 빌려오고, 작업 폴더는 실행마다 비운다.
   *
   * 주지 않으면 예전처럼 실행마다 임시 폴더를 만들고 끝나면 지운다(그때는 `resume`을 넘겨도 이어받지 못한다).
   */
  stateDir?: string;
  /** 하위 프로세스 실행을 바꿔 끼우는 지점(테스트용 가짜) */
  process?: OpenCodeProcess;
}

export interface OpenCodeRunResult extends AgentResult {
  /** 이번 실행이 만든 세션. 다음 요청에 `resume`으로 넘겨 갈라 이어받을 수 있다 */
  sessionId?: string;
}

/**
 * 이 PC에 설치된 OpenCode CLI(`opencode`)로 요청을 처리한다. 로그인 없이 무료 모델로 돌릴 수 있다.
 *
 * 도구 경계를 세 겹으로 막는다.
 *  1. 빈 HOME(`stateDir`을 주면 세션마다 고정된 `<stateDir>/home`, 아니면 실행마다 만드는 임시 폴더)을 쓰고 XDG 경로도 그 아래로 돌린다
 *     (HOME 격리의 XDG 기본값까지 덮어써 사용자가 전역으로 둔 XDG_* 값이 새지 않게 한다).
 *     그대로 두면 사용자 설정·플러그인·외부 스킬(`~/.claude`·`~/.agents`)이 모델에 실려 b-studio 도구를 거치지 않고 작업 공간을 바꿀 수 있다.
 *  2. 작업 폴더(cwd)를 빈 폴더(`stateDir`을 주면 `<stateDir>/work`를 비워서, 아니면 실행마다 만드는 임시 폴더)로 두고, 그 폴더의 `opencode.json`에 전용 에이전트 `b-studio`를 정의한다.
 *     그 에이전트는 `permission`에서 **넓은 규칙(`*`: deny)을 먼저, 좁은 허용(`b_studio_*`: allow)을 나중에** 둔다.
 *     opencode 권한 엔진은 "마지막으로 맞는 규칙"이 이기므로(0단계 근거) 이 순서라야 내장 도구는 전부 거부되고 b-studio 도구만 통과한다.
 *     `OPENCODE_CONFIG`로 그 파일을 명시하고 `OPENCODE_DISABLE_PROJECT_CONFIG`로 상위 폴더의 설정이 끼어들지 않게 한다.
 *  3. 실제 변경은 b-studio 도구(MCP 서버)만 호스트의 작업 공간에 쓴다.
 *
 * 완료 판정은 직접 만든 루프·Codex 러너와 같은 검증 게이트가 한다. `opencode run` 한 번이 모델 턴 하나이고,
 * 턴이 끝날 때마다 게이트를 돌리고 실패하면 같은 세션을 `--session <id> --fork`로 이어 피드백을 넣는다.
 *
 * **이어받기에는 `stateDir`이 필요하다.** `resume`은 같은 실행 안의 재시도에는 그대로 쓰이고, 실행 사이(다음 작업,
 * 후속 요청)를 이으려면 HOME·XDG가 같아야 한다. 상태 폴더 없이 `resume`만 받으면 이어받을 수 없으므로
 * `--session`을 넘기지 않고 새 대화로 시작하며 warning 이벤트 한 번으로 알린다(조용히 실패시키지 않는다).
 *
 * **무료 Zen 거절(결정).** 무료 Zen 티어는 내장 도구 구성을 좁힌 요청을 403(`PROVIDER_GATE`)으로 거절한다(3단계 실측).
 * b-studio 경계("모델은 b-studio 도구만")를 지키려면 내장 도구를 꺼야 하므로, 이 검사를 통과하려고 경계를 풀지 않는다 —
 * 보안 후퇴이고 제공자 정책 우회다. 대신 그 사실을 그대로 실패로 알리고(OPENCODE_PROVIDER_GATE_MESSAGE) **재시도하지 않는다**.
 * 정상 경로는 로그인한 제공자의 모델을 고르는 것이다(그래서 linkAuth 기본값이 true다).
 *
 * 아직 다른 러너가 받는 것을 받지 않는다: 되묻기(`interactive`), 레인 조율 게시판(`board`), 실행 중 지시(`steering`).
 * 도구 목록을 `buildTools(project)`로만 만들어 그 옵션들이 빠지고, 지시는 넣어도 실행 끝에 적용되지 못한 것으로 안내된다.
 * 모델 승격(`escalation`)은 타입으로는 받지만 지원하지 않는다 — 무시하지 않고 warning 이벤트로 알린다(codex·Command Code 러너와 같다).
 */
export async function runOpenCodeAgent(options: OpenCodeRunOptions): Promise<OpenCodeRunResult> {
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
    linkAuth = true,
    stateDir,
    process: proc = DEFAULT_PROCESS,
    intent = 'build',
  } = options;
  signal?.throwIfAborted();
  const ask = intent === 'ask';
  // 모델을 추측하지 않는다. 무료 Zen 모델을 기본값으로 두지 않고, 없으면 오류를 낸다(CLI·벤치·스튜디오 같은 규칙)
  const chosenModel = model?.trim();
  if (!chosenModel) throw new Error(OPENCODE_MODEL_REQUIRED);

  // 이어받기를 요청했는데 상태 폴더가 없으면 이어받을 수 없다(HOME·XDG가 실행마다 달라져 opencode가 세션을 찾지 못한다).
  // 조용히 실패시키지 않고 한 번 알린 뒤 새 대화로 시작한다
  const canResume = resume !== undefined && stateDir !== undefined;
  if (resume !== undefined && stateDir === undefined) {
    onEvent({ type: 'warning', message: '이 실행은 이전 대화를 이어받지 못합니다: 상태 폴더 없음' });
  }
  // 이 러너는 모델 승격을 지원하지 않는다. 받으면 무시하지 않고 경고 이벤트를 한 번 알린다(codex·Command Code 러너와 같은 규칙).
  // 벤치는 --escalate-to를 claude-code에서만 받으므로 여기까지 오지 않지만, 옵션을 직접 넘기는 경로도 조용히 넘기지 않는다
  if (options.escalation) onEvent({ type: 'warning', message: '로컬 OpenCode Agent 러너는 모델 승격을 지원하지 않습니다. 승격 옵션을 무시합니다' });

  const workspace = new Workspace(project.root);
  // 질문 모드는 파일을 바꾸지 않으므로 계약 기준을 잡거나 게이트를 돌리지 않는다.
  // 지연 기동 세션(ensureSandbox)은 게이트를 여기서 만들지 않고, 첫 파일 변경·샌드박스 도구 때 샌드박스를 켠 뒤에 만든다
  let gate: VerificationGate | undefined;
  let gatePromise: Promise<VerificationGate> | undefined;
  const gateFor = (): Promise<VerificationGate> =>
    (gatePromise ??= VerificationGate.create({ project, sandbox, workspace, allowBreaking, maxVerifyAttempts, verify: options.verify, fetcher, pageFetcher, browserRunner, signal, onServiceStatus, onEvent }));
  if (!ask && !options.ensureSandbox) gate = await gateFor();
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
    // 지연 기동 세션이면 샌드박스 도구를 실행하기 직전에 켠다(핸들러가 게이트 생성까지 한다)
    ...(options.ensureSandbox ? { ensureSandbox: options.ensureSandbox } : {}),
  };
  const specs = buildTools(project);
  const toolName = (name: string) => `mcp__${SERVER}__${name}`;
  // b-studio MCP 도구 이름에는 서버 이름이 들어간다(`b_studio_list_files` 또는 `mcp__b_studio__list_files`). 내장 도구에는 없다
  const isStudioTool = (name: string) => name.includes(SERVER);

  // 도구 호출은 모델이 낸 순서대로 하나씩 실행한다. 로컬 Claude Agent·Codex 러너와 같은 큐를 쓴다
  const serial = serialQueue();
  // 실행 지표. modelMs는 이벤트에 스텝 시간이 있을 때만 더한다(없으면 0 = "재지 않음")
  const metrics: RunMetrics = { modelCalls: 0, maxContextTokens: 0, modelMs: 0, toolMs: 0, gateMs: 0 };

  // 작업 폴더(cwd). project.root를 cwd로 주면 모델이 내장 도구로 작업 공간을 직접 바꿀 수 있다.
  // 상태 폴더를 주면 그 아래 고정 경로를 쓴다 — 두 러너(Command Code·OpenCode)를 같은 규칙으로 두고, 이어받을 때 조건도 같게 한다
  const workdir = stateDir ? path.join(stateDir, 'work') : await mkdtemp(path.join(tmpdir(), WORKDIR_PREFIX));
  let toolServer: Awaited<ReturnType<typeof startToolServer>> | undefined;
  let home: string | undefined;
  let result: OpenCodeRunResult | undefined;
  const usage = emptyUsage();
  let completedTurns = 0;
  let lastText = '';
  /** 이어받기·재시도에 쓰는 현재 세션 id. 첫 턴은 이어받을 수 있을 때만 options.resume에서 시작한다 */
  let sessionId: string | undefined = canResume ? resume : undefined;
  let announced = false;
  // b-studio 도구가 아닌 호출을 한 번만 기록한다
  const foreignTools = new Set<string>();

  const finish = (status: AgentResult['status'], summary: string): void => {
    result = {
      status,
      summary,
      changedFiles: workspace.changedFiles(),
      report: gate?.report,
      checks: gate?.checks,
      passedStages: gate ? [...gate.passedStages] : undefined,
      ...(options.verify === 'light' ? { verify: 'light' as const } : {}),
      ...(gate && gate.skippedStages.length > 0 ? { skippedStages: [...gate.skippedStages] } : {}),
      verifyAttempts: gate?.attempts ?? 0,
      turns: completedTurns,
      usage,
      metrics: { ...metrics },
      sessionId,
    };
    onEvent(status === 'done' ? { type: 'done', result } : { type: 'failed', result });
  };

  /**
   * b-studio 도구가 아닌 도구 호출을 실제 일어난 일대로 감사 기록한다.
   * opencode는 도구 호출을 `tool_use`(part.state.status)로 알린다. 완료면 실행된 것이고, 오류 메시지가 거부면 거부다.
   * 거부는 헤드리스 기본에서 `ask` 권한이 auto-reject돼 `Tool execution denied by user.`로 온다(0단계 근거).
   * 같은 호출(callID)당 한 번만 남긴다. (b-studio MCP 도구는 서버 핸들러가 이미 tool_call/tool_result로 알리므로 건드리지 않는다)
   */
  const recordForeignTool = (part: OpenCodePart): void => {
    const name = part.tool;
    if (!name || isStudioTool(name)) return;
    const id = part.callID ?? name;
    if (foreignTools.has(id)) return;
    const status = part.state?.status;
    if (status === 'completed') {
      foreignTools.add(id);
      onEvent({ type: 'policy', tool: name, decision: 'allow', reason: '내장 도구가 실행됨(b-studio 도구 밖)' });
      return;
    }
    if (status === 'error') {
      foreignTools.add(id);
      const output = typeof part.state?.output === 'string' ? part.state.output.trim() : '';
      if (/denied|rejected|not allowed/i.test(output)) onEvent({ type: 'policy', tool: name, decision: 'deny', reason: output.slice(0, 300) || 'OpenCode가 이 도구 호출을 거부했습니다' });
      else onEvent({ type: 'policy', tool: name, decision: 'allow', reason: '내장 도구가 실행됨(b-studio 도구 오류)' });
    }
    // running 등은 아직 결정이 아니다. 완료·오류 이벤트에서 기록한다
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
          // 지연 기동 세션: 첫 파일 변경·샌드박스 도구일 때 샌드박스를 켠다. 게이트(계약 기준)는 그 뒤에 만들어진다
          if (options.ensureSandbox && (SANDBOX_TOOLS.has(name) || WRITE_TOOLS.has(name))) {
            await options.ensureSandbox();
            gate = await gateFor();
          }
          const toolStarted = performance.now();
          const outcome = await executeTool(name, args, context);
          metrics.toolMs += Math.round(performance.now() - toolStarted);
          onEvent({ type: 'tool_result', name, ok: outcome.ok, content: outcome.content });
          return outcome;
        }),
    });

    // 고정 작업 폴더는 실행 시작 때 안을 비운다. "빈 작업 폴더" 성질(모델이 여기서 만든 파일이 프로젝트에 반영되지 않는다)을 그대로 유지한다
    if (stateDir) await emptyDirectory(workdir);
    // 작업 폴더(cwd)에 실행별 MCP 설정과 전용 에이전트를 둔다. 사용자 설정은 건드리지 않는다
    const configPath = path.join(workdir, 'opencode.json');
    await writeFile(configPath, openCodeJson(toolServer.url));

    // HOME. 상태 폴더를 주면 고정한다(opencode가 세션·런타임 DB를 여기 아래에 쓴다).
    // 작업 폴더와 다른 폴더다(opencode가 세션·로그를 여기에 쓰므로 작업 폴더와 섞지 않는다)
    home = stateDir ? path.join(stateDir, 'home') : await mkdtemp(path.join(tmpdir(), HOME_PREFIX));
    await mkdir(home, { recursive: true });
    if (linkAuth) await linkAuthFile(home);

    // `opencode run`에는 systemPrompt 자리가 없어 프로젝트 규칙·도구 이름을 첫 사용자 메시지 앞에 붙인다
    let pending = `${buildSystemPrompt(project, { toolName })}${workflowContext(project)}\n\n${ask ? buildAskRequest(request, { toolName }) : request}`;

    for (let turn = 1; turn <= maxTurns; turn++) {
      signal?.throwIfAborted();
      onEvent({ type: 'turn', turn });

      // 이 턴만 중단하는 컨트롤러. 치명적 오류를 받으면 자식을 죽인다
      const turnAbort = new AbortController();
      const turnSignal = signal ? AbortSignal.any([signal, turnAbort.signal]) : turnAbort.signal;
      const { lines, exitCode, stderr } = proc.run({ args: commandArgs({ pending, sessionId, model: chosenModel }), cwd: workdir, env: runEnv(home, configPath, toolServer.token), signal: turnSignal });

      let errorMessage = '';
      let turnText = '';
      let fatal = false;

      // 줄을 하나씩 읽는다. `type:"error"` 이벤트를 받으면 더 읽지 않고 곧바로 빠져나온다 —
      // opencode는 이 오류 뒤에 종료하지 않고 멈출 수 있어(3단계 관찰) 스트림 끝을 기다리면 매달린다.
      const iterator = lines[Symbol.asyncIterator]();
      for (;;) {
        const value = await iterator.next().catch(() => ({ done: true as const, value: undefined }));
        if (value.done) break;
        const trimmed = (value.value ?? '').trim();
        if (!trimmed) continue;
        let parsed: OpenCodeEvent;
        try {
          parsed = JSON.parse(trimmed) as OpenCodeEvent;
        } catch {
          // NDJSON이 아닌 줄(경고 등)은 무시한다
          continue;
        }
        if (typeof parsed.sessionID === 'string') sessionId = parsed.sessionID;
        switch (parsed.type) {
          case 'step_start':
            if (typeof parsed.part?.sessionID === 'string') sessionId = parsed.part.sessionID;
            // 턴마다 다시 올 수 있으므로 실행마다 한 번만 알린다
            if (!announced) {
              announced = true;
              onEvent({ type: 'session', backend: BACKEND, model: chosenModel });
            }
            break;
          case 'text': {
            const text = typeof parsed.part?.text === 'string' ? parsed.part.text : '';
            if (text) {
              turnText = text;
              onEvent({ type: 'text', text });
            }
            break;
          }
          case 'tool_use':
            if (parsed.part) recordForeignTool(parsed.part);
            break;
          case 'step_finish': {
            // 한 스텝 = 모델 요청 한 번. 스텝마다 토큰을 합산한다(0단계: step_finish.tokens는 실행/스텝 기준, 세션 누적 아님)
            metrics.modelCalls += 1;
            addUsage(usage, parsed.part?.tokens);
            metrics.maxContextTokens = Math.max(metrics.maxContextTokens, contextTokens(parsed.part?.tokens));
            const ms = stepMs(parsed.part);
            if (ms !== undefined) metrics.modelMs += Math.round(ms);
            onEvent({ type: 'tokens', usage: { ...usage } });
            break;
          }
          case 'error':
            // 실행을 끝내는 오류다. 여기서 멈추고 실패로 마무리한다(게이트 재시도·fork로 다시 돌리지 않는다)
            errorMessage = errorText(parsed) || errorMessage;
            fatal = true;
            break;
          default:
            break;
        }
        if (fatal) break;
      }

      // 오류 이벤트를 받았으면 자식을 죽이고, 스스로 끝나기를 기다리지 않고 제한 시간 안에 실패로 마무리한다
      if (fatal) {
        turnAbort.abort();
        await Promise.race([exitCode.catch(() => 1), delay(EXIT_GRACE_MS)]);
        finish('failed', classifyFailure({ exitCode: 1, message: errorMessage.trim() }));
        break;
      }

      const code = await exitCode;
      const stderrText = stderr ? await stderr().catch(() => '') : '';
      const message = (errorMessage || stderrText).trim();

      // 결과 줄이 없다. 종료 코드로 완료/실패를 판정하고, 한도·인증·제공자 거절은 문구로 분류한다(0단계: 종료 코드 0/1/130뿐)
      if (code !== 0) {
        finish('failed', classifyFailure({ exitCode: code, message }));
        break;
      }
      completedTurns += 1;

      const text = turnText || lastText;
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
    if (!result) finish('failed', `최대 턴 수(${maxTurns})를 넘었습니다`);
  } finally {
    // 프로세스를 닫아도 이미 시작한 도구 핸들러는 이어서 돈다. 호출한 쪽이 변경을 되돌리기 전에 끝나기를 기다린다
    await serial.idle();
    await toolServer?.close();
    // 상태 폴더를 쓰면 HOME·작업 폴더를 지우지 않는다. opencode가 세션·DB를 HOME 아래(`$XDG_DATA_HOME/opencode/opencode.db`)에
    // 두므로 지우면 다음 실행이 이어받지 못한다. 주지 않았을 때만 예전처럼 임시 폴더를 지운다
    if (!stateDir) {
      // 심볼릭 링크만 지운다. 링크가 가리키는 원본 auth.json은 그대로 남는다
      if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
      // opencode가 작업 폴더에 남긴 것(세션 파일·로그)이 있어도 작업 공간과 무관하므로 통째로 지운다
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }

  signal?.throwIfAborted();
  if (!result) throw new Error('OpenCode가 결과를 보내지 않고 종료됐습니다');
  return result;
}

/** `opencode run` 한 번의 인자. 모델은 항상 `-m`으로 명시한다(계정 기본값을 추측하지 않는다) */
function commandArgs(input: { pending: string; sessionId?: string; model: string }): string[] {
  const args = ['run', '--format', 'json', '--pure', '--agent', AGENT, '-m', input.model];
  // --fork는 --continue/--session과 함께 써야 한다. 세션을 갈라 이어받아 원본을 보존한다
  if (input.sessionId) args.push('--session', input.sessionId, '--fork');
  args.push(input.pending);
  return args;
}

/**
 * 실행별 `opencode.json`. 토큰 값이 아니라 환경 변수 참조(`{env:B_STUDIO_MCP_TOKEN}`)를 적어 파일에 비밀이 남지 않게 한다.
 * opencode의 헤더 보간은 `{env:VAR}`이고 셸식 `${VAR}`는 치환되지 않는다(0단계 근거).
 *
 * 에이전트 권한은 삽입 순서가 곧 규칙 순서다 — 넓은 deny를 먼저, 좁은 allow를 나중에 둔다(마지막으로 맞는 규칙이 이긴다).
 * 허용 키는 **MCP 도구 이름 글롭 `b_studio_*`**이다. 처음에는 `mcp:b_studio:*`를 썼지만, 실행별 설정을 실제로 띄워
 * 모델에 보내는 요청을 캡처해 보니 그 키로는 도구가 하나도 노출되지 않았다(넓은 deny가 MCP 도구까지 걸렀다).
 * 로컬 캡처 매트릭스에서 `b_studio_list_files`(도구 이름)와 `b_studio_*`(글롭)가 도구를 그대로 노출했고, 후자가 서버의 모든 도구를 한 번에 연다.
 * 내장 도구(`bash`·`edit`·`write`·`read` 등)는 넓은 deny만 맞아 목록에서 빠진다.
 */
export function openCodeJson(url: string): string {
  const config = {
    $schema: 'https://opencode.ai/config.json',
    mcp: { [SERVER]: { type: 'remote', url, enabled: true, headers: { Authorization: `Bearer {env:${TOKEN_ENV}}` } } },
    agent: {
      [AGENT]: {
        description: 'b-studio 전용. b-studio 도구만 쓰고 내장 도구는 쓰지 않는다',
        mode: 'primary',
        permission: { '*': 'deny', [`${SERVER}_*`]: 'allow' },
      },
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * 자식 프로세스 환경. HOME을 임시 폴더로 바꾸고 XDG 경로도 그 아래로 돌린다(사용자가 전역으로 둔 XDG_* 값까지 덮어쓴다).
 * `OPENCODE_CONFIG`로 실행별 설정을 명시하고 `OPENCODE_DISABLE_PROJECT_CONFIG`로 상위 폴더의 설정이 끼어들지 않게 한다.
 * 외부 스킬 스캔(`~/.claude`·`~/.agents`)도 끈다. 토큰은 환경 변수로만 넘긴다.
 */
function runEnv(home: string, configPath: string, token: string): Record<string, string> {
  return {
    ...processEnv(),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    OPENCODE_CONFIG: configPath,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    [TOKEN_ENV]: token,
  };
}

/** 한 `step_finish`의 입력 크기 = input + cache_read + cache_write. 로컬 Claude Agent·Codex·Command Code 러너와 같은 규칙 */
function contextTokens(usage: OpenCodeUsage | undefined): number {
  return (usage?.input ?? 0) + (usage?.cache?.read ?? 0) + (usage?.cache?.write ?? 0);
}

function addUsage(total: AgentUsage, usage: OpenCodeUsage | undefined): void {
  total.inputTokens += usage?.input ?? 0;
  total.outputTokens += usage?.output ?? 0;
  total.cacheReadTokens += usage?.cache?.read ?? 0;
  total.cacheWriteTokens += usage?.cache?.write ?? 0;
}

/** step_finish에 스텝 시간이 실려 있으면 그 값, 없으면 undefined("재지 않음") */
function stepMs(part: OpenCodePart | undefined): number | undefined {
  const start = part?.time?.start;
  const end = part?.time?.end;
  return typeof start === 'number' && typeof end === 'number' && end >= start ? end - start : undefined;
}

/** `error` 이벤트에서 사람이 읽을 문구를 뽑는다 */
function errorText(event: OpenCodeEvent): string {
  for (const value of [event.error, event.message]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'object' && value !== null) {
      const message = (value as { message?: unknown; data?: { message?: unknown } }).message ?? (value as { data?: { message?: unknown } }).data?.message;
      if (typeof message === 'string' && message.trim()) return message.trim();
    }
  }
  return '';
}

/**
 * 실패 분류. 종료 코드와 문구를 함께 본다(0단계: 종료 코드 0/1/130, 한도·인증·크레딧·제공자 거절은 문구).
 * 분류 종류: `provider_gate`(무료 Zen 거절) · `rate_limited` · `insufficient_credit` · `auth` · 그 밖.
 */
function classifyFailure({ exitCode, message }: { exitCode: number; message: string }): string {
  const detail = message || `종료 코드 ${exitCode}`;
  if (exitCode === 130) return '요청을 취소했습니다';
  // 무료 Zen 거절(provider_gate). 재시도해도 같은 결과라 한 번만 알리고 멈춘다
  if (PROVIDER_GATE.test(message)) return OPENCODE_PROVIDER_GATE_MESSAGE;
  if (USAGE_LIMIT.test(message)) return `OpenCode 사용 한도에 걸렸습니다: ${detail}`;
  if (INSUFFICIENT_CREDIT.test(message)) return `OpenCode 크레딧이 부족합니다: ${detail}`;
  if (AUTH_FAILURE.test(message)) return `OpenCode에 로그인돼 있지 않습니다. \`${COMMAND} auth login\`으로 제공자에 로그인하고 그 제공자의 모델을 고르세요`;
  if (message) return message;
  return `OpenCode가 종료 코드 ${exitCode}로 끝났습니다`;
}

/**
 * 샌드박스를 띄우기 전에 이 PC의 OpenCode CLI가 있는지 확인한다.
 * `opencode --version`만 부르므로 모델 호출도, 사용량도 쓰지 않는다. 토큰·계정 정보는 읽지 않는다.
 */
export async function preflightOpenCode({ command = COMMAND, timeoutMs = 60_000 }: { command?: string; timeoutMs?: number } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await run(command, ['--version'], timeoutMs);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `OpenCode CLI를 찾지 못했습니다. 터미널에서 "${command}"가 실행되는지 확인하세요. (${describe(error)})` };
  }
}

export interface OpenCodeModel {
  /** `provider/model` 형식의 전체 id */
  id: string;
  /** 마지막 `/` 뒤의 짧은 이름 */
  name: string;
  /** 제공자(`opencode` 등) */
  provider: string;
  /** 이름에 `free`가 들어가는 무료 모델인지 */
  free: boolean;
  /** b-studio가 이 모델을 쓸 수 있는지. 무료 Zen(`opencode` 제공자 + free)은 내장 도구를 끈 구성에서 거절돼 false다(3단계 실측) */
  usable: boolean;
  /** 쓸 수 없을 때의 이유 */
  reason?: string;
}

/**
 * `opencode models` 텍스트를 파싱한다(순수 함수). 한 줄에 `provider/model` 하나이고 설명·기본 표시는 없다.
 * 무료 여부는 이름에 `free`가 들어가는지로만 본다(0단계 근거). `--verbose`의 JSON은 쓰지 않는다.
 * `usable`은 지금까지 확인한 사실만 반영한다: `opencode` 제공자의 무료 모델은 b-studio 구성에서 거절된다(3단계).
 */
export function parseOpenCodeModels(text: string): OpenCodeModel[] {
  const models: OpenCodeModel[] = [];
  const seen = new Set<string>();
  for (const raw of text.split('\n')) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    // `provider/model` 형식만 받는다. 경고·안내 줄은 버린다
    const match = /^([a-z0-9][\w.-]*)\/([\w.:@+-]+)$/i.exec(id);
    if (!match) continue;
    seen.add(id);
    const provider = match[1]!;
    const name = match[2]!;
    const free = /free/i.test(name);
    // 무료 Zen 모델은 내장 도구를 끈 b-studio 구성에서 거절되므로 쓸 수 없다
    const gated = provider === 'opencode' && free;
    models.push(gated ? { id, name, provider, free, usable: false, reason: OPENCODE_FREE_UNUSABLE_REASON } : { id, name, provider, free, usable: true });
  }
  return models;
}

/** 이 PC에서 쓸 수 있는 OpenCode 모델 목록. `opencode models` 텍스트를 파싱한다(모델 호출 없음) */
export async function listOpenCodeModels({ command = COMMAND, timeoutMs = 60_000 }: { command?: string; timeoutMs?: number } = {}): Promise<OpenCodeModel[]> {
  return parseOpenCodeModels(await run(command, ['models'], timeoutMs));
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

/** 고정 작업 폴더를 빈 상태로 만든다. 지난 실행이 남긴 모델 산출물과 opencode 설정을 지우고 새로 만든다 */
async function emptyDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

/**
 * `linkAuth`(기본 true)일 때 로그인 파일을 HOME으로 빌려온다. 파일 내용을 읽거나 복사하지 않고 심볼릭 링크 하나만 만든다.
 * opencode의 로그인 파일은 `$XDG_DATA_HOME/opencode/auth.json`이므로 기본 위치는 `~/.local/share/opencode/auth.json`이다(0단계).
 * 파일이 없으면 링크하지 않고 진행한다(판단은 파일 존재만 본다). 그러면 로그인한 제공자의 모델을 쓸 수 없다는 기존 실패 경로를 탄다.
 *
 * 상태 폴더를 쓰면 같은 HOME을 다시 쓰므로 링크가 남아 있다. 매번 확인해 **없을 때만** 만든다(있으면 그대로 둔다).
 */
async function linkAuthFile(home: string): Promise<void> {
  const target = path.join(home, '.local', 'share', 'opencode', 'auth.json');
  if (await exists(target)) return;
  const source = path.join(userHome(), '.local', 'share', 'opencode', 'auth.json');
  if (!(await exists(source))) return;
  await mkdir(path.dirname(target), { recursive: true });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
