import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { Thread, ThreadEvent, ThreadOptions, Usage } from '@openai/codex-sdk';
import type { Effort } from './anthropic-client';
import { serialQueue } from './claude-code-runner';
import type { EscalationPolicy } from './escalation';
import { recheckGateOnMaxTurns, VerificationGate } from './gate';
import { emptyUsage, formatSteering, takeSteering, type AgentEvent, type AgentResult, type AgentUsage, type RunAgentOptions, type RunMetrics } from './loop';
import { startToolServer } from './mcp-http-server';
import { loadProjectGuide } from './project-guide';
import { buildAskRequest, buildSystemPrompt, projectGuideSection } from './prompts';
import { createToolResultCache } from './tool-output';
import { buildTools, executeTool, SANDBOX_TOOLS, WRITE_TOOLS, type AskUserQuestion, type ToolContext, type ToolOutcome } from './tools';
import { fetchContract } from './verify';
import { executionPolicyFor, workflowContext } from './workflow';
import { syncExternalChanges, Workspace } from './workspace';
import { cliPreflightFailure, type CliPreflightFailure } from './cli-failure';

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
 * 관문을 거치지 않고 일하는 Codex 내장 기능(#976). 모두 끈다.
 * 묶인 CLI 0.157.0에서 실측했다: 셸만 끄면 앱 커넥터(로그인한 ChatGPT 계정의 커넥터), 플러그인, 이미지 생성, 목표,
 * 브라우저·컴퓨터 사용, 웹 실행과, 그 도구들을 자바스크립트로 부르는 코드 모드(exec)가 남아 도구가 64개였다.
 * 이것들을 끄면 b-studio 도구와 apply_patch(끄는 설정이 없다, 빈 작업 폴더·읽기 전용으로 둔다), 시계, MCP 자원 읽기만 남는다.
 * 코드 모드(code_mode_host)는 끄지 않는다(#979): 이 판에서는 MCP 도구가 코드 모드를 거쳐서만 보이고, 코드 모드의 자바스크립트는
 * 모듈을 불러오지 못하며(unsupported import) fetch·process 같은 전역이 없어 ALL_TOOLS에 있는 도구만 부른다.
 * 모르는 기능 이름은 Codex가 무시하므로 판이 바뀌어도 실행이 깨지지 않는다. 새 판을 들일 때 `codex features list`로 다시 본다
 */
const DISABLED_FEATURES = [
  'shell_tool',
  'apps',
  'plugins',
  'remote_plugin',
  'plugin_sharing',
  'image_generation',
  'goals',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'computer_use',
  'in_app_browser',
  'multi_agent',
  'sleep_tool',
  'tool_suggest',
  'view_image',
  'skill_search',
  'skill_mcp_dependency_install',
  'workspace_dependencies',
  'worktrees',
  // 데스크톱 앱·대화형 화면용. 비대화형 실행에서 쓰지 않으니 꺼서 안전 목록을 작게 둔다(#980)
  'daemon_auto_start',
  'in_app_chat',
  'in_app_dictation',
  'in_app_local_automation',
  'in_app_updates',
  'realtime_conversation',
  'hooks',
  'shell_snapshot',
  'mentions_v2',
] as const;

/**
 * 끄지 않고 켜 둔 기능과 그 까닭(#980). 닫힌 목록이다: 실행 전에 `codex features list`를 같은 설정으로 읽어,
 * 여기에 없는 기능이 하나라도 켜져 있으면 모델을 부르지 않는다. 끄라고 넘긴 기능이 켜진 채 보여도 여기에 없으니 막힌다.
 * 근거는 묶인 0.157.0에서 이 기능들을 켠 채 에이전트가 본 도구 목록(실측, docs/experiments/2026-10-28-codex-real.md)이다:
 * b-studio 도구, apply_patch, 시계, MCP 자원 읽기 말고는 없었다. 판을 올리면 이 목록을 그 판의 출력으로 다시 정한다
 */
const ALLOWED_ENABLED_FEATURES: Readonly<Record<string, string>> = {
  code_mode_host: 'MCP 도구가 코드 모드로만 보인다(#979). 코드 모드의 자바스크립트는 모듈을 불러오지 못하고 네트워크 전역이 없어 ALL_TOOLS의 도구만 부른다',
  unified_exec: '끌 수 없다(0.157.0은 -c와 --disable을 무시한다). 셸 도구의 구현 방식이라 shell_tool을 끄면 exec_command가 생기지 않는다(실측 도구 목록에 없음)',
  unified_exec_tty: 'unified_exec의 터미널 모드. 위와 같다',
  tool_call_mcp_elicitation: 'MCP 도구 호출 중의 확인 요청 처리. b-studio MCP 서버는 확인을 요청하지 않는다',
  auth_elicitation: 'MCP 서버 인증 요청 처리. b-studio MCP 서버는 환경 변수의 토큰으로 붙는다',
  guardian_approval: '승인 검토. 도구를 주지 않는다',
  guardian_reuse_parent_compaction: '승인 검토의 압축 재사용. 도구를 주지 않는다',
  'guardianv2.thread_context': '승인 검토의 스레드 문맥. 도구를 주지 않는다',
  fast_mode: '응답 속도 설정. 도구를 주지 않는다',
  compaction_image_budget: '대화 압축 때 이미지 예산. 도구를 주지 않는다',
  content_item_kinds: '메시지 항목 형식. 도구를 주지 않는다',
  enable_request_compression: '요청 전송 압축. 도구를 주지 않는다',
  system_proxy_fallback: '시스템 프록시 사용. 도구를 주지 않는다',
  unbounded_connection_retries: '연결 재시도. 도구를 주지 않는다',
  // removed 단계: 이 판의 코드가 더는 읽지 않는 이름이다
  collaboration_modes: 'removed',
  item_ids: 'removed',
  resize_all_images: 'removed',
  sqlite: 'removed',
  steer: 'removed',
  terminal_resize_reflow: 'removed',
  tool_search_always_defer_mcp_tools: 'removed',
  tui_app_server: 'removed',
  unified_exec_zsh_fork: 'removed',
};

/** 스레드와 기능 확인이 함께 쓰는 설정(#976·#980). MCP 서버는 스레드에만 더한다 */
export function codexFeatureConfig(): CodexConfig {
  return { features: Object.fromEntries(DISABLED_FEATURES.map((name) => [name, false])), web_search: 'disabled' };
}

/**
 * `codex features list` 출력에서 켜진 기능이 모두 안전 목록에 있는지 본다(#980). 한 줄은 "이름  단계  true|false"다.
 * 한 줄도 읽지 못하면 확인하지 못한 것으로 막는다
 */
export function checkCodexFeatures(listed: string): { ok: true } | { ok: false; reason: string } {
  const rows = listed
    .split('\n')
    .flatMap((line) => {
      const match = /^(\S+)\s+(.+?)\s+(true|false)$/.exec(line.trim());
      return match ? [{ name: match[1]!, enabled: match[3] === 'true' }] : [];
    });
  if (rows.length === 0) return { ok: false, reason: 'Codex 기능 목록을 읽지 못해 실행하지 않았습니다(관문 밖 기능이 켜져 있는지 확인할 수 없습니다)' };
  const unknown = rows.filter((row) => row.enabled && !Object.hasOwn(ALLOWED_ENABLED_FEATURES, row.name)).map((row) => row.name);
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `Codex에 b-studio가 확인하지 않은 기능이 켜져 있어 실행하지 않았습니다: ${unknown.join(', ')}. 묶인 Codex 판이 바뀌었으면 그 기능이 관문 밖에서 일하는지 보고 끄는 목록이나 안전 목록에 더해야 합니다`,
    };
  }
  return { ok: true };
}

/** 설정 트리를 `--config 키=값` 인자로 편다. 문자열은 TOML 문자열로 감싼다 */
function configArgs(config: CodexConfig, prefix = ''): string[] {
  return Object.entries(config).flatMap(([key, value]) => {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) return configArgs(value, name);
    return ['--config', `${name}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`];
  });
}

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
  /** 스레드가 쓰는 것과 같은 Codex로 `codex features list`를 돌려 출력을 돌려준다(#980). 모델을 부르지 않는다 */
  listFeatures(input: { config: CodexConfig; env: Record<string, string> }): Promise<string>;
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
export const DEFAULT_SDK: CodexSdk = {
  async listFeatures({ config, env }) {
    const { Codex } = await import('@openai/codex-sdk');
    // 스레드와 같은 묶인 실행 파일을 쓴다. SDK가 경로를 내보내지 않아 내부 필드를 읽는다(SDK 판을 고정해 둔다). 없으면 확인하지 못한 것으로 막힌다
    const executable = (new Codex({ env }) as unknown as { exec?: { executablePath?: unknown } }).exec?.executablePath;
    if (typeof executable !== 'string') throw new Error('묶인 Codex 실행 파일을 찾지 못했습니다');
    return run(executable, [...configArgs(config), 'features', 'list'], 30_000, env);
  },
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
  /**
   * 로그인 파일을 빌려 올 계정의 CODEX_HOME(#885). 없으면 지금처럼 `$CODEX_HOME`, 그것도 없으면 `~/.codex`다.
   * 임시 CODEX_HOME을 쓰는 것은 같다 — 이 폴더에서는 auth.json 링크 하나만 가져온다
   */
  authHome?: string;
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
    (gatePromise ??= VerificationGate.create({ project, sandbox, workspace, allowBreaking, maxVerifyAttempts, verify: options.verify, allowCheckChanges: options.allowCheckChanges, outsideChanges: options.outsideChanges, fetcher, pageFetcher, browserRunner, signal, onServiceStatus, onEvent }));
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
  // 실행 지표. modelMs는 모델 응답 대기가 SDK 안(하위 프로세스)에서 일어나 이 러너가 관찰하지 못하므로 비워 둔다("재지 않음", 0초와 다르다).
  // 전체 시간에서 도구·게이트 시간을 뺀 추측값을 넣지 않는다
  const metrics: RunMetrics = { modelCalls: 0, maxContextTokens: 0, toolMs: 0, gateMs: 0, ...(guide ? { guideChars: guide.charsUsed } : {}) };

  // Codex 작업 폴더는 실행마다 만드는 빈 임시 폴더다. project.root를 넘기면 모델이 apply_patch로 작업 공간을 직접 바꿀 수 있다
  const workdir = await mkdtemp(path.join(tmpdir(), WORKDIR_PREFIX));
  let toolServer: Awaited<ReturnType<typeof startToolServer>> | undefined;
  let codexHome: string | undefined;
  let result: CodexRunResult | undefined;
  const usage = emptyUsage();
  // 모델 이름별 사용량(벤치·스튜디오 사용량 집계가 CLI 레인 사용량을 모델별로 더하는 자리, 이슈 #428).
  // 이 러너는 실행 내내 모델을 하나만 쓰므로(승격 미지원, 위 escalation 경고 참고) usage와 같은 객체를
  // 참조로 공유해 갱신을 한 곳에서만 한다. 모델을 고르지 않았으면(계정 기본) 백엔드 이름으로 키를 만든다
  metrics.usageByModel = { [model ?? 'codex:default']: usage };
  let completedTurns = 0;
  /** 앞 턴의 turn.completed.usage(스레드 누적값, #977). 이번 턴의 값은 이것과의 차이다 */
  let threadUsage: Usage | undefined;
  let lastText = '';
  let threadId: string | undefined;
  // ask_user가 남긴 질문. 있으면 이 턴이 끝날 때 실행을 끝내고 사용자 답을 기다린다
  let asked: AskUserQuestion | undefined;

  const finish = (status: AgentResult['status'], summary: string, question?: AskUserQuestion, failureReason?: AgentResult['failureReason']): void => {
    result = {
      status,
      summary,
      changedFiles: workspace.changedFiles(),
      ...(question ? { question } : {}),
      report: gate?.report,
      checks: gate?.checks,
      ...(gate?.lastOutcome ? { gateOutcome: gate.lastOutcome } : {}),
      passedStages: gate ? [...gate.passedStages] : undefined,
      ...(options.verify === 'light' ? { verify: 'light' as const } : {}),
      ...(status === 'done' && gate?.passedAtTurnLimit ? { incomplete: 'max_turns' as const } : {}),
      ...(gate && gate.skippedStages.length > 0 ? { skippedStages: [...gate.skippedStages] } : {}),
      ...((status === 'done' || status === 'awaiting_input') && gate?.lastOutcome === 'pass' && gate.verifiedFingerprints
        ? { verifiedFingerprints: Object.fromEntries(gate.verifiedFingerprints) }
        : {}),
      verifyAttempts: gate?.attempts ?? 0,
      turns: completedTurns,
      usage,
      metrics: { ...metrics },
      threadId,
      ...(failureReason ? { failureReason } : {}),
    };
    onEvent(status === 'failed' ? { type: 'failed', result } : { type: 'done', result });
  };

  try {
    // 임시 CODEX_HOME. 작업 폴더와 다른 폴더다(Codex가 세션·로그를 여기에 쓰므로 작업 폴더와 섞지 않는다)
    codexHome = await mkdtemp(path.join(tmpdir(), CODEX_HOME_PREFIX));
    await linkAuthFile(codexHome, options.authHome);
    const home = codexHome;

    // 모델을 부르기 전에 켜진 기능이 모두 확인한 것인지 본다(#980). 끄는 목록만으로는 새 판이 더한 기능을 막지 못한다
    const features = await sdk.listFeatures({ config: codexFeatureConfig(), env: { ...processEnv(), CODEX_HOME: home } }).then(checkCodexFeatures, (error: unknown) => ({
      ok: false as const,
      reason: `Codex 기능 목록을 읽지 못해 실행하지 않았습니다: ${error instanceof Error ? error.message : String(error)}`,
    }));
    if (!features.ok) {
      finish('failed', features.reason);
      return result!;
    }

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
        ...codexFeatureConfig(),
        // b-studio 도구가 관문이다. Codex 쪽 승인은 미리 허락한다(#979): 0.157은 승인 없음(never)으로 돌면 MCP 도구 호출을 거절한다
        mcp_servers: { [SERVER]: { url: toolServer.url, bearer_token_env_var: TOKEN_ENV, default_tools_approval_mode: 'approve' } },
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
      try {
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
              const turn = turnUsage(event.usage, threadUsage);
              threadUsage = event.usage;
              addUsage(usage, turn);
              const turnContext = turn.inputTokens + turn.cacheReadTokens + turn.cacheWriteTokens;
              metrics.maxContextTokens = Math.max(metrics.maxContextTokens, turnContext);
              onEvent({ type: 'tokens', usage: { ...usage } });
              // 턴 하나의 사용량. 누적값(tokens)과 달리 턴별 컨텍스트 증가를 볼 수 있다
              onEvent({
                type: 'turn_usage',
                turn: completedTurns,
                ...turn,
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
      } catch (error) {
        // SDK는 turn.failed·error 이벤트를 넘긴 뒤 CLI가 종료 코드 1로 끝나면 예외를 던진다(#983).
        // 이벤트로 받은 이유(사용 한도 등)가 있으면 그것을 쓴다. 예외 문구에는 stderr 첫 줄만 남는다
        if (!failure) throw error;
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
    if (!result) {
      // 턴 상한에 걸렸다. 바로 실패로 끝내지 않고 지금까지의 변경이 게이트를 통과하는지 한 번 더 본다(ADR-131)
      const gateStarted = performance.now();
      const recheck = await recheckGateOnMaxTurns(gate, maxTurns, onEvent);
      metrics.gateMs += Math.round(performance.now() - gateStarted);
      if (recheck.pass) finish('done', recheck.summary);
      else finish('failed', recheck.summary, undefined, 'max_turns');
    }
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
  { command = 'codex', timeoutMs = 60_000, env }: { command?: string; timeoutMs?: number; /** 계정마다 CODEX_HOME을 따로 둘 때 준다(#885). 없으면 process.env */ env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: true } | CliPreflightFailure> {
  try {
    await run(command, ['login', 'status'], timeoutMs, env);
    return { ok: true };
  } catch (error) {
    return cliPreflightFailure(`Codex CLI에 로그인돼 있지 않습니다. 터미널에서 "codex"를 실행해 "Sign in with ChatGPT"로 로그인하세요.`, error);
  }
}

/**
 * 한 턴의 사용량을 b-studio 규칙(입력은 캐시 제외)으로 옮긴다(#977). 실측(Codex 0.157.0, 2026-10-28):
 *  - 같은 스레드를 이어 가면(SDK가 턴마다 `codex exec resume`) turn.completed.usage는 스레드 누적값이다.
 *    첫 턴 input 17,280, 둘째 턴 29,759이고 세션 기록의 둘째 턴 호출은 12,479였다. 그래서 앞 턴 값과의 차이를 쓴다.
 *  - input_tokens는 캐시 읽기를 포함한다(세션 기록의 total_tokens = input_tokens + output_tokens). 그래서 캐시 몫을 뺀다.
 *    cache_write_input_tokens도 같은 자리라고 본다(실측에서는 늘 0).
 * 값이 앞 턴보다 작으면(새 스레드) 이번 값을 그대로 쓴다.
 */
function turnUsage(now: Usage, before: Usage | undefined): AgentUsage {
  const fields = (u: Usage) => [u.input_tokens, u.cached_input_tokens ?? 0, u.cache_write_input_tokens ?? 0, u.output_tokens] as const;
  const current = fields(now);
  const previous = before ? fields(before) : undefined;
  const fresh = !previous || current.some((value, index) => value < previous[index]!);
  const [input, cached, written, output] = current.map((value, index) => (fresh ? value : value - previous![index]!));
  return { inputTokens: Math.max(0, input! - cached! - written!), outputTokens: output!, cacheReadTokens: cached!, cacheWriteTokens: written! };
}

function addUsage(total: AgentUsage, turn: AgentUsage): void {
  total.inputTokens += turn.inputTokens;
  total.outputTokens += turn.outputTokens;
  total.cacheReadTokens += turn.cacheReadTokens;
  total.cacheWriteTokens += turn.cacheWriteTokens;
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
async function linkAuthFile(codexHome: string, authHome: string | undefined): Promise<void> {
  const auth = path.join(authHome ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex'), 'auth.json');
  if (!(await exists(auth))) return;
  await symlink(auth, path.join(codexHome, 'auth.json'));
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  );
}

function run(command: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, ...(env ? { env } : {}) }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

