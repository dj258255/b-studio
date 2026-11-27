import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { native } from './native';
import { COMMAND_CODE_GATEWAY_DIR_ENV, COMMAND_CODE_MOD, COMMAND_CODE_MOD_NAME } from './commandcode-mod';
import { geminiSettingsContent } from './gemini-config';
import { GEMINI_HOME_DIR, GEMINI_HOOK, GEMINI_HOOK_NAME, GEMINI_SETTINGS_NAME } from './gemini-hook';
import {
  AGENT_HOOK_EVENTS,
  AGENT_HOOK_SCRIPT,
  agentManagedMcp,
  CODEX_GATEWAY_DIR_ENV,
  CODEX_HOOK_SCRIPT,
  CODEX_HOOK_SCRIPT_NAME,
  clampTerminalSize,
  defaultAgentGatewayRoot,
  GATEWAY_FILE_NAME,
  HOOK_SCRIPT_NAME,
  STATUSLINE_FILE,
  type AgentGatewayAddress,
  type AgentHookEvent,
  type AgentTerminal,
  type TerminalSize,
} from './docker/agent-terminal';
import { SandboxError } from './errors';
import { execChecked } from './exec-checked';


/**
 * 이 컴퓨터에서 도는 세션 터미널(ADR-173). 세션의 작업 복사본에서 이 컴퓨터에 깔린 에이전트 CLI를 그대로 띄운다.
 *
 * 컨테이너 방식(docker/agent-terminal.ts)과 견주면:
 *  - 설치·로그인·플러그인·설정이 그대로 따라온다(프로젝트마다 다시 하지 않는다)
 *  - 격리가 없다. CLI는 이 컴퓨터의 다른 파일에도 닿을 수 있다. 평소 터미널에서 CLI를 쓰는 것과 같은 신뢰 수준이다
 *  - 훅과 b-studio 도구는 관리 설정 자리가 아니라 실행 인자(`--settings`, `--mcp-config`)로 붙인다.
 *    인자로 준 설정은 프로젝트·사용자 설정보다 앞선다. 다만 CLI를 인자 없이 직접 띄우면 붙지 않는다 —
 *    그래서 사용자의 로그인 셸 시작 파일 끝에 `claude`를 감싸개를 부르는 **함수**로 정의한다(함수는 PATH 순서와 무관하다).
 *    터미널에서는 사용자의 셸이 그대로 열리고, 시작 파일이 PATH 앞에 진짜 `claude`를 두어도 이 함수가 이긴다
 *
 * 훅은 여기서도 판정이 아니라 통로다. 훅이 불리지 않으면 검증이 돌지 않고, 검증이 돌지 않으면 체크포인트가 생기지 않는다
 */

/** 이 컴퓨터의 CLI가 b-studio의 훅 서버·도구 서버를 부르는 주소의 호스트 */
export const HOST_GATEWAY_HOST = '127.0.0.1';
export { STATUSLINE_FILE };
const SETTINGS_FILE = 'settings.json';
const MCP_FILE = 'mcp.json';
const WRAPPER_DIR = 'bin';
/** Codex 감싸개가 읽는 환경(세션의 관문 폴더, 도구 서버·텔레메트리 토큰). 토큰을 실행 인자에 넣지 않으려고 따로 둔다(#825) */
const CODEX_ENV_FILE = 'codex.env';
/** Codex 감싸개가 도구 서버(MCP) 토큰을 넘기는 환경 변수 */
const CODEX_MCP_TOKEN_ENV = 'B_STUDIO_MCP_TOKEN';
/** Codex는 SessionEnd 훅을 3초까지만 기다린다(공식 문서) */
const CODEX_SESSION_END_SECONDS = 3;
/** 셸 시작 파일을 두는 폴더와 그 안의 파일들(폴더 기준). 사용자 셸을 열 때 ZDOTDIR/--rcfile로 이 자리를 가리킨다 */
const SHELL_DIR = 'shell';
const ZSH_DIR = path.join(SHELL_DIR, 'zsh');
const ZSH_START_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin'] as const;
const BASH_RC_FILE = path.join(SHELL_DIR, 'bashrc');
const HOST_PING_SECONDS = 5;

/** 셸 명령에 넣을 글을 작은따옴표로 감싼다. 경로에 빈칸이나 따옴표가 있어도 한 덩어리로 읽힌다(판정은 Rust 코어가 한다) */
export function shellQuote(value: string): string {
  return native.terminalShellQuote(value);
}

/**
 * 터미널에서 띄우는 에이전트 CLI. 세션의 백엔드가 codex면 codex, commandcode면 commandcode(실험, ADR-233), 그 밖에는 claude다(#825)
 * commandcode는 훅을 설정 파일이 아니라 mod 파일(`--mod`)로 붙인다. gemini(실험, ADR-242)는 `GEMINI_CLI_HOME`을 관문 폴더 안의 홈으로 바꿔 그 사용자 설정의 훅으로 붙인다
 */
export type HostCliKind = 'claude' | 'codex' | 'commandcode' | 'gemini';
const CLI_BIN_ENV: Record<HostCliKind, string> = { claude: 'B_STUDIO_CLAUDE_BIN', codex: 'B_STUDIO_CODEX_BIN', commandcode: 'B_STUDIO_COMMANDCODE_BIN', gemini: 'B_STUDIO_GEMINI_BIN' };

export interface HostCli {
  kind: HostCliKind;
  /** 이 컴퓨터에 깔린 에이전트 CLI의 절대 경로 */
  cliPath: string;
  /** 훅 스크립트를 돌릴 node의 절대 경로(스튜디오가 도는 그 node) */
  nodePath: string;
  /**
   * 이 세션이 쓰는 계정의 설정 폴더(#885). 감싸개가 claude는 CLAUDE_CONFIG_DIR, codex는 CODEX_HOME으로 넘긴다.
   * 없으면 기본 계정이라 아무것도 넘기지 않는다(사용자가 셸에서 정한 값이 그대로 간다)
   */
  configDir?: string;
  /**
   * 사용자가 쓰던 Claude 상태 줄 명령(#920). b-studio의 상태 줄이 문맥 창을 관문에 알린 뒤 이 명령을 이어 부른다.
   * 실행 인자의 설정이 사용자 설정의 상태 줄을 덮으므로, 이어 부르지 않으면 사용자의 상태 줄이 사라진다
   */
  statusLine?: string;
  /** gemini: 사용자가 쓰던 로그인 방식(`security.auth.selectedType`). 우리 설정에 옮겨 CLI가 로그인 방식을 처음부터 다시 묻지 않게 한다 */
  geminiAuthType?: string;
  /**
   * API 모드 세션의 자체 에이전트 CLI(ADR-226). 있으면 종류는 claude 그대로 두고 `cliPath`만 관문 폴더의 실행기(`agent-tty`)로 바꾼다.
   * 그러면 감싸개·훅 설정·감시가 그대로 맞물린다. 실행기와 모델 파일(키가 든다)도 기대 파일이라 변조 감시·복구와 정리의 대상이다
   */
  selfAgent?: SelfAgent;
}

/** 자체 CLI를 띄우는 데 필요한 것. 경로는 모두 절대 경로다 */
export interface SelfAgent {
  /** `apps/cli/src/agent-tty.ts` */
  entry: string;
  /** tsx의 `dist/loader.mjs`. `node --import`로 불러 프로세스를 하나로 둔다 */
  loader: string;
  /** 모델 파일에 쓸 값. 모델 설정(검증은 CLI가 한다)과 키 */
  model: { profile: Record<string, unknown>; apiKey?: string };
}

/** 관문 폴더 안의 자체 CLI 실행기와 모델 파일 이름. Rust 정리 목록(GATEWAY_FILE_NAMES)과 같아야 한다 */
export const SELF_AGENT_LAUNCHER_FILE = 'agent-tty';
export const SELF_AGENT_MODEL_FILE = 'agent-model.json';

/** 이 관문 폴더에서 CLI로 부를 경로. 자체 CLI면 폴더의 실행기, 아니면 이 컴퓨터에 깔린 CLI다 */
export function hostCliPath(dir: string, cli: Pick<HostCli, 'cliPath' | 'selfAgent'>): string {
  return cli.selfAgent ? path.join(dir, SELF_AGENT_LAUNCHER_FILE) : cli.cliPath;
}

/**
 * 자체 CLI 실행기. `exec -a`로 첫 낱말(`ps`가 보여 주는 argv[0])을 실행기 경로로 둬서 감시가 알아본다.
 * 모든 값은 작은따옴표로 감싼다(경로에 빈칸·따옴표가 있어도 한 덩어리)
 */
export function selfAgentLauncher(dir: string, nodePath: string, agent: Pick<SelfAgent, 'entry' | 'loader'>): string {
  const q = shellQuote;
  return `#!/bin/bash\nexec -a ${q(path.join(dir, SELF_AGENT_LAUNCHER_FILE))} ${q(nodePath)} --import ${q(agent.loader)} ${q(agent.entry)} "$@"\n`;
}

/**
 * 사용자가 쓰던 Claude 상태 줄 명령을 읽기만 한다(#920). Claude의 설정 순서(사용자 < 프로젝트 < 로컬)대로
 * 작업 폴더의 `.claude/settings.local.json`, `.claude/settings.json`(#942), 계정 폴더(없으면 ~/.claude)의 settings.json에서
 * 처음 맞는 `statusLine.command`를 고른다. 터미널을 열 때 한 번만 읽는다(세션 중에 작업 폴더의 파일이 바뀌어도 이번 터미널에는 닿지 않는다).
 * 없거나 꼴이 틀리거나, b-studio 훅 스크립트를 부르는 명령이면(자기 자신을 다시 부르게 된다) 다음 것을 보고, 모두 아니면 undefined
 */
export async function userStatusLineCommand(configDir: string | undefined, home: string = homedir(), projectDir?: string): Promise<string | undefined> {
  const files = [
    ...(projectDir ? [path.join(projectDir, '.claude', 'settings.local.json'), path.join(projectDir, '.claude', 'settings.json')] : []),
    path.join(configDir ?? path.join(home, '.claude'), 'settings.json'),
  ];
  for (const file of files) {
    const command = await statusLineIn(file);
    if (command) return command;
  }
  return undefined;
}

async function statusLineIn(file: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    const line = typeof parsed === 'object' && parsed !== null ? (parsed as { statusLine?: unknown }).statusLine : undefined;
    const command = typeof line === 'object' && line !== null ? (line as { command?: unknown }).command : undefined;
    if (typeof command !== 'string' || !command.trim() || command.includes(HOOK_SCRIPT_NAME)) return undefined;
    return command;
  } catch {
    return undefined;
  }
}

/** CLI마다 계정 설정 폴더를 받는 환경 변수(#885). commandcode는 기본 계정만 쓴다(계정 폴더를 정하는 변수를 모르는 채 내보내지 않는다) */
export const ACCOUNT_DIR_ENV: Record<Exclude<HostCliKind, 'commandcode' | 'gemini'>, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };

/** 계정 폴더 변수의 이름. 기본 계정만 쓰는 CLI(commandcode·gemini)는 없다 */
export function accountDirEnvName(kind: HostCliKind): string | undefined {
  return kind === 'commandcode' || kind === 'gemini' ? undefined : ACCOUNT_DIR_ENV[kind];
}

/** 감싸개에서 계정 폴더를 내보내는 줄. 기본 계정이면 없다 */
function accountExport(kind: HostCliKind, configDir: string | undefined): string[] {
  const name = accountDirEnvName(kind);
  return configDir && name ? [`export ${name}=${shellQuote(configDir)}`] : [];
}

/**
 * 이 컴퓨터의 에이전트 CLI를 찾는다. `B_STUDIO_CLAUDE_BIN`(codex는 `B_STUDIO_CODEX_BIN`)이 있으면 그것을, 없으면 PATH에서 찾는다.
 * 찾지 못하면 던진다 — 터미널을 열어 놓고 "명령을 찾을 수 없음"을 보이는 것보다 먼저 알린다
 */
export async function findHostCli(env: Record<string, string | undefined> = process.env, kind: HostCliKind = 'claude'): Promise<HostCli> {
  const variable = CLI_BIN_ENV[kind];
  const configured = env[variable]?.trim();
  let cliPath = configured && path.isAbsolute(configured) ? configured : undefined;
  if (!cliPath) {
    // 셸의 내장 명령으로 찾는다. 이름은 고정이라 명령 글에 끼워 넣는 값이 없다
    // 이름은 문자열에 잇지 않고 위치 인자($1)로 넘긴다
    const found = await execChecked('/bin/sh', ['-c', 'command -v -- "$1"', 'sh', kind], { env: env as NodeJS.ProcessEnv }).then(
      ({ stdout }) => stdout.trim().split('\n')[0] ?? '',
      () => '',
    );
    if (path.isAbsolute(found)) cliPath = found;
  }
  if (!cliPath) {
    throw new SandboxError(
      `이 컴퓨터에서 ${kind} CLI를 찾지 못했습니다`,
      kind === 'claude'
        ? 'claude를 설치하고 로그인한 뒤 다시 여세요. 다른 자리에 있으면 B_STUDIO_CLAUDE_BIN에 절대 경로를 적습니다. B_STUDIO_TERMINAL=container로 띄우면 컨테이너 안에 설치해 씁니다'
        : kind === 'commandcode'
          ? 'commandcode를 설치하고 로그인한 뒤 다시 여세요. 다른 자리에 있으면 B_STUDIO_COMMANDCODE_BIN에 절대 경로를 적습니다'
          : kind === 'gemini'
            ? 'gemini(0.71.1 이상)를 설치하고 로그인한 뒤 다시 여세요. 다른 자리에 있으면 B_STUDIO_GEMINI_BIN에 절대 경로를 적습니다'
            : 'codex를 설치하고 로그인한 뒤 다시 여세요. 다른 자리에 있으면 B_STUDIO_CODEX_BIN에 절대 경로를 적습니다',
    );
  }
  // commandcode는 링크를 푼 진짜 파일로 띄운다: 감시는 프로세스 인자에 설치된 패키지 자리(/command-code/dist/)가 있는 것을 그 CLI로 본다.
  // 링크 이름(`…/bin/commandcode`)으로 띄우면 node의 인자에 패키지 자리가 없어 감시가 CLI로 알아보지 못한다. 풀지 못하면 그대로 둔다
  // gemini도 같다: `node <패키지>/bundle/gemini.js`로 보여야 감시가 CLI로 알아본다
  if (kind === 'commandcode' || kind === 'gemini') cliPath = await realpath(cliPath).catch(() => cliPath!);
  return { kind, cliPath, nodePath: process.execPath };
}

/** 이 컴퓨터용 CLI 설정: 훅 명령이 세션의 관문 폴더에 둔 스크립트를 부른다(텔레메트리도 같은 관문 주소로 보낸다) */
export function hostGatewaySettings(address: Pick<AgentGatewayAddress, 'hookUrl' | 'hookToken'>, dir: string, nodePath: string): Record<string, unknown> {
  return JSON.parse(native.terminalHostGatewaySettingsJson(dir, nodePath, address.hookUrl, address.hookToken)) as Record<string, unknown>;
}

/**
 * 인자를 붙여 CLI를 부르는 감싸개. 터미널의 PATH 맨 앞에 놓여, 터미널에서 `claude`를 어떻게 띄우든(다시 띄우거나 `--resume`을 주거나)
 * 훅과 b-studio 도구가 붙는다. 사용자가 준 인자는 그대로 넘긴다.
 * `--mcp-config`는 값을 여러 개 받으므로 첫 낱말(요청 글)을 설정 파일로 먹지 않게 `--settings`를 뒤에 둔다(#836).
 * 감시가 이 정확한 자리(`<cli> --mcp-config M --settings S`)로 붙었는지 판정한다(ADR-219). 순서는 Rust 코어가 지킨다
 */
export function hostCliWrapper(dir: string, claudePath: string, configDir?: string): string {
  return native.terminalHostCliWrapper(dir, claudePath, configDir);
}

/** TOML 기본 문자열. JSON의 이스케이프는 TOML 기본 문자열에서도 같은 뜻이다 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Codex 훅 명령. 세션과 무관하게 같은 글이어야 한다 — Codex는 훅 명령 글의 해시로 사용자의 신뢰를 기억해서,
 * 글이 바뀌면 다시 검토하라고 묻는다(0.160.1에서 실측). 그래서 세션의 관문 폴더가 아니라 관문 루트의 스크립트를 가리키고,
 * 세션의 관문 폴더는 감싸개가 환경 변수로 넘긴다
 */
export function codexHookCommand(root: string, nodePath: string, event: AgentHookEvent): string {
  return `${shellQuote(nodePath)} ${shellQuote(path.join(root, CODEX_HOOK_SCRIPT_NAME))} ${event}`;
}

/**
 * Codex에 붙이는 설정 덮어쓰기(`-c 키=값`). 훅·도구 서버·텔레메트리를 붙이고, 사용자 설정이 훅을 꺼 두었어도 켠다.
 * 토큰은 여기 넣지 않는다(실행 인자는 이 컴퓨터의 다른 사용자도 `ps`로 본다). 감싸개가 codex.env에서 읽어 환경 변수로 넘긴다.
 * PreToolUse에 matcher를 두지 않는다: Codex의 matcher는 앞보기를 못 쓰는 정규식이라 "읽기 도구가 아닌 모든 것"을 적을 수 없다.
 * 모든 도구에 훅을 걸고 관문이 읽기 도구(CODEX_READ_TOOLS)를 바로 통과시킨다
 */
export function codexGatewayArgs(address: Pick<AgentGatewayAddress, 'hookUrl' | 'mcpUrl'>, root: string, nodePath: string): string[] {
  const hook = (event: AgentHookEvent, seconds: number = AGENT_HOOK_EVENTS[event]): string =>
    `[{hooks=[{type="command",command=${tomlString(codexHookCommand(root, nodePath, event))},timeout=${seconds}}]}]`;
  const overrides = [
    'features.hooks=true',
    `hooks.SessionStart=${hook('session-start')}`,
    `hooks.UserPromptSubmit=${hook('prompt')}`,
    `hooks.PreToolUse=${hook('pre-tool')}`,
    `hooks.Stop=${hook('stop')}`,
    `hooks.SessionEnd=${hook('session-end', CODEX_SESSION_END_SECONDS)}`,
    // 권한 확인 창이 뜨면 알린다(B7). 답을 주지 않으므로 확인은 사용자가 그대로 한다
    `hooks.PermissionRequest=${hook('notification')}`,
    `mcp_servers.b-studio={url=${tomlString(address.mcpUrl)},bearer_token_env_var=${tomlString(CODEX_MCP_TOKEN_ENV)}}`,
    `otel.exporter={otlp-http={endpoint=${tomlString(`${address.hookUrl}/v1/logs`)},protocol="json"}}`,
    'otel.log_user_prompt=false',
    // b-studio 터미널의 CLI가 시작할 때 업데이트를 묻거나 스스로 깔지 않게 한다(#836). 그 창이 뜨면 터미널에 보낸 글과 Enter가 답이 될 수 있다
    'check_for_update_on_startup=false',
  ];
  return overrides.flatMap((value) => ['-c', value]);
}

/** Codex 감싸개가 읽는 환경 파일. 토큰이 들어 있어 600으로 둔다 */
export function codexEnvFile(address: Pick<AgentGatewayAddress, 'hookToken' | 'mcpToken'>, dir: string): string {
  return [
    '# b-studio가 만든 파일입니다. 고쳐도 다음에 터미널을 열 때 다시 쓰입니다.',
    `export ${CODEX_GATEWAY_DIR_ENV}=${shellQuote(dir)}`,
    `export ${CODEX_MCP_TOKEN_ENV}=${shellQuote(address.mcpToken)}`,
    // 텔레메트리도 관문의 토큰으로 받는다(Claude와 같다). OTLP 머리글 값의 빈칸은 %20으로 적는다
    `export OTEL_EXPORTER_OTLP_LOGS_HEADERS=${shellQuote(`Authorization=Bearer%20${address.hookToken}`)}`,
    '',
  ].join('\n');
}

/**
 * Codex 감싸개. 환경 파일을 읽고 설정 덮어쓰기를 붙여 진짜 codex를 띄운다. 사용자가 준 인자는 그대로 넘긴다.
 * Codex는 세션 시작 훅을 CLI가 뜰 때가 아니라 첫 요청을 보낼 때 돌린다(0.160.1에서 실측, #828). 그래서 대화형으로 띄울 때는
 * 감싸개가 띄우기 직전에 세션 시작을, CLI가 끝난 뒤에 세션 끝을 같은 훅 스크립트로 알린다(화면의 "CLI 떠 있음"). 알림은 판정에 쓰이지 않는다.
 * 대화형으로 보는 것은 인자가 없거나, 옵션으로 시작하거나(도움말·판 보기 빼고), `resume`·`fork`일 때다. 첫 요청 글을 인자로 주면
 * CLI가 곧바로 그 요청의 세션 시작 훅을 돌리므로 알리지 않는다. `exec` 같은 하위 명령도 알리지 않는다
 */
export function hostCodexWrapper(address: Pick<AgentGatewayAddress, 'hookUrl' | 'mcpUrl'>, dir: string, cli: Pick<HostCli, 'cliPath' | 'nodePath' | 'configDir'>): string {
  const args = codexGatewayArgs(address, path.dirname(dir), cli.nodePath).map(shellQuote).join(' ');
  const notify = (event: AgentHookEvent) => `printf '{}' | ${codexHookCommand(path.dirname(dir), cli.nodePath, event)} >/dev/null 2>&1`;
  const codex = shellQuote(cli.cliPath);
  return [
    '#!/bin/sh',
    '# b-studio가 만든 파일입니다. 고쳐도 다음에 터미널을 열 때 다시 쓰입니다.',
    `. ${shellQuote(path.join(dir, CODEX_ENV_FILE))}`,
    // 세션의 계정(#885). 훅 신뢰도 계정 폴더마다 따로 기억하므로 새 계정에서는 처음 한 번 묻는다
    ...accountExport('codex', cli.configDir),
    'interactive=',
    'case "${1-}" in',
    '  -h|--help|-V|--version) ;;',
    "  ''|-*|resume|fork) interactive=1 ;;",
    'esac',
    `set -- ${args} "$@"`,
    `[ -n "$interactive" ] || exec ${codex} "$@"`,
    '# 끝난 뒤의 알림을 보내도록 신호에 바로 죽지 않는다(빈 처리기라 자식 CLI는 신호를 평소대로 받는다)',
    "trap ':' INT TERM HUP",
    notify('session-start'),
    `${codex} "$@"`,
    'status=$?',
    notify('session-end'),
    'exit $status',
    '',
  ].join('\n');
}

/** Command Code 감싸개가 mod 파일의 자리로 넘기는 인자. 감시(`hooked_launch`)가 이 정확한 자리(`<cli> --mod <M>`)를 본다 */
export function commandCodeModPath(dir: string): string {
  return path.join(dir, COMMAND_CODE_MOD_NAME);
}

/**
 * Command Code 감싸개(ADR-233, 실험). 세션의 관문 폴더를 환경 변수로 알리고 `commandcode --mod <관문 폴더>/b-studio-mod.ts`로 부른다. 사용자가 준 인자는 그대로 뒤에 붙인다.
 * 모델 고르기(`-m`·`--model`)와 권한 방식(`--permission-mode`·`--yolo`)은 붙이지 않는다: 기본 모델로 뜨고, TUI의 권한 창은 Claude 터미널과 같이 사람이 답한다.
 * `--mod`는 인자의 맨 앞에 둔다. 감시가 이 정확한 자리만 붙은 것으로 본다(사용자가 `--mod`를 더 주거나 `--safe-mode`를 주면 붙지 않은 것이다).
 * 토큰은 여기 없다. mod가 관문 폴더의 주소 파일에서 읽는다
 */
export function hostCommandCodeWrapper(dir: string, cli: Pick<HostCli, 'cliPath'>): string {
  return [
    '#!/bin/sh',
    '# b-studio가 만든 파일입니다. 고쳐도 다음에 터미널을 열 때 다시 쓰입니다.',
    `export ${COMMAND_CODE_GATEWAY_DIR_ENV}=${shellQuote(dir)}`,
    `exec ${shellQuote(cli.cliPath)} --mod ${shellQuote(commandCodeModPath(dir))} "$@"`,
    '',
  ].join('\n');
}

/** Gemini가 홈으로 쓸 폴더(`GEMINI_CLI_HOME`). 감시(`hooked_launch`)가 이 정확한 글을 환경에서 본다 */
export function geminiHomePath(dir: string): string {
  return path.join(dir, GEMINI_HOME_DIR);
}

/**
 * Gemini 감싸개(ADR-242, 실험). Gemini는 훅을 설정(`settings.json`)에서 읽고, 시스템 설정은 root 소유일 때만 읽으므로 사용자 설정으로 붙인다:
 * `GEMINI_CLI_HOME`을 관문 폴더 안의 홈으로 바꾸고, 그 안의 `.gemini/settings.json`에 관문 폴더의 `gemini-settings.json`(내용을 검사하는 기대 파일)을 **띄울 때마다 새로 복사한다**.
 * 사용자의 진짜 `~/.gemini`는 읽지 않는다(그 설정의 훅·확장이 붙지 않는다). 로그인 파일(`oauth_creds.json` 등 넷)만 링크로 이어 로그인이 따라오게 한다.
 * 홈 안에 확장·정책·`.env`가 있거나 홈이 링크이면 띄우지 않는다(훅을 더하거나 믿음 설정을 바꿀 수 있다). 시스템 설정 자리와 믿음을 정하는 환경 변수는 지운다.
 * 사용자가 준 인자는 그대로 뒤에 붙인다. 모델 고르기(`-m`·`--model`)와 권한을 건너뛰는 인자(`--yolo`·`--approval-mode`)는 붙이지 않는다: 기본 모델로 뜨고, 권한 확인은 사람이 답한다.
 * `B_STUDIO_GEMINI_USER_HOME`은 진짜 홈을 기억한다(감싸개를 안쪽에서 다시 불러도 우리 홈을 진짜 홈으로 읽지 않게)
 */
export function hostGeminiWrapper(dir: string, cli: Pick<HostCli, 'cliPath'>): string {
  const q = shellQuote;
  return [
    '#!/bin/sh',
    '# b-studio가 만든 파일입니다. 고쳐도 다음에 터미널을 열 때 다시 쓰입니다.',
    `dir=${q(dir)}`,
    `home=${q(geminiHomePath(dir))}`,
    'real="${B_STUDIO_GEMINI_USER_HOME:-${GEMINI_CLI_HOME:-$HOME}}"',
    'export B_STUDIO_GEMINI_USER_HOME="$real"',
    "refuse() { printf '%s\\n' \"[b-studio] $1\" >&2; exit 1; }",
    '[ -L "$home" ] || [ -L "$home/.gemini" ] && refuse "Gemini의 홈이 링크라 띄우지 않았습니다"',
    'mkdir -p -m 700 "$home" && mkdir -p -m 700 "$home/.gemini" || refuse "Gemini의 홈을 만들지 못했습니다"',
    'for name in extensions policies .env; do',
    '  [ -e "$home/.gemini/$name" ] || [ -L "$home/.gemini/$name" ] && refuse "Gemini의 홈에 $name 이(가) 있어 띄우지 않았습니다"',
    'done',
    // 설정은 지우고 새로 복사한다(미리 심은 링크를 따라 쓰지 않는다)
    `rm -f "$home/.gemini/settings.json" && cp "$dir/${GEMINI_SETTINGS_NAME}" "$home/.gemini/settings.json" && chmod 600 "$home/.gemini/settings.json" || refuse "Gemini 설정을 복사하지 못했습니다"`,
    'for name in oauth_creds.json google_accounts.json google_account_id installation_id; do',
    '  if [ -f "$real/.gemini/$name" ] && [ "$real" != "$home" ] && [ ! -e "$home/.gemini/$name" ] && [ ! -L "$home/.gemini/$name" ]; then',
    '    ln -s "$real/.gemini/$name" "$home/.gemini/$name"',
    '  fi',
    'done',
    'unset GEMINI_CLI_SYSTEM_SETTINGS_PATH GEMINI_CLI_SYSTEM_DEFAULTS_PATH GEMINI_RESTRICTED_MODE GEMINI_CLI_TRUST_WORKSPACE',
    'export GEMINI_CLI_HOME="$home"',
    `exec ${q(cli.cliPath)} "$@"`,
    '',
  ].join('\n');
}

/**
 * 첫 요청(#836). 터미널을 열 때 받은 첫 요청 글을 CLI의 실행 인자로 넘긴다. 키 입력(붙여 넣기 + Enter)으로 넣지 않는다:
 * CLI가 시작하며 묻는 창(폴더 신뢰, 훅 신뢰, 업데이트)이 뜨면 그 글과 Enter가 사람 대신 그 창의 답이 된다.
 * 글은 PTY의 환경 변수로만 받고(셸 글에 잇지 않는다), 셸이 시작 파일을 읽기 전에 셸 변수로 옮기고 환경에서 지운다.
 * 셸 변수는 내보내지 않으므로 사용자의 시작 파일이 띄우는 프로그램과 CLI에 내려가지 않는다. 첫 실행에서 한 번 쓰고 지운다
 */
export const FIRST_PROMPT_ENV = 'B_STUDIO_FIRST_PROMPT';

/** 검증 함수의 `{ok,value|title,detail}` 봉투를 풀거나 `SandboxError`로 만든다 */
function gatewayValue<T>(json: string): T {
  const result = JSON.parse(json) as { ok: boolean; value?: T; title?: string; detail?: string };
  if (result.ok) return result.value as T;
  throw new SandboxError(result.title!, result.detail);
}

/**
 * CLI 실행 인자로 넘길 첫 요청 글. 옵션(`-`로 시작)이나 하위 명령(`update`처럼 빈칸 없는 한 낱말)으로 읽히지 않게 앞에 "요청: "을 붙인다.
 * `--`로 옵션을 끝내는 길은 쓰지 않는다: claude(commander)는 `--` 뒤의 첫 낱말도 하위 명령으로 맞춰 본다
 */
export function firstPromptArg(text: string): string {
  return gatewayValue<string>(native.terminalFirstPromptArg(text));
}

/**
 * 이어 붙일 CLI 대화 id(#872). 스튜디오를 다시 띄운 뒤 터미널을 열 때, 훅으로 받아 세션 기록에 남긴 지난 대화를 첫 실행에서 이어 붙인다
 * (claude `--resume <id>`, codex `resume <id>`). 첫 요청과 같이 PTY 환경 변수로만 받고, 시작 파일보다 먼저 셸 변수로 옮겨 환경에서 지운다
 */
export const RESUME_CONVERSATION_ENV = 'B_STUDIO_RESUME_ID';

/** 이어 붙일 수 있는 꼴의 대화 id인가. 훅으로 온 값을 기억하기 전에 본다(꼴 판정은 Rust 코어가 한다) */
export function isResumableConversation(id: unknown): id is string {
  return typeof id === 'string' && native.terminalIsResumableConversation(id);
}

/** CLI 실행 인자로 넘길 대화 id. 꼴이 맞지 않으면 던진다(훅으로 온 값이라 바깥에서 온 값이다) */
export function resumeConversationArg(id: string): string {
  return gatewayValue<string>(native.terminalResumeConversationArg(id));
}

/**
 * 라우팅이 고른 모델(#988). 세션에 모델이 있으면 CLI를 처음 띄울 때 `--model=<id>`로 넘긴다(claude·codex 모두 받는다).
 * 첫 요청과 같이 PTY 환경 변수로만 받고, 시작 파일보다 먼저 셸 변수로 옮겨 환경에서 지운다. 없으면 CLI 기본 모델이다
 */
export const CLI_MODEL_ENV = 'B_STUDIO_CLI_MODEL';

/** CLI 실행 인자로 넘길 모델 id. 꼴이 맞지 않으면 던진다(꼴 판정은 Rust 코어가 한다) */
export function cliModelArg(model: string): string {
  return gatewayValue<string>(native.terminalCliModelArg(model));
}

/** zsh의 관문 폴더에 둘 네 파일 → 내용. 셸 주입을 막는 글은 Rust 코어가 만든다(ADR-219) */
export function hostZshFiles(dir: string, kind: HostCliKind = 'claude'): Record<(typeof ZSH_START_FILES)[number], string> {
  return Object.fromEntries(native.terminalHostZshFiles(dir, kind).map((file) => [file.name, file.content])) as Record<(typeof ZSH_START_FILES)[number], string>;
}

/** bash의 관문 폴더에 둘 시작 파일 → 내용. 로그인 셸의 순서(/etc/profile, 그다음 사용자 파일 하나)를 흉내 낸다 */
export function hostBashRc(dir: string, kind: HostCliKind = 'claude'): string {
  return native.terminalHostBashRc(dir, kind);
}

/** Codex 훅 스크립트의 자리(폴더 기준). 관문 루트에 하나를 두고 모든 세션이 같이 쓴다 — 훅 명령 글이 세션마다 같아야 한다 */
const CODEX_HOOK_SCRIPT_ENTRY = path.join('..', CODEX_HOOK_SCRIPT_NAME);

/**
 * 관문 폴더에 있어야 할 파일: 이름(폴더 기준) → { 내용, 권한 }. 내용·권한의 근거를 한 곳에 둔다.
 * codex는 설정을 실행 인자로 붙이므로 설정 파일(settings.json·mcp.json) 대신 환경 파일과 감싸개를 두고,
 * 훅 스크립트는 관문 루트(`../`)에 둔다
 */
export function expectedHostGatewayFiles(address: AgentGatewayAddress, dir: string, cli: HostCli): Record<string, { content: string; mode: number }> {
  const file = (content: string): { content: string; mode: number } => ({ content, mode: 0o600 });
  const shell = {
    ...Object.fromEntries(Object.entries(hostZshFiles(dir, cli.kind)).map(([name, content]) => [path.join(ZSH_DIR, name), file(content)])),
    [BASH_RC_FILE]: file(hostBashRc(dir, cli.kind)),
  };
  const cliPath = hostCliPath(dir, cli);
  const addressFile = file(`${JSON.stringify({ url: address.hookUrl, token: address.hookToken })}\n`);
  if (cli.kind === 'commandcode') {
    return {
      // 훅은 mod 파일이 부른다. 훅 스크립트는 터미널을 열기 전에 관문에 닿는지 묻는 데만 쓴다(probeHostGateway)
      [COMMAND_CODE_MOD_NAME]: file(COMMAND_CODE_MOD),
      [HOOK_SCRIPT_NAME]: file(AGENT_HOOK_SCRIPT),
      [GATEWAY_FILE_NAME]: addressFile,
      [path.join(WRAPPER_DIR, 'commandcode')]: { content: hostCommandCodeWrapper(dir, cli), mode: 0o700 },
      ...shell,
    };
  }
  if (cli.kind === 'gemini') {
    return {
      // 훅은 설정이 부르는 명령 파일이다. 감싸개가 설정을 홈으로 복사한다. 훅 스크립트(Claude의 것)는 터미널을 열기 전에 관문에 닿는지 묻는 데만 쓴다(probeHostGateway)
      [GEMINI_HOOK_NAME]: file(GEMINI_HOOK),
      [GEMINI_SETTINGS_NAME]: file(geminiSettingsContent(dir, cli.nodePath, cli.geminiAuthType)),
      [HOOK_SCRIPT_NAME]: file(AGENT_HOOK_SCRIPT),
      [GATEWAY_FILE_NAME]: addressFile,
      [path.join(WRAPPER_DIR, 'gemini')]: { content: hostGeminiWrapper(dir, cli), mode: 0o700 },
      ...shell,
    };
  }
  if (cli.kind === 'codex') {
    return {
      [CODEX_HOOK_SCRIPT_ENTRY]: file(CODEX_HOOK_SCRIPT),
      [GATEWAY_FILE_NAME]: addressFile,
      [CODEX_ENV_FILE]: file(codexEnvFile(address, dir)),
      [path.join(WRAPPER_DIR, 'codex')]: { content: hostCodexWrapper(address, dir, cli), mode: 0o700 },
      ...shell,
    };
  }
  return {
    [SETTINGS_FILE]: file(`${native.terminalHostGatewaySettingsJson(dir, cli.nodePath, address.hookUrl, address.hookToken)}\n`),
    [MCP_FILE]: file(`${JSON.stringify(agentManagedMcp(address), null, 2)}\n`),
    [HOOK_SCRIPT_NAME]: file(AGENT_HOOK_SCRIPT),
    [GATEWAY_FILE_NAME]: addressFile,
    [path.join(WRAPPER_DIR, 'claude')]: { content: hostCliWrapper(dir, cliPath, cli.configDir), mode: 0o700 },
    ...(cli.selfAgent
      ? {
          [SELF_AGENT_LAUNCHER_FILE]: { content: selfAgentLauncher(dir, cli.nodePath, cli.selfAgent), mode: 0o700 },
          [SELF_AGENT_MODEL_FILE]: file(`${JSON.stringify({ profile: cli.selfAgent.model.profile, apiKey: cli.selfAgent.model.apiKey })}\n`),
        }
      : {}),
    // 사용자의 원래 상태 줄(#920). 훅 스크립트가 옆의 이 파일을 읽어 이어 부른다
    ...(cli.statusLine ? { [STATUSLINE_FILE]: file(`${JSON.stringify({ command: cli.statusLine })}\n`) } : {}),
    ...shell,
  };
}

/** 관문 폴더에 둘 파일의 이름(폴더 기준) → 내용 */
export function hostGatewayFiles(address: AgentGatewayAddress, dir: string, cli: HostCli): Record<string, string> {
  return Object.fromEntries(Object.entries(expectedHostGatewayFiles(address, dir, cli)).map(([name, spec]) => [name, spec.content]));
}

/** Rust가 던진 두 줄짜리 오류(제목·상세)를 옛 `SandboxError`로 되돌린다 */
function gatewayIoError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const [title, ...rest] = message.split('\n');
  if (rest.length) throw new SandboxError(title!, rest.join('\n'));
  throw error;
}

function gatewaySpecs(expected: Record<string, { content: string; mode: number }>): Array<{ name: string; content: string; mode: number }> {
  return Object.entries(expected).map(([name, spec]) => ({ name, content: spec.content, mode: spec.mode }));
}

/**
 * 세션의 관문 설정을 이 컴퓨터에 쓰고 그 폴더를 돌려준다. 토큰이 들어 있으므로 이 사용자만 읽을 수 있게 둔다.
 * 컨테이너 방식과 같은 폴더(`<루트>/<샌드박스 id>`)를 쓴다 — 세션은 한 번에 한 방식으로만 열린다.
 * 관문 폴더 안의 링크를 따라가지 않는다: 하위 폴더 자리가 링크면 그 자리만 지우고 새로 만든다(집행은 Rust 코어가 한다)
 */
export async function writeHostGatewayConfig(sandboxId: string, address: AgentGatewayAddress, cli: HostCli, root: string = defaultAgentGatewayRoot()): Promise<string> {
  const dir = await native.terminalPrepareHostGateway(root, sandboxId).catch(gatewayIoError);
  const expected = expectedHostGatewayFiles(address, dir, cli);
  await native.terminalWriteGatewayFiles(dir, gatewaySpecs(expected), STATUSLINE_FILE).catch(gatewayIoError);
  return dir;
}

/**
 * 관문 폴더가 쓴 그대로인가. 다르거나 없거나 권한이 다른 파일의 이름(폴더 기준)을 돌려준다.
 * 권한을 700으로 유지해야 하는 폴더(관문 폴더·bin·shell·shell/zsh)의 권한이 다르면 그 폴더 이름도 넣는다
 * (관문 폴더 자체는 '.'). 기대하는 파일 자리가 심볼릭 링크면 다른 것을 가리킨 것이므로 위반으로 본다.
 * 관문 폴더 안에 기대하지 않은 파일이 생긴 것은 위반으로 보지 않는다(우리가 읽지 않는다)
 */
export async function checkHostGatewayConfig(dir: string, expected: Record<string, { content: string; mode: number }>): Promise<string[]> {
  return native.terminalCheckHostGatewayConfig(dir, gatewaySpecs(expected)).catch(gatewayIoError);
}

/**
 * 세션이 멈출 때 그 세션의 관문 설정을 지운다. 이 코드가 쓴 파일만 지우고, 폴더는 비었을 때만 지운다.
 * 링크를 따라가지 않는다: 관문 폴더 자체나 하위 폴더가 링크면 그 너머의 파일은 건드리지 않고 링크 자리만 지운다
 */
export async function removeHostGatewayConfig(sandboxId: string, root: string = defaultAgentGatewayRoot()): Promise<void> {
  await native.terminalRemoveHostGatewayConfig(root, sandboxId).catch(gatewayIoError);
}

/**
 * 훅이 관문에 닿는가. 터미널의 훅이 쓰는 바로 그 스크립트와 주소 파일로 묻는다.
 * codex는 관문 루트의 공용 스크립트를 쓰고, 세션의 관문 폴더를 환경 변수로 넘긴다(감싸개와 같은 방식, #825)
 */
export async function probeHostGateway(dir: string, nodePath: string = process.execPath, kind: HostCliKind = 'claude'): Promise<boolean> {
  const script = kind === 'codex' ? path.join(path.dirname(dir), CODEX_HOOK_SCRIPT_NAME) : path.join(dir, HOOK_SCRIPT_NAME);
  const env = kind === 'codex' ? { ...process.env, [CODEX_GATEWAY_DIR_ENV]: dir } : process.env;
  // 훅 스크립트는 ping에서도 표준 입력을 다 읽는다. `runCommand`는 입력이 없어도 stdin을 바로 닫아 준다
  return execChecked(nodePath, [script, 'ping'], { timeoutMs: (HOST_PING_SECONDS + 10) * 1000, env }).then(
    () => true,
    () => false,
  );
}

/** 이 컴퓨터의 프로세스 하나. `ps`가 준 pid·부모 pid·인자 한 줄 */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  args: string;
}

/** `ps -A -o pid=,ppid=,args=`로 이 컴퓨터의 프로세스 목록을 읽는다(macOS와 리눅스 둘 다 된다) */
export async function listProcesses(): Promise<ProcessEntry[]> {
  const { stdout } = await execChecked('ps', ['-A', '-o', 'pid=,ppid=,args=']);
  const entries: ProcessEntry[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3]!.trimEnd() });
  }
  return entries;
}

/**
 * root(PTY의 pid) 아래에서 도는 에이전트 CLI 중 우리 설정이 붙지 않은 것의 pid. 판정은 Rust 코어가 한다(ADR-219, `terminal::watch::find_unhooked_cli`).
 * root를 모르면(2보다 작다) `undefined`다 — 아래에 아무것도 없다는 뜻(빈 목록)이 아니라 찾을 수 없다는 뜻이다. 부르는 쪽은 이것을 통과로 읽지 않는다(N20).
 * 붙었다고 보는 것은 인자에 표식이 있는 것이다 — claude는 `--settings <settingsPath>`(낱말 경계로, `--settings`가 하나뿐일 때), codex는 훅 명령이 가리키는
 * 관문 루트의 훅 스크립트 경로(`-c hooks.…` 안, 문자열 포함). 관문 폴더 경로에 빈칸이 있어도 `ps`의 인자 한 줄에서 그대로 견줄 수 있다.
 * 옛 판정은 지웠다(#1347)
 */
export function findUnhookedCliOrUnknown(
  root: number,
  processes: readonly ProcessEntry[],
  expected: { settingsPath: string; cliPath: string; kind?: HostCliKind },
): ProcessEntry[] | undefined {
  const kind = expected.kind ?? 'claude';
  // codex는 settingsPath 자리에 관문 폴더를 받아 그 위(관문 루트)의 훅 스크립트를 표식으로 본다
  const marker = kind === 'codex' ? path.join(path.dirname(path.dirname(expected.settingsPath)), CODEX_HOOK_SCRIPT_NAME) : `--settings ${expected.settingsPath}`;
  // 정수가 아닌 pid(읽지 못한 목록)는 코어에 넘기지 않고 던진다. 건너뛰면 찾지 못한 것이 통과가 된다
  if (!Number.isSafeInteger(root) || processes.some((entry) => !Number.isSafeInteger(entry.pid) || !Number.isSafeInteger(entry.ppid))) {
    throw new SandboxError('프로세스 목록을 읽지 못했습니다', '정수가 아닌 pid가 있습니다');
  }
  const pids = native.terminalFindUnhookedCli(
    root,
    processes.map((entry) => ({ pid: entry.pid, ppid: entry.ppid, args: entry.args })),
    kind,
    expected.cliPath,
    marker,
  );
  if (pids === null) return undefined;
  const byPid = new Map<number, ProcessEntry>();
  for (const entry of processes) if (!byPid.has(entry.pid)) byPid.set(entry.pid, entry);
  return pids.map((pid) => byPid.get(pid)!);
}

/** 프로세스의 진짜 argv. 끝났으면 null, 읽지 못하면(권한·지원하지 않는 OS) 던진다 */
export function processArgv(pid: number): string[] | null {
  return native.terminalProcessArgv(pid);
}

/**
 * 프로세스의 환경(뜰 때의 `NAME=값`, 같은 계정의 프로세스만). 끝났으면 null, 읽지 못하면 던진다. 가려져 비어 보이는 것(macOS의 SIP 프로그램)도 던진다 —
 * 빈 환경으로 돌려주지 않는다. 부른 쪽은 던진 것을 "모른다"(붙지 않은 것)로 읽는다
 */
export function processEnv(pid: number): Array<{ name: string; value: string }> | null {
  return native.terminalProcessEnv(pid);
}

/** 새 갈래(commandcode·opencode·gemini)가 우리 설정으로 떴는가(여는 쪽이라 좁게). `env`가 null이면(읽지 못함) 환경이 필요한 갈래는 붙지 않은 것이다 */
export function hookedLaunch(kind: string, argv: string[], env: Array<{ name: string; value: string }> | null, expected: string): boolean {
  return native.terminalHookedLaunch(kind, argv, env, expected);
}

/**
 * 감시가 쓰는 판정(ADR-219 후속): claude는 ps 한 줄이 아니라 **진짜 argv**로 훅이 붙었는지 본다. `ps`의 인자 한 줄은 낱말마다 따옴표를 잃어
 * 첫 요청 글(실행 인자로 실린다)에 든 `--settings`가 진짜 옵션과 구별되지 않았다. 후보(ps 한 줄로 CLI로 보이는 것, 넓게)마다 argv를 읽어
 * 감싸개가 붙이는 정확한 자리(`--mcp-config <M> --settings <S>`, `--settings`는 하나뿐)인지 본다(여는 쪽이라 좁게). argv가 없으면(그 사이 끝났다) 건너뛰고, 읽지 못하면 던진다 — 부른 쪽은 이것을 프로세스 검사의 실패(믿을 수 없음)로 읽는다.
 * codex는 옛 규칙(ps 한 줄의 표식 포함, 실험)이다. root를 모르면(2보다 작다) `undefined`다
 */
export function findUnhookedCliByArgv(
  root: number,
  processes: readonly ProcessEntry[],
  /** selfAgent: 자체 CLI 세션이면 실행기가 넘기는 로더·진입점의 절대 경로. 그 정확한 꼴만 붙은 것으로 본다 */
  expected: { settingsPath: string; cliPath: string; kind?: HostCliKind; selfAgent?: Pick<SelfAgent, 'loader' | 'entry'> },
  readArgv: (pid: number) => string[] | null = processArgv,
  readEnv: (pid: number) => Array<{ name: string; value: string }> | null = processEnv,
): ProcessEntry[] | undefined {
  const kind = expected.kind ?? 'claude';
  if (kind === 'codex') return findUnhookedCliOrUnknown(root, processes, expected);
  if (!Number.isSafeInteger(root) || processes.some((entry) => !Number.isSafeInteger(entry.pid) || !Number.isSafeInteger(entry.ppid))) {
    throw new SandboxError('프로세스 목록을 읽지 못했습니다', '정수가 아닌 pid가 있습니다');
  }
  const pids = native.terminalCliCandidates(
    root,
    processes.map((entry) => ({ pid: entry.pid, ppid: entry.ppid, args: entry.args })),
    kind,
    expected.cliPath,
  );
  if (pids === null) return undefined;
  const byPid = new Map<number, ProcessEntry>();
  for (const entry of processes) if (!byPid.has(entry.pid)) byPid.set(entry.pid, entry);
  // 감싸개가 `--mcp-config <관문 폴더>/mcp.json --settings <관문 폴더>/settings.json`을 붙인다: 두 파일은 같은 폴더에 있다
  const mcpPath = path.join(path.dirname(expected.settingsPath), MCP_FILE);
  // commandcode는 `--mod <관문 폴더>/b-studio-mod.ts`다. 같은 폴더의 mod 파일이 아니거나 `--safe-mode`가 있으면 붙지 않은 것이다(판정은 Rust 코어)
  const modPath = commandCodeModPath(path.dirname(expected.settingsPath));
  const found: ProcessEntry[] = [];
  for (const pid of pids) {
    const argv = readArgv(pid);
    if (argv === null) continue;
    if (kind === 'commandcode') {
      // 환경은 읽지 않는다: 이 갈래는 인자만 본다(null은 "환경을 읽지 못함"이지만 commandcode의 판정은 환경을 쓰지 않는다)
      if (!native.terminalHookedLaunch(kind, argv, null, modPath)) found.push(byPid.get(pid)!);
      continue;
    }
    if (kind === 'gemini') {
      // gemini는 홈을 환경(`GEMINI_CLI_HOME`)으로 바꿔 훅을 붙인다. 환경을 읽어 판정한다: 끝났으면(null) 건너뛰고, 읽지 못하면 붙었는지 알 수 없으므로 붙지 않은 것이다
      let env: Array<{ name: string; value: string }> | null | undefined;
      try {
        env = readEnv(pid);
      } catch {
        env = undefined;
      }
      if (env === null) continue;
      if (!native.terminalHookedLaunch(kind, argv, env ?? null, geminiHomePath(path.dirname(expected.settingsPath)))) found.push(byPid.get(pid)!);
      continue;
    }
    if (!native.terminalHookedArgv(argv, expected.settingsPath, mcpPath, expected.selfAgent?.loader ?? null, expected.selfAgent?.entry ?? null)) found.push(byPid.get(pid)!);
  }
  return found;
}

/** `findUnhookedCliOrUnknown`과 같되 root를 모르면 던진다(찾지 못한 것을 빈 목록으로 읽지 않는다) */
export function findUnhookedCli(root: number, processes: readonly ProcessEntry[], expected: { settingsPath: string; cliPath: string; kind?: HostCliKind }): ProcessEntry[] {
  const found = findUnhookedCliOrUnknown(root, processes, expected);
  if (found === undefined) throw new SandboxError('터미널의 프로세스 번호를 알 수 없습니다', `root pid ${root}`);
  return found;
}

/**
 * 터미널을 열면 도는 명령. CLI를 띄우고, CLI에서 나오면 이 컴퓨터의 셸로 남는다.
 * `claude`는 PATH 맨 앞의 감싸개다. 셸의 시작 파일이 PATH의 순서를 바꾸면 되돌아간 셸에서 친 `claude`에는 훅이 붙지 않을 수 있다 —
 * 그때의 변경은 다음 요청의 검증에 "실행 전부터 있던 변경"으로 들어간다
 */
export function hostTerminalCommand(kind: HostCliKind = 'claude'): string {
  return native.terminalHostTerminalCommand(kind);
}
export const HOST_TERMINAL_COMMAND = hostTerminalCommand('claude');

/**
 * 터미널에 넘길 환경. 스튜디오 프로세스의 환경을 그대로 내려보내지 않고 **허용한 이름만** 넘긴다.
 * 스튜디오를 에이전트 CLI 안에서 띄우면 `CLAUDECODE`·`CLAUDE_CODE_*` 표식이 터미널의 CLI까지 내려가 안쪽 세션으로 오해되고
 * ("inherited CLAUDE_CODE_CHILD_SESSION marker"), pnpm이 끼운 PATH(`node_modules/.bin`)와 `NODE_ENV` 등도 함께 내려간다.
 * `B_STUDIO_`만 빼는 것으로는 부족하다. 나머지는 사용자의 로그인 셸이 시작 파일로 만든다 — 평소 터미널을 열 때와 같다
 */
export function hostTerminalEnv(gatewayDir: string | undefined, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const pairs = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined);
  return Object.fromEntries(gatewayValue<string[][]>(native.terminalHostTerminalEnv(gatewayDir, pairs))) as Record<string, string>;
}

/**
 * PTY로 띄울 것: 실행 파일, 인자, 추가 환경 변수.
 * 사용자의 로그인 셸을 열고, 그 시작 파일 끝에 둔 `claude` 함수와 첫 실행으로 CLI를 붙인다(셸 함수는 PATH 순서와 무관하다).
 * 관문 폴더가 없으면(훅 없이 여는 터미널, 테스트) 지금처럼 셸 하나로 CLI를 띄우고 끝낸다
 */
export function hostShellLaunch(
  gatewayDir: string | undefined,
  env: Record<string, string | undefined> = process.env,
  kind: HostCliKind = 'claude',
): { file: string; args: string[]; env: Record<string, string> } {
  if (!gatewayDir) return { file: '/bin/sh', args: ['-c', hostTerminalCommand(kind)], env: {} };
  const shell = path.isAbsolute(env.SHELL ?? '') ? env.SHELL! : '/bin/sh';
  const name = path.basename(shell);
  if (name === 'zsh') {
    return { file: shell, args: ['-l', '-i'], env: { ZDOTDIR: path.join(gatewayDir, ZSH_DIR), BSTUDIO_USER_ZDOTDIR: env.ZDOTDIR ?? env.HOME ?? '' } };
  }
  if (name === 'bash') {
    return { file: shell, args: ['--rcfile', path.join(gatewayDir, BASH_RC_FILE), '-i'], env: {} };
  }
  // fish 등: 셸 함수를 정의할 자리가 없다. 감싸개 절대 경로로 한 번 띄우고, 다시 띄울 때는 그 경로를 쓰라고 알린다
  return { file: '/bin/sh', args: ['-c', native.terminalHostFallbackCommand(gatewayDir, kind)], env: {} };
}

/** 가상 터미널(portable-pty, 또는 테스트의 가짜)에서 이 모듈이 쓰는 부분 */
export interface HostPty {
  /** 이 가상 터미널의 pid. 감시가 이 아래에서 훅 없이 뜬 CLI를 찾는 데 쓴다. 플랫폼이 못 주면 undefined다(0으로 바꾸지 않는다: 0은 모든 프로세스의 부모 자리다, N20) */
  readonly pid: number | undefined;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  // 출력은 raw bytes다(UTF-8 경계가 조각에서 잘릴 수 있어 터미널이 재조립한다). node-pty 시절의 string에서 Buffer로 바꿨다(2c-4a)
  onData(listener: (data: Buffer) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
}
/** 가상 터미널을 띄우는 자리(테스트가 가짜를 끼운다) */
export type SpawnHostPty = (file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => HostPty | Promise<HostPty>;

/** 플랫폼이 pid를 주지 못하면(null) undefined다. 0으로 바꾸지 않는다: 0은 모든 프로세스의 부모 자리라 감시가 이 컴퓨터의 프로세스를 전부 훑는다(N20, ADR-219) */
export function ptyPid(pid: number | null | undefined): number | undefined {
  return pid ?? undefined;
}

/** Rust(portable-pty)로 가상 터미널을 연다(2c-4a, #1049). 출력·종료는 Rust 스레드에서 역류하므로 리스너 배열로 중계한다. */
const spawnWithPortablePty: SpawnHostPty = (file, args, options) => {
  const dataListeners: Array<(data: Buffer) => void> = [];
  const exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  const pty = new native.HostPty(
    file,
    args,
    options.name,
    options.cols,
    options.rows,
    options.cwd,
    options.env,
    (data) => {
      for (const listener of dataListeners) listener(data);
    },
    (code) => {
      for (const listener of exitListeners) listener({ exitCode: code });
    },
  );
  return {
    pid: ptyPid(pty.pid),
    write: (data) => pty.write(Buffer.from(data, 'utf8')),
    resize: (cols, rows) => pty.resize(cols, rows),
    // portable-pty의 kill은 신호를 받지 않고 자식을 끝낸다(셸과 CLI가 함께 끝나는 목적엔 충분)
    kill: () => pty.kill(),
    onData: (listener) => void dataListeners.push(listener),
    onExit: (listener) => void exitListeners.push(listener),
  };
};

/** 세션의 작업 복사본에서 가상 터미널을 열고 기본 명령(CLI)을 띄운다 */
export async function openHostTerminal({
  id,
  size,
  cwd,
  gatewayDir,
  cli = 'claude',
  initialPrompt,
  resumeConversation,
  model,
  accountEnv = {},
  env = process.env,
  spawnPty = spawnWithPortablePty,
}: {
  id: string;
  size: TerminalSize;
  /** 세션의 작업 복사본 */
  cwd: string;
  /** 관문 설정을 둔 폴더(writeHostGatewayConfig). 주지 않으면 훅 없이 띄운다 */
  gatewayDir?: string;
  /** 띄울 CLI(#825). 관문 폴더의 감싸개도 같은 CLI로 써 둬야 한다 */
  cli?: HostCliKind;
  /** CLI를 처음 띄울 때 실행 인자로 넘길 첫 요청(#836). PTY 환경 변수로만 넘기고, 셸이 한 번 쓰고 지운다 */
  initialPrompt?: string;
  /** 첫 실행에서 이어 붙일 CLI 대화 id(#872). 첫 요청이 있으면 새 대화라 쓰지 않는다 */
  resumeConversation?: string;
  /** 라우팅이 고른 모델 id(#988). 첫 실행에 `--model=<id>`로 넘긴다. 없으면 CLI 기본 모델이다 */
  model?: string;
  /**
   * 세션 계정의 설정 폴더 변수(#885, CLAUDE_CONFIG_DIR·CODEX_HOME). 감싸개도 같은 값을 넘기지만, 셸에서 CLI가 아닌 도구(예: `claude` 하위 명령을
   * 부르는 스크립트)도 같은 계정을 보게 PTY 환경에도 둔다. 이 두 이름만 받는다
   */
  accountEnv?: Record<string, string>;
  env?: Record<string, string | undefined>;
  spawnPty?: SpawnHostPty;
}): Promise<AgentTerminal & { pid: number | undefined }> {
  const { cols, rows } = clampTerminalSize(size);
  // Command Code는 기본 모델로만 띄운다(모델 고르기 인자를 넘기지 않는다). 모델이 오면 조용히 무시하지 않고 거절한다
  if (cli === 'commandcode' && model !== undefined) throw new SandboxError('Command Code 터미널은 모델을 고르지 않습니다', '기본 모델로만 띄웁니다(-m·--model을 넘기지 않는다)');
  if (cli === 'gemini' && model !== undefined) throw new SandboxError('Gemini 터미널은 모델을 고르지 않습니다', '기본 모델로만 띄웁니다(-m·--model을 넘기지 않는다)');
  const allowedAccountEnv = new Set(Object.values(ACCOUNT_DIR_ENV));
  for (const name of Object.keys(accountEnv)) {
    if (!allowedAccountEnv.has(name)) throw new SandboxError('계정 환경에 쓸 수 없는 이름이 있습니다', `${name} — ${[...allowedAccountEnv].join('·')}만 받습니다`);
  }
  const launch = hostShellLaunch(gatewayDir, env, cli);
  const first: Record<string, string> =
    initialPrompt !== undefined
      ? { [FIRST_PROMPT_ENV]: firstPromptArg(initialPrompt) }
      : resumeConversation !== undefined
        ? { [RESUME_CONVERSATION_ENV]: resumeConversationArg(resumeConversation) }
        : {};
  if (model !== undefined) first[CLI_MODEL_ENV] = cliModelArg(model);
  let pty: HostPty;
  try {
    pty = await spawnPty(launch.file, launch.args, { name: 'xterm-256color', cols, rows, cwd, env: { ...hostTerminalEnv(gatewayDir, env), ...accountEnv, ...launch.env, ...first } });
  } catch (error) {
    throw new SandboxError('이 컴퓨터에서 터미널을 열지 못했습니다', error instanceof Error ? error.message : String(error), { platform: true });
  }
  let closed = false;
  return {
    id,
    pid: pty.pid,
    write(data) {
      if (!closed) pty.write(data);
    },
    async resize(next) {
      if (closed) return;
      const wanted = clampTerminalSize(next);
      try {
        pty.resize(wanted.cols, wanted.rows);
      } catch {
        // 이미 끝난 터미널의 크기는 바꿀 것이 없다
      }
    },
    onData(listener) {
      pty.onData((data) => listener(data));
    },
    onExit(listener) {
      pty.onExit(({ exitCode }) => {
        closed = true;
        listener(exitCode);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        // 터미널이 끊겼다고 알린다. 셸과 그 안의 CLI가 함께 끝난다
        pty.kill('SIGHUP');
      } catch {
        // 이미 끝났다
      }
    },
  };
}
