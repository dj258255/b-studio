import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { geminiHookSeconds, GEMINI_HOOK_NAME, type GeminiHookEvent } from './gemini-hook';
import { parseJsonc } from './gemini-jsonc';

/**
 * Gemini CLI의 설정이 b-studio의 훅을 끄거나 다른 훅을 더하는 길을 닫는다(ADR-242).
 * 근거는 0.71.1에 든 소스다(`settings`의 `mergeSettings`, `HookRegistry`, `Config`; 실제로 띄워 보지는 않았다):
 * - 설정은 기본값 < 시스템 기본값 < 사용자(`<홈>/.gemini/settings.json`) < **작업 폴더**(`<작업 폴더>/.gemini/settings.json`, 믿는 폴더일 때만) < 시스템(`GEMINI_CLI_SYSTEM_SETTINGS_PATH`나 OS의 관리자 자리) 순으로 합쳐진다.
 *   시스템 설정은 파일과 **모든 상위 폴더가 root 소유이고 그룹·다른 사용자가 쓸 수 없을 때만** 읽는다(`isFileAndDirectorySecureSync`). 그래서 사용자 폴더의 파일을 시스템 설정으로 붙일 수 없고, 훅은 `GEMINI_CLI_HOME`(홈을 바꾸는 환경 변수)의 사용자 설정으로 붙인다.
 * - `hooks.<이벤트>`는 **이어 붙이고**(`concat`), `hooksConfig.disabled`는 합집합이며, `hooksConfig.enabled`는 뒤에 오는 쪽(작업 폴더·시스템)이 이긴다.
 *   그러므로 작업 폴더 설정이 `hooks`를 더하면 다른 훅이 우리 훅과 나란히 돌며 `tool_input`을 바꿔 쓸 수 있고(훅 출력의 `hookSpecificOutput.tool_input`), `hooksConfig`를 두면 우리 훅을 끌 수 있다.
 * - 믿지 않는 폴더에서는 설정 훅이 **하나도 등록되지 않는다**(`HookRegistry.processHooksFromConfig`). 시스템 설정의 훅도 그렇다. 그 경우는 세션 시작 신호가 오지 않는 것으로 잡는다.
 * - 확장(extensions)은 `<홈>/.gemini/extensions`에서만 불러온다. 홈이 우리 폴더라 비어 있다.
 *
 * 부르는 자리마다 막는 쪽인지 여는 쪽인지:
 * - `geminiConfigRefusal`: 터미널을 여는 것을 허락하는 판정이라 열린 쪽은 "모두 읽었고 훅을 바꾸는 것이 없다"뿐이다. 읽지 못한 것·모르는 모양은 거절이다
 * - `geminiConfigPathBlocked`: 거부 목록이다. 넓게 맞추면 더 막을 뿐이다(이름이 `.gemini`인 칸은 깊이와 상관없이 막는다)
 * - `geminiVersionRefusal`: 여는 쪽이다. 판을 읽지 못하거나 읽어 본 판보다 낮으면 거절이다
 */

/** 훅을 읽어 본 판. 이보다 낮은 판은 훅이 없거나(0.1.22) 읽어 보지 않았다 */
export const GEMINI_MIN_VERSION = '0.71.1';

/** 훅 명령을 이을 때 설정 글의 환경 변수 풀기(`$이름`)에 걸리는 글자. 있으면 훅 명령이 바뀐다 */
function assertNoDollar(value: string, what: string): void {
  if (value.includes('$')) throw new Error(`${what}에 $가 있어 Gemini 설정의 환경 변수 풀기에 걸립니다: ${value}`);
}

/** 작은따옴표로 감싼다(경로에 빈칸이 있어도 한 덩어리) */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 막는 훅이 실행되지 못했을 때(노드 없음·스크립트 죽음) 거절이 되게 하는 꼬리. 표준 오류의 글이 있어야 거절로 읽힌다 */
const FAIL_CLOSED = `|| { echo '[b-studio] 훅 명령이 실행되지 못해 막았습니다' >&2; exit 2; }`;

const HOOKS: ReadonlyArray<{ gemini: string; event: GeminiHookEvent; name: string; blocking: boolean }> = [
  { gemini: 'SessionStart', event: 'session-start', name: 'b-studio-session-start', blocking: false },
  { gemini: 'BeforeAgent', event: 'prompt', name: 'b-studio-prompt', blocking: true },
  { gemini: 'BeforeTool', event: 'pre-tool', name: 'b-studio-pre-tool', blocking: true },
  { gemini: 'AfterTool', event: 'post-tool', name: 'b-studio-post-tool', blocking: false },
  { gemini: 'AfterAgent', event: 'stop', name: 'b-studio-stop', blocking: false },
  { gemini: 'Notification', event: 'notification', name: 'b-studio-notification', blocking: false },
  { gemini: 'SessionEnd', event: 'session-end', name: 'b-studio-session-end', blocking: false },
];

/**
 * 우리 설정 파일의 글(`GEMINI_CLI_HOME/.gemini/settings.json`이 된다). 훅만 있고 matcher는 두지 않는다(모든 도구를 관문에 묻고 읽기 도구는 관문이 바로 통과시킨다).
 * `timeout`은 밀리초다. `authType`은 사용자가 쓰던 로그인 방식(`security.auth.selectedType`)을 옮긴 값이다(없으면 CLI가 처음에 묻는다)
 */
export function geminiSettingsContent(dir: string, nodePath: string, authType?: string): string {
  assertNoDollar(dir, '관문 폴더 경로');
  assertNoDollar(nodePath, 'node 경로');
  const hooks: Record<string, unknown> = {};
  for (const hook of HOOKS) {
    const command = `${quote(nodePath)} ${quote(path.join(dir, GEMINI_HOOK_NAME))} ${hook.event}${hook.blocking ? ` ${FAIL_CLOSED}` : ''}`;
    hooks[hook.gemini] = [{ hooks: [{ type: 'command', name: hook.name, command, timeout: geminiHookSeconds(hook.event) * 1000 }] }];
  }
  const settings: Record<string, unknown> = {
    hooksConfig: { enabled: true, disabled: [] },
    hooks,
    // 업데이트를 묻거나 스스로 깔지 않는다: 그 창이 뜨면 터미널에 보낸 글과 Enter가 답이 될 수 있다
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
  };
  if (authType !== undefined && /^[A-Za-z0-9_-]{1,64}$/u.test(authType)) settings.security = { auth: { selectedType: authType } };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** 사용자의 Gemini 설정에서 로그인 방식만 읽는다(읽기만). 없거나 모양이 틀리면 undefined */
export async function geminiUserAuthType(home: string | undefined): Promise<string | undefined> {
  if (!home) return undefined;
  try {
    const parsed = parseJsonc(await readFile(path.join(home, '.gemini', 'settings.json'), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const security = (parsed as { security?: unknown }).security;
    const auth = typeof security === 'object' && security !== null ? (security as { auth?: unknown }).auth : undefined;
    const selected = typeof auth === 'object' && auth !== null ? (auth as { selectedType?: unknown }).selectedType : undefined;
    return typeof selected === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(selected) ? selected : undefined;
  } catch {
    return undefined;
  }
}

/** 설정 파일 하나의 크기 상한. 넘으면 읽지 않고 거절한다(에이전트가 쓸 수 있는 자리라 상한이 없으면 읽는 쪽을 멈출 수 있다) */
const MAX_CONFIG_BYTES = 1024 * 1024;
/** `.env`에서 믿음·설정 자리를 바꾸는 변수 */
const ENV_RISK = /^\s*(?:export\s+)?(GEMINI_RESTRICTED_MODE|GEMINI_CLI_TRUST_WORKSPACE|GEMINI_CLI_HOME|GEMINI_CLI_SYSTEM_SETTINGS_PATH|GEMINI_CLI_SYSTEM_DEFAULTS_PATH)\s*=/mu;
const MAX_LEVELS = 64;

export interface GeminiLoadCheck {
  /** Gemini가 뜰 작업 폴더 */
  cwd: string;
  /** 시험이 시스템 설정 자리를 바꾼다. 기본은 운영체제의 관리자 자리 */
  systemSettingsDir?: string;
}

type Refusal = string | undefined;
const HINT = 'b-studio의 터미널은 b-studio의 훅 하나만 불러와야 합니다. 그 설정을 지운 뒤 다시 여세요';

function systemSettingsDir(): string {
  return process.platform === 'darwin' ? '/Library/Application Support/GeminiCli' : '/etc/gemini-cli';
}

function ancestors(cwd: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(cwd);
  for (let level = 0; level < MAX_LEVELS; level += 1) {
    dirs.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

/** 설정 파일 하나를 본다. 없으면 통과, 읽지 못하거나 JSON이 아니거나 `hooks`·`hooksConfig`가 있으면 거절 */
async function settingsFileRefusal(file: string, label: string): Promise<Refusal> {
  let text: string;
  try {
    const info = await stat(file);
    if (info.isFile() && info.size > MAX_CONFIG_BYTES) return `Gemini ${label} ${file}이(가) 너무 커서(${info.size}바이트) 읽지 않았습니다. 훅을 바꾸는지 알 수 없어 터미널을 열지 않았습니다`;
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    return `Gemini ${label} ${file}을(를) 읽지 못해 터미널을 열지 않았습니다(${(error as Error).message}). 훅을 바꾸는지 알 수 없습니다`;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch {
    return `Gemini ${label} ${file}을(를) JSON으로 읽지 못해 터미널을 열지 않았습니다. 훅을 바꾸는지 알 수 없습니다. 고치거나 지운 뒤 다시 여세요`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return `Gemini ${label} ${file}이(가) JSON 객체가 아니라 읽지 못해 터미널을 열지 않았습니다`;
  const record = parsed as Record<string, unknown>;
  // 비어 있는 훅 객체만 받는다. 모르는 모양은 거절이다
  if (record.hooks !== undefined && !(typeof record.hooks === 'object' && record.hooks !== null && !Array.isArray(record.hooks) && Object.keys(record.hooks).length === 0)) {
    return `Gemini ${label} ${file}에 hooks가 있습니다. 다른 훅이 우리 훅과 나란히 돌며 도구 입력을 바꿀 수 있습니다. ${HINT}`;
  }
  if (record.hooksConfig !== undefined) return `Gemini ${label} ${file}에 hooksConfig가 있습니다. 훅을 끄거나 우리 훅을 이름으로 끌 수 있습니다. ${HINT}`;
  return undefined;
}

/** `.env`가 믿음·설정 자리를 바꾸는 변수를 정하는가. 읽지 못하면 거절 */
async function envFileRefusal(file: string): Promise<Refusal> {
  let text: string;
  try {
    const info = await stat(file);
    if (info.isFile() && info.size > MAX_CONFIG_BYTES) return `${file}이(가) 너무 커서 읽지 않았습니다. Gemini의 믿음 설정을 바꾸는지 알 수 없어 터미널을 열지 않았습니다`;
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return undefined;
    return `${file}을(를) 읽지 못해 터미널을 열지 않았습니다(${(error as Error).message}). Gemini의 믿음 설정을 바꾸는지 알 수 없습니다`;
  }
  const hit = ENV_RISK.exec(text);
  if (hit) return `${file}이(가) ${hit[1]}을(를) 정합니다. 훅이 불러와지지 않게 할 수 있어 터미널을 열지 않았습니다. 그 줄을 지운 뒤 다시 여세요`;
  return undefined;
}

/**
 * 터미널을 열기 전에 Gemini가 읽을 설정이 b-studio의 훅을 끄거나 다른 훅을 더하지 않는지 본다. 거절하는 글을 돌려주고, 열어도 되면 undefined다.
 * 보는 자리: 작업 폴더의 `.gemini/settings.json`(`hooks`·`hooksConfig`), 시스템 설정과 시스템 기본값(관리자 자리), 작업 폴더와 그 위 폴더의 `.env`·`.gemini/.env`.
 * 사용자의 `~/.gemini`는 보지 않는다: 감싸개가 홈을 바꿔 그 설정과 확장을 읽지 않게 한다.
 */
export async function geminiConfigRefusal(check: GeminiLoadCheck): Promise<Refusal> {
  const workspace = await settingsFileRefusal(path.join(check.cwd, '.gemini', 'settings.json'), '작업 폴더 설정');
  if (workspace) return workspace;
  const systemDir = check.systemSettingsDir ?? systemSettingsDir();
  for (const name of ['settings.json', 'system-defaults.json']) {
    const refusal = await settingsFileRefusal(path.join(systemDir, name), '시스템 설정');
    if (refusal) return refusal;
  }
  for (const dir of ancestors(check.cwd)) {
    for (const file of [path.join(dir, '.gemini', '.env'), path.join(dir, '.env')]) {
      const refusal = await envFileRefusal(file);
      if (refusal) return refusal;
    }
  }
  return undefined;
}

/** `1.2.3` 꼴(앞의 v와 뒤의 `-…`는 뗀다)을 수 셋으로. 읽지 못하면 undefined */
export function parseGeminiVersion(text: string): [number, number, number] | undefined {
  const hit = /(?:^|[^0-9.])v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?![0-9.])/u.exec(text.trim());
  if (!hit) return undefined;
  return [Number(hit[1]), Number(hit[2]), Number(hit[3])];
}

function atLeast(version: [number, number, number], min: string): boolean {
  const wanted = parseGeminiVersion(min)!;
  for (let i = 0; i < 3; i += 1) {
    if (version[i]! !== wanted[i]!) return version[i]! > wanted[i]!;
  }
  return true;
}

/**
 * 띄우려는 gemini가 훅을 지원하는 판인가. `<gemini> --version`의 출력을 읽는다. 거절하는 글을 돌려주고, 열어도 되면 undefined다.
 * 판을 읽지 못하면(실행 실패·시간 초과·모르는 출력) 열지 않는다. 훅이 없는 옛 판(0.1.22)은 훅을 붙이지 못해 검증 없이 돈다
 */
export async function geminiVersionRefusal(cliPath: string, run: (file: string, args: string[]) => Promise<{ stdout: string }>): Promise<Refusal> {
  let version: [number, number, number] | undefined;
  try {
    version = parseGeminiVersion((await run(cliPath, ['--version'])).stdout);
  } catch (error) {
    return `gemini의 판을 확인하지 못해 터미널을 열지 않았습니다(${error instanceof Error ? error.message : String(error)}). 훅이 있는 판(${GEMINI_MIN_VERSION} 이상)이 필요합니다`;
  }
  if (!version) return `gemini의 판을 읽지 못해 터미널을 열지 않았습니다. 훅이 있는 판(${GEMINI_MIN_VERSION} 이상)이 필요합니다. 다른 판이 있으면 B_STUDIO_GEMINI_BIN에 절대 경로를 적습니다`;
  if (!atLeast(version, GEMINI_MIN_VERSION)) {
    return `gemini ${version.join('.')}은(는) 설정 훅이 없거나 읽어 보지 않은 판이라 터미널을 열지 않았습니다. ${GEMINI_MIN_VERSION} 이상이 필요합니다. 다른 판이 있으면 B_STUDIO_GEMINI_BIN에 절대 경로를 적습니다`;
  }
  return undefined;
}

/** 이름 비교용: 대소문자·전각·호환 글자를 접고 보이지 않는 글자와 끝의 점·빈칸을 뗀다. 접는 쪽이 넓게 맞아 거부 목록에는 더 막을 뿐이다 */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;
function fold(name: string): string {
  return name.normalize('NFKC').replace(INVISIBLE, '').toLowerCase().replace(/[. ]+$/u, '');
}
const CONFIG_DIR = '.gemini';

export interface GeminiConfigWrite {
  /** Gemini가 뜬 작업 폴더 */
  cwd: string;
  home: string | undefined;
  /** 도구 입력의 경로(상대·절대·`~/`) */
  file: string;
}

/**
 * 그 경로의 쓰기가 Gemini의 설정 자리를 건드리는가. 거부 목록이라 넓게 맞춘다:
 * ① 경로 어디에든 이름이 `.gemini`인 칸이 있음(대소문자·전각·보이지 않는 글자·끝의 점과 빈칸을 접어서, `..`를 풀기 전의 글과 푼 글 둘 다),
 * ② 링크를 푼 실제 경로의 칸에도 같은 이름이 있음, ③ 이미 있는 조상이 보호 폴더(작업 폴더와 그 위, 홈의 `.gemini`)와 같은 폴더(inode)임(이름이 달라도 같은 폴더를 가리키는 링크·대소문자 무시 볼륨).
 * 작업 폴더의 `.env`는 막지 않는다(저장소의 평범한 파일일 수 있다): 믿음 변수를 정하는 경우는 터미널을 열 때의 검사와 세션 시작 신호가 잡는다
 */
export async function geminiConfigPathBlocked(write: GeminiConfigWrite): Promise<boolean> {
  const home = write.home ?? '';
  const raw = write.file.trim();
  const candidates = [raw];
  if (raw === '~' || raw.startsWith('~/')) candidates.push(`${home}${raw.slice(1)}`);
  const protectedDirs = [path.join(home, CONFIG_DIR), ...ancestors(write.cwd).map((dir) => path.join(dir, CONFIG_DIR))];
  const protectedIds = new Set<string>();
  for (const dir of protectedDirs) {
    try {
      const info = await stat(dir);
      protectedIds.add(`${info.dev}:${info.ino}`);
    } catch {
      // 아직 없는 폴더는 이름으로만 본다
    }
  }
  const nameHit = (segments: string[]): boolean => segments.some((segment) => fold(segment) === CONFIG_DIR);
  for (const candidate of candidates) {
    if (nameHit(candidate.split(/[\\/]/u).filter((segment) => segment !== ''))) return true;
    const absolute = path.resolve(write.cwd, candidate);
    if (nameHit(absolute.split(path.sep).filter((segment) => segment !== ''))) return true;
    let existing = absolute;
    const rest: string[] = [];
    let real: string | undefined;
    for (;;) {
      try {
        real = await realpath(existing);
        break;
      } catch {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        rest.unshift(path.basename(existing));
        existing = parent;
      }
    }
    if (real === undefined) continue;
    if (nameHit(path.join(real, ...rest).split(path.sep).filter((segment) => segment !== ''))) return true;
    if (protectedIds.size > 0) {
      for (let ancestor = real; ; ancestor = path.dirname(ancestor)) {
        try {
          const info = await stat(ancestor);
          if (protectedIds.has(`${info.dev}:${info.ino}`)) return true;
        } catch {
          // 읽지 못한 조상은 건너뛴다(위의 이름 검사가 이미 보았다)
        }
        if (path.dirname(ancestor) === ancestor) break;
      }
    }
  }
  return false;
}
