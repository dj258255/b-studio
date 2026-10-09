import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
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

/**
 * Gemini CLI(`gemini`, `@google/gemini-cli`) 러너.
 *
 * **0단계 조사(실계정 호출 없음, 공식 문서·이슈 트래커 근거).** 헤드리스 실행은 `gemini -p "<prompt>" --output-format json`이
 * 한 번에 JSON 문서 하나(`response`·`stats.models[].tokens`·`error`)를 표준출력에 낸다
 * (https://google-gemini.github.io/gemini-cli/docs/cli/headless.html). NDJSON으로 턴마다 이벤트를 받는
 * `--output-format stream-json`도 있지만(`init`에 session_id가 실린다는 보고가 있다) 비공식 2차 출처뿐이라 쓰지 않았다 —
 * 이 러너는 한 번에 하나의 JSON 문서를 받는 `json` 포맷만 쓴다(opencode·commandcode 러너의 줄 단위 NDJSON 파싱과 다른 점).
 *
 * **도구 경계(알려진 한계).** opencode·commandcode 러너는 내장 도구를 전부 거부하고 b-studio MCP 도구만 허용(allowlist)하지만,
 * Gemini CLI는 그 자리(`tools.core`)에 알려진 버그가 있어(github.com/google-gemini/gemini-cli/issues/28361) 무엇을 넣어도
 * MCP 도구까지 함께 숨는다. 그래서 이 러너는 **`excludeTools`로 알려진 내장 도구 이름을 모두 나열하는 블록리스트**를 쓴다 —
 * allowlist보다 약한 보장이다. 새 내장 도구가 CLI에 추가되면 이 블록리스트가 따라가지 못해 b-studio 도구 경계 밖에서
 * 실제로 파일을 바꿀 수 있다. 실계정으로 `gemini mcp list`·`--allowed-tools` 캡처를 떠 재검증해야 한다(ADR에 남김).
 *
 * **세션 이어받기(불확실).** 대화형 세션은 `~/.gemini/tmp/<project_hash>/chats/`에 cwd 해시로 저장되고 `--resume <uuid>`가
 * 있다고 공식 문서(session-management.md)에 적혀 있다. 하지만 헤드리스 `-p --output-format json`의 응답에 세션 id가
 * 실제로 실리는지는 확인하지 못했다. 이 러너는 `session_id`/`sessionId` 필드가 있으면 그 값을 받아 다음 턴에
 * `--resume`으로 넘기고(opencode·commandcode와 같은 stateDir 패턴), 없으면 조용히 새 대화로 넘어간다 — 실패시키지 않되
 * 다음 턴이 이전 턴의 맥락을 잃을 수 있다는 것을 ADR에 한계로 남긴다.
 *
 * **노력(effort) 단계(확인 못 함).** Gemini API 자체에는 `thinkingConfig.thinkingBudget`이 있지만, CLI가 이를 노출하는
 * 플래그를 문서에서 찾지 못했다. 받으면 조용히 버리지 않고 경고 이벤트로 한 번 알린다(opencode·commandcode의 승격
 * 미지원 경고와 같은 규칙).
 *
 * **중요(사람이 확인할 일).** 구글이 2026-05-19에 레거시 `gemini` CLI를 2026-06-18부로 개인 무료 Google AI Pro/Ultra
 * 계정에서 단계적으로 끊고 Antigravity CLI로 옮기라고 공지했다
 * (https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/).
 * 조직이 산 Gemini Code Assist Standard/Enterprise 라이선스만 계속 쓸 수 있다. 실계정 로그인 전에 이 조건을 먼저
 * 확인해야 한다 — 개인 무료 계정이면 이 러너가 아예 요청을 처리하지 못할 수 있다.
 */
const SERVER = 'b_studio';
/** MCP bearer 토큰을 넘기는 환경 변수 이름. 토큰 값은 파일·로그에 남기지 않는다 */
const TOKEN_ENV = 'B_STUDIO_MCP_TOKEN';
/** 화면 표기. 제품 이름을 그대로 쓰지 않는다(다른 로컬 구독 CLI 러너와 같은 규칙) */
const BACKEND = '로컬 Gemini Agent';
/** 실제 실행할 CLI. 이 PC에 설치된 `gemini`를 그대로 쓴다 */
const COMMAND = 'gemini';
/** 실행마다 만드는 작업 폴더(cwd)의 접두어 */
const WORKDIR_PREFIX = 'b-studio-gemini-';
/** 실행마다 만드는 임시 HOME의 접두어. gemini가 사용자 설정 대신 이 폴더를 읽는다 */
const HOME_PREFIX = 'b-studio-gemini-home-';

/** 모델을 고르지 않았을 때의 오류. 기본 모델을 추측하지 않는다(모델 이름이 자주 바뀌는 CLI라 다른 러너보다도 더 추측하지 않는다) */
export const GEMINI_MODEL_REQUIRED = 'Gemini 모델을 골라야 합니다. -m <모델> 또는 B_STUDIO_GEMINI_MODEL로 지정하세요';

/**
 * 알려진 Gemini CLI 내장 도구 이름(모델이 실제로 부르는 도구 이름 기준 추정, 공식 도구 문서 전체를 실계정으로
 * 다시 확인하기 전까지의 최선 추정 — ADR에 한계로 남긴다). `tools.core` allowlist 버그(#28361) 때문에
 * `excludeTools` 블록리스트로만 막을 수 있다
 */
const BUILTIN_TOOL_NAMES = [
  'list_directory',
  'read_file',
  'read_many_files',
  'write_file',
  'edit',
  'replace',
  'run_shell_command',
  'search_file_content',
  'glob',
  'web_fetch',
  'web_search',
  'google_web_search',
  'save_memory',
] as const;

/** 사용 한도·429 문구 판정. 실패 분류 기준은 이 한 곳에만 둔다(0단계 근거: RESOURCE_EXHAUSTED·RATE_LIMIT_EXCEEDED 이슈 보고) */
const USAGE_LIMIT = /RESOURCE_EXHAUSTED|RATE_LIMIT_EXCEEDED|rate[ _]limit|usage[ _]limit|\b429\b/i;
/** 로그인·인증 실패 문구(불확실 — 실계정으로 재확인 전까지의 최선 추정) */
const AUTH_FAILURE = /UNAUTHENTICATED|not authenticated|unauthorized|\b401\b|please (log|sign) ?in|no credentials|login required/i;

/** 헤드리스 `--output-format json`의 응답 JSON 문서. 확인한 필드(response·stats·error)만 좁혀 정의하고, 세션 id는 확인하지 못해 선택 필드로만 둔다 */
interface GeminiResultLine {
  response?: string;
  /** 세션 id(불확실 — 공식 문서는 stream-json의 init 이벤트에서만 확인됨). 있으면 받아서 다음 턴에 이어받는다 */
  session_id?: string;
  sessionId?: string;
  stats?: { models?: Record<string, { tokens?: GeminiTokens }>; tools?: unknown };
  error?: { type?: string; message?: string; code?: number | string };
  [key: string]: unknown;
}

interface GeminiTokens {
  prompt?: number;
  candidates?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  total?: number;
}

/** 하위 프로세스 실행 결과. 헤드리스 json 포맷은 한 번에 문서 하나라(NDJSON이 아니다) 표준출력을 통째로 받는다 */
export interface GeminiProcessResult {
  /** stdout 전체 */
  stdout: Promise<string>;
  /** 프로세스 종료 코드 */
  exitCode: Promise<number>;
  /** 실패 이유 보강용 stderr */
  stderr?: () => Promise<string>;
}

/**
 * 하위 프로세스 실행을 바꿔 끼우는 지점. 실제로는 `gemini`를 띄우고, 테스트는 가짜를 넣는다.
 * 인자·환경·cwd를 받아 stdout 전체와 종료 코드를 돌려준다.
 */
export interface GeminiProcess {
  run(input: { args: string[]; cwd: string; env: Record<string, string>; signal?: AbortSignal }): GeminiProcessResult;
}

const DEFAULT_PROCESS: GeminiProcess = {
  run({ args, cwd, env, signal }) {
    // stdin은 닫아 둔다: 파이프를 열어 두면 gemini가 파이프 입력을 기다릴 수 있다. stdout만 받는다
    const child = spawn(COMMAND, args, { cwd, env: env as unknown as NodeJS.ProcessEnv, signal, stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessByStdio<null, Readable, Readable>;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exitCode = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    // 아래 stdoutPromise의 .then(onFulfilled, onRejected)이 생성 즉시 exitCode를 "처리됨"으로 표시해
    // commandcode·opencode 러너와 같은 처리하지 않은 거부 문제를 막는다. 구조가 바뀌어도 이 보장이 깨지지
    // 않게 명시적으로도 한 번 더 단다(둘 다 있어도 해는 없다)
    exitCode.catch(() => {});
    const stdoutPromise = exitCode.then(
      () => stdout,
      () => stdout,
    );
    return { stdout: stdoutPromise, exitCode, stderr: async () => stderr };
  },
};

export interface GeminiRunOptions extends Omit<RunAgentOptions, 'client' | 'conversation' | 'escalation'> {
  /** 이전 실행의 Gemini 세션 id. 주면 `--resume <id>`로 이어받는다(실제로 이어받아지는지는 실계정 확인 전) */
  resume?: string;
  /** 필수. 모델은 항상 `-m`으로 명시한다. 없으면 GEMINI_MODEL_REQUIRED 오류를 낸다(기본 모델을 추측하지 않는다) */
  model?: string;
  /** 이 러너는 노력 단계를 지원하지 않는다(CLI 플래그를 확인하지 못했다). 받으면 무시하지 않고 경고 이벤트를 한 번 알린다 */
  effort?: Effort;
  /** 이 러너는 모델 승격을 지원하지 않는다. 받으면 무시하지 않고 경고 이벤트를 한 번 알린다(opencode·commandcode 러너와 같다) */
  escalation?: EscalationPolicy;
  /**
   * 세션마다 고정된 상태 폴더. 주면 HOME을 `<stateDir>/home`, 작업 폴더(cwd)를 `<stateDir>/work`로 고정한다.
   * Gemini CLI는 세션을 cwd 해시로 HOME 아래(`$HOME/.gemini/tmp/<project_hash>/chats/`)에 저장한다고 문서에 적혀 있어
   * (session-management.md), 다른 로컬 구독 CLI 러너와 같은 이유로 실행 사이에 이어받으려면 HOME·cwd가 같아야 한다.
   * 주지 않으면 예전처럼 실행마다 임시 폴더를 만들고 끝나면 지운다(그때는 `resume`을 넘겨도 이어받지 못한다).
   */
  stateDir?: string;
  /** 하위 프로세스 실행을 바꿔 끼우는 지점(테스트용 가짜) */
  process?: GeminiProcess;
}

export interface GeminiRunResult extends AgentResult {
  /** 이번 실행이 받은 세션 id(있으면). 다음 요청에 `resume`으로 넘겨 이어받을 수 있다 */
  sessionId?: string;
}

/**
 * 이 PC에 로그인한 Gemini CLI(`gemini`)로 요청을 처리한다. API 키 없이 개인 Google 계정으로 돌릴 수 있다
 * (단, 2026-06-18부터 개인 무료 계정은 레거시 CLI 지원이 끊겼을 수 있다 — 파일 머리말 참고).
 *
 * 도구 경계를 세 겹으로 막되, b-studio MCP 도구 allowlist를 깨끗하게 쓰는 opencode·commandcode 러너와 달리
 * **블록리스트(`excludeTools`)**로만 막는다(`tools.core` allowlist의 알려진 버그 때문 — 파일 머리말 참고).
 *  1. 빈 HOME(`stateDir`을 주면 세션마다 고정된 `<stateDir>/home`, 아니면 실행마다 만드는 임시 폴더)을 쓴다.
 *     그대로 두면 사용자 전역 설정·확장(`~/.gemini`)이 모델에 실릴 수 있다. 로그인 파일(`oauth_creds.json`)만 심볼릭 링크로 빌려온다.
 *  2. 작업 폴더(cwd)를 빈 폴더로 두고, 그 폴더의 `.gemini/settings.json`에 b-studio MCP 서버(`trust: true`)와
 *     알려진 내장 도구 전체를 `excludeTools`로 등록한다.
 *  3. 실제 변경은 b-studio 도구(MCP 서버)만 호스트의 작업 공간에 쓴다.
 *
 * 완료 판정은 직접 만든 루프·다른 CLI 러너와 같은 검증 게이트가 한다. `gemini -p` 한 번이 모델 턴 하나이고,
 * 턴이 끝날 때마다 게이트를 돌리고 실패하면 결과를 다음 턴 프롬프트에 그대로 넣는다.
 *
 * 레인 조율 게시판(`board`)은 codex·claude-code 러너와 같은 규칙으로 받는다: 넘어오면 `buildTools`에 넘겨
 * post_note·read_notes를 도구 목록에 더하고(S2·S5처럼 읽기 전용이면 post_note는 뺀다), 실행 컨텍스트에도 실어
 * `executeTool`이 그 레인 신원으로 게시판을 읽고 쓰게 한다(이슈 #428, E12). 새 도구는 MCP 서버(`trust: true`)가
 * 등록하는 도구라 `excludeTools` 블록리스트(알려진 내장 도구 이름만 나열)에 걸리지 않는다.
 *
 * 아직 다른 러너가 받는 것을 받지 않는다: 되묻기(`interactive`), 실행 중 지시(`steering`).
 * 도구 목록을 만들 때 그 옵션들이 빠진다. 모델 승격(`escalation`)·노력 단계(`effort`)는
 * 타입으로는 받지만 지원하지 않는다 — 무시하지 않고 warning 이벤트로 알린다.
 */
export async function runGeminiAgent(options: GeminiRunOptions): Promise<GeminiRunResult> {
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
  // 모델을 추측하지 않는다. 이름이 자주 바뀌는 CLI라 기본값을 두지 않고, 없으면 오류를 낸다(opencode 러너와 같은 규칙)
  const chosenModel = model?.trim();
  if (!chosenModel) throw new Error(GEMINI_MODEL_REQUIRED);

  // 이어받기를 요청했는데 상태 폴더가 없으면 이어받을 수 없다. 조용히 실패시키지 않고 한 번 알린 뒤 새 대화로 시작한다
  const canResume = resume !== undefined && stateDir !== undefined;
  if (resume !== undefined && stateDir === undefined) {
    onEvent({ type: 'warning', message: '이 실행은 이전 대화를 이어받지 못합니다: 상태 폴더 없음' });
  }
  if (options.escalation) onEvent({ type: 'warning', message: '로컬 Gemini Agent 러너는 모델 승격을 지원하지 않습니다. 승격 옵션을 무시합니다' });
  // 이 러너는 노력 단계를 지원하지 않는다(CLI 플래그를 확인하지 못했다). 받으면 조용히 버리지 않고 한 번 알린다
  if (effort) onEvent({ type: 'warning', message: '로컬 Gemini Agent 러너는 노력 단계를 지원하지 않습니다(CLI 플래그를 확인하지 못했습니다). 노력 단계 옵션을 무시합니다' });

  const workspace = new Workspace(project.root);
  // 요구사항 문서의 실행 전 모습을 고정한다(게이트가 사람 확인 기록 위조를 견주는 기준, ADR-157)
  workspace.beginRun();
  // 이번 실행 전부터 작업 트리에 있던 변경(보관본 되살리기 등)을 먼저 알려, 에이전트가 이번 실행에서 파일을
  // 하나도 건드리지 않아도 게이트가 "검증할 변경 없음"으로 건너뛰지 않게 한다(ADR-131)
  if (options.externalChanges?.length) syncExternalChanges(workspace, options.externalChanges);
  let gate: VerificationGate | undefined;
  let gatePromise: Promise<VerificationGate> | undefined;
  const gateFor = (): Promise<VerificationGate> =>
    (gatePromise ??= VerificationGate.create({ project, sandbox, workspace, allowBreaking, maxVerifyAttempts, verify: options.verify, fetcher, pageFetcher, browserRunner, signal, onServiceStatus, onEvent }));
  if (!ask && !options.ensureSandbox) gate = await gateFor();
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
    policy: options.policy ?? executionPolicyFor(project),
    approvalToken: options.approvalToken,
    requestApproval: options.requestApproval,
    board: options.board,
    onPolicyDecision: (decision) => onEvent({ type: 'policy', ...decision }),
    ...(options.ensureSandbox ? { ensureSandbox: options.ensureSandbox } : {}),
  };
  // 조율 게시판은 Claude Code·Codex 러너와 같게, 켠 실행에만 도구를 더한다
  const specs = buildTools(project, { ...(options.board ? { board: options.board, allowedTools: context.policy?.allowedTools } : {}) });
  const toolName = (name: string) => `mcp__${SERVER}__${name}`;

  const serial = serialQueue();
  const metrics: RunMetrics = { modelCalls: 0, maxContextTokens: 0, modelMs: 0, toolMs: 0, gateMs: 0, ...(guide ? { guideChars: guide.charsUsed } : {}) };

  const workdir = stateDir ? path.join(stateDir, 'work') : await mkdtemp(path.join(tmpdir(), WORKDIR_PREFIX));
  let toolServer: Awaited<ReturnType<typeof startToolServer>> | undefined;
  let home: string | undefined;
  let result: GeminiRunResult | undefined;
  const usage = emptyUsage();
  // 모델 이름별 사용량(벤치·스튜디오 사용량 집계가 CLI 레인 사용량을 모델별로 더하는 자리, 이슈 #428).
  // 이 러너는 실행 내내 모델을 하나만 쓰므로(승격 미지원) usage와 같은 객체를 참조로 공유해 갱신을 한 곳에서만 한다.
  // 모델은 항상 명시해야 하므로(GEMINI_MODEL_REQUIRED) 백엔드 이름으로 떨어지는 경우가 없다
  metrics.usageByModel = { [chosenModel]: usage };
  let completedTurns = 0;
  let lastText = '';
  let sessionId: string | undefined = canResume ? resume : undefined;
  let announced = false;

  const finish = (status: AgentResult['status'], summary: string, failureReason?: AgentResult['failureReason']): void => {
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
      ...(failureReason ? { failureReason } : {}),
    };
    onEvent(status === 'done' ? { type: 'done', result } : { type: 'failed', result });
  };

  try {
    toolServer = await startToolServer({
      name: SERVER,
      specs,
      run: (name, args) =>
        serial(async (): Promise<ToolOutcome> => {
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

    // 고정 작업 폴더는 실행 시작 때 안을 비운다("빈 작업 폴더" 성질을 유지한다)
    if (stateDir) await emptyDirectory(workdir);
    // 작업 폴더(cwd)에 실행별 프로젝트 설정을 둔다. 사용자 전역 설정은 건드리지 않는다
    await mkdir(path.join(workdir, '.gemini'), { recursive: true });
    await writeFile(path.join(workdir, '.gemini', 'settings.json'), geminiSettingsJson(toolServer.url));

    // HOME. 상태 폴더를 주면 고정한다(gemini가 세션·OAuth 자격을 여기 아래에 쓴다)
    home = stateDir ? path.join(stateDir, 'home') : await mkdtemp(path.join(tmpdir(), HOME_PREFIX));
    await mkdir(home, { recursive: true });
    await linkAuthFile(home);

    // gemini -p에는 systemPrompt 자리가 없어 프로젝트 규칙·도구 이름을 첫 사용자 메시지 앞에 붙인다
    let pending = `${buildSystemPrompt(project, { toolName, selfCheck: options.selfCheck })}${workflowContext(project)}${projectGuideSection(guide)}\n\n${ask ? buildAskRequest(request, { toolName, ...(research ? { research: { webToolsAvailable: false } } : {}) }) : request}`;

    for (let turn = 1; turn <= maxTurns; turn++) {
      signal?.throwIfAborted();
      onEvent({ type: 'turn', turn });
      if (!announced) {
        announced = true;
        onEvent({ type: 'session', backend: BACKEND, model: chosenModel });
      }

      const { stdout, exitCode, stderr } = proc.run({
        args: commandArgs({ pending, sessionId, model: chosenModel }),
        cwd: workdir,
        env: runEnv(home, toolServer.token),
        signal,
      });

      const [rawOut, code, rawErr] = await Promise.all([stdout.catch(() => ''), exitCode, stderr ? stderr().catch(() => '') : Promise.resolve('')]);

      let parsed: GeminiResultLine | undefined;
      try {
        parsed = JSON.parse(rawOut.trim()) as GeminiResultLine;
      } catch {
        parsed = undefined;
      }

      if (parsed === undefined || parsed.error !== undefined || code !== 0) {
        // error.type·error.code(429·401 등)도 분류 문구에 합쳐 USAGE_LIMIT·AUTH_FAILURE 정규식이 코드만 온 경우도 잡게 한다.
        // 사람에게 보여줄 문구는 error.message(있으면)를 앞세우고, 없으면 stderr를 쓴다
        const displayMessage = parsed?.error?.message ?? rawErr.trim();
        const matchText = parsed?.error ? [parsed.error.type, parsed.error.message, parsed.error.code].filter((value) => value !== undefined).join(' ') : rawErr.trim();
        finish('failed', classifyFailure({ exitCode: code, displayMessage, matchText, raw: rawOut, parsed: parsed !== undefined }));
        break;
      }
      completedTurns += 1;

      // 세션 id는 확인하지 못한 필드라(파일 머리말 참고) 있으면 받고, 없으면 이전 값을 그대로 둔다
      sessionId = parsed.session_id ?? parsed.sessionId ?? sessionId;

      const text = parsed.response ?? '';
      if (text) {
        lastText = text;
        onEvent({ type: 'text', text });
      }

      metrics.modelCalls += 1;
      const turnUsage = sumTokens(parsed.stats?.models);
      addUsage(usage, turnUsage);
      metrics.maxContextTokens = Math.max(metrics.maxContextTokens, contextTokens(turnUsage));
      onEvent({ type: 'tokens', usage: { ...usage } });

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
    if (!result) {
      // 턴 상한에 걸렸다. 바로 실패로 끝내지 않고 지금까지의 변경이 게이트를 통과하는지 한 번 더 본다(ADR-131)
      const gateStarted = performance.now();
      const recheck = await recheckGateOnMaxTurns(gate, maxTurns, onEvent);
      metrics.gateMs += Math.round(performance.now() - gateStarted);
      if (recheck.pass) finish('done', recheck.summary);
      else finish('failed', recheck.summary, 'max_turns');
    }
  } finally {
    await serial.idle();
    await toolServer?.close();
    if (!stateDir) {
      if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }

  signal?.throwIfAborted();
  if (!result) throw new Error('Gemini CLI가 결과를 보내지 않고 종료됐습니다');
  return result;
}

/** `gemini -p` 한 번의 인자. 모델은 항상 `-m`으로 명시한다(기본값을 추측하지 않는다) */
function commandArgs(input: { pending: string; sessionId?: string; model: string }): string[] {
  const args = ['-p', input.pending, '--output-format', 'json', '-m', input.model];
  // 세션 id가 있을 때만 이어받기를 시도한다(실제로 이어받아지는지는 실계정 확인 전 — 파일 머리말 참고)
  if (input.sessionId) args.push('--resume', input.sessionId);
  return args;
}

/**
 * 실행별 `.gemini/settings.json`. `tools.core` allowlist는 알려진 버그(#28361)로 MCP 도구까지 숨기므로,
 * 알려진 내장 도구 이름을 모두 `excludeTools`에 올리는 블록리스트를 쓴다(파일 머리말의 한계 참고).
 * MCP 서버는 `trust: true`로 등록해 도구 호출 확인을 생략한다. 토큰 값은 설정 파일에 적지 않고
 * 환경 변수 참조(`$B_STUDIO_MCP_TOKEN`)만 적는다 — 실제 보간 문법은 실계정으로 재확인 전까지의 최선 추정이다.
 */
export function geminiSettingsJson(url: string): string {
  const config = {
    mcpServers: { [SERVER]: { httpUrl: url, headers: { Authorization: `Bearer $${TOKEN_ENV}` }, trust: true } },
    excludeTools: [...BUILTIN_TOOL_NAMES],
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * 자식 프로세스 환경. HOME을 임시 폴더로 바꿔 사용자 전역 설정·확장(`~/.gemini`)이 모델에 실리지 않게 한다.
 * 토큰은 환경 변수로만 넘긴다.
 */
function runEnv(home: string, token: string): Record<string, string> {
  return { ...processEnv(), HOME: home, [TOKEN_ENV]: token };
}

/** stats.models(모델 이름별 토큰)를 실행 지표가 쓰는 AgentUsage 모양으로 합친다. 여러 모델이 섞여도 합계로 본다 */
function sumTokens(models: Record<string, { tokens?: GeminiTokens }> | undefined): AgentUsage {
  const total = emptyUsage();
  for (const entry of Object.values(models ?? {})) {
    const tokens = entry.tokens;
    if (!tokens) continue;
    total.inputTokens += tokens.prompt ?? 0;
    total.cacheReadTokens += tokens.cached ?? 0;
    // candidates(실제 출력)·thoughts(추론) 모두 모델이 생성한 토큰이라 출력에 합친다(0단계 추정 — tool 토큰은 성격이 불확실해 뺀다)
    total.outputTokens += (tokens.candidates ?? 0) + (tokens.thoughts ?? 0);
  }
  return total;
}

function addUsage(total: AgentUsage, usage: AgentUsage): void {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cacheReadTokens += usage.cacheReadTokens;
  total.cacheWriteTokens += usage.cacheWriteTokens;
}

/** 한 턴의 입력 크기 = input + cache_read(cache_write는 stats에 없다). 다른 러너의 contextTokens와 같은 규칙 */
function contextTokens(usage: AgentUsage): number {
  return usage.inputTokens + usage.cacheReadTokens;
}

/**
 * 실패 분류. 구조적 오류(`error` 필드)가 있으면 그 문구로, 없으면(JSON 파싱 실패 등) 종료 코드·stderr로 분류한다.
 * `parsed`가 false면 CLI가 예상한 JSON을 내지 않은 것이라 원문 일부를 그대로 보여준다(지어내지 않는다).
 */
function classifyFailure({ exitCode, displayMessage, matchText, raw, parsed }: { exitCode: number; displayMessage: string; matchText: string; raw: string; parsed: boolean }): string {
  if (exitCode === 130) return '요청을 취소했습니다';
  if (USAGE_LIMIT.test(matchText)) return `Gemini 사용 한도에 걸렸습니다: ${displayMessage || matchText}`;
  if (AUTH_FAILURE.test(matchText)) return `Gemini CLI에 로그인돼 있지 않습니다. 터미널에서 "${COMMAND}"를 실행해 로그인하세요`;
  if (displayMessage) return displayMessage;
  if (!parsed) return `Gemini CLI가 예상한 JSON 형식으로 응답하지 않았습니다: ${raw.slice(0, 300) || `(빈 응답, 종료 코드 ${exitCode})`}`;
  return `Gemini CLI가 종료 코드 ${exitCode}로 끝났습니다`;
}

/**
 * 샌드박스를 띄우기 전에 이 PC의 Gemini CLI가 있는지 확인한다. `gemini --version`만 부르므로 모델 호출도, 사용량도 쓰지 않는다.
 * 로그인 여부까지 확인하는 공식 명령을 찾지 못해(0단계 한계), CLI 존재만 확인한다 — 설치 안 됨과 로그인 안 됨을
 * 구분하지 못할 수 있다(opencode 러너의 preflight와 같은 한계).
 */
export async function preflightGemini({ command = COMMAND, timeoutMs = 60_000 }: { command?: string; timeoutMs?: number } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await run(command, ['--version'], timeoutMs);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Gemini CLI를 찾지 못했습니다. 터미널에서 "${command}"가 실행되는지, 로그인돼 있는지 확인하세요. (${describe(error)})` };
  }
}

function processEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  return env;
}

/** 사용자 홈. 테스트가 process.env.HOME을 바꿔 원본 oauth_creds.json 위치를 바꿔 끼울 수 있다 */
function userHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

/** 고정 작업 폴더를 빈 상태로 만든다. 지난 실행이 남긴 모델 산출물과 gemini 설정을 지우고 새로 만든다 */
async function emptyDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
}

/**
 * 로그인 파일만 HOME으로 빌려온다. 파일 내용을 읽거나 복사하지 않고 심볼릭 링크 하나만 만든다.
 * Gemini CLI의 OAuth 자격은 `~/.gemini/oauth_creds.json`에 저장된다(0단계 근거: 여러 이슈 보고).
 * 파일이 없으면 링크하지 않고 진행한다(로그인 오류로 끝나는 기존 실패 경로를 탄다).
 */
async function linkAuthFile(home: string): Promise<void> {
  const target = path.join(home, '.gemini', 'oauth_creds.json');
  if (await exists(target)) return;
  const source = path.join(userHome(), '.gemini', 'oauth_creds.json');
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
