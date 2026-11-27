/**
 * Gemini의 설정 자리·믿음을 바꾸는 환경 변수. 감싸개가 지우고(`unset`), Rust 감시(`GEMINI_SETTINGS_ENVS`)가 있으면 붙지 않은 것으로 보고, `.env`가 정하면 거절한다.
 * 근거는 0.71.1: `GEMINI_CLI_HOME`(`Storage`)·`GEMINI_CLI_SYSTEM_SETTINGS_PATH`·`GEMINI_CLI_SYSTEM_DEFAULTS_PATH`(`settings`)·`GEMINI_RESTRICTED_MODE`·`GEMINI_CLI_TRUST_WORKSPACE`(`trustedFolders`)
 */
export const GEMINI_SETTINGS_ENVS: readonly string[] = ['GEMINI_CLI_SYSTEM_SETTINGS_PATH', 'GEMINI_CLI_SYSTEM_DEFAULTS_PATH', 'GEMINI_RESTRICTED_MODE', 'GEMINI_CLI_TRUST_WORKSPACE'];
/**
 * 샌드박스를 켜거나 꾸미는 환경 변수(0.71.1의 `loadSandboxConfig`·`getSandboxCommand`·샌드박스 시작 코드). 샌드박스는 CLI를 다른 프로세스에서 다시 띄워(docker·podman·sandbox-exec 등)
 * 우리 훅이 붙었는지 알 수 없다. `GEMINI_SANDBOX`는 설정·인자보다 먼저 읽히고(비어 있지 않으면 이긴다), `GEMINI_SANDBOX_IMAGE`는 이미지를, 나머지는 샌드박스 안의 마운트·포트·프로필·프록시를 정한다.
 * `SANDBOX`는 "이미 샌드박스 안"이라는 표식이라 설정돼 있으면 CLI가 샌드박스 시작을 건너뛰고 안쪽으로 행동한다
 */
export const GEMINI_SANDBOX_ENVS: readonly string[] = [
  'GEMINI_SANDBOX',
  'SANDBOX',
  'GEMINI_SANDBOX_IMAGE',
  'GEMINI_SANDBOX_PROXY_COMMAND',
  'SANDBOX_ENV',
  'SANDBOX_FLAGS',
  'SANDBOX_MOUNTS',
  'SANDBOX_PORTS',
  'SANDBOX_SET_UID_GID',
  'SEATBELT_PROFILE',
];
/** 감싸개가 띄우기 전에 지우는 환경 변수 전부(설정 자리·믿음 + 샌드박스). 홈(`GEMINI_CLI_HOME`)은 따로 우리 홈으로 정한다 */
export const GEMINI_UNSET_ENVS: readonly string[] = [...GEMINI_SETTINGS_ENVS, ...GEMINI_SANDBOX_ENVS];

/** 감싸개가 훅 명령 줄에 넘기는 환경 이름 기준(띄우기 직전의 이름 목록)과 훅 시점의 이름 목록을 담는 환경 변수. 훅 스크립트가 CLI 프로세스 안에서 새로 생긴 위험 이름을 가린다(#1475) */
export const GEMINI_ENV_BASELINE_ENV = 'B_STUDIO_ENV_BASELINE';
export const GEMINI_ENV_NAMES_ENV = 'B_STUDIO_ENV_NAMES';
