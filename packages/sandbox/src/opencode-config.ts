import { access, lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { envCodeLoadKey, envRiskKeyIn } from './env-risk';
import { OPENCODE_PLUGIN_NAME } from './opencode-plugin';

/**
 * OpenCode의 설정이 b-studio의 플러그인 말고 다른 플러그인을 붙이는 길을 닫는다(ADR-241).
 * 근거는 설치된 opencode 1.18.33의 바이너리에 든 소스다(실제로 띄워 보지는 않았다):
 * - 설정은 `~/.config/opencode/{config.json,opencode.json,opencode.jsonc}` → `OPENCODE_CONFIG`(우리 파일) → 작업 폴더에서 위로 찾은 `opencode.json(c)`(`OPENCODE_DISABLE_PROJECT_CONFIG`가 없을 때)
 *   → 작업 폴더에서 위로 찾은 `.opencode` 폴더와 `OPENCODE_CONFIG_DIR`의 `opencode.json(c)`와 `plugin/`·`plugins/`(자동으로 불러오는 `*.ts`·`*.js`) → `OPENCODE_CONFIG_CONTENT` → 관리형 설정 폴더 순으로 읽어 `plugin` 목록을 **이어 붙인다**(`deduplicatePluginOrigins`).
 *   뒤에 붙은 플러그인은 우리 훅 뒤에 도구 입력(`output.args`)을 바꿔 쓸 수 있다. TUI 설정(`tui.json(c)`)도 `plugin`을 가진다.
 * - OpenCode는 `$schema`가 없는 설정 파일을 **다시 쓴다**(`F`가 `$schema`를 더해 같은 파일에 쓴다). 우리 설정 파일에 `$schema`가 이미 있어야 관문 파일 감시가 OpenCode 때문에 변조로 잡히지 않는다.
 *
 * 부르는 자리마다 막는 쪽인지 여는 쪽인지:
 * - `openCodeConfigRefusal`: 터미널을 여는 것을 허락하는 판정이라 열린 쪽은 "모두 읽었고 플러그인이 없다"뿐이다. 읽지 못한 것·모르는 모양은 거절이다
 * - `openCodeConfigPathBlocked`: 거부 목록이다. 넓게 맞추면 더 막을 뿐이다(`.opencode`라는 이름의 폴더는 깊이와 상관없이 막는다)
 * 마지막 방어선은 플러그인 자신이다: 설정 훅이 합쳐진 설정을 보고 다른 플러그인이 하나라도 있으면 세션 시작 신호를 보내지 않고 모든 도구를 막는다(원격 설정·조직 설정처럼 파일로 보이지 않는 출처도 거기서 잡힌다).
 */

export const OPENCODE_CONFIG_SCHEMA = 'https://opencode.ai/config.json';
/** 우리 설정 파일의 글: `$schema`와 플러그인 하나(file URL). OpenCode가 이 파일을 다시 쓰지 않게 `$schema`를 둔다 */
export function openCodeConfigContent(dir: string): string {
  return `${JSON.stringify({ $schema: OPENCODE_CONFIG_SCHEMA, plugin: [pathToFileURL(path.join(dir, OPENCODE_PLUGIN_NAME)).href] }, null, 2)}\n`;
}

const CONFIG_DIR = '.opencode';
/** 설정 폴더 안에서 OpenCode가 읽는 파일 이름 */
const CONFIG_FILES = ['config.json', 'opencode.json', 'opencode.jsonc', 'tui.json', 'tui.jsonc'] as const;
/** 프로젝트 폴더(작업 폴더와 그 위)에서 OpenCode가 읽는 파일 이름 */
const PROJECT_FILES = ['opencode.json', 'opencode.jsonc', 'tui.json', 'tui.jsonc'] as const;
const PLUGIN_DIRS = ['plugin', 'plugins'] as const;
/** 작업 폴더에서 위로 올라가며 보는 최대 칸 수(파일 시스템 루트까지, 이만큼에서 끊는다) */
const MAX_LEVELS = 64;
/** 설정 파일 하나의 크기 상한. 넘으면 읽지 않고 거절한다 */
const MAX_CONFIG_BYTES = 1024 * 1024;
/** 관리형 설정 폴더(운영체제가 관리자에게 주는 자리). 읽기만 한다 */
const MANAGED_DIRS = ['/Library/Application Support/opencode', '/etc/opencode'] as const;

export interface OpenCodeLoadCheck {
  /** OpenCode가 뜰 작업 폴더 */
  cwd: string;
  /** CLI가 볼 HOME(터미널 환경의 HOME). 없으면 빈 값으로 읽는다 */
  home: string | undefined;
  /** 터미널 환경의 XDG_CONFIG_HOME. 없으면 `<HOME>/.config`다 */
  xdgConfigHome?: string | undefined;
  /** 시험이 관리형 설정 폴더를 바꾼다. 기본은 운영체제의 자리 */
  managedDirs?: readonly string[];
}

type Refusal = string | undefined;
const HINT = 'b-studio의 터미널은 b-studio의 플러그인 하나만 불러와야 합니다. 그 설정을 지운 뒤 다시 여세요';

/** 파일에 쓰인 JSONC(주석·끝의 쉼표)를 JSON으로 읽는다. 글자열 안의 `//`·`/*`는 그대로 둔다. 읽지 못하면 던진다 */
export function parseJsonc(text: string): unknown {
  let out = '';
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) throw new Error('닫히지 않은 주석');
      index = end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  // 끝의 쉼표(`,}`·`,]`). 글자열 밖에서만 센다
  let cleaned = '';
  let at = 0;
  while (at < out.length) {
    const char = out[at]!;
    if (char === '"') {
      let end = at + 1;
      while (end < out.length && out[end] !== '"') end += out[end] === '\\' ? 2 : 1;
      cleaned += out.slice(at, end + 1);
      at = end + 1;
    } else if (char === ',') {
      let next = at + 1;
      while (next < out.length && /\s/u.test(out[next]!)) next += 1;
      if (out[next] !== '}' && out[next] !== ']') cleaned += char;
      at += 1;
    } else {
      cleaned += char;
      at += 1;
    }
  }
  return JSON.parse(cleaned);
}

/** 위로 올라가는 폴더들: 작업 폴더부터 루트까지(최대 MAX_LEVELS칸) */
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

/** OpenCode의 전역 설정 폴더(`Path.config`): `$XDG_CONFIG_HOME/opencode`, 없으면 `<HOME>/.config/opencode` */
export function openCodeGlobalConfigDir(home: string | undefined, xdgConfigHome?: string): string {
  const base = xdgConfigHome && path.isAbsolute(xdgConfigHome) ? xdgConfigHome : path.join(home ?? '', '.config');
  return path.join(base, 'opencode');
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** 설정 파일 하나를 본다. 없으면 통과, 읽지 못하거나 JSON(주석 허용)이 아니거나 `{file:`을 쓰거나 `plugin`이 비어 있지 않으면 거절 */
async function configFileRefusal(file: string): Promise<Refusal> {
  let text: string;
  try {
    // 읽기 전에 크기를 본다: 에이전트가 쓸 수 있는 자리의 파일이라 상한이 없으면 크게 만들어 읽는 쪽을 멈출 수 있다
    const info = await stat(file);
    if (info.isFile() && info.size > MAX_CONFIG_BYTES) return `OpenCode 설정 파일 ${file}이(가) 너무 커서(${info.size}바이트) 읽지 않았습니다. 다른 플러그인을 붙이는지 알 수 없어 터미널을 열지 않았습니다`;
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    return `OpenCode 설정 파일 ${file}을(를) 읽지 못해 터미널을 열지 않았습니다(${(error as Error).message}). 설정이 다른 플러그인을 붙이는지 알 수 없습니다`;
  }
  // `{file:경로}`는 설정 글에 다른 파일의 내용을 끼워 넣는다. 끼운 글이 `plugin`을 만들 수 있어 읽을 수 없다
  if (text.includes('{file:')) return `OpenCode 설정 파일 ${file}이(가) {file:…}로 다른 파일을 끼워 넣습니다. 끼운 내용이 플러그인을 붙이는지 알 수 없어 터미널을 열지 않았습니다. 그 설정을 지운 뒤 다시 여세요`;
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch {
    return `OpenCode 설정 파일 ${file}을(를) JSON으로 읽지 못해 터미널을 열지 않았습니다. 설정이 다른 플러그인을 붙이는지 알 수 없습니다. 고치거나 지운 뒤 다시 여세요`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const plugin = (parsed as Record<string, unknown>).plugin;
  if (plugin === undefined) return undefined;
  if (!Array.isArray(plugin)) return `OpenCode 설정 파일 ${file}의 plugin이 목록이 아니라 읽지 못해 터미널을 열지 않았습니다. ${HINT}`;
  if (plugin.length > 0) return `OpenCode 설정 파일 ${file}의 plugin이 다른 플러그인을 불러옵니다. ${HINT}`;
  return undefined;
}

/** 폴더 하나의 `plugin`·`plugins` 폴더: 점으로 시작하지 않는 항목이 하나라도 있으면 거절(자동으로 불러오는 `*.ts`·`*.js`) */
async function pluginDirRefusal(dir: string): Promise<Refusal> {
  for (const name of PLUGIN_DIRS) {
    const folder = path.join(dir, name);
    let info;
    try {
      info = await stat(folder);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      return `OpenCode의 플러그인 폴더 ${folder}을(를) 읽지 못해 터미널을 열지 않았습니다(${(error as Error).message}). 다른 플러그인이 있는지 알 수 없습니다`;
    }
    if (!info.isDirectory()) continue;
    let entries: string[];
    try {
      entries = await readdir(folder);
    } catch (error) {
      return `OpenCode의 플러그인 폴더 ${folder}을(를) 읽지 못해 터미널을 열지 않았습니다(${(error as Error).message}). 다른 플러그인이 있는지 알 수 없습니다`;
    }
    const found = entries.find((entry) => !entry.startsWith('.') && entry !== 'node_modules');
    if (found !== undefined) return `OpenCode의 플러그인 폴더 ${folder}에 플러그인(${found})이 있습니다. ${HINT}`;
  }
  return undefined;
}

/** Bun이 시작할 때 읽는 파일의 크기 상한. 넘으면 읽지 않고 거절한다(에이전트가 쓸 수 있는 자리라 상한이 없으면 읽는 쪽을 멈출 수 있다) */
export const MAX_STARTUP_FILE_BYTES = 1024 * 1024;
/** Bun의 `.env` 계열(`.env`·`.env.local`·`.env.<NODE_ENV>`·`.env.<NODE_ENV>.local`). 읽는 쪽은 이름을 넓게 맞춘다(`NODE_ENV`가 무엇이든 `.env.<이름>`을 읽는다) */
const BUN_ENV_FILE = /^\.env(\..*)?$/u;
/** 쓰기를 막는 `.env` 이름(명시한 목록). 거부 목록이라 하위 폴더와 `.env.example` 같은 이름은 막지 않는다 */
const BUN_ENV_WRITE_NAMES: ReadonlySet<string> = new Set(['.env', '.env.local', '.env.development', '.env.production', '.env.test', '.env.development.local', '.env.production.local', '.env.test.local']);
const BUNFIG_NAMES: ReadonlySet<string> = new Set(['bunfig.toml', '.bunfig.toml']);

/** `.env`가 OpenCode의 설정·플러그인·권한·홈을 바꾸거나 코드를 적재·실행하게 하는 열쇠를 정하는가(`OPENCODE_`·`BUN_` 열쇠는 모두, 코드 적재 변수는 Gemini와 같은 공통 목록) */
function startupEnvKeyRisky(key: string): boolean {
  const upper = key.toUpperCase();
  return upper.startsWith('OPENCODE_') || upper.startsWith('BUN_') || envCodeLoadKey(key);
}

/**
 * OpenCode는 Bun으로 컴파일된 실행 파일이다(바이너리에 `Bun v1.3.14`). 그 판의 `bun build --compile`은 작업 폴더의 `.env` 계열과 `bunfig.toml`을 실행 파일에서 기본으로 읽는다
 * (바이너리의 도움말 `--compile-autoload-dotenv`·`--compile-autoload-bunfig`가 둘 다 `default: true`). opencode가 껐는지는 실행 없이 알 수 없어 읽는 것으로 본다.
 * `.env`의 값은 감싸개가 환경을 지운 뒤에 환경에 들어가고 감시도 못 보며, `bunfig.toml`의 `preload`는 코드를 실행한다. 작업 폴더만 본다(Bun은 위 폴더를 찾지 않는다).
 * 열린 쪽은 "해당 파일이 없거나 모두 읽었고 위험한 열쇠가 없다"뿐이다: 링크·폴더·읽지 못함·너무 큼은 거절이다
 */
async function startupFilesRefusal(cwd: string): Promise<Refusal> {
  let names: string[];
  try {
    names = await readdir(cwd);
  } catch (error) {
    return `작업 폴더 ${cwd}을(를) 읽지 못해 터미널을 열지 않았습니다(${(error as Error).message}). OpenCode가 시작할 때 읽는 .env·bunfig.toml을 확인할 수 없습니다`;
  }
  for (const name of names) {
    const folded = fold(name);
    const isEnv = BUN_ENV_FILE.test(folded);
    const isBunfig = BUNFIG_NAMES.has(folded);
    if (!isEnv && !isBunfig) continue;
    const file = path.join(cwd, name);
    if (isBunfig) return `${file}이(가) 있습니다. OpenCode는 시작할 때 작업 폴더의 bunfig.toml을 읽고 그 preload가 코드를 실행해 b-studio의 플러그인이 붙었는지 알 수 없어 터미널을 열지 않았습니다. 그 파일을 지우거나 옮긴 뒤 다시 여세요`;
    let text: string;
    try {
      const link = await lstat(file);
      if (!link.isFile()) return `${file}이(가) 일반 파일이 아니라(링크이거나 폴더) 읽지 않았습니다. OpenCode가 시작할 때 읽는 .env일 수 있어 터미널을 열지 않았습니다`;
      if (link.size > MAX_STARTUP_FILE_BYTES) return `${file}이(가) 너무 커서(${link.size}바이트) 읽지 않았습니다. OpenCode의 설정을 바꾸는지 알 수 없어 터미널을 열지 않았습니다`;
      text = await readFile(file, 'utf8');
    } catch (error) {
      return `${file}을(를) 읽지 못해 터미널을 열지 않았습니다(${(error as Error).message}). OpenCode의 설정을 바꾸는지 알 수 없습니다`;
    }
    const risky = envRiskKeyIn(text, startupEnvKeyRisky);
    if (risky) return `${file}이(가) ${risky}을(를) 정합니다. OpenCode는 시작할 때 작업 폴더의 .env를 환경에 넣어 설정·플러그인·권한을 바꾸거나 코드를 실행할 수 있어 터미널을 열지 않았습니다. 그 줄을 지운 뒤 다시 여세요`;
  }
  return undefined;
}

/**
 * 터미널을 열기 전에 OpenCode가 읽을 설정이 b-studio의 플러그인 말고 다른 플러그인을 붙이지 않는지 본다. 거절하는 글을 돌려주고, 열어도 되면 undefined다.
 * 보는 자리: 전역 설정 폴더, `<HOME>/.opencode`, 작업 폴더와 그 위 모든 폴더의 `opencode.json(c)`·`tui.json(c)`와 `.opencode` 폴더, 관리형 설정 폴더.
 * (OpenCode는 `.git`이 있는 작업 트리 루트에서 위로 찾기를 멈추지만 우리는 파일 시스템 루트까지 본다: 넓게 보면 더 거절할 뿐이다)
 */
export async function openCodeConfigRefusal(check: OpenCodeLoadCheck): Promise<Refusal> {
  const startup = await startupFilesRefusal(check.cwd);
  if (startup) return startup;
  const home = check.home ?? '';
  const globalDir = openCodeGlobalConfigDir(home, check.xdgConfigHome);
  const levels = ancestors(check.cwd);
  const configDirs = [globalDir, path.join(home, CONFIG_DIR), ...levels.map((dir) => path.join(dir, CONFIG_DIR)), ...(check.managedDirs ?? MANAGED_DIRS)];
  const seen = new Set<string>();
  for (const dir of configDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    for (const name of CONFIG_FILES) {
      const refusal = await configFileRefusal(path.join(dir, name));
      if (refusal) return refusal;
    }
    const plugins = await pluginDirRefusal(dir);
    if (plugins) return plugins;
  }
  // 옛 전역 설정 `config`(확장자 없는 TOML)는 읽어서 `config.json`으로 옮겨 쓴다. 읽을 수 없는 모양이라 있으면 거절한다
  if (await exists(path.join(globalDir, 'config'))) return `OpenCode의 옛 전역 설정 ${path.join(globalDir, 'config')}이(가) 있습니다. 읽을 수 없는 모양이라 다른 플러그인을 붙이는지 알 수 없어 터미널을 열지 않았습니다. 지우거나 옮긴 뒤 다시 여세요`;
  for (const dir of levels) {
    for (const name of PROJECT_FILES) {
      const refusal = await configFileRefusal(path.join(dir, name));
      if (refusal) return refusal;
    }
  }
  return undefined;
}

/** 이름 비교용: 대소문자·전각·호환 글자를 접고 보이지 않는 글자와 끝의 점·빈칸을 뗀다. 접는 쪽이 넓게 맞아 거부 목록에는 더 막을 뿐이다 */
export const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;
function fold(name: string): string {
  return name.normalize('NFKC').replace(INVISIBLE, '').toLowerCase().replace(/[. ]+$/u, '');
}
const PROTECTED_FILE_NAMES: ReadonlySet<string> = new Set(['opencode.json', 'opencode.jsonc', 'tui.json', 'tui.jsonc']);

export interface OpenCodeConfigWrite {
  /** OpenCode가 뜬 작업 폴더 */
  cwd: string;
  home: string | undefined;
  xdgConfigHome?: string | undefined;
  /** 도구 입력의 경로(상대·절대·`~/`) */
  file: string;
}

/** 작업 폴더 바로 아래의 `.env` 계열·`bunfig.toml`을 쓰는 것인가(다음에 CLI를 다시 띄우면 Bun이 읽는다). 폴더는 이름과 inode 둘 다로 견준다(링크·대소문자 무시 볼륨) */
async function startupFileWrite(cwd: string, target: string): Promise<boolean> {
  const name = fold(path.basename(target));
  if (!BUN_ENV_WRITE_NAMES.has(name) && !BUNFIG_NAMES.has(name)) return false;
  const parent = path.dirname(target);
  if (fold(path.resolve(parent)) === fold(path.resolve(cwd))) return true;
  try {
    const [a, b] = await Promise.all([stat(parent), stat(cwd)]);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/**
 * 그 경로의 쓰기가 OpenCode의 설정·플러그인 자리를 건드리는가. 거부 목록이라 넓게 맞춘다:
 * ① 경로 어디에든 이름이 `.opencode`인 칸이 있음(대소문자·전각·보이지 않는 글자·끝의 점과 빈칸을 접어서, `..`를 풀기 전의 글과 푼 글 둘 다)
 * ② 파일 이름이 설정 파일(`opencode.json(c)`·`tui.json(c)`) — 어느 폴더에 있든, 그리고 전역 설정 폴더 안의 모든 것(그 안의 `config.json` 포함)
 * ③ 링크를 푼 실제 경로의 칸에도 같은 이름이 있거나 전역 설정 폴더 아래임, ④ 이미 있는 조상이 보호 폴더(전역 설정 폴더·`<HOME>/.opencode`·작업 폴더와 그 위의 `.opencode`)와 같은 폴더(inode)임(이름이 달라도 같은 폴더를 가리키는 링크·대소문자 무시 볼륨).
 * OpenCode의 `edit`·`write`는 `~`를 펴지 않지만 부르는 쪽의 규칙이 바뀔 수 있어 `~/`도 홈으로 펴서 같이 본다(넓게)
 */
export async function openCodeConfigPathBlocked(write: OpenCodeConfigWrite): Promise<boolean> {
  const home = write.home ?? '';
  const globalDir = openCodeGlobalConfigDir(home, write.xdgConfigHome);
  const raw = write.file.trim();
  const candidates = [raw];
  if (raw === '~' || raw.startsWith('~/')) candidates.push(`${home}${raw.slice(1)}`);
  const protectedDirs = [globalDir, path.join(home, CONFIG_DIR), ...ancestors(write.cwd).map((dir) => path.join(dir, CONFIG_DIR))];
  const protectedIds = new Set<string>();
  for (const dir of protectedDirs) {
    try {
      const info = await stat(dir);
      protectedIds.add(`${info.dev}:${info.ino}`);
    } catch {
      // 아직 없는 폴더는 이름으로만 본다
    }
  }
  const underGlobal = (absolute: string): boolean => {
    const relative = path.relative(globalDir, absolute);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  const nameHit = (segments: string[]): boolean => segments.some((segment) => fold(segment) === CONFIG_DIR) || (segments.length > 0 && PROTECTED_FILE_NAMES.has(fold(segments[segments.length - 1]!)));
  for (const candidate of candidates) {
    const loose = candidate.split(/[\\/]/u).filter((segment) => segment !== '');
    if (nameHit(loose)) return true;
    const absolute = path.resolve(write.cwd, candidate);
    if (nameHit(absolute.split(path.sep).filter((segment) => segment !== ''))) return true;
    if (underGlobal(absolute)) return true;
    if (await startupFileWrite(write.cwd, absolute)) return true;
    // 이미 있는 가장 가까운 조상을 링크까지 풀고, 남은 칸을 붙인다
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
    const resolved = path.join(real, ...rest);
    if (nameHit(resolved.split(path.sep).filter((segment) => segment !== ''))) return true;
    if (underGlobal(resolved)) return true;
    if (await startupFileWrite(write.cwd, resolved)) return true;
    // 전역 설정 폴더 자체가 링크일 수 있다: 풀린 전역 폴더 아래인가
    const realGlobal = await realpath(globalDir).catch(() => undefined);
    if (realGlobal !== undefined) {
      const relative = path.relative(realGlobal, resolved);
      if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return true;
    }
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
