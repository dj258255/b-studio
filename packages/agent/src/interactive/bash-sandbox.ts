import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, platform as osPlatform, tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Bash 자식이 쓸 수 있는 곳을 OS 샌드박스로 가둔다(macOS sandbox-exec, Linux bwrap).
 * 정책은 "허용 목록"이다: 쓰기는 기본 거절, 아래 목록만 연다. 읽기와 실행은 열어 둔다(빌드·테스트가 시스템 파일을 읽는다).
 * 허용 목록을 만드는 쪽(이 파일)은 모르는 입력을 범위 밖으로 처리한다: 경로를 안전하게 적을 수 없으면 샌드박스를 만들지 않고 실행을 거절한다.
 */

/** 샌드박스를 만들 수 없을 때 던진다. 호출한 쪽은 명령을 실행하지 않고 오류 결과를 낸다 */
export class SandboxError extends Error {}

export interface BashSandboxOptions {
  /** 어떤 경우에도 쓰지 못하게 할 폴더(허용 폴더 안에 있어도). 관문 폴더 */
  denyWrite?: readonly string[];
  /** 임시 폴더(기본은 os.tmpdir()와 그 realpath). 시험이 바꾼다 */
  tmpDirs?: readonly string[];
  /** 홈 폴더(기본은 os.homedir()). 캐시 허용 목록의 기준 */
  home?: string;
  /** 시험이 바꾼다(기본은 process.platform) */
  platform?: NodeJS.Platform;
  /** 시험이 바꾼다: 샌드박스를 끄면 true. 운영 코드는 쓰지 않는다 */
  disabled?: boolean;
}

export type SandboxPlan =
  | { kind: 'wrapped'; command: string; args: string[]; tool: 'sandbox-exec' | 'bwrap' }
  /** 이 플랫폼에는 쓸 수 있는 도구가 없어 감싸지 않는다(Linux만). notice를 화면과 도구 결과에 알린다 */
  | { kind: 'unsandboxed'; notice: string }
  /** 감쌀 수 없고 감싸지 않고 돌려서도 안 된다(macOS). 명령을 실행하지 않는다 */
  | { kind: 'refused'; reason: string };

/**
 * macOS: 사용자 홈 아래에서 빌드·테스트가 쓰는 캐시. 홈 전체는 열지 않는다.
 *  - .npm: npm 캐시·로그(`npm test`만 돌려도 _logs에 쓴다, 실측)
 *  - Library/pnpm, Library/Caches/pnpm, .cache/pnpm, .local/share/pnpm: pnpm 저장소·상태(`pnpm install`이 쓴다, 실측)
 *  - .cargo/registry, .cargo/git, .cargo/.package-cache(-mutate), .cargo/.global-cache: cargo가 내려받기·잠금·사용 기록에 쓴다(오프라인 빌드도 .global-cache를 고친다, 실측). .cargo/bin은 PATH에 있어 열지 않는다
 *  - .gradle/caches, wrapper, daemon, native: gradle의 캐시·래퍼·데몬 기록. .gradle/init.d·gradle.properties는 모든 빌드가 읽어 실행하므로 열지 않는다
 *  - .node-gyp, .cache/node-gyp, Library/Caches/node-gyp: 네이티브 애드온 빌드 헤더
 */
export const HOME_CACHE_WRITE_PATHS = [
  '.npm',
  'Library/pnpm',
  'Library/Caches/pnpm',
  '.cache/pnpm',
  '.local/share/pnpm',
  '.cargo/registry',
  '.cargo/git',
  '.cargo/.package-cache',
  '.cargo/.package-cache-mutate',
  '.cargo/.global-cache',
  '.gradle/caches',
  '.gradle/wrapper',
  '.gradle/daemon',
  '.gradle/native',
  '.node-gyp',
  '.cache/node-gyp',
  'Library/Caches/node-gyp',
] as const;

/** 프로그램이 /tmp를 직접 쓰는 경우(하드코딩된 경로)를 위해 연다. macOS에서 /tmp·/var는 /private 아래로 풀린다 */
const SHARED_TMP = ['/tmp', '/var/tmp'];
/** 그 폴더 안의 관문 폴더는 세션마다 만들어지는 이름이라 이름 꼴로 막는다(다른 세션의 관문 폴더를 고치지 못하게) */
export const GATEWAY_DIR_PREFIX = 'b-studio-gateway-';

const realOf = (target: string): string => {
  try {
    return realpathSync.native(target);
  } catch {
    return target;
  }
};

function requireAbsolute(value: string, what: string): string {
  if (typeof value !== 'string' || value === '' || !path.isAbsolute(value)) throw new SandboxError(`${what}이(가) 절대 경로가 아닙니다`);
  // 제어 문자(NUL·개행·이스케이프)는 프로필 글에서 안전하게 적을 수 없다. 짝 없는 서로게이트는 UTF-8로 적을 수 없다
  if (/[\u0000-\u001f\u007f]/.test(value) || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)) throw new SandboxError(`${what}에 프로필로 적을 수 없는 문자가 있습니다`);
  return path.normalize(value).replace(/\/+$/, '') || '/';
}

/** SBPL 문자열 리터럴. 따옴표와 역슬래시만 이스케이프하면 되고(그 밖의 문자는 그대로), 제어 문자는 위에서 이미 거절했다 */
export function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 경로의 두 꼴(받은 그대로, realpath). 같으면 하나 */
function variants(target: string): string[] {
  const given = requireAbsolute(target, '경로');
  const real = realOf(given);
  return real === given ? [given] : [given, real];
}

interface ResolvedPlan {
  work: string[];
  tmp: string[];
  caches: string[];
  deny: string[];
  gatewayParents: string[];
}

function resolvePlan(cwd: string, options: BashSandboxOptions): ResolvedPlan {
  const home = requireAbsolute(options.home ?? homedir(), '홈 폴더');
  const work = variants(cwd);
  // 작업 폴더가 루트나 홈(또는 그 위)이면 "작업 폴더 안"이 사실상 전부라 가둠이 의미가 없다. 모르는 값은 거절한다
  for (const entry of work) {
    const real = realOf(entry);
    if (real === '/' || real === realOf(home) || realOf(home).startsWith(`${real}/`)) throw new SandboxError(`작업 폴더(${entry})가 너무 넓어 샌드박스로 가둘 수 없습니다(루트·홈 폴더이거나 그 위)`);
  }
  const tmpInputs = options.tmpDirs ?? [tmpdir(), ...SHARED_TMP];
  const tmp = [...new Set(tmpInputs.flatMap((dir) => variants(dir)))];
  // macOS의 사용자 캐시 폴더(.../C)는 임시 폴더(.../T)의 형제다. clang 모듈 캐시 등이 쓴다
  if (options.tmpDirs === undefined) {
    const realTmp = realOf(tmpdir());
    if (path.basename(realTmp) === 'T' && realTmp.startsWith('/private/var/folders/')) tmp.push(path.join(path.dirname(realTmp), 'C'));
  }
  const caches = HOME_CACHE_WRITE_PATHS.flatMap((relative) => variants(path.join(home, relative)));
  const deny = (options.denyWrite ?? []).flatMap((dir) => variants(dir));
  // 작업 폴더의 .git: 서버의 git(체크포인트)이 이 폴더에서 돌아 훅·설정(core.fsmonitor 등)을 서버 권한으로 실행한다
  for (const entry of work) deny.push(path.join(entry, '.git'));
  return { work, tmp, caches, deny: [...new Set(deny)], gatewayParents: tmp };
}

/**
 * sandbox-exec 프로필 글. 마지막으로 맞은 규칙이 이긴다(실측): 허용 뒤에 거부를 적어 허용 폴더 안의 관문·.git을 다시 막는다.
 * 경로는 모두 SBPL 문자열로 적는다. 이름 비교는 커널이 실제 파일(링크를 푼 경로)로 하므로 링크·`..`·대소문자 변형은 문자열 비교가 아니다
 */
export function buildSeatbeltProfile(cwd: string, options: BashSandboxOptions = {}): string {
  const plan = resolvePlan(cwd, options);
  const sub = (paths: readonly string[]) => paths.map((entry) => `(subpath ${sbplString(entry)})`).join(' ');
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${sub(plan.work)} ${sub(plan.tmp)} ${sub(plan.caches)})`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/[0-9]+$"))',
  ];
  // 임시 폴더 안의 다른 세션 관문 폴더(이름 꼴로 막는다. 정규식에는 경로를 넣지 않고 고정 글만 쓴다)
  lines.push(`(deny file-write* (require-all (require-any ${sub(plan.gatewayParents)}) (regex #"/${GATEWAY_DIR_PREFIX}[^/]*(/|$)")))`);
  if (plan.deny.length > 0) lines.push(`(deny file-write* ${sub(plan.deny)})`);
  return `${lines.join('\n')}\n`;
}

/** bwrap 인자(작업 명령 앞부분). 읽기 전용 루트 위에 쓸 곳만 다시 연결한다. 읽기 전용으로 덮을 곳은 마지막에 둔다(나중 마운트가 이긴다) */
export function buildBwrapArgs(cwd: string, options: BashSandboxOptions = {}): string[] {
  const plan = resolvePlan(cwd, options);
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--new-session'];
  const writable = [...plan.work, ...plan.tmp, ...plan.caches];
  for (const dir of [...new Set(writable.map((entry) => realOf(entry)))]) if (existsSync(dir)) args.push('--bind', dir, dir);
  // bwrap은 이름 꼴로 막지 못한다. 지금 있는 다른 세션의 관문 폴더를 읽기 전용으로 덮는다(시작 뒤에 생기는 폴더는 덮지 못한다)
  const gateways: string[] = [];
  for (const parent of plan.gatewayParents) {
    try {
      for (const name of readdirSync(parent)) if (name.startsWith(GATEWAY_DIR_PREFIX)) gateways.push(path.join(parent, name));
    } catch {
      // 없는 폴더
    }
  }
  for (const dir of [...new Set([...plan.deny, ...gateways].map((entry) => realOf(entry)))]) if (existsSync(dir)) args.push('--ro-bind', dir, dir);
  return args;
}

let seatbeltProbe: string | null | undefined;
let bwrapProbe: boolean | undefined;

/** sandbox-exec가 이 환경에서 실제로 동작하는지(이미 다른 샌드박스 안이면 적용이 거절된다). 한 번만 잰다. 실패 이유를 돌려주고, 되면 null */
function probeSeatbelt(): string | null {
  if (seatbeltProbe !== undefined) return seatbeltProbe;
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8', timeout: 10_000 });
  seatbeltProbe = result.error ? `sandbox-exec를 실행하지 못했습니다(${(result.error as NodeJS.ErrnoException).code ?? result.error.message})` : result.status !== 0 ? `sandbox-exec가 샌드박스를 적용하지 못했습니다(종료 ${result.status}: ${String(result.stderr).trim().slice(0, 200)})` : null;
  return seatbeltProbe;
}

function probeBwrap(): boolean {
  if (bwrapProbe !== undefined) return bwrapProbe;
  const result = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '/bin/true'], { encoding: 'utf8', timeout: 10_000 });
  bwrapProbe = !result.error && result.status === 0;
  return bwrapProbe;
}

/** 시험이 프로브 캐시를 비운다 */
export function resetSandboxProbes(): void {
  seatbeltProbe = undefined;
  bwrapProbe = undefined;
}

export const UNSANDBOXED_NOTICE = '이 컴퓨터에서는 명령의 쓰기를 가두는 도구(bwrap)를 쓸 수 없어, 명령이 작업 폴더 밖에도 쓸 수 있습니다';

/**
 * 명령을 어떻게 감싸 실행할지 정한다. macOS는 감싸지 못하면 거절한다(fail closed).
 * Linux는 bwrap이 없거나 동작하지 않으면 감싸지 않고 알린다(서버·CI에서 도구를 못 쓰게 되는 것을 피한 결정, 알림은 화면과 도구 결과에 낸다).
 * 그 밖의 플랫폼도 같다
 */
export function planSandbox(command: string, cwd: string, options: BashSandboxOptions = {}): SandboxPlan {
  const os = options.platform ?? osPlatform();
  if (options.disabled) return { kind: 'unsandboxed', notice: UNSANDBOXED_NOTICE };
  if (os === 'darwin') {
    const failed = probeSeatbelt();
    if (failed) return { kind: 'refused', reason: `${failed}. 작업 폴더 밖 쓰기를 막지 못하므로 명령을 실행하지 않았습니다` };
    let profile: string;
    try {
      profile = buildSeatbeltProfile(cwd, options);
    } catch (error) {
      if (error instanceof SandboxError) return { kind: 'refused', reason: `${error.message}. 명령을 실행하지 않았습니다` };
      throw error;
    }
    return { kind: 'wrapped', tool: 'sandbox-exec', command: '/usr/bin/sandbox-exec', args: ['-p', profile, '/bin/bash', '-c', command] };
  }
  if (os === 'linux' && probeBwrap()) {
    try {
      return { kind: 'wrapped', tool: 'bwrap', command: 'bwrap', args: [...buildBwrapArgs(cwd, options), '/bin/bash', '-c', command] };
    } catch (error) {
      if (error instanceof SandboxError) return { kind: 'refused', reason: `${error.message}. 명령을 실행하지 않았습니다` };
      throw error;
    }
  }
  return { kind: 'unsandboxed', notice: UNSANDBOXED_NOTICE };
}

/** 세션 시작 때 화면에 알릴 글(가둘 수 없는 환경이면). 가둘 수 있으면 null */
export function sandboxStartupNotice(cwd: string, options: BashSandboxOptions = {}): string | null {
  const plan = planSandbox('true', cwd, options);
  if (plan.kind === 'unsandboxed') return plan.notice;
  if (plan.kind === 'refused') return `명령 실행이 막혀 있습니다: ${plan.reason}`;
  return null;
}
