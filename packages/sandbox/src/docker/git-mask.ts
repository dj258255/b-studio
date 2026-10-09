import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LoadedProject } from '@b-studio/spec';
import { SandboxError } from '../errors';
import { bindMounts, type BindMount } from './relay';

const execFileAsync = promisify(execFile);

/**
 * 서비스 컨테이너가 프로젝트 폴더의 `.git`을 쓰지 못하게 하는 마운트 계획(ADR-158).
 *
 * 작업 복사본 전체가 서비스 컨테이너에 읽기·쓰기로 마운트되면 컨테이너 안 명령이 `.git`을 고칠 수 있다. `.git`에는
 * 체크포인트 저장소(근거 판정이 믿는 기준)와 b-studio의 상태 폴더(`.git/b-studio`: 세션 기록, 테스트 근거, 미리보기 토큰)가 있어
 * 에이전트가 근거를 위조할 수 있었다. 서비스가 프로젝트를 마운트한 자리마다 더 구체적인 경로의 마운트를 겹쳐 막는다
 * (Docker는 더 깊은 경로의 마운트를 위에 얹는다)
 *  - `.git` 자체: 읽기 전용. 빌드가 git 정보를 읽는 경우는 그대로 된다
 *  - `.git/b-studio`: 빈 tmpfs. 읽지도 못한다
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

/** compose의 긴 문법 마운트 한 개. override의 services.<이름>.volumes에 그대로 적는다 */
export type MaskVolume =
  | { type: 'bind'; source: string; target: string; read_only: true; bind: { create_host_path: false } }
  | { type: 'tmpfs'; target: string };

const GIT = '.git';
const STATE = 'b-studio';

/**
 * 판정을 순수 함수로 둔 계획. 서비스 이름 → 그 서비스에 덧붙일 마운트.
 *  - 서비스가 `.git`이 든 폴더(또는 그 상위)를 마운트하면 그 안의 `.git`을 읽기 전용으로, 상태 폴더는 tmpfs로 덮는다
 *  - 서비스가 `.git` 안쪽(`.git`, `.git/b-studio`, 그 하위)을 직접 마운트하면 같은 자리에서 읽기 전용(상태 폴더는 tmpfs)으로 바꾼다
 *  - 서비스가 프로젝트의 하위 폴더만 마운트해 `.git`이 보이지 않으면 아무것도 하지 않는다
 *  - `.git`이 없으면 아무것도 하지 않는다
 * 마운트의 source·target은 `docker compose config --format json`이 정규화한 값(절대 경로)이다
 */
export function planGitMask(mounts: readonly Pick<BindMount, 'service' | 'source' | 'target'>[], entries: readonly GitEntry[]): Record<string, MaskVolume[]> {
  const plan = new Map<string, Map<string, MaskVolume>>();
  const add = (service: string, volume: MaskVolume) => {
    const volumes = plan.get(service) ?? new Map<string, MaskVolume>();
    // 같은 자리를 둘 이상의 규칙이 덮으면 더 강한 쪽(tmpfs)이 남는다
    if (volumes.get(volume.target)?.type !== 'tmpfs') volumes.set(volume.target, volume);
    plan.set(service, volumes);
  };

  for (const mount of mounts) {
    const source = path.resolve(mount.source);
    for (const entry of entries) {
      const git = path.join(entry.dir, GIT);
      const state = path.join(git, STATE);
      if (isInside(source, entry.dir)) {
        // 이 마운트 안에 `.git`이 보인다
        const containerGit = path.posix.join(mount.target, toPosix(path.relative(source, git)));
        add(mount.service, { type: 'bind', source: git, target: containerGit, read_only: true, bind: { create_host_path: false } });
        if (entry.kind === 'directory' && entry.hasState) add(mount.service, { type: 'tmpfs', target: path.posix.join(containerGit, STATE) });
      } else if (isInside(git, source)) {
        // `.git` 안쪽을 직접 마운트했다. 같은 자리(target)의 마운트를 바꿔 쓴다
        if (isInside(state, source)) add(mount.service, { type: 'tmpfs', target: mount.target });
        else add(mount.service, { type: 'bind', source, target: mount.target, read_only: true, bind: { create_host_path: false } });
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

/**
 * `docker compose config --format json`의 services에서 바인드 마운트를 읽어 서비스별 마스크 마운트를 계산한다.
 * 마운트 소스는 심볼릭 링크를 풀어 `.git` 위치와 같은 꼴로 맞춘다
 */
export async function computeGitMask(
  projectRoot: string,
  services: Parameters<typeof bindMounts>[0],
): Promise<Record<string, MaskVolume[]>> {
  const mounts = await Promise.all(bindMounts(services, new Set()).map(async (mount) => ({ ...mount, source: await real(mount.source) })));
  const entries = await detectGitEntries(projectRoot, mounts.map((mount) => mount.source));
  // 상태 폴더가 아직 없으면 미리 빈 폴더로 만들어 둔다. tmpfs를 얹으려면 마운트 지점이 있어야 하고(읽기 전용 `.git` 아래에서는 만들 수 없다),
  // 없다고 건너뛰면 나중에 b-studio가 만든 폴더가 컨테이너에 그대로 보인다. 만들지 못하면 보호 없이 띄우지 않고 멈춘다
  for (const entry of entries) {
    if (entry.kind !== 'directory' || entry.hasState) continue;
    try {
      await mkdir(path.join(entry.dir, GIT, STATE), { recursive: true });
    } catch (error) {
      throw new SandboxError(`${path.join(entry.dir, GIT, STATE)} 폴더를 만들지 못해 상태 폴더를 가릴 수 없습니다`, error instanceof Error ? error.message : String(error));
    }
    entry.hasState = true;
  }
  return planGitMask(mounts, entries);
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
 * 보호 없이 띄우지 않고 멈춘다 — 같은 compose 파일을 읽지 못하면 `up`도 어차피 실패한다
 */
export async function loadGitMask(
  project: Pick<LoadedProject, 'root' | 'composePath'>,
  { dockerBin = 'docker', env = process.env }: { dockerBin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<Record<string, MaskVolume[]>> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(dockerBin, ['compose', '--profile', '*', '--project-directory', project.root, '--file', project.composePath, 'config', '--format', 'json'], {
      env,
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (error) {
    throw new SandboxError('compose 설정을 읽지 못해 서비스 컨테이너의 .git 보호를 정할 수 없습니다', error instanceof Error ? error.message : String(error));
  }
  let services: Parameters<typeof computeGitMask>[1];
  try {
    services = (JSON.parse(stdout) as { services?: typeof services }).services ?? {};
  } catch {
    throw new SandboxError('compose 설정(config --format json)을 해석하지 못해 서비스 컨테이너의 .git 보호를 정할 수 없습니다');
  }
  return computeGitMask(project.root, services);
}
