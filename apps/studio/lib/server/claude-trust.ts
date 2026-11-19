/**
 * b-studio가 만든 세션 폴더를 claude의 폴더 신뢰에 적고 지운다(ADR-222).
 *
 * claude는 새 폴더(특히 Git 저장소)마다 "이 폴더를 믿습니까" 창을 띄우고, 믿는다고 답하면 설정 파일
 * (기본 계정은 `~/.claude.json`, 다른 계정은 `$CLAUDE_CONFIG_DIR/.claude.json`)의 `projects["<경로>"].hasTrustDialogAccepted`를 true로 적는다.
 * 무인으로 여러 세션을 돌리려면 사람이 그 창을 칸마다 누를 수 없다. 그래서 b-studio가 직접 만든 세션 폴더에 한해 그 값을 미리 적는다.
 *
 * 이 기록은 **믿을 폴더를 넓히는 허용 목록**이다. 그래서:
 *  - 적는 쪽은 좁게 맞춘다: 세션 폴더 루트 안의 실제 폴더만. 링크·`..`·대소문자 차이처럼 경로 글자와 실제 폴더가 갈라지면 적지 않는다.
 *  - 지우는 쪽은 넓게 맞춘다: 믿음을 줄이는 방향이라 그 세션 폴더 아래의 모든 키를 대소문자를 가리지 않고 지운다.
 *  - 파일이 없거나 JSON이 깨졌거나 꼴을 알 수 없으면 쓰지 않는다. 신뢰 창이 뜨게 둔다(fail-closed).
 *
 * 설정 파일은 claude도 쓴다. 읽고-고치고-같은 폴더의 임시 파일에 쓰고-rename하되, rename 직전에 원본이 바뀌었으면(내용·mtime·크기·inode)
 * 임시 파일을 버리고 다시 읽는다. 상한을 넘으면 쓰지 않고 실패로 알린다. 점검과 rename 사이의 아주 짧은 틈은 남는다(claude의 잠금을 쓰지 않는다).
 */
import { randomBytes } from 'node:crypto';
import { realpath as realpathCallback } from 'node:fs';
import { chmod, lstat, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

export type TrustResult = { ok: true; changed: boolean } | { ok: false; reason: string; /** 설정 파일이 없어서 못 쓴 경우 */ missing?: true };

export interface TrustOptions {
  /** b-studio가 세션 폴더를 만드는 루트. 이 밖의 경로는 적지 않는다 */
  sessionsRoot: string;
  /** 계정의 설정 폴더(CLAUDE_CONFIG_DIR). 기본 계정이면 없다 */
  configDir?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  /** 파일이 바뀌어 다시 읽는 상한(기본 5) */
  maxAttempts?: number;
  /** 시험용: 임시 파일을 쓴 뒤 마지막 점검 직전에 부른다. 경쟁을 흉내 낸다 */
  beforeCommit?: () => Promise<void>;
}

const DEFAULT_ATTEMPTS = 5;

/** 저장된 이름으로 돌려주는 realpath(대소문자를 구분하지 않는 볼륨에서도 실제 이름이다). fs/promises의 realpath에는 native가 없다 */
const realpathNative = promisify(realpathCallback.native);

/**
 * claude가 읽는 설정 파일. 계정 폴더(감싸개가 CLAUDE_CONFIG_DIR로 넘긴다) → `B_STUDIO_CLAUDE_CONFIG_DIR` → 홈 순서다.
 * 터미널에는 정해 둔 이름만 넘어가므로(host-terminal의 허용 이름) 서버 프로세스의 CLAUDE_CONFIG_DIR은 `B_STUDIO_TERMINAL_ENV`에 적었을 때만 따른다.
 * 사용자의 셸 시작 파일이 따로 CLAUDE_CONFIG_DIR을 내보내는 환경이면 b-studio는 알 수 없으니, 기본 계정의 설정 폴더를 `B_STUDIO_CLAUDE_CONFIG_DIR`로 알려 준다
 * (시험도 이 변수를 빈 임시 폴더로 돌려 사용자의 실제 `~/.claude.json`을 건드리지 않는다)
 */
export function claudeConfigFile(configDir: string | undefined, env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  const passed = (env.B_STUDIO_TERMINAL_ENV ?? '').split(',').some((name) => name.trim() === 'CLAUDE_CONFIG_DIR');
  const fromEnv = passed ? env.CLAUDE_CONFIG_DIR?.trim() : undefined;
  return path.join(configDir || env.B_STUDIO_CLAUDE_CONFIG_DIR?.trim() || fromEnv || home, '.claude.json');
}

/** 어떤 오류든 던지지 않고 사유로 바꾼다. 사유는 사람에게 보인다 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isInside(root: string, target: string): string | undefined {
  const rel = path.relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return undefined;
  return rel;
}

/**
 * 적을 폴더의 실제 경로. 세션 폴더 루트 안의 실제 폴더가 아니면 사유를 돌려준다.
 * 글자로 본 위치(`resolve`)와 실제 위치(`realpath`)의 루트 기준 상대 경로가 같아야 한다 — 다르면 루트 안의 링크이거나
 * 대소문자가 다른 글자다(대소문자를 구분하지 않는 볼륨은 realpath가 저장된 이름으로 돌려준다). claude가 비교하는 키는 실제 경로다
 */
async function trustedKey(folder: string, sessionsRoot: string): Promise<{ key: string } | { reason: string }> {
  if (!folder || !sessionsRoot) return { reason: '폴더 경로가 비어 있습니다' };
  try {
    const lexicalRel = isInside(path.resolve(sessionsRoot), path.resolve(folder));
    if (lexicalRel === undefined) return { reason: '세션 폴더 루트 밖의 경로라 신뢰를 적지 않았습니다' };
    const realRoot = await realpathNative(sessionsRoot);
    const real = await realpathNative(folder);
    const realRel = isInside(realRoot, real);
    if (realRel === undefined) return { reason: '세션 폴더 루트 밖을 가리키는 경로(링크)라 신뢰를 적지 않았습니다' };
    if (realRel !== lexicalRel) return { reason: '경로 글자가 실제 폴더와 달라(링크 또는 대소문자) 신뢰를 적지 않았습니다' };
    if (!(await stat(real)).isDirectory()) return { reason: '폴더가 아니라 신뢰를 적지 않았습니다' };
    return { key: real };
  } catch (error) {
    return { reason: `세션 폴더를 확인하지 못했습니다: ${describe(error)}` };
  }
}

interface Snapshot {
  real: string;
  text: string;
  mtimeMs: number;
  size: number;
  ino: number;
  mode: number;
}

async function readSnapshot(file: string): Promise<Snapshot> {
  // 설정 파일이 링크(dotfiles 관리 등)면 링크를 지키고 가리키는 파일을 바꾼다
  const real = await realpathNative(file);
  if (!(await lstat(real)).isFile()) throw new Error('설정 파일이 일반 파일이 아닙니다');
  const text = await readFile(real, 'utf8');
  const info = await stat(real);
  return { real, text, mtimeMs: info.mtimeMs, size: info.size, ino: info.ino, mode: info.mode & 0o7777 };
}

function same(a: Snapshot, b: Snapshot): boolean {
  return a.real === b.real && a.text === b.text && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

/** 원본의 들여쓰기·줄바꿈·끝 줄바꿈 꼴로 다시 쓰는 함수. 한 줄 파일이면 한 줄로 쓴다 */
function serializerFor(text: string): (value: unknown) => string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = text.includes('\n') ? (/\n([ \t]+)"/.exec(text)?.[1] ?? '  ') : undefined;
  const trailing = /\r?\n$/.test(text) ? newline : '';
  return (value) => {
    const body = JSON.stringify(value, null, indent);
    return (newline === '\r\n' ? body.replace(/\n/g, '\r\n') : body) + trailing;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 설정 파일을 읽고 `mutate`로 고쳐 바꿔치기한다. `mutate`가 false를 돌려주면 바꿀 것이 없다.
 * 다시 써도 우리가 바꾸지 않은 값이 달라지는 파일(원본을 같은 꼴로 다시 써 보아 글이 다르면)은 쓰지 않는다
 */
async function rewriteConfig(file: string, options: TrustOptions, mutate: (projects: Record<string, unknown>) => boolean): Promise<TrustResult> {
  const max = options.maxAttempts ?? DEFAULT_ATTEMPTS;
  for (let attempt = 1; attempt <= max; attempt += 1) {
    let before: Snapshot;
    try {
      before = await readSnapshot(file);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      return { ok: false, reason: `claude 설정 파일(${file})을 읽지 못했습니다(없으면 만들지 않습니다): ${describe(error)}`, ...(missing ? { missing: true as const } : {}) };
    }
    let config: unknown;
    try {
      config = JSON.parse(before.text);
    } catch (error) {
      return { ok: false, reason: `claude 설정 파일(${file})이 올바른 JSON이 아니라 고치지 않았습니다: ${describe(error)}` };
    }
    if (!isRecord(config)) return { ok: false, reason: `claude 설정 파일(${file})의 최상위가 객체가 아니라 고치지 않았습니다` };
    const serialize = serializerFor(before.text);
    if (serialize(config) !== before.text) {
      return { ok: false, reason: `claude 설정 파일(${file})을 같은 꼴로 다시 쓸 수 없어(숫자 정밀도·들여쓰기·이스케이프 등) 다른 값이 바뀔 수 있어 고치지 않았습니다` };
    }
    if (config.projects !== undefined && !isRecord(config.projects)) return { ok: false, reason: `claude 설정 파일(${file})의 projects가 객체가 아니라 고치지 않았습니다` };
    const projects = (config.projects ?? {}) as Record<string, unknown>;
    if (!mutate(projects)) return { ok: true, changed: false };
    config.projects = projects;

    const temp = path.join(path.dirname(before.real), `${path.basename(before.real)}.b-studio-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
    try {
      await writeFile(temp, serialize(config), { flag: 'wx', mode: before.mode });
      await chmod(temp, before.mode);
      await options.beforeCommit?.();
      let now: Snapshot;
      try {
        now = await readSnapshot(file);
      } catch {
        await rm(temp, { force: true });
        continue;
      }
      if (!same(before, now)) {
        await rm(temp, { force: true });
        continue;
      }
      await rename(temp, before.real);
      return { ok: true, changed: true };
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      return { ok: false, reason: `claude 설정 파일(${file})을 쓰지 못했습니다: ${describe(error)}` };
    }
  }
  return { ok: false, reason: `claude 설정 파일(${file})이 계속 바뀌어(${max}번 다시 읽음) 쓰지 않았습니다` };
}

/** 같은 설정 파일을 동시에 고치지 않게 한 줄로 세운다(프로세스 안). 다른 프로세스(claude)와는 rewriteConfig의 점검이 맡는다 */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

/** 세션 폴더를 claude가 믿는 폴더로 적는다. 던지지 않는다: 실패하면 사유를 돌려주고 신뢰 창이 뜨게 둔다 */
export async function trustSessionFolder(folder: string, options: TrustOptions): Promise<TrustResult> {
  try {
    const target = await trustedKey(folder, options.sessionsRoot);
    if ('reason' in target) return { ok: false, reason: target.reason };
    const file = claudeConfigFile(options.configDir, options.env, options.home);
    return await exclusive(() =>
      rewriteConfig(file, options, (projects) => {
        const entry = projects[target.key];
        if (isRecord(entry)) {
          if (entry.hasTrustDialogAccepted === true) return false;
          entry.hasTrustDialogAccepted = true;
        } else {
          projects[target.key] = { hasTrustDialogAccepted: true };
        }
        return true;
      }),
    );
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
}

/** 대소문자·유니코드 정규화를 가리지 않고 맞추는 글자 꼴(지우는 쪽만 쓴다) */
const fold = (value: string): string => value.normalize('NFC').toLowerCase();

/**
 * 세션 폴더와 그 아래 모든 키를 지운다. 폴더가 이미 지워졌어도 경로 글자로 지운다(실제 경로와 글자 경로 둘 다).
 * 막는 쪽이 아니라 믿음을 줄이는 쪽이라 넓게 맞춘다(대소문자 무시). 세션 폴더 루트 밖이거나 루트 자체면 아무것도 지우지 않는다
 */
export async function untrustSessionFolders(folder: string, options: TrustOptions): Promise<TrustResult> {
  try {
    if (!folder || !options.sessionsRoot) return { ok: false, reason: '폴더 경로가 비어 있습니다' };
    const lexical = path.resolve(folder);
    const lexicalRoot = path.resolve(options.sessionsRoot);
    if (isInside(lexicalRoot, lexical) === undefined) return { ok: false, reason: '세션 폴더 루트 밖의 경로라 신뢰 기록을 지우지 않았습니다' };
    const prefixes = new Set([lexical]);
    try {
      const realRoot = await realpathNative(lexicalRoot);
      const real = await realpathNative(lexical);
      if (isInside(realRoot, real) !== undefined) prefixes.add(real);
    } catch {
      // 폴더가 이미 없다: 글자 경로로만 지운다. 루트의 실제 경로 아래 같은 이름도 함께 본다
      try {
        const realRoot = await realpathNative(lexicalRoot);
        prefixes.add(path.join(realRoot, path.relative(lexicalRoot, lexical)));
      } catch {
        // 루트도 없다: 글자 경로만
      }
    }
    const folded = [...prefixes].map(fold);
    const file = claudeConfigFile(options.configDir, options.env, options.home);
    return await exclusive(() =>
      rewriteConfig(file, options, (projects) => {
        let changed = false;
        for (const key of Object.keys(projects)) {
          const k = fold(key);
          if (folded.some((prefix) => k === prefix || k.startsWith(prefix + path.sep))) {
            delete projects[key];
            changed = true;
          }
        }
        return changed;
      }),
    );
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
}
