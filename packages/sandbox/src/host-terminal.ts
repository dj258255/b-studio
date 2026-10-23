import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
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
  gatewayDirFor,
  gatewaySettings,
  HOOK_SCRIPT_NAME,
  type AgentGatewayAddress,
  type AgentHookEvent,
  type AgentTerminal,
  type TerminalSize,
} from './docker/agent-terminal';
import { SandboxError } from './errors';

const execFileAsync = promisify(execFile);

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
/** 관문 폴더 안에 만들 폴더들. 지울 때는 이 역순으로 지운다 */
const GATEWAY_DIRS = [WRAPPER_DIR, SHELL_DIR, ZSH_DIR] as const;
/** 권한을 700으로 유지해야 하는 폴더들(폴더 기준 이름). 빈 이름은 관문 폴더 그 자체를 뜻한다 */
const GATEWAY_FOLDER_NAMES = ['', WRAPPER_DIR, SHELL_DIR, ZSH_DIR] as const;
/** 관문 폴더에 쓰는 파일들(폴더 기준). hostGatewayFiles의 키와 같아야 한다 */
const GATEWAY_FILE_NAMES = [
  SETTINGS_FILE,
  MCP_FILE,
  HOOK_SCRIPT_NAME,
  GATEWAY_FILE_NAME,
  CODEX_ENV_FILE,
  path.join(WRAPPER_DIR, 'claude'),
  path.join(WRAPPER_DIR, 'codex'),
  ...ZSH_START_FILES.map((name) => path.join(ZSH_DIR, name)),
  BASH_RC_FILE,
];
const HOST_PING_SECONDS = 5;
/** 첫 실행의 표식. 안쪽에서 연 셸이나 CLI가 띄운 셸이 CLI를 또 띄우지 않게 export한다 */
const SHELL_STARTED_VAR = 'BSTUDIO_TERMINAL_STARTED';
/** CLI에서 나온 뒤 사용자에게 보이는 한 줄(셸 시작 파일·대체 명령이 함께 쓴다) */
function shellStartedNotice(kind: HostCliKind): string {
  return `[b-studio] ${kind}에서 나왔습니다. 다시 띄우려면 ${kind} 를 입력하세요.`;
}

/** 셸 명령에 넣을 글을 작은따옴표로 감싼다. 경로에 빈칸이나 따옴표가 있어도 한 덩어리로 읽힌다 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 터미널에서 띄우는 에이전트 CLI. 세션의 백엔드가 codex면 codex, 그 밖에는 claude다(#825) */
export type HostCliKind = 'claude' | 'codex';
const CLI_BIN_ENV: Record<HostCliKind, string> = { claude: 'B_STUDIO_CLAUDE_BIN', codex: 'B_STUDIO_CODEX_BIN' };

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
}

/** CLI마다 계정 설정 폴더를 받는 환경 변수(#885) */
export const ACCOUNT_DIR_ENV: Record<HostCliKind, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };

/** 감싸개에서 계정 폴더를 내보내는 줄. 기본 계정이면 없다 */
function accountExport(kind: HostCliKind, configDir: string | undefined): string[] {
  return configDir ? [`export ${ACCOUNT_DIR_ENV[kind]}=${shellQuote(configDir)}`] : [];
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
    const found = await execFileAsync('/bin/sh', ['-c', `command -v ${kind}`], { env: env as NodeJS.ProcessEnv }).then(
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
        : 'codex를 설치하고 로그인한 뒤 다시 여세요. 다른 자리에 있으면 B_STUDIO_CODEX_BIN에 절대 경로를 적습니다',
    );
  }
  return { kind, cliPath, nodePath: process.execPath };
}

/** 이 컴퓨터용 CLI 설정: 훅 명령이 세션의 관문 폴더에 둔 스크립트를 부른다(텔레메트리도 같은 관문 주소로 보낸다) */
export function hostGatewaySettings(address: Pick<AgentGatewayAddress, 'hookUrl' | 'hookToken'>, dir: string, nodePath: string): Record<string, unknown> {
  return gatewaySettings((event) => `${shellQuote(nodePath)} ${shellQuote(path.join(dir, HOOK_SCRIPT_NAME))} ${event}`, address);
}

/**
 * 인자를 붙여 CLI를 부르는 감싸개. 터미널의 PATH 맨 앞에 놓여, 터미널에서 `claude`를 어떻게 띄우든(다시 띄우거나 `--resume`을 주거나)
 * 훅과 b-studio 도구가 붙는다. 사용자가 준 인자는 그대로 넘긴다
 */
export function hostCliWrapper(dir: string, claudePath: string, configDir?: string): string {
  return [
    '#!/bin/sh',
    '# b-studio가 만든 파일입니다. 고쳐도 다음에 터미널을 열 때 다시 쓰입니다.',
    // 세션의 계정(#885). 사용자의 시작 파일이 같은 변수를 정해도 이 세션의 CLI는 고른 계정으로 뜬다
    ...accountExport('claude', configDir),
    // --mcp-config는 값을 여러 개 받는다(`<configs...>`). 사용자 인자 바로 앞에 두면 첫 낱말(요청 글)을 설정 파일로 먹으므로,
    // 값을 하나만 받는 --settings를 뒤에 둔다(#836)
    `exec ${shellQuote(claudePath)} --mcp-config ${shellQuote(path.join(dir, MCP_FILE))} --settings ${shellQuote(path.join(dir, SETTINGS_FILE))} "$@"`,
    '',
  ].join('\n');
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

/** 감싸개(관문 폴더 안)의 절대 경로. 셸 함수가 이것을 부른다 */
function wrapperPath(dir: string, kind: HostCliKind): string {
  return path.join(dir, WRAPPER_DIR, kind);
}

/**
 * 첫 요청(#836). 터미널을 열 때 받은 첫 요청 글을 CLI의 실행 인자로 넘긴다. 키 입력(붙여 넣기 + Enter)으로 넣지 않는다:
 * CLI가 시작하며 묻는 창(폴더 신뢰, 훅 신뢰, 업데이트)이 뜨면 그 글과 Enter가 사람 대신 그 창의 답이 된다.
 * 글은 PTY의 환경 변수로만 받고(셸 글에 잇지 않는다), 셸이 시작 파일을 읽기 전에 셸 변수로 옮기고 환경에서 지운다.
 * 셸 변수는 내보내지 않으므로 사용자의 시작 파일이 띄우는 프로그램과 CLI에 내려가지 않는다. 첫 실행에서 한 번 쓰고 지운다
 */
export const FIRST_PROMPT_ENV = 'B_STUDIO_FIRST_PROMPT';
const FIRST_PROMPT_VAR = 'BSTUDIO_FIRST_PROMPT_VALUE';
/** 첫 요청 글의 길이 상한. 화면의 붙여 넣기 상한(8천 자)에 앞말이 붙어도 넘지 않게 잡는다 */
const FIRST_PROMPT_MAX = 10_000;

/**
 * CLI 실행 인자로 넘길 첫 요청 글. 옵션(`-`로 시작)이나 하위 명령(`update`처럼 빈칸 없는 한 낱말)으로 읽히지 않게 앞에 "요청: "을 붙인다.
 * `--`로 옵션을 끝내는 길은 쓰지 않는다: claude(commander)는 `--` 뒤의 첫 낱말도 하위 명령으로 맞춰 본다
 */
export function firstPromptArg(text: string): string {
  const body = text.trim();
  if (!body) throw new SandboxError('첫 요청 글이 비어 있습니다', '빈 글은 CLI에 넘기지 않습니다');
  if (body.includes('\0')) throw new SandboxError('첫 요청 글에 NUL 문자가 있습니다', '환경 변수로 넘길 수 없습니다');
  if (body.length > FIRST_PROMPT_MAX) throw new SandboxError('첫 요청 글이 너무 깁니다', `${FIRST_PROMPT_MAX}자까지 넘깁니다`);
  return body.startsWith('-') || !/\s/.test(body) ? `요청: ${body}` : body;
}

/**
 * 이어 붙일 CLI 대화 id(#872). 스튜디오를 다시 띄운 뒤 터미널을 열 때, 훅으로 받아 세션 기록에 남긴 지난 대화를 첫 실행에서 이어 붙인다
 * (claude `--resume <id>`, codex `resume <id>`). 첫 요청과 같이 PTY 환경 변수로만 받고, 시작 파일보다 먼저 셸 변수로 옮겨 환경에서 지운다
 */
export const RESUME_CONVERSATION_ENV = 'B_STUDIO_RESUME_ID';
const RESUME_CONVERSATION_VAR = 'BSTUDIO_RESUME_ID_VALUE';
/** 대화 id의 꼴. 두 CLI 모두 UUID를 쓰고, 옵션(-로 시작)·빈칸·셸 글자는 받지 않는다 */
const RESUME_CONVERSATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** 이어 붙일 수 있는 꼴의 대화 id인가. 훅으로 온 값을 기억하기 전에 본다 */
export function isResumableConversation(id: unknown): id is string {
  return typeof id === 'string' && RESUME_CONVERSATION_PATTERN.test(id);
}

/** CLI 실행 인자로 넘길 대화 id. 꼴이 맞지 않으면 던진다(훅으로 온 값이라 바깥에서 온 값이다) */
export function resumeConversationArg(id: string): string {
  if (!isResumableConversation(id)) throw new SandboxError('이어 붙일 대화 id의 꼴이 맞지 않습니다', '영문·숫자·밑줄·붙임표로 된 128자 이하의 id만 넘깁니다');
  return id;
}

/** 받은 첫 요청과 대화 id를 셸 변수로 옮기고 환경에서 지운다. 사용자의 시작 파일보다 먼저 돈다 */
const FIRST_PROMPT_CAPTURE = [
  `if [ -n "\${${FIRST_PROMPT_ENV}+x}" ]; then`,
  `  ${FIRST_PROMPT_VAR}="$${FIRST_PROMPT_ENV}"`,
  `  unset ${FIRST_PROMPT_ENV}`,
  'fi',
  `if [ -n "\${${RESUME_CONVERSATION_ENV}+x}" ]; then`,
  `  ${RESUME_CONVERSATION_VAR}="$${RESUME_CONVERSATION_ENV}"`,
  `  unset ${RESUME_CONVERSATION_ENV}`,
  'fi',
];

/** 이어 붙이지 못했을 때 터미널에 남기는 안내. CLI를 대신 새로 띄우지 않는다(사람이 일부러 끝낸 것과 가를 수 없다) */
function resumeFailedNotice(kind: HostCliKind): string {
  return `[b-studio] 지난 대화를 이어 붙이지 못했습니다. '${kind}'를 치면 새 대화로 시작합니다.`;
}

/**
 * CLI를 처음 띄우는 자리. 첫 요청이 있으면 인자로 한 번 넘긴다(새 대화). 없고 대화 id가 있으면 그 대화를 이어 붙인다(#872).
 * 둘 다 없으면 인자 없이 띄운다. 두 변수 모두 한 번 쓰고 지운다
 */
function firstLaunch(command: string, kind: HostCliKind, indent = ''): string[] {
  const resume = kind === 'codex' ? `${command} resume "$${RESUME_CONVERSATION_VAR}"` : `${command} --resume "$${RESUME_CONVERSATION_VAR}"`;
  return [
    `if [ -n "\${${FIRST_PROMPT_VAR}+x}" ]; then`,
    `  ${command} "$${FIRST_PROMPT_VAR}"`,
    `elif [ -n "\${${RESUME_CONVERSATION_VAR}+x}" ]; then`,
    `  ${resume} || printf '%s\\n' ${shellQuote(resumeFailedNotice(kind))}`,
    'else',
    `  ${command}`,
    'fi',
    `unset ${FIRST_PROMPT_VAR} ${RESUME_CONVERSATION_VAR}`,
  ].map((line) => indent + line);
}

/**
 * zsh 시작 파일 하나의 틀. ZDOTDIR을 사용자의 것으로 두고 사용자의 파일을 그대로 읽은 뒤, b-studio의 몇 줄을 더한다.
 * 그래야 사용자 설정(플러그인·별칭·프롬프트)이 평소 터미널과 같고, 우리 파일은 ZDOTDIR을 우리 폴더로 되돌려 다음 파일도 우리가 읽는다
 */
function zshStartFile(name: string, extra: { before?: readonly string[]; after?: readonly string[] } = {}): string {
  return [
    '# b-studio가 만든 파일입니다. 사용자의 시작 파일을 그대로 읽은 뒤 b-studio의 몇 줄을 더합니다.',
    'BSTUDIO_ZDOTDIR="$ZDOTDIR"',
    'ZDOTDIR="${BSTUDIO_USER_ZDOTDIR:-$HOME}"',
    ...(extra.before ?? []),
    `[ -r "$ZDOTDIR/${name}" ] && . "$ZDOTDIR/${name}"`,
    '# 사용자의 파일이 ZDOTDIR을 바꿨으면 그 값을 사용자의 것으로 기억한다',
    'export BSTUDIO_USER_ZDOTDIR="$ZDOTDIR"',
    'ZDOTDIR="$BSTUDIO_ZDOTDIR"',
    'unset BSTUDIO_ZDOTDIR',
    ...(extra.after ?? []),
    '',
  ].join('\n');
}

/** zsh의 관문 폴더에 둘 네 파일 → 내용 */
export function hostZshFiles(dir: string, kind: HostCliKind = 'claude'): Record<(typeof ZSH_START_FILES)[number], string> {
  const wrapper = shellQuote(wrapperPath(dir, kind));
  return {
    // 첫 요청은 사용자의 .zshenv보다 먼저 환경에서 지운다(#836)
    '.zshenv': zshStartFile('.zshenv', { before: FIRST_PROMPT_CAPTURE }),
    '.zprofile': zshStartFile('.zprofile'),
    '.zshrc': zshStartFile('.zshrc', {
      // macOS의 /etc/zshrc가 HISTFILE을 $ZDOTDIR 아래로 잡는다. 그대로 두면 명령 기록이 관문 폴더에 쌓였다가 지워진다
      before: ['HISTFILE="${BSTUDIO_USER_ZDOTDIR:-$HOME}/.zsh_history"'],
      // 별칭은 함수보다 먼저 풀린다. 사용자가 `alias claude=…`를 두었으면(예전 설치 방식) 그 별칭을 지우고 함수를 정의한다.
      // `function name { … }` 꼴은 이름 자리에서 별칭을 풀지 않는다. PATH 순서와도 무관하므로 진짜 CLI를 PATH 앞에 두어도 이긴다
      after: [`unalias ${kind} 2>/dev/null`, `function ${kind} { ${wrapper} "$@"; }`],
    }),
    '.zlogin': zshStartFile('.zlogin', {
      after: [
        `if [[ -o interactive && -z "$${SHELL_STARTED_VAR}" ]]; then`,
        `  export ${SHELL_STARTED_VAR}=1`,
        ...firstLaunch(kind, kind, '  '),
        `  print -r -- ${shellQuote(shellStartedNotice(kind))}`,
        'fi',
      ],
    }),
  };
}

/** bash의 관문 폴더에 둘 시작 파일 → 내용. 로그인 셸의 순서(/etc/profile, 그다음 사용자 파일 하나)를 흉내 낸다 */
export function hostBashRc(dir: string, kind: HostCliKind = 'claude'): string {
  const wrapper = shellQuote(wrapperPath(dir, kind));
  return [
    '# b-studio가 만든 파일입니다. 로그인 셸의 순서를 흉내 낸 뒤 b-studio의 몇 줄을 더합니다.',
    // 첫 요청은 시작 파일보다 먼저 환경에서 지운다(#836)
    ...FIRST_PROMPT_CAPTURE,
    '[ -r /etc/profile ] && . /etc/profile',
    'if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"',
    'elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"',
    'elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"',
    'fi',
    // 별칭은 함수보다 먼저 풀린다. 대화형(-i)이라 사용자의 `alias claude=…`가 있으면 그 별칭을 지우고 함수를 정의한다.
    // `function name { … }` 꼴은 이름 자리에서 별칭을 풀지 않는다. PATH 순서와도 무관하므로 진짜 CLI를 PATH 앞에 두어도 이긴다
    `unalias ${kind} 2>/dev/null`,
    `function ${kind} { ${wrapper} "$@"; }`,
    `if [ -z "$${SHELL_STARTED_VAR}" ]; then`,
    `  export ${SHELL_STARTED_VAR}=1`,
    ...firstLaunch(kind, kind, '  '),
    `  printf '%s\\n' ${shellQuote(shellStartedNotice(kind))}`,
    'fi',
    '',
  ].join('\n');
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
  const addressFile = file(`${JSON.stringify({ url: address.hookUrl, token: address.hookToken })}\n`);
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
    [SETTINGS_FILE]: file(`${JSON.stringify(hostGatewaySettings(address, dir, cli.nodePath), null, 2)}\n`),
    [MCP_FILE]: file(`${JSON.stringify(agentManagedMcp(address), null, 2)}\n`),
    [HOOK_SCRIPT_NAME]: file(AGENT_HOOK_SCRIPT),
    [GATEWAY_FILE_NAME]: addressFile,
    [path.join(WRAPPER_DIR, 'claude')]: { content: hostCliWrapper(dir, cli.cliPath, cli.configDir), mode: 0o700 },
    ...shell,
  };
}

/** 관문 폴더에 둘 파일의 이름(폴더 기준) → 내용 */
export function hostGatewayFiles(address: AgentGatewayAddress, dir: string, cli: HostCli): Record<string, string> {
  return Object.fromEntries(Object.entries(expectedHostGatewayFiles(address, dir, cli)).map(([name, spec]) => [name, spec.content]));
}

/** 부모가 진짜 폴더일 때만 자식을 본다. 부모가 링크면 그 너머로 들어가지 않는다(관문 폴더 밖을 건드리지 않는다) */
async function lstatChild(parent: string, child: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  const info = await lstat(parent).catch(() => undefined);
  if (!info?.isDirectory() || info.isSymbolicLink()) return undefined;
  return lstat(child).catch(() => undefined);
}

/** 보통 폴더일 때만 권한을 조인다(링크를 따라가 그 너머의 폴더 권한을 바꾸지 않는다) */
async function chmodRealDir(target: string, mode: number): Promise<void> {
  const info = await lstat(target).catch(() => undefined);
  if (info?.isDirectory() && !info.isSymbolicLink()) await chmod(target, mode);
}

/**
 * 관문 폴더 아래의 폴더 자리를 확보한다. 자리가 링크거나 폴더가 아니면 자리 자체를 지우고 새로 만든다 —
 * 링크의 대상은 건드리지 않는다. `mkdir`은 자리 자체만 만들고 링크를 따라가지 않는다
 */
async function ensureGatewayDir(target: string): Promise<void> {
  const info = await lstat(target).catch(() => undefined);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) await rm(target, { force: true });
  await mkdir(target, { recursive: true, mode: 0o700 });
  const after = await lstat(target).catch(() => undefined);
  if (!after?.isDirectory() || after.isSymbolicLink()) throw new SandboxError('관문 폴더를 만들지 못했습니다', target);
}

/**
 * 세션의 관문 설정을 이 컴퓨터에 쓰고 그 폴더를 돌려준다. 토큰이 들어 있으므로 이 사용자만 읽을 수 있게 둔다.
 * 컨테이너 방식과 같은 폴더(`<루트>/<샌드박스 id>`)를 쓴다 — 세션은 한 번에 한 방식으로만 열린다.
 * 관문 폴더 안의 링크를 따라가지 않는다: 하위 폴더 자리가 링크면 그 자리만 지우고 새로 만든다
 */
export async function writeHostGatewayConfig(sandboxId: string, address: AgentGatewayAddress, cli: HostCli, root: string = defaultAgentGatewayRoot()): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const made = gatewayDirFor(sandboxId, root);
  // 관문 폴더 자체가 링크면 그 너머를 건드리지 않고 멈춘다(루트 아래의 세션 폴더를 링크로 바꾼 경우다)
  const madeInfo = await lstat(made).catch(() => undefined);
  if (madeInfo?.isSymbolicLink()) throw new SandboxError('관문 폴더가 심볼릭 링크입니다', made);
  await mkdir(made, { recursive: true, mode: 0o700 });
  // 훅 명령과 감싸개에 이 폴더의 경로가 들어간다. 링크를 푼 진짜 경로로 적는다(위에서 링크가 아님을 확인했다)
  const dir = await realpath(made);
  for (const name of GATEWAY_DIRS) await ensureGatewayDir(path.join(dir, name));
  // 이미 있던 폴더에는 mkdir의 mode가 적용되지 않는다. 부를 때마다 다시 조인다
  await chmodRealDir(dir, 0o700);
  for (const name of GATEWAY_DIRS) await chmodRealDir(path.join(dir, name), 0o700);
  for (const [name, { content, mode }] of Object.entries(expectedHostGatewayFiles(address, dir, cli))) {
    const target = path.join(dir, name);
    // 기대하는 자리가 보통 파일이 아니면(없거나, 심볼릭 링크거나, 폴더면) 다시 쓴다. 링크를 남겨 두면 검사가 매번 위반으로 본다
    const info = await lstat(target).catch(() => undefined);
    const same = info?.isFile() === true && !info.isSymbolicLink() && (await readFile(target, 'utf8').catch(() => undefined)) === content;
    if (!same) {
      // 추측할 수 없는 이름을 새로 만들 때만 쓰고(wx) 옮긴다. 미리 심어 둔 링크를 따라 쓰지 않는다.
      // rename은 자리의 링크를 그 대상이 아니라 자리 자체로 바꾼다
      const staged = `${target}.${randomBytes(8).toString('hex')}.tmp`;
      await writeFile(staged, content, { mode, flag: 'wx' });
      await rename(staged, target);
    }
    // 내용이 같아 쓰지 않았어도 권한이 넓혀져 있을 수 있다(주소 파일에는 토큰이 있다). 보통 파일일 때만 다시 조인다
    const after = await lstat(target).catch(() => undefined);
    if (after?.isFile() && !after.isSymbolicLink()) await chmod(target, mode);
  }
  return dir;
}

/**
 * 관문 폴더가 쓴 그대로인가. 다르거나 없거나 권한이 다른 파일의 이름(폴더 기준)을 돌려준다.
 * 권한을 700으로 유지해야 하는 폴더(관문 폴더·bin·shell·shell/zsh)의 권한이 다르면 그 폴더 이름도 넣는다
 * (관문 폴더 자체는 '.'). 기대하는 파일 자리가 심볼릭 링크면 다른 것을 가리킨 것이므로 위반으로 본다.
 * 관문 폴더 안에 기대하지 않은 파일이 생긴 것은 위반으로 보지 않는다(우리가 읽지 않는다)
 */
export async function checkHostGatewayConfig(dir: string, expected: Record<string, { content: string; mode: number }>): Promise<string[]> {
  const bad: string[] = [];
  for (const [name, spec] of Object.entries(expected)) {
    const target = path.join(dir, name);
    const info = await lstat(target).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== spec.mode || (await readFile(target, 'utf8').catch(() => undefined)) !== spec.content) {
      bad.push(name);
    }
  }
  for (const name of GATEWAY_FOLDER_NAMES) {
    const target = name ? path.join(dir, name) : dir;
    const info = await lstat(target).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o777) !== 0o700) bad.push(name || '.');
  }
  return bad;
}

/**
 * 세션이 멈출 때 그 세션의 관문 설정을 지운다. 이 코드가 쓴 파일만 지우고, 폴더는 비었을 때만 지운다.
 * 링크를 따라가지 않는다: 관문 폴더 자체나 하위 폴더가 링크면 그 너머의 파일은 건드리지 않고 링크 자리만 지운다
 */
export async function removeHostGatewayConfig(sandboxId: string, root: string = defaultAgentGatewayRoot()): Promise<void> {
  const dir = gatewayDirFor(sandboxId, root);
  const dirInfo = await lstat(dir).catch(() => undefined);
  // 관문 폴더 자체가 링크면 그 너머를 건드리지 않고 링크만 지운다
  if (dirInfo?.isSymbolicLink()) {
    await rm(dir, { force: true }).catch(() => {});
    return;
  }
  if (!dirInfo) return;
  // 하위 폴더가 링크면 그 안으로 들어가지 않고 링크 자체만 지운다
  for (const name of GATEWAY_DIRS) {
    const folder = path.join(dir, name);
    const info = await lstatChild(path.dirname(folder), folder);
    if (info?.isSymbolicLink()) await rm(folder, { force: true }).catch(() => {});
  }
  // 파일은 그 부모 폴더가 진짜일 때만 지운다(부모가 링크면 그 너머의 파일을 지우지 않는다)
  for (const name of GATEWAY_FILE_NAMES) {
    const target = path.join(dir, name);
    if (!(await lstatChild(path.dirname(target), target))) continue;
    await rm(target, { force: true }).catch(() => {});
  }
  // 진짜 폴더만 비었을 때 지운다(역순)
  for (const name of [...GATEWAY_DIRS].reverse()) {
    const folder = path.join(dir, name);
    const info = await lstatChild(path.dirname(folder), folder);
    if (info?.isDirectory() && !info.isSymbolicLink()) await rmdir(folder).catch(() => {});
  }
  await rmdir(dir).catch(() => {});
}

/**
 * 훅이 관문에 닿는가. 터미널의 훅이 쓰는 바로 그 스크립트와 주소 파일로 묻는다.
 * codex는 관문 루트의 공용 스크립트를 쓰고, 세션의 관문 폴더를 환경 변수로 넘긴다(감싸개와 같은 방식, #825)
 */
export async function probeHostGateway(dir: string, nodePath: string = process.execPath, kind: HostCliKind = 'claude'): Promise<boolean> {
  const script = kind === 'codex' ? path.join(path.dirname(dir), CODEX_HOOK_SCRIPT_NAME) : path.join(dir, HOOK_SCRIPT_NAME);
  const env = kind === 'codex' ? { ...process.env, [CODEX_GATEWAY_DIR_ENV]: dir } : process.env;
  return new Promise<boolean>((resolve) => {
    // 훅 스크립트는 ping에서도 표준 입력을 다 읽는다. 열어 두면 입력을 기다리다 끝나지 않으므로 닫아 준다
    const child = execFile(nodePath, [script, 'ping'], { timeout: (HOST_PING_SECONDS + 10) * 1000, env }, (error) => resolve(!error));
    child.stdin?.end();
  });
}

/** 이 컴퓨터의 프로세스 하나. `ps`가 준 pid·부모 pid·인자 한 줄 */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  args: string;
}

/** `ps -A -o pid=,ppid=,args=`로 이 컴퓨터의 프로세스 목록을 읽는다(macOS와 리눅스 둘 다 된다) */
export async function listProcesses(): Promise<ProcessEntry[]> {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,args=']);
  const entries: ProcessEntry[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3]!.trimEnd() });
  }
  return entries;
}

/** CLI 패키지가 설치된 자리에 들어가는 글. 감싸개나 node 실행기가 진짜 CLI를 띄울 때도 인자에 남는다 */
const CLI_PACKAGE_MARK: Record<HostCliKind, string> = { claude: '/@anthropic-ai/claude-code/', codex: '/@openai/codex' };

/**
 * 이 프로세스가 에이전트 CLI로 보이는가. 첫 낱말의 파일 이름이 CLI 이름(`claude`·`codex`)이거나, 첫 낱말이 cliPath와 같거나,
 * 인자에 CLI 패키지 자리가 들었을 때. 감싸개(`bin/claude`, 셸 스크립트)는 `/bin/sh <감싸개>`로 보인다(대화형 codex 감싸개는
 * CLI가 끝날 때까지 부모로 남는다). 첫 낱말이 `/bin/sh`라 이 규칙에 걸리지 않고, 그 아래의 진짜 CLI를 본다
 */
function looksLikeAgentCli(args: string, cliPath: string, kind: HostCliKind): boolean {
  const first = args.trim().split(/\s+/)[0] ?? '';
  return path.basename(first) === kind || first === cliPath || args.includes(CLI_PACKAGE_MARK[kind]);
}

/**
 * root(PTY의 pid) 아래에서 도는 에이전트 CLI 중 우리 설정이 붙지 않은 것.
 * 붙었다고 보는 것은 인자에 표식이 그대로 있는 것이다 — claude는 `--settings <settingsPath>`, codex는 훅 명령이 가리키는
 * 관문 루트의 훅 스크립트 경로(`-c hooks.…` 안). 관문 폴더 경로에 빈칸이 있어도 `ps`의 인자 한 줄에서 그대로 견줄 수 있게 문자열 포함으로 본다
 */
export function findUnhookedCli(
  root: number,
  processes: readonly ProcessEntry[],
  expected: { settingsPath: string; cliPath: string; kind?: HostCliKind },
): ProcessEntry[] {
  const kind = expected.kind ?? 'claude';
  // codex는 settingsPath 자리에 관문 폴더를 받아 그 위(관문 루트)의 훅 스크립트를 표식으로 본다
  const marker = kind === 'codex' ? path.join(path.dirname(path.dirname(expected.settingsPath)), CODEX_HOOK_SCRIPT_NAME) : `--settings ${expected.settingsPath}`;
  const children = new Map<number, ProcessEntry[]>();
  for (const process of processes) {
    const list = children.get(process.ppid);
    if (list) list.push(process);
    else children.set(process.ppid, [process]);
  }
  const found: ProcessEntry[] = [];
  const seen = new Set<number>([root]);
  // 직계 자식뿐 아니라 손자(셸 → 셸 → claude)까지 본다. 같은 pid를 두 번 보지 않는다
  const walk = (pid: number): void => {
    for (const child of children.get(pid) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      if (looksLikeAgentCli(child.args, expected.cliPath, kind) && !child.args.includes(marker)) found.push(child);
      walk(child.pid);
    }
  };
  walk(root);
  return found;
}

/**
 * 터미널을 열면 도는 명령. CLI를 띄우고, CLI에서 나오면 이 컴퓨터의 셸로 남는다.
 * `claude`는 PATH 맨 앞의 감싸개다. 셸의 시작 파일이 PATH의 순서를 바꾸면 되돌아간 셸에서 친 `claude`에는 훅이 붙지 않을 수 있다 —
 * 그때의 변경은 다음 요청의 검증에 "실행 전부터 있던 변경"으로 들어간다
 */
export function hostTerminalCommand(kind: HostCliKind = 'claude'): string {
  return [
    // Ctrl-C는 앞에서 도는 프로그램(CLI)과 이 셸에 함께 간다. 셸이 죽으면 터미널이 통째로 끝나므로 받아서 넘긴다
    'trap : INT',
    ...FIRST_PROMPT_CAPTURE,
    ...firstLaunch(kind, kind),
    `printf "%s\\n" ${JSON.stringify(shellStartedNotice(kind))}`,
    'exec "${SHELL:-/bin/sh}"',
  ].join('\n');
}
export const HOST_TERMINAL_COMMAND = hostTerminalCommand('claude');

/** 터미널로 그대로 넘기는 이름. 나머지(PATH의 실제 내용, 버전 관리자, 프록시 등)는 사용자의 로그인 셸이 시작 파일로 만든다 */
const TERMINAL_ENV_NAMES = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TMPDIR', 'TZ', 'SSH_AUTH_SOCK', 'DISPLAY', 'WAYLAND_DISPLAY', '__CF_USER_TEXT_ENCODING'];
/** 앞머리로 넘기는 이름 */
const TERMINAL_ENV_PREFIXES = ['LC_', 'XDG_'];
/** 터미널의 PATH. 감싸개 폴더가 있으면 그 앞에 두고, 스튜디오 프로세스의 PATH는 넘기지 않는다 */
const TERMINAL_PATH = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** B_STUDIO_TERMINAL_ENV: 터미널에 더 넘길 환경 변수 이름. 쉼표로 구분하고, 빈 것은 건너뛰고, 틀린 이름은 던진다 */
function extraTerminalEnvNames(env: Record<string, string | undefined>): string[] {
  const raw = env.B_STUDIO_TERMINAL_ENV?.trim();
  if (!raw) return [];
  const names: string[] = [];
  for (const piece of raw.split(',')) {
    const name = piece.trim();
    if (!name) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.startsWith('B_STUDIO_')) {
      throw new SandboxError('B_STUDIO_TERMINAL_ENV에 쓸 수 없는 환경 변수 이름이 있습니다', `${name} — 영문·숫자·밑줄로 된 이름이어야 하고 B_STUDIO_로 시작할 수 없습니다`);
    }
    names.push(name);
  }
  return names;
}

/**
 * 터미널에 넘길 환경. 스튜디오 프로세스의 환경을 그대로 내려보내지 않고 **허용한 이름만** 넘긴다.
 * 스튜디오를 에이전트 CLI 안에서 띄우면 `CLAUDECODE`·`CLAUDE_CODE_*` 표식이 터미널의 CLI까지 내려가 안쪽 세션으로 오해되고
 * ("inherited CLAUDE_CODE_CHILD_SESSION marker"), pnpm이 끼운 PATH(`node_modules/.bin`)와 `NODE_ENV` 등도 함께 내려간다.
 * `B_STUDIO_`만 빼는 것으로는 부족하다. 나머지는 사용자의 로그인 셸이 시작 파일로 만든다 — 평소 터미널을 열 때와 같다
 */
export function hostTerminalEnv(gatewayDir: string | undefined, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const wanted = new Set([...TERMINAL_ENV_NAMES, ...extraTerminalEnvNames(env)]);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (wanted.has(key) || TERMINAL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) result[key] = value;
  }
  result.TERM = 'xterm-256color';
  result.COLORTERM = 'truecolor';
  result.PATH = [...(gatewayDir ? [path.join(gatewayDir, WRAPPER_DIR)] : []), ...TERMINAL_PATH].join(path.delimiter);
  return result;
}

/** 셸 함수를 정의할 자리가 없는 셸( fish 등)의 대체 명령. 감싸개 절대 경로로 띄우고, 다시 띄울 때도 그 경로를 쓰라고 알린다 */
function hostFallbackCommand(dir: string, kind: HostCliKind): string {
  const safe = `[b-studio] 이 셸에서는 ${kind}를 다시 띄울 때 검증이 붙지 않을 수 있습니다. '${wrapperPath(dir, kind)}'로 띄우세요.`;
  return [
    // Ctrl-C는 앞에서 도는 프로그램(CLI)과 이 셸에 함께 간다. 셸이 죽으면 터미널이 통째로 끝나므로 받아서 넘긴다
    'trap : INT',
    ...FIRST_PROMPT_CAPTURE,
    ...firstLaunch(shellQuote(wrapperPath(dir, kind)), kind),
    `printf "%s\\n" ${shellQuote(shellStartedNotice(kind))}`,
    `printf "%s\\n" ${shellQuote(safe)}`,
    'exec "${SHELL:-/bin/sh}"',
  ].join('\n');
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
  return { file: '/bin/sh', args: ['-c', hostFallbackCommand(gatewayDir, kind)], env: {} };
}

/** node-pty가 주는 가상 터미널에서 이 모듈이 쓰는 부분 */
export interface HostPty {
  /** 이 가상 터미널의 pid. 감시가 이 아래에서 훅 없이 뜬 CLI를 찾는 데 쓴다 */
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
}
/** 가상 터미널을 띄우는 자리(테스트가 가짜를 끼운다) */
export type SpawnHostPty = (file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => HostPty | Promise<HostPty>;

const spawnWithNodePty: SpawnHostPty = async (file, args, options) => {
  // 네이티브 모듈은 터미널을 열 때만 읽는다. 이 컴퓨터용 터미널을 쓰지 않는 환경(서버 모드, 컨테이너 방식)에서는 읽지 않는다
  const pty = await import('@lydell/node-pty');
  return pty.spawn(file, args, options);
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
  accountEnv = {},
  env = process.env,
  spawnPty = spawnWithNodePty,
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
  /**
   * 세션 계정의 설정 폴더 변수(#885, CLAUDE_CONFIG_DIR·CODEX_HOME). 감싸개도 같은 값을 넘기지만, 셸에서 CLI가 아닌 도구(예: `claude` 하위 명령을
   * 부르는 스크립트)도 같은 계정을 보게 PTY 환경에도 둔다. 이 두 이름만 받는다
   */
  accountEnv?: Record<string, string>;
  env?: Record<string, string | undefined>;
  spawnPty?: SpawnHostPty;
}): Promise<AgentTerminal & { pid: number }> {
  const { cols, rows } = clampTerminalSize(size);
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
      pty.onData((data) => listener(Buffer.from(data, 'utf8')));
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
