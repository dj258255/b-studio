/**
 * OpenCode의 설정·플러그인·권한·홈을 바꾸는 환경 변수. 감싸개가 띄우기 전에 지우고, Rust 감시(`OPENCODE_PLUGIN_ENVS` + `OPENCODE_PURE`)가 있으면 붙지 않은 것으로 본다(시험이 두 목록을 견준다).
 * 플러그인도 CLI 프로세스 안에서 이 이름이 새로 생겼는지 본다(Bun이 시작할 때 작업 폴더의 `.env`를 넣은 것을 잡는다).
 * 근거는 1.18.33 바이너리의 평문 JS다: `OPENCODE_TEST_MANAGED_CONFIG_DIR`은 관리형 설정 폴더(그 안의 `opencode.json(c)`가 마지막에 합쳐진다), `OPENCODE_TEST_HOME`은 `.opencode` 폴더를 찾는 홈,
 * `OPENCODE_PERMISSION`은 `permission`에 합쳐지는 JSON, `OPENCODE_DISABLE_DEFAULT_PLUGINS`는 내장 플러그인을 건너뛴다(우리 플러그인은 설정의 플러그인이라 직접 영향은 없지만 거부 목록이라 넓게 잡는다)
 */
export const OPENCODE_UNSET_ENVS: readonly string[] = [
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_TUI_CONFIG',
  'OPENCODE_PURE',
  'OPENCODE_TEST_MANAGED_CONFIG_DIR',
  'OPENCODE_TEST_HOME',
  'OPENCODE_DISABLE_DEFAULT_PLUGINS',
  'OPENCODE_PERMISSION',
];

/** 감싸개가 띄우기 직전의 환경 이름 목록(공백으로 이은 글)을 담아 CLI에 넘기는 환경 변수. 플러그인이 "그 뒤에 새로 생긴" 위험 이름을 가린다 */
export const OPENCODE_ENV_BASELINE_ENV = 'B_STUDIO_ENV_BASELINE';
