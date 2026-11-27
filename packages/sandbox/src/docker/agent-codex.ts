import { codexEnvFile, codexGatewayArgs, codexHookCommand, shellQuote } from '../host-terminal';
import { AGENT_CODEX_BIN } from './agent-image';
import {
  AGENT_FIRST_PROMPT_ENV,
  AGENT_FIRST_PROMPT_VAR,
  AGENT_GATEWAY_TARGET,
  AGENT_HOOK_SCRIPT,
  AGENT_NODE,
  CODEX_CONTAINER_ENV_FILE,
  CODEX_CONTAINER_RC_FILE,
  CODEX_CONTAINER_WRAPPER_FILE,
  CODEX_HOOK_SCRIPT_NAME,
  type AgentGatewayAddress,
} from './agent-terminal';

/**
 * 컨테이너 방식 터미널의 codex(ADR-245). 이 컴퓨터 방식의 codex(호스트 감싸개, `hostCodexWrapper`)와 같은 방식으로 훅·b-studio 도구·텔레메트리를
 * `-c` 덮어쓰기로 붙인다. 달라지는 것은 자리뿐이다:
 * - 훅 스크립트는 세션의 관문 폴더(컨테이너의 `/etc/claude-code`, 읽기 전용 마운트)에 있다. 이 컴퓨터 방식은 관문 루트의 공용 스크립트를 쓰지만(훅 명령 글이 세션마다 같아야 신뢰를 다시 묻지 않는다),
 *   컨테이너는 세션마다 같은 자리라서 명령 글이 늘 같다. 스크립트는 claude의 훅과 같은 것(자기 옆의 주소 파일을 읽는다)이다.
 * - 토큰은 인자가 아니라 관문 폴더의 환경 파일(`codex.env`)로 넘기고 감싸개가 읽는다.
 * - codex 실행 파일은 이미지의 `/opt/b-studio/codex`(에이전트가 쓸 수 없는 자리)다. 홈 볼륨에 설치하지 않는다.
 * 호스트의 `codexGatewayArgs`를 그대로 써서 두 방식의 설정이 어긋나지 않게 한다
 */

/** 컨테이너 안에서 감싸개가 있는 자리 */
export const AGENT_CODEX_WRAPPER_PATH = `${AGENT_GATEWAY_TARGET}/${CODEX_CONTAINER_WRAPPER_FILE}`;
const RC_PATH = `${AGENT_GATEWAY_TARGET}/${CODEX_CONTAINER_RC_FILE}`;

/** 셸에서 `codex`를 치면 감싸개로 부르는 함수. 이것이 없으면 다시 띄운 codex에는 훅이 붙지 않는다(PATH에는 codex가 없다) */
const CODEX_FUNCTION = `codex() { sh ${shellQuote(AGENT_CODEX_WRAPPER_PATH)} "$@"; }`;

/** 관문 폴더에 더 쓸 codex 파일: 이름 → 내용 */
export function agentCodexFiles(address: AgentGatewayAddress): Record<string, string> {
  return {
    [CODEX_HOOK_SCRIPT_NAME]: AGENT_HOOK_SCRIPT,
    [CODEX_CONTAINER_ENV_FILE]: codexEnvFile(address, AGENT_GATEWAY_TARGET),
    [CODEX_CONTAINER_WRAPPER_FILE]: agentCodexWrapper(address),
    [CODEX_CONTAINER_RC_FILE]: `${CODEX_FUNCTION}\n`,
  };
}

/**
 * codex 감싸개(`sh`로 실행한다). `hostCodexWrapper`와 같은 순서다: 환경 파일을 읽고, 설정 덮어쓰기를 붙이고, 대화형이면 세션 시작을 알린 뒤 codex를 띄우고, 끝나면 세션 끝을 알린다.
 * 사용자가 준 인자(첫 요청 글 포함)는 그대로 넘긴다
 */
export function agentCodexWrapper(address: Pick<AgentGatewayAddress, 'hookUrl' | 'mcpUrl'>): string {
  const args = codexGatewayArgs(address, AGENT_GATEWAY_TARGET, AGENT_NODE).map(shellQuote).join(' ');
  const notify = (event: 'session-start' | 'session-end') => `printf '{}' | ${codexHookCommand(AGENT_GATEWAY_TARGET, AGENT_NODE, event)} >/dev/null 2>&1`;
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
  'printf "%s\\n" "[b-studio] codex에서 나왔습니다. 다시 띄우려면 codex 를 입력하세요."',
  `exec bash --rcfile ${shellQuote(RC_PATH)}`,
].join('\n');
