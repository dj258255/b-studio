import dotenv from 'dotenv';

/**
 * 프로세스 전체(훅 명령을 실행하는 셸과 node 포함)에 코드를 적재·실행시키는 환경 변수. 감싸개가 지우고(`unset`, `DYLD_*`는 이름으로 찾아 지운다), `.env`가 정하면 거절한다.
 * 근거(0.71.1): `.env`의 값은 `loadEnvironment`가 `process.env`에 그대로 넣고(제외 목록은 `DEBUG` 등 넷뿐), 훅 명령은 `executeCommandHook`이 `sanitizeEnvironment(process.env)`(기본값은 가리지 않음)에
 * 얹어 `bash -c`로 띄운다. 셸 이름 `bash`는 `PATH`로 찾고, 비대화형 `bash -c`도 `BASH_ENV`를 읽는다. `SHELLOPTS`·`BASHOPTS`는 셸이 읽기 전용으로 쥐고 있어 감싸개가 지우지 못하므로 `.env` 거절에만 둔다. 그래서 훅 명령 줄의 `env -i`만으로는 `PATH`·`BASH_ENV`를 막지 못해 둘 다 `.env`에서 거절한다
 */
export const CODE_LOAD_ENVS: readonly string[] = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
  'PS4',
  'PROMPT_COMMAND',
];
/** `.env`가 정하면 거절하는 코드 적재·실행 경로 변수(거부 목록이라 넓게). `NODE_ENV`는 흔한 평범한 값이라 뺀다(Node 자체는 읽지 않는다) */
const ENV_CODE_LOAD_EXACT: ReadonlySet<string> = new Set(['PATH', 'SHELLOPTS', 'BASHOPTS', 'IFS', 'CDPATH', 'GLOBIGNORE', 'SSL_CERT_FILE', 'SSL_CERT_DIR', ...CODE_LOAD_ENVS]);
const ENV_CODE_LOAD_PREFIXES: readonly string[] = ['NODE_', 'LD_', 'DYLD_', 'PYTHON', 'OPENSSL_', 'BASH_FUNC_'];
const ENV_CODE_LOAD_ALLOWED: ReadonlySet<string> = new Set(['NODE_ENV']);
/** dotenv의 줄 문법보다 느슨하게 줄 머리의 열쇠를 읽는다(`=`나 `:`가 따르면 열쇠로 본다). dotenv가 읽지 않는 줄까지 잡을 뿐이다 */
const ENV_LOOSE_KEY = /^[\s]*(?:export\s+)?([\w.-]+)\s*[=:]/gmu;

/** `.env` 열쇠 하나가 코드 적재·실행 경로 변수인가(대소문자를 접어 견준다). 거부 목록이라 넓게 맞춘다 */
export function envCodeLoadKey(key: string): boolean {
  const upper = key.toUpperCase();
  return !ENV_CODE_LOAD_ALLOWED.has(upper) && (ENV_CODE_LOAD_EXACT.has(upper) || ENV_CODE_LOAD_PREFIXES.some((prefix) => upper.startsWith(prefix)));
}

/** `.env` 글에서 `risky`가 참인 첫 열쇠를 찾는다. `dotenv.parse`(Gemini가 쓰는 17.1.0과 같은 판)가 읽는 열쇠에, 줄 머리의 열쇠를 느슨하게 읽은 것을 더한다(따옴표 안의 줄까지 보는 것은 더 막을 뿐이다) */
export function envRiskKeyIn(text: string, risky: (key: string) => boolean): string | undefined {
  for (const key of Object.keys(dotenv.parse(text))) if (risky(key)) return key;
  for (const match of text.matchAll(ENV_LOOSE_KEY)) if (risky(match[1]!)) return match[1];
  return undefined;
}
