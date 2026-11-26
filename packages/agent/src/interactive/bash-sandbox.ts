import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync, rmdirSync } from 'node:fs';
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
  /** 시험이 바꾼다: 계획을 직접 정한다(진짜 bwrap 없이 정리 동작을 시험한다). 운영 코드는 쓰지 않는다 */
  planOverride?: (command: string, cwd: string) => SandboxPlan;
}

export type SandboxPlan =
  | { kind: 'wrapped'; command: string; args: string[]; tool: 'sandbox-exec' | 'bwrap'; placeholders?: string[] }
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

/** realpath. 없는 경로는 있는 가장 가까운 위쪽 폴더를 풀고 나머지를 붙인다(아직 없는 거부 경로도 링크를 푼 꼴로 맞추려고) */
const realOf = (target: string): string => {
  try {
    return realpathSync.native(target);
  } catch {
    const parent = path.dirname(target);
    return parent === target ? target : path.join(realOf(parent), path.basename(target));
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

const inside = (target: string, root: string): boolean => target === root || target.startsWith(root === '/' ? '/' : `${root}/`);

/**
 * 막은 경로(deny)와 작업 폴더의 위쪽 폴더 가운데 **쓸 수 있는 구역 안에 있어 이름을 바꿀 수 있는 것**.
 * 경로로 적은 거부는 위쪽 폴더가 옮겨지면 비켜 간다(`mv $작업폴더 $작업폴더.old; mkdir -p $작업폴더/.git/hooks`로 서버의 git이 쓰는 `.git`을 에이전트가 만든 것으로 바꾼다).
 * 구역 밖의 폴더는 에이전트가 옮길 수 없다. 구역 자체(허용 뿌리)와 구역 안의 위쪽 폴더는 옮길 수 있으므로 모두 센다
 */
function renamableAncestors(targets: readonly string[], writableRoots: readonly string[]): string[] {
  const found = new Set<string>();
  for (const target of targets) {
    for (let dir = path.dirname(target); dir !== '/' && dir !== path.dirname(dir); dir = path.dirname(dir)) {
      if (writableRoots.some((root) => inside(dir, root))) found.add(dir);
    }
  }
  return [...found];
}

interface ResolvedPlan {
  work: string[];
  tmp: string[];
  caches: string[];
  deny: string[];
  gatewayParents: string[];
  /** 이름을 바꿀 수 있는 위쪽 폴더(작업 폴더 자신 포함). 폴더 자체의 이름·삭제·권한만 막고 안의 쓰기는 막지 않는다 */
  pinned: string[];
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
  const writableRoots = [...work, ...tmp, ...caches];
  const denied = [...new Set(deny)];
  // 작업 폴더 자신도 옮길 수 없게 한다(옮기면 그 자리에 새 .git을 만들 수 있다)
  const pinned = [...new Set([...work.filter((entry) => writableRoots.some((root) => inside(entry, root))), ...renamableAncestors([...denied, ...work], writableRoots)])];
  return { work, tmp, caches, deny: denied, gatewayParents: tmp, pinned };
}

/**
 * `(allow default)`를 쓰면 실행·IPC가 열려 있어, 샌드박스 안의 프로세스가 샌드박스 밖 프로세스에게 일을 시킬 수 있다.
 * 둘로 막는다. (1) 시키는 도구의 실행(경로는 이 macOS에서 확인). (2) 도구를 복사해 와도 막히도록 IPC 자체: Apple Events 보내기와 LaunchServices·Apple Events 서비스 조회.
 * launchd에 일을 맡기는 길(launchctl)은 도구의 실행만 막는다(복사한 launchctl은 서명 때문에 죽는 것을 확인했지만, XPC로 직접 말하는 프로그램은 막지 못한다. ADR-229의 남은 한계)
 */
export const IPC_ESCAPE_DENIES = [
  '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/usr/bin/osacompile") (literal "/usr/bin/shortcuts") (literal "/bin/launchctl") (literal "/usr/bin/at") (literal "/usr/bin/atq") (literal "/usr/bin/atrm") (literal "/usr/bin/batch") (literal "/usr/bin/crontab"))',
  '(deny appleevent-send)',
  '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.coreservices.appleevents") (global-name-regex #"^com\\.apple\\.lsd\\."))',
];

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
  // 막은 경로의 위쪽 폴더는 그 폴더 자체만(literal) 막는다: 옮기거나 지우면 그 자리에 새로 만든 .git·관문 폴더가 거부 규칙을 비켜 간다
  if (plan.pinned.length > 0) lines.push(`(deny file-write* ${plan.pinned.map((entry) => `(literal ${sbplString(entry)})`).join(' ')})`);
  // 프로필을 쓴 프로세스가 launchd·LaunchServices·Apple Events로 샌드박스 밖에서 일을 시키는 길(open, osascript, launchctl, at 등)
  lines.push(...IPC_ESCAPE_DENIES);
  return `${lines.join('\n')}\n`;
}

/** bwrap 인자(작업 명령 앞부분). 읽기 전용 루트 위에 쓸 곳만 다시 연결한다. 읽기 전용으로 덮을 곳은 마지막에 둔다(나중 마운트가 이긴다) */
export function buildBwrapArgs(cwd: string, options: BashSandboxOptions = {}): string[] {
  return bwrapPlan(cwd, options).args;
}

/** bwrap 인자와, 이 명령을 위해 호스트에 새로 생길 빈 자리 폴더(없는 거부 경로의 tmpfs 마운트 지점) */
export function bwrapPlan(cwd: string, options: BashSandboxOptions = {}): { args: string[]; placeholders: string[] } {
  const plan = resolvePlan(cwd, options);
  const placeholders: string[] = [];
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--die-with-parent', '--new-session'];
  const writableRoots = [...new Set([...plan.work, ...plan.tmp, ...plan.caches].map((entry) => realOf(entry)))].filter((dir) => existsSync(dir));
  // 쓸 곳 사이의 위쪽 폴더(옮겨지면 거부가 비켜 가는 폴더)도 마운트 지점으로 만든다. 마운트 지점은 이름을 바꾸거나 지울 수 없다(EBUSY). 얕은 것부터 연결한다
  const pinned = [...new Set(plan.pinned.map((entry) => realOf(entry)))].filter((dir) => existsSync(dir) && !writableRoots.includes(dir));
  for (const dir of [...writableRoots, ...pinned].sort((x, y) => x.length - y.length)) args.push('--bind', dir, dir);
  // bwrap은 이름 꼴로 막지 못한다. 지금 있는 다른 세션의 관문 폴더를 읽기 전용으로 덮는다(시작 뒤에 생기는 폴더는 덮지 못한다)
  const gateways: string[] = [];
  for (const parent of plan.gatewayParents) {
    try {
      for (const name of readdirSync(parent)) if (name.startsWith(GATEWAY_DIR_PREFIX)) gateways.push(path.join(parent, name));
    } catch {
      // 없는 폴더
    }
  }
  for (const dir of [...new Set([...plan.deny, ...gateways].map((entry) => realOf(entry)))]) {
    if (existsSync(dir)) {
      args.push('--ro-bind', dir, dir);
    } else if (writableRoots.some((root) => inside(dir, root))) {
      // 아직 없는 거부 경로는 쓸 수 있는 구역 안에서 새로 만들 수 있다: 빈 읽기 전용 tmpfs로 그 자리를 막는다.
      // 위쪽 폴더도 없으면 `mkdir -p`로 만들 수 있어 막을 수 없다: 실행하지 않는다
      if (!existsSync(path.dirname(dir))) throw new SandboxError(`거부할 경로(${dir})의 위쪽 폴더가 없어 막을 수 없습니다`);
      args.push('--tmpfs', dir, '--remount-ro', dir);
      placeholders.push(dir);
    }
  }
  return { args, placeholders };
}

/**
 * 명령이 끝난 뒤 bwrap이 호스트에 만들어 둔 자리 폴더를 치운다: 여전히 비어 있는 진짜 폴더(링크 아님)일 때만. rmdir은 안의 것을 지우지 않는다.
 * 명령이 그 자리에 무언가를 만들었거나 링크로 바꿨으면 건드리지 않는다(없던 `.git` 폴더가 남아 git이 깨진 저장소로 보는 것을 막는다)
 */
export function removeEmptyPlaceholders(paths: readonly string[]): void {
  for (const target of paths) {
    try {
      if (!lstatSync(target).isDirectory()) continue;
      rmdirSync(target);
    } catch {
      // 이미 없거나(ENOENT), 비어 있지 않다(ENOTEMPTY)
    }
  }
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
  if (options.planOverride) return options.planOverride(command, cwd);
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
      const { args, placeholders } = bwrapPlan(cwd, options);
      return { kind: 'wrapped', tool: 'bwrap', command: 'bwrap', args: [...args, '/bin/bash', '-c', command], placeholders };
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
