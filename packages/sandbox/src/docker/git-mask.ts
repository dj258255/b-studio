import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LoadedProject } from '@b-studio/spec';
import { SandboxError } from '../errors';
import type { BindMount } from './relay';

const execFileAsync = promisify(execFile);

/**
 * 서비스 컨테이너가 프로젝트 폴더의 `.git`을 쓰지 못하게 하는 마운트 계획(ADR-158).
 *
 * 작업 복사본 전체가 서비스 컨테이너에 읽기·쓰기로 마운트되면 컨테이너 안 명령이 `.git`을 고칠 수 있다. `.git`에는
 * 체크포인트 저장소(근거 판정이 믿는 기준)와 b-studio의 상태 폴더(`.git/b-studio`: 세션 기록, 테스트 근거, 미리보기 토큰)가 있어
 * 에이전트가 근거를 위조할 수 있었다. 서비스가 프로젝트를 마운트한 자리마다 더 구체적인 경로의 마운트를 겹쳐 막는다
 * (Docker는 더 깊은 경로의 마운트를 위에 얹는다)
 *  - `.git` 자체: 읽기 전용. 빌드가 git 정보를 읽는 경우는 그대로 된다
 *  - `.git/b-studio`: 빈 폴더를 읽기 전용으로 얹는다. 읽지도 못한다
 */

/** 프로젝트 폴더나 그 상위 폴더에서 찾은 `.git` 하나 */
export interface GitEntry {
  /** `.git`이 든 폴더(호스트 절대 경로) */
  dir: string;
  /** `.git`이 폴더인지, 파일(worktree·submodule의 gitdir 포인터)인지 */
  kind: 'directory' | 'file';
  /** `.git/b-studio`(b-studio의 상태 폴더)가 있는지 */
  hasState: boolean;
}

/** compose의 긴 문법 마운트 한 개(읽기 전용 bind). override의 services.<이름>.volumes에 그대로 적는다 */
export interface MaskVolume {
  type: 'bind';
  source: string;
  target: string;
  read_only: true;
  bind: { create_host_path: false };
}

const GIT = '.git';
const STATE = 'b-studio';
/** 상태 폴더 자리에 읽기 전용으로 얹을 빈 폴더(`.git` 안). tmpfs는 `volumes_from`으로 물려받는 서비스의 생성을 깨뜨려 쓰지 않는다(ADR-158) */
const STATE_MASK = 'b-studio-empty';

/**
 * 판정을 순수 함수로 둔 계획. 서비스 이름 → 그 서비스에 덧붙일 마운트.
 *  - 서비스가 `.git`이 든 폴더(또는 그 상위)를 마운트하면 그 안의 `.git`을 읽기 전용으로, 상태 폴더는 빈 폴더(읽기 전용)로 덮는다
 *  - 서비스가 `.git` 안쪽(`.git`, `.git/b-studio`, 그 하위)을 직접 마운트하면 같은 자리에서 읽기 전용(상태 폴더는 빈 폴더)로 바꾼다
 *  - 서비스가 프로젝트의 하위 폴더만 마운트해 `.git`이 보이지 않으면 아무것도 하지 않는다
 *  - `.git`이 없으면 아무것도 하지 않는다
 * 마운트의 source·target은 `docker compose config --format json`이 정규화한 값(절대 경로)이다
 */
export function planGitMask(mounts: readonly Pick<BindMount, 'service' | 'source' | 'target'>[], entries: readonly GitEntry[]): Record<string, MaskVolume[]> {
  const plan = new Map<string, Map<string, MaskVolume>>();
  const add = (service: string, volume: MaskVolume) => {
    const volumes = plan.get(service) ?? new Map<string, MaskVolume>();
    // 같은 자리를 둘 이상의 규칙이 덮으면 상태 폴더를 가리는 쪽이 남는다
    if (!volumes.get(volume.target)?.source.endsWith(`/${STATE_MASK}`)) volumes.set(volume.target, volume);
    plan.set(service, volumes);
  };
  const readOnly = (source: string, target: string): MaskVolume => ({ type: 'bind', source, target, read_only: true, bind: { create_host_path: false } });

  for (const mount of mounts) {
    const source = path.resolve(mount.source);
    for (const entry of entries) {
      const git = path.join(entry.dir, GIT);
      const state = path.join(git, STATE);
      if (isInside(source, entry.dir)) {
        // 이 마운트 안에 `.git`이 보인다
        const containerGit = path.posix.join(mount.target, toPosix(path.relative(source, git)));
        add(mount.service, readOnly(git, containerGit));
        if (entry.kind === 'directory' && entry.hasState) add(mount.service, readOnly(path.join(git, STATE_MASK), path.posix.join(containerGit, STATE)));
      } else if (isInside(git, source)) {
        // `.git` 안쪽을 직접 마운트했다. 같은 자리(target)의 마운트를 바꿔 쓴다
        if (isInside(state, source)) add(mount.service, readOnly(path.join(git, STATE_MASK), mount.target));
        else add(mount.service, readOnly(source, mount.target));
      }
    }
  }
  return Object.fromEntries([...plan].map(([service, volumes]) => [service, [...volumes.values()].sort((a, b) => a.target.localeCompare(b.target))]));
}

/**
 * 프로젝트 폴더에서 위로 올라가며 `.git`이 든 폴더를 찾는다. 프로젝트 폴더의 상위를 마운트한 서비스가 있으면(모노레포 저장소 루트를
 * 마운트) 가장 위의 그 마운트 소스까지, 없으면 프로젝트 폴더 자신만 본다. 경로는 심볼릭 링크를 풀어 비교한다(macOS의 /tmp → /private/tmp)
 */
export async function detectGitEntries(projectRoot: string, mountSources: readonly string[]): Promise<GitEntry[]> {
  const root = await real(projectRoot);
  const above = (await Promise.all(mountSources.map(real))).filter((source) => isInside(source, root));
  const stop = above.sort((a, b) => a.length - b.length)[0] ?? root;

  const entries: GitEntry[] = [];
  for (let dir = root; ; dir = path.dirname(dir)) {
    const entry = await inspectGit(dir);
    if (entry) entries.push(entry);
    if (dir === stop || dir === path.dirname(dir)) break;
  }
  return entries;
}

/** `docker compose config --format json` 중 마운트를 읽는 데 쓰는 부분 */
export interface ComposeMountConfig {
  services: Record<string, { volumes?: Array<{ type: string; source?: string; target: string }>; volumes_from?: string[] }>;
  volumes?: Record<string, { driver?: string; driver_opts?: Record<string, string>; external?: unknown } | null>;
}

/** 이름 있는 볼륨이 로컬 드라이버로 호스트 폴더에 묶인 꼴(`driver_opts: { type: none, o: bind, device: <경로> }`)이면 그 호스트 경로 */
export function boundDevice(volume: { driver?: string; driver_opts?: Record<string, string> } | null | undefined): string | undefined {
  if (!volume || (volume.driver !== undefined && volume.driver !== 'local')) return undefined;
  const options = (volume.driver_opts?.o ?? '').split(',').map((option) => option.trim());
  const device = volume.driver_opts?.device;
  return device && path.isAbsolute(device) && (options.includes('bind') || options.includes('rbind')) ? device : undefined;
}

/**
 * 서비스가 호스트 폴더를 붙이는 모든 꼴을 모은다: bind 마운트, 호스트 폴더에 묶은 이름 있는 볼륨, `volumes_from`으로 물려받은 마운트
 * (물려준 서비스의 마운트를 같은 target으로 물려받는다. 전이적이며 순환은 끊는다). `volumes_from`이 compose 밖 컨테이너
 * (`container:<이름>`)를 가리키면 무엇이 붙는지 알 수 없으므로 던진다
 */
export function collectHostMounts(config: ComposeMountConfig): Array<Pick<BindMount, 'service' | 'source' | 'target'>> {
  const own = new Map<string, Array<{ source: string; target: string }>>();
  for (const [service, spec] of Object.entries(config.services)) {
    const mounts: Array<{ source: string; target: string }> = [];
    for (const volume of spec.volumes ?? []) {
      if (!volume.source) continue;
      if (volume.type === 'bind') mounts.push({ source: path.resolve(volume.source), target: volume.target });
      else if (volume.type === 'volume') {
        const device = boundDevice(config.volumes?.[volume.source]);
        if (device) mounts.push({ source: path.resolve(device), target: volume.target });
      }
    }
    own.set(service, mounts);
  }

  const effective = (service: string, seen: Set<string>): Array<{ source: string; target: string }> => {
    if (seen.has(service)) return [];
    seen.add(service);
    const inherited = (config.services[service]?.volumes_from ?? []).flatMap((entry) => {
      const name = entry.split(':')[0]!;
      if (name === 'container') throw new SandboxError(`서비스 ${service}의 volumes_from(${entry})이 compose 밖의 컨테이너를 가리켜 무엇이 마운트되는지 알 수 없습니다. .git 보호를 정할 수 없어 멈춥니다`);
      return effective(name, seen);
    });
    return [...(own.get(service) ?? []), ...inherited];
  };
  return Object.keys(config.services).flatMap((service) => effective(service, new Set()).map((mount) => ({ service, ...mount })));
}

/**
 * `docker compose config --format json` 결과에서 서비스별 마스크 마운트를 계산한다.
 * 마운트 소스는 심볼릭 링크를 풀어 `.git` 위치와 같은 꼴로 맞춘다
 */
export async function computeGitMask(projectRoot: string, config: ComposeMountConfig): Promise<Record<string, MaskVolume[]>> {
  const mounts = await Promise.all(collectHostMounts(config).map(async (mount) => ({ ...mount, source: await real(mount.source) })));
  const entries = await detectGitEntries(projectRoot, mounts.map((mount) => mount.source));
  // b-studio가 만든 체크포인트 저장소(저장소 설정에 `[b-studio]` 절이 있다)인데 상태 폴더가 아직 없으면 미리 빈 폴더로 만들어 둔다.
  // 마운트 지점이 있어야 하고(읽기 전용 `.git` 아래에서는 만들 수 없다), 없다고 건너뛰면 나중에 b-studio가 만든 폴더가 컨테이너에
  // 그대로 보인다. 사용자 자신의 저장소(내 폴더 모드)에는 흔적을 남기지 않는다. 만들지 못하면 멈춘다
  for (const entry of entries) {
    if (entry.kind !== 'directory') continue;
    if (!entry.hasState && !(await isBStudioRepository(entry.dir))) continue;
    const state = path.join(entry.dir, GIT, STATE);
    const empty = path.join(entry.dir, GIT, STATE_MASK);
    try {
      await mkdir(state, { recursive: true });
      // 상태 폴더 자리에 얹을 빈 폴더. 내용이 있으면 비운다(가린다는 약속이 깨지지 않게).
      // 폴더 자체는 지우지 않는다: 서비스 여럿이 함께 재시작되면 이 함수가 동시에 불리는데, "지우고 다시 만들기"는 서로 엇갈려
      // EEXIST로 실패했다(도그푸딩 마찰 187). 그리고 먼저 뜬 서비스의 컨테이너가 이 폴더를 이미 마운트하고 있을 수 있다.
      // 있으면 그대로 두고 안의 항목만 지우면 몇 번을, 동시에 불러도 결과가 같다
      await mkdir(empty, { recursive: true });
      for (const name of await readdir(empty)) await rm(path.join(empty, name), { recursive: true, force: true });
    } catch (error) {
      throw new SandboxError(`${state} 폴더를 가릴 빈 폴더를 준비하지 못했습니다`, error instanceof Error ? error.message : String(error));
    }
    entry.hasState = true;
  }
  return planGitMask(mounts, entries);
}

async function isBStudioRepository(dir: string): Promise<boolean> {
  return readFile(path.join(dir, GIT, 'config'), 'utf8').then((text) => /^\[b-studio\]/m.test(text), () => false);
}

/** `docker inspect`의 Mounts 한 항목 */
export interface InspectedMount {
  Type: string;
  Name?: string;
  Source?: string;
  Destination: string;
  RW?: boolean;
}

/**
 * 사후 확인(설정이 아니라 결과를 본다): 실행 중인 컨테이너의 실제 마운트에서 `.git`이 든 호스트 폴더를 덮는 마운트가 있는데
 * 그 안의 `.git` 자리에 읽기 전용 마운트(상태 폴더는 빈 폴더)가 없으면 빠진 자리(컨테이너 안 경로)를 돌려준다.
 * 이름 있는 볼륨은 `volumeDevices`(볼륨 이름 → 로컬 드라이버 옵션)로 호스트 폴더에 묶였는지 본다
 */
export async function findMissingMasks(
  projectRoot: string,
  mounts: readonly InspectedMount[],
  volumeOptions: Readonly<Record<string, { driver?: string; driver_opts?: Record<string, string> } | undefined>>,
): Promise<string[]> {
  const hostMounts = await Promise.all(
    mounts.flatMap((mount) => {
      const source = mount.Type === 'bind' ? mount.Source : mount.Type === 'volume' && mount.Name ? boundDevice(volumeOptions[mount.Name]) : undefined;
      return source ? [real(source).then((resolved) => ({ service: 'container', source: resolved, target: mount.Destination }))] : [];
    }),
  );
  if (hostMounts.length === 0) return [];
  const entries = await detectGitEntries(projectRoot, hostMounts.map((mount) => mount.source));
  const missing: string[] = [];
  for (const volume of planGitMask(hostMounts, entries).container ?? []) {
    const actual = mounts.find((mount) => mount.Destination === volume.target);
    const ok = actual !== undefined && actual.RW === false;
    if (!ok) missing.push(volume.target);
  }
  return missing;
}

async function inspectGit(dir: string): Promise<GitEntry | undefined> {
  const stat = await lstat(path.join(dir, GIT)).catch(() => undefined);
  if (!stat) return undefined;
  if (stat.isDirectory()) return { dir, kind: 'directory', hasState: await lstat(path.join(dir, GIT, STATE)).then((s) => s.isDirectory(), () => false) };
  // 파일은 worktree·submodule의 gitdir 포인터다. 심볼릭 링크 `.git`은 마운트 지점으로 쓸 수 없어 건너뛴다(남긴 한계, ADR-158)
  return stat.isFile() ? { dir, kind: 'file', hasState: false } : undefined;
}

async function real(target: string): Promise<string> {
  return realpath(target).catch(() => path.resolve(target));
}

function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

/**
 * 사용자의 compose 파일이 정규화된 마운트(`docker compose config --format json`: 짧은 문법·상대 경로·변수 치환을 compose가 푼 결과)를
 * 읽어, 프로젝트 폴더를 마운트한 서비스마다 `.git`을 막는 마운트를 계산한다. 마운트를 읽지 못하면 막을 자리를 알 수 없으므로
 * 보호 없이 띄우지 않고 멈춘다 — 같은 compose 파일을 읽지 못하면 `up`도 어차피 실패한다.
 * `up`을 부르는 `#composeArgs`와 같은 파일·프로젝트 이름·프로젝트 폴더·환경으로 읽는다(프로필만 모두 켠다).
 * 오류에는 명령줄을 담지 않고 stderr만 `redact`로 가려 담는다(compose의 오류에 치환된 시크릿 값이 섞일 수 있다)
 */
export async function loadGitMask(
  project: Pick<LoadedProject, 'root' | 'composePath'>,
  { dockerBin = 'docker', env = process.env, projectName, redact = (text: string) => text }: { dockerBin?: string; env?: NodeJS.ProcessEnv; projectName?: string; redact?: (text: string) => string } = {},
): Promise<Record<string, MaskVolume[]>> {
  const args = ['compose', ...(projectName ? ['--project-name', projectName] : []), '--profile', '*', '--project-directory', project.root, '--file', project.composePath, 'config', '--format', 'json'];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(dockerBin, args, { env, maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    throw new SandboxError('compose 설정을 읽지 못해 서비스 컨테이너의 .git 보호를 정할 수 없습니다', redact(typeof stderr === 'string' && stderr.trim() ? stderr : 'docker 실행 실패'));
  }
  let config: ComposeMountConfig;
  try {
    const parsed = JSON.parse(stdout) as Partial<ComposeMountConfig>;
    config = { services: parsed.services ?? {}, ...(parsed.volumes ? { volumes: parsed.volumes } : {}) };
  } catch {
    throw new SandboxError('compose 설정(config --format json)을 해석하지 못해 서비스 컨테이너의 .git 보호를 정할 수 없습니다');
  }
  return computeGitMask(project.root, config);
}
