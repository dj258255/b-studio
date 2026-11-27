import { codexEnvFile, codexGatewayArgs, codexHookCommand, shellQuote } from '../host-terminal';
import { AGENT_CODEX_BIN } from './agent-image';
import {
  AGENT_HOOK_EVENTS,
  AGENT_FIRST_PROMPT_ENV,
  AGENT_FIRST_PROMPT_VAR,
  AGENT_GATEWAY_TARGET,
  AGENT_HOOK_SCRIPT,
  AGENT_NODE,
  CODEX_CONTAINER_ENV_FILE,
  CODEX_CONTAINER_REQUIREMENTS_FILE,
  CODEX_CONTAINER_RC_FILE,
  CODEX_CONTAINER_WRAPPER_FILE,
  CODEX_HOOK_SCRIPT_NAME,
  type AgentGatewayAddress,
  type AgentHookEvent,
} from './agent-terminal';

/**
 * 컨테이너 방식 터미널의 codex(ADR-245). 이 컴퓨터 방식의 codex(호스트 감싸개, `hostCodexWrapper`)와 같은 방식으로 훅·b-studio 도구·텔레메트리를
 * `-c` 덮어쓰기로 붙인다. 달라지는 것은 자리뿐이다:
 * - 훅 스크립트는 세션의 관문 폴더(컨테이너의 `/etc/claude-code`, 읽기 전용 마운트)에 있다. 이 컴퓨터 방식은 관문 루트의 공용 스크립트를 쓰지만(훅 명령 글이 세션마다 같아야 신뢰를 다시 묻지 않는다),
 *   컨테이너는 세션마다 같은 자리라서 명령 글이 늘 같다. 스크립트는 claude의 훅과 같은 것(자기 옆의 주소 파일을 읽는다)이다.
 * - 토큰은 인자가 아니라 관문 폴더의 환경 파일(`codex.env`)로 넘기고 감싸개가 읽는다.
 * - codex 실행 파일은 이미지의 `/opt/b-studio/codex`(에이전트가 쓸 수 없는 자리)다. 홈 볼륨에 설치하지 않는다.
 * **훅은 `-c`가 아니라 관리 요구사항(`/etc/codex/requirements.toml`)으로 붙인다**(보안 검토): 감싸개의 `-c`는 에이전트가 이미지의 codex 실행 파일을 직접 부르면 빠진다.
 * 요구사항은 codex가 늘 읽는 관리자 설정이고(소스: codex-rs/config/src/loader/mod.rs의 `system_requirements_toml_file` = `/etc/codex/requirements.toml`),
 * 사용자 설정·`-c`보다 앞선 제약이며, 그 안의 `[hooks]`는 켜져 있고 신뢰 확인 없이 돌며 끌 수 없다(codex-rs/hooks/src/engine/discovery.rs의 `hook_enabled`·`hook_trust_status`, 불러오지 못하면 시작하지 않는 `HookRequirement::Required`).
 * `[features] hooks = true`로 훅 기능을 못 끄게 고정하고, `allow_managed_hooks_only = true`로 사용자·프로젝트 훅은 돌지 않게 한다.
 * 감싸개의 `-c`는 훅이 아닌 것(b-studio 도구 서버, 텔레메트리, 업데이트 확인 끄기)만 붙인다 — 이것들은 빠져도 검증이 약해지지 않는다(도구·사용량만 빠진다)
 */

/** 컨테이너 안에서 감싸개가 있는 자리 */
export const AGENT_CODEX_WRAPPER_PATH = `${AGENT_GATEWAY_TARGET}/${CODEX_CONTAINER_WRAPPER_FILE}`;
const RC_PATH = `${AGENT_GATEWAY_TARGET}/${CODEX_CONTAINER_RC_FILE}`;

/** 셸에서 `codex`를 치면 감싸개로 부르는 함수. 이것이 없으면 다시 띄운 codex에는 훅이 붙지 않는다(PATH에는 codex가 없다) */
const CODEX_FUNCTION = `codex() { sh ${shellQuote(AGENT_CODEX_WRAPPER_PATH)} "$@"; }`;

/**
 * 감싸개가 붙이는 `-c` 덮어쓰기. 호스트와 같은 목록(`codexGatewayArgs`)에서 **훅(`hooks.*`, `features.hooks`)을 뺀 것**이다 — 훅은 관리 요구사항이 맡는다.
 * 훅을 `-c`로도 붙이면 같은 훅이 두 번 돈다(요구사항의 훅은 사용자 설정의 훅에 더해진다)
 */
export function codexWrapperArgs(address: Pick<AgentGatewayAddress, 'hookUrl' | 'mcpUrl'>): string[] {
  const all = codexGatewayArgs(address, AGENT_GATEWAY_TARGET, AGENT_NODE);
  const kept: string[] = [];
  for (let i = 0; i < all.length; i += 2) {
    const value = all[i + 1] ?? '';
    if (value.startsWith('hooks.') || value.startsWith('features.hooks')) continue;
    kept.push(all[i]!, value);
  }
  return kept;
}

/** TOML 기본 문자열 */
const toml = (value: string): string => JSON.stringify(value);

/** 요구사항의 훅 하나: TOML 이벤트 이름, 훅 이름(관문의 경로), 기다리는 시간(초) */
const REQUIRED_HOOKS: ReadonlyArray<readonly [string, AgentHookEvent, number]> = [
  ['SessionStart', 'session-start', AGENT_HOOK_EVENTS['session-start']],
  ['UserPromptSubmit', 'prompt', AGENT_HOOK_EVENTS.prompt],
  // matcher를 두지 않는다: codex의 matcher는 앞보기를 못 쓰는 정규식이라 "읽기 도구가 아닌 모든 것"을 적을 수 없다. 모든 도구에 걸고 관문이 읽기 도구를 통과시킨다(호스트와 같다)
  ['PreToolUse', 'pre-tool', AGENT_HOOK_EVENTS['pre-tool']],
  ['Stop', 'stop', AGENT_HOOK_EVENTS.stop],
  // 호스트의 CODEX_SESSION_END_SECONDS(3)와 같다
  ['SessionEnd', 'session-end', 3],
  // 권한 확인 창이 뜨면 알린다(B7). 답을 주지 않는다
  ['PermissionRequest', 'notification', AGENT_HOOK_EVENTS.notification],
];

/**
 * `/etc/codex/requirements.toml`. 에이전트가 쓸 수 없는 읽기 전용 마운트에 놓이고, codex가 어떤 방법으로 띄워지든(감싸개, 이미지의 실행 파일을 직접, node로 그 JS를) 읽는다.
 * 훅 명령은 호스트와 같은 글(`codexHookCommand`)이라 세션마다 같다
 */
export function agentCodexRequirements(): string {
  const lines = [
    '# b-studio가 만든 파일입니다. 읽기 전용 마운트라 컨테이너 안에서 바꿀 수 없습니다.',
    'allow_managed_hooks_only = true',
    '',
    '[features]',
    'hooks = true',
    '',
    '[hooks]',
    '',
  ];
  for (const [event, hook, seconds] of REQUIRED_HOOKS) {
    lines.push(`[[hooks.${event}]]`, '', `[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${toml(codexHookCommand(AGENT_GATEWAY_TARGET, AGENT_NODE, hook, { gatewayDirEnv: false }))}`, `timeout = ${seconds}`, '');
  }
  return lines.join('\n');
}

/** 관문 폴더에 더 쓸 codex 파일: 이름 → 내용 */
export function agentCodexFiles(address: AgentGatewayAddress): Record<string, string> {
  return {
    [CODEX_HOOK_SCRIPT_NAME]: AGENT_HOOK_SCRIPT,
    [CODEX_CONTAINER_ENV_FILE]: codexEnvFile(address, AGENT_GATEWAY_TARGET),
    [CODEX_CONTAINER_WRAPPER_FILE]: agentCodexWrapper(address),
    [CODEX_CONTAINER_RC_FILE]: `${CODEX_FUNCTION}\n`,
    [CODEX_CONTAINER_REQUIREMENTS_FILE]: agentCodexRequirements(),
  };
}

/**
 * codex 감싸개(`sh`로 실행한다). `hostCodexWrapper`와 같은 순서다: 환경 파일을 읽고, 설정 덮어쓰기를 붙이고, 대화형이면 세션 시작을 알린 뒤 codex를 띄우고, 끝나면 세션 끝을 알린다.
 * 사용자가 준 인자(첫 요청 글 포함)는 그대로 넘긴다
 */
export function agentCodexWrapper(address: Pick<AgentGatewayAddress, 'hookUrl' | 'mcpUrl'>): string {
  const args = codexWrapperArgs(address).map(shellQuote).join(' ');
  const notify = (event: 'session-start' | 'session-end') => `printf '{}' | ${codexHookCommand(AGENT_GATEWAY_TARGET, AGENT_NODE, event, { gatewayDirEnv: false })} >/dev/null 2>&1`;
  const codex = shellQuote(AGENT_CODEX_BIN);
  return [
    '#!/bin/sh',
    '# b-studio가 만든 파일입니다. 고쳐도 다음에 터미널을 열 때 다시 쓰입니다.',
    `. ${shellQuote(`${AGENT_GATEWAY_TARGET}/${CODEX_CONTAINER_ENV_FILE}`)}`,
    'interactive=',
    'case "${1-}" in',
    '  -h|--help|-V|--version) ;;',
    "  ''|-*|resume|fork) interactive=1 ;;",
    'esac',
    `set -- ${args} "$@"`,
    `[ -n "$interactive" ] || exec ${codex} "$@"`,
    "trap ':' INT TERM HUP",
    notify('session-start'),
    `${codex} "$@"`,
    'status=$?',
    notify('session-end'),
    'exit $status',
    '',
  ].join('\n');
}

/**
 * codex 세션의 터미널 명령. claude 명령(AGENT_TERMINAL_COMMAND)과 같은 모양이다: 첫 요청은 환경 변수로만 받아 셸 변수로 옮기고 환경에서 지운 뒤 첫 실행에서만 인자로 쓴다.
 * 설치 단계가 없다(이미지에 있다). codex에서 나오면 셸로 남고, 그 셸에서도 `codex`는 감싸개를 부른다(rcfile)
 */
export const AGENT_CODEX_TERMINAL_COMMAND = [
  'trap : INT',
  `if [ -n "\${${AGENT_FIRST_PROMPT_ENV}+x}" ]; then`,
  `  ${AGENT_FIRST_PROMPT_VAR}="\$${AGENT_FIRST_PROMPT_ENV}"`,
  `  unset ${AGENT_FIRST_PROMPT_ENV}`,
  'fi',
  CODEX_FUNCTION,
  `if [ -n "\${${AGENT_FIRST_PROMPT_VAR}+x}" ]; then codex "\$${AGENT_FIRST_PROMPT_VAR}"; else codex; fi`,
  `unset ${AGENT_FIRST_PROMPT_VAR}`,
  'printf "%s\n" "[b-studio] codex에서 나왔습니다. 다시 띄우려면 codex 를 입력하세요."',
  `exec bash --rcfile ${shellQuote(RC_PATH)}`,
].join('\n');
