import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { COMMAND_CODE_MOD_NAME } from './commandcode-mod';

/**
 * Command Code의 설정이 b-studio의 mod를 끄거나 다른 mod를 붙이는 길을 닫는다(ADR-233).
 * 근거는 설치된 cli.mjs(v1.93.4)의 함수들이다: `loadMods`(`if(e.builtinsOnly||o.disableAll)return;` — `--mod`로 준 mod도 건너뛴다, 이름이 `disabled`에 있으면 그것만 건너뛴다),
 * `discoverMods`(`--mod` 경로 → 프로젝트 `.commandcode/mods` → 사용자 `~/.commandcode/mods` → 설정의 `mods.paths` → `mods.sources` 순으로 모은다, 이름이 같으면 먼저 온 것이 이긴다),
 * `resolveModSettings`(사용자 `~/.commandcode/settings.json`, 프로젝트 `<루트>/.commandcode/settings.json`, `settings.local.json`의 `mods` 키), `resolveProjectRoot`(작업 폴더에서 위로 최대 10칸, `.git`이 있는 폴더, 없으면 `.commandcode`가 있는 폴더),
 * `scanModsDir`(점으로 시작하는 이름과 node_modules를 뺀 모든 항목), `modNameFromPath`(확장자를 떼고, `index`는 폴더 이름).
 *
 * 부르는 자리마다 막는 쪽인지 여는 쪽인지:
 * - `commandCodeModLoadRefusal`: 터미널을 여는 것을 허락하는 판정이라 열린 쪽은 "모두 읽었고 아무 문제가 없다"뿐이다. 읽지 못한 것·모르는 모양은 거절이다
 * - `commandCodeConfigPathBlocked`: 거부 목록이다. 넓게 맞추면 더 막을 뿐이다(`.commandcode`라는 이름의 폴더는 깊이와 상관없이 막는다)
 */

/** cli.mjs의 `FR`: mod 파일로 읽는 확장자 */
const MOD_EXTENSION = /\.(ts|js|mts|mjs)$/;
const MOD_EXTENSION_ANY_CASE = /\.(ts|js|mts|mjs)$/i;
/** 설정이 보이는 항목 최대 올라가는 칸 수(cli.mjs의 `ai`) */
const PROJECT_ROOT_LEVELS = 10;
const CONFIG_DIR = '.commandcode';

/** cli.mjs의 `modNameFromPath`와 같은 규칙으로 mod 이름을 정한다 */
export function commandCodeModName(file: string): string {
  const base = path.basename(file).replace(MOD_EXTENSION, '');
  return base === 'index' ? path.basename(path.dirname(file)) : base;
}

/** 우리 mod의 이름(`b-studio-mod`) */
const OUR_MOD_NAME = commandCodeModName(COMMAND_CODE_MOD_NAME);

/** 이름 비교용: 대소문자·전각·호환 글자를 접고 보이지 않는 글자와 끝의 점·빈칸을 뗀다. 접는 쪽이 넓게 맞아 거부 목록에는 더 막을 뿐이다 */
const INVISIBLE = /[­​-‏‪-‮⁠-⁤﻿]/g;
function fold(name: string): string {
  return name.normalize('NFKC').replace(INVISIBLE, '').toLowerCase().replace(/[. ]+$/u, '');
}

/** 이 이름이 `.commandcode` 폴더 이름인가(접어서). 접은 뒤 끝의 점을 떼므로 `.commandcode.`도 맞는다 */
function isConfigDirName(segment: string): boolean {
  return fold(segment) === CONFIG_DIR;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** cli.mjs의 `walkUpToFindDir`: 작업 폴더에서 위로 올라가며(HOME에 닿으면 멈춘다, 최대 10칸) 그 이름이 든 폴더를 찾는다 */
async function walkUpToFind(cwd: string, home: string, dirName: string): Promise<string | undefined> {
  let current = cwd;
  for (let level = 0; level < PROJECT_ROOT_LEVELS && current !== home; level += 1) {
    if (await exists(path.join(current, dirName))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/** cli.mjs의 `resolveProjectRoot`: `.git`이 있는 폴더, 없으면 `.commandcode`가 있는 폴더 */
async function projectRoot(cwd: string, home: string): Promise<string | undefined> {
  return (await walkUpToFind(cwd, home, '.git')) ?? (await walkUpToFind(cwd, home, CONFIG_DIR));
}

/** Command Code가 보는 HOME(cli.mjs의 `homeDir2`: `HOME ?? USERPROFILE ?? ""`) */
function homeOf(home: string | undefined): string {
  return home ?? '';
}

/** 설정이나 mod를 읽는 폴더들: 작업 폴더와 프로젝트 루트(둘이 같으면 하나). 프로젝트 루트를 못 찾아도 작업 폴더는 본다 */
async function projectDirs(cwd: string, home: string): Promise<string[]> {
  const root = await projectRoot(cwd, home);
  return root === undefined || root === cwd ? [cwd] : [cwd, root];
}

export interface CommandCodeModLoadCheck {
  /** Command Code가 뜰 작업 폴더 */
  cwd: string;
  /** CLI가 볼 HOME(터미널 환경의 HOME). 없으면 빈 값으로 읽는다(cli.mjs와 같다) */
  home: string | undefined;
}

type Refusal = string | undefined;

/**
 * 터미널을 열기 전에 설정이 b-studio의 mod를 끄거나 다른 mod를 붙이지 않는지 본다. 거절하는 글을 돌려주고, 열어도 되면 undefined다.
 * 거절: 설정 파일이 있는데 읽지 못함(JSON 아님 포함), `mods.disableAll`이 참, `mods.disabled`에 우리 mod 이름(대소문자·확장자 무시),
 * 다른 mod를 불러올 출처(`mods.paths`·`mods.sources`가 하나라도 있음, 프로젝트·사용자 mods 폴더에 항목이 있음)
 */
export async function commandCodeModLoadRefusal(check: CommandCodeModLoadCheck): Promise<Refusal> {
  const home = homeOf(check.home);
  const userDir = `${home}/${CONFIG_DIR}`;
  const dirs = await projectDirs(check.cwd, home);
  const settingsFiles = [`${userDir}/settings.json`, ...dirs.flatMap((dir) => [path.join(dir, CONFIG_DIR, 'settings.json'), path.join(dir, CONFIG_DIR, 'settings.local.json')])];
  for (const file of settingsFiles) {
    const refusal = await settingsRefusal(file);
    if (refusal) return refusal;
  }
  for (const dir of [`${userDir}/mods`, ...dirs.map((dir) => path.join(dir, CONFIG_DIR, 'mods'))]) {
    const refusal = await modsDirRefusal(dir);
    if (refusal) return refusal;
  }
  return undefined;
}

const OTHER_SOURCES_HINT = 'b-studio의 터미널은 b-studio의 mod 하나만 불러와야 합니다. 그 설정을 지운 뒤 다시 여세요';

async function settingsRefusal(file: string): Promise<Refusal> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return `Command Code 설정 파일 ${file}을(를) 읽지 못해 터미널을 열지 않았습니다(${(error as Error).message}). 설정이 b-studio의 mod를 끄는지 알 수 없습니다`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `Command Code 설정 파일 ${file}을(를) JSON으로 읽지 못해 터미널을 열지 않았습니다. 설정이 b-studio의 mod를 끄는지 알 수 없습니다. 고치거나 지운 뒤 다시 여세요`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const mods = (parsed as Record<string, unknown>).mods;
  if (typeof mods !== 'object' || mods === null || Array.isArray(mods)) return undefined;
  const record = mods as Record<string, unknown>;
  if (record.disableAll === true) return `Command Code 설정 ${file}의 mods.disableAll이 켜져 있어 b-studio의 mod가 불러와지지 않습니다. 이 값을 지운 뒤 다시 여세요`;
  if (Array.isArray(record.disabled)) {
    const ours = fold(OUR_MOD_NAME);
    for (const entry of record.disabled) {
      if (typeof entry !== 'string') continue;
      // 이름 그대로이거나 파일 이름 꼴(확장자가 붙은 것)이어도 같은 mod로 읽는다. 넓게 맞춰 더 막는다
      if (fold(entry) === ours || fold(entry.replace(MOD_EXTENSION_ANY_CASE, '')) === ours) {
        return `Command Code 설정 ${file}의 mods.disabled에 b-studio의 mod(${OUR_MOD_NAME})가 들어 있어 불러와지지 않습니다. 그 이름을 지운 뒤 다시 여세요`;
      }
    }
  }
  if (Array.isArray(record.paths) && record.paths.length > 0) return `Command Code 설정 ${file}의 mods.paths가 다른 mod를 불러옵니다. ${OTHER_SOURCES_HINT}`;
  if (Array.isArray(record.sources) && record.sources.length > 0) return `Command Code 설정 ${file}의 mods.sources가 다른 mod를 불러옵니다. ${OTHER_SOURCES_HINT}`;
  return undefined;
}

async function modsDirRefusal(dir: string): Promise<Refusal> {
  let info;
  try {
    info = await stat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return `Command Code의 mods 폴더 ${dir}을(를) 읽지 못해 터미널을 열지 않았습니다(${(error as Error).message}). 다른 mod가 있는지 알 수 없습니다`;
  }
  if (!info.isDirectory()) return undefined;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    return `Command Code의 mods 폴더 ${dir}을(를) 읽지 못해 터미널을 열지 않았습니다(${(error as Error).message}). 다른 mod가 있는지 알 수 없습니다`;
  }
  const found = entries.find((name) => !name.startsWith('.') && name !== 'node_modules');
  if (found !== undefined) return `Command Code의 mods 폴더 ${dir}에 mod(${found})가 있습니다. ${OTHER_SOURCES_HINT}`;
  return undefined;
}

export interface CommandCodeConfigWrite {
  /** Command Code가 뜬 작업 폴더 */
  cwd: string;
  home: string | undefined;
  /** 도구 입력의 경로(상대·절대·`~/`) */
  file: string;
}

/**
 * 그 경로의 쓰기가 Command Code의 설정·mod 자리(`.commandcode`: 작업 폴더·프로젝트 루트·사용자 홈)를 건드리는가. 거부 목록이라 넓게 맞춘다:
 * ① 경로 어디에든 이름이 `.commandcode`인 칸이 있음(대소문자·전각·보이지 않는 글자·끝의 점과 빈칸을 접어서, `..`를 풀기 전의 글과 푼 글 둘 다),
 * ② 링크를 푼 실제 경로의 칸에도 같은 이름이 있음, ③ 이미 있는 조상이 그 폴더와 같은 폴더(inode)임(이름이 달라도 같은 폴더를 가리키는 링크·대소문자 무시 볼륨).
 * 도구가 `~/`를 홈으로 펴는 것(cli.mjs `write_file`의 설명)도 같이 본다
 */
export async function commandCodeConfigPathBlocked(write: CommandCodeConfigWrite): Promise<boolean> {
  const home = homeOf(write.home);
  const raw = write.file.trim();
  const candidates = [raw];
  if (raw === '~' || raw.startsWith('~/')) candidates.push(`${home}${raw.slice(1)}`);
  const protectedDirs = [path.join(write.cwd, CONFIG_DIR), `${home}/${CONFIG_DIR}`];
  const root = await projectRoot(write.cwd, home);
  if (root !== undefined) protectedDirs.push(path.join(root, CONFIG_DIR));
  const protectedIds = new Set<string>();
  for (const dir of protectedDirs) {
    try {
      const info = await stat(dir);
      protectedIds.add(`${info.dev}:${info.ino}`);
    } catch {
      // 아직 없는 폴더는 이름으로만 본다
    }
  }
  for (const candidate of candidates) {
    if (candidate.split(/[\\/]/u).some(isConfigDirName)) return true;
    const absolute = path.resolve(write.cwd, candidate);
    if (absolute.split(path.sep).some(isConfigDirName)) return true;
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
    if ([...real.split(path.sep), ...rest].some(isConfigDirName)) return true;
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
