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
/**
 * `.env`가 정하면 거절하는 코드 적재·실행·설정 자리 변수(거부 목록이라 넓게). `NODE_ENV`는 흔한 평범한 값이라 뺀다(Node 자체는 읽지 않는다).
 * 허용 목록으로 바꾸지 않는다: `.env`는 보통 프로젝트가 쓰는 임의의 이름(DB 주소·키 등)을 담아 평범한 프로젝트의 `.env`가 거의 다 거절된다. "감싸개가 `.env` 적재 뒤에 값을 강제"하는 길도 없다:
 * Bun(opencode)과 Gemini의 `loadEnvironment`가 CLI 프로세스 안에서 `process.env`를 직접 채우므로 밖의 감싸개는 그 뒤에 끼어들 수 없다.
 * 묶음(#1475, 커밋 보안 검토): ① 설정·홈·캐시 자리를 옮기는 변수(`HOME`·`USERPROFILE`·`XDG_*`·`TMPDIR`·`APPDATA`·`LOCALAPPDATA` 등 — opencode의 `Global.Path`와 Gemini의 홈·설정이 이 값을 따라 띄우기 전 검사가 본 폴더와 실제로 읽는 폴더가 달라진다),
 * ② 프로그램을 띄우거나 코드를 실행하는 변수(`SHELL`·`COMSPEC`·`EDITOR`·`VISUAL`·`PAGER`·`BROWSER`·`GIT_*`·`JAVA_TOOL_OPTIONS`·`PERL*`·`RUBY*`·`GEM_*`·`NPM_CONFIG_*`·`YARN_*`·`PNPM_*`),
 * ③ 통신 경로·인증서를 바꾸는 변수(`*_PROXY`·`SSL_*`·`CURL_*`·`GRPC_*`·`REQUESTS_CA_BUNDLE`). opencode 1.18.33 문자열과 Gemini 0.71.1 번들의 `process.env.<이름>`을 훑어 같은 꼴(홈·설정·셸·브라우저·인증서 자리)을 더했다
 */
const ENV_CODE_LOAD_EXACT: ReadonlySet<string> = new Set([
  'PATH',
  'PATHEXT',
  'SHELLOPTS',
  'BASHOPTS',
  'IFS',
  'CDPATH',
  'GLOBIGNORE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'WINDIR',
  'ZDOTDIR',
  'SHELL',
  'COMSPEC',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'BROWSER',
  'VIRTUAL_ENV',
  'PREFIX',
  'DESTDIR',
  'DOTENV_KEY',
  'REQUESTS_CA_BUNDLE',
  'JAVA_TOOL_OPTIONS',
  '_JAVA_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'NOPROXY',
  ...CODE_LOAD_ENVS,
]);
const ENV_CODE_LOAD_PREFIXES: readonly string[] = ['NODE_', 'LD_', 'DYLD_', 'PYTHON', 'OPENSSL_', 'BASH_FUNC_', 'XDG_', 'GIT_', 'SSL_', 'CURL_', 'GRPC_', 'PERL', 'RUBY', 'GEM_', 'NPM_CONFIG_', 'YARN_', 'PNPM_', 'CLOUDSDK_', 'DOTNET_'];
const ENV_CODE_LOAD_SUFFIXES: readonly string[] = ['_PROXY'];
const ENV_CODE_LOAD_ALLOWED: ReadonlySet<string> = new Set(['NODE_ENV']);
/** dotenv의 줄 문법보다 느슨하게 줄 머리의 열쇠를 읽는다(`=`나 `:`가 따르면 열쇠로 본다). dotenv가 읽지 않는 줄까지 잡을 뿐이다 */
const ENV_LOOSE_KEY = /^[\s]*(?:export\s+)?([\w.-]+)\s*[=:]/gmu;

/** `.env` 열쇠 하나가 코드 적재·실행 경로 변수인가(대소문자를 접어 견준다). 거부 목록이라 넓게 맞춘다 */
export function envCodeLoadKey(key: string): boolean {
  const upper = key.toUpperCase();
  return !ENV_CODE_LOAD_ALLOWED.has(upper) && (ENV_CODE_LOAD_EXACT.has(upper) || ENV_CODE_LOAD_PREFIXES.some((prefix) => upper.startsWith(prefix)) || ENV_CODE_LOAD_SUFFIXES.some((suffix) => upper.endsWith(suffix)));
}

/** 코드 적재 변수 규칙을 JSON으로 낸다. 관문 폴더의 검사 스크립트(`startup-check.ts`)가 같은 목록을 쓴다(목록은 한 곳이다) */
export function envCodeLoadRules(): { exact: string[]; prefixes: string[]; suffixes: string[]; allowed: string[] } {
  return { exact: [...ENV_CODE_LOAD_EXACT], prefixes: [...ENV_CODE_LOAD_PREFIXES], suffixes: [...ENV_CODE_LOAD_SUFFIXES], allowed: [...ENV_CODE_LOAD_ALLOWED] };
}

/**
 * `.env` 글에서 `risky`가 참인 첫 열쇠를 찾는다. 줄 머리의 열쇠를 느슨하게 읽은 것(줄 끝을 `\n`으로 맞춘 뒤, `=`나 `:`가 따르는 열쇠)을 먼저 보고, 그다음에 `dotenv.parse`(Gemini가 쓰는 17.1.0과 같은 판)의 열쇠를 본다.
 * 느슨한 읽기가 `dotenv.parse`의 열쇠를 모두 포함한다: dotenv의 줄 문법은 줄 머리에서 `export`를 뗀 `[\w.-]+` 뒤에 `=`(앞뒤 빈칸 허용)나 `:`+빈칸이 오는 것이고, dotenv도 `\r\n`·`\r`을 `\n`으로 맞춘 뒤 읽는다.
 * 그래서 관문 폴더의 검사 스크립트는 `dotenv` 없이 느슨한 읽기만 써도 같은 답을 낸다(시험이 두 쪽을 견준다). 따옴표 안의 줄까지 보는 것은 더 막을 뿐이다
 */
export function envRiskKeyIn(text: string, risky: (key: string) => boolean): string | undefined {
  for (const match of text.replace(/\r\n?/gu, '\n').matchAll(ENV_LOOSE_KEY)) if (risky(match[1]!)) return match[1];
  for (const key of Object.keys(dotenv.parse(text))) if (risky(key)) return key;
  return undefined;
}
