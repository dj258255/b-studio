import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { SANDBOX_ID } from '../sandbox-id';

const execFileAsync = promisify(execFile);

/** b-studio가 만든 공유 캐시 볼륨에 붙는 라벨. 다음 세션의 기동 속도가 여기에 달려 있어 지우지 않는다 */
const CACHE_LABEL = 'b-studio.cache';

/** 샌드박스 id 패턴에서 앞뒤 앵커(`^`·`$`)를 뗀 몸통 */
const SANDBOX_ID_BODY = SANDBOX_ID.source.slice(1, -1);

/**
 * 이미지 이름 앞부분의 샌드박스 id. compose가 `<샌드박스 id>-<서비스>` 로 만든다.
 * `[a-z0-9-]` 를 최소 일치(`*?`)로 써야 서비스 이름에 하이픈이 있어도 id 를 잘못 자르지 않는다.
 * 탐욕적으로 맞추면 `studio-orders-1a2b3c-facade-api:latest` 의 `facade`(16진수 6자리)를 id 로 읽어
 * 실행 중인 샌드박스의 이미지를 삭제 대상으로 만든다
 */
const SANDBOX_IMAGE = new RegExp(`^(${SANDBOX_ID_BODY.replace('[a-z0-9-]*', '[a-z0-9-]*?')})-`);

export interface SandboxLeftovers {
  /** 컨테이너 이름 */
  containers: string[];
  /** 이미지 `repo:tag` */
  images: string[];
  /** 볼륨 이름 */
  volumes: string[];
  /** 네트워크 이름 */
  networks: string[];
}

export interface PruneOptions {
  /** docker 실행 파일 경로 (기본: PATH의 docker) */
  dockerBin?: string;
  /** true면 지울 목록만 구하고 아무것도 지우지 않는다 */
  dryRun?: boolean;
  /** 자원을 모은 직후·지우기 직전에 한 번 부른다. 보여 준 목록과 지우는 대상이 어긋나지 않게 한다 */
  onFound?: (found: SandboxLeftovers) => void;
}

export interface PruneResult {
  /** 지울 대상으로 찾은 자원 */
  found: SandboxLeftovers;
  /** 실제로 지운 자원. `dryRun` 이면 비어 있다 */
  removed: SandboxLeftovers;
  /** 건드리지 않고 넘어간 자원과 그 이유 */
  skipped: Array<{ resource: string; reason: string }>;
}

const KINDS: ReadonlyArray<{ kind: keyof SandboxLeftovers; args: string[] }> = [
  { kind: 'containers', args: ['rm'] },
  { kind: 'images', args: ['image', 'rm'] },
  { kind: 'volumes', args: ['volume', 'rm'] },
  { kind: 'networks', args: ['network', 'rm'] },
];

function emptyLeftovers(): SandboxLeftovers {
  return { containers: [], images: [], volumes: [], networks: [] };
}

function isSandboxProject(project: string): boolean {
  return SANDBOX_ID.test(project);
}

/** 컨테이너·볼륨·네트워크 목록에서 `<이름>\t<compose 프로젝트>\t...` 를 읽는다 */
function parseLabelled(stdout: string): Array<{ name: string; project: string; labels: string[] }> {
  return stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [name = '', project = '', ...labels] = line.split('\t').map((field) => field.trim());
      return { name, project, labels };
    })
    .filter((entry) => entry.name);
}

/** 지금 살아 있는 샌드박스의 compose 프로젝트 이름. 이 프로젝트들의 자원은 건드리지 않는다 */
async function runningProjects(dockerBin: string): Promise<Set<string>> {
  const { stdout } = await execFileAsync(dockerBin, ['ps', '--format', '{{.Label "com.docker.compose.project"}}'], { cwd: tmpdir() });
  return new Set(stdout.split('\n').map((line) => line.trim()).filter(Boolean));
}

/**
 * b-studio가 만들었지만 쓰지 않는 자원을 찾는다. 남의 자원을 지우지 않도록 다음을 지킨다.
 * - 이름이 `studio-<프로젝트>-<6자리 16진수>` 형태인 compose 프로젝트의 자원만 대상으로 한다
 * - `b-studio.cache=true` 공유 캐시 볼륨과 compose 라벨이 없는 익명 볼륨은 건드리지 않는다
 * - 지금 실행 중인 샌드박스의 자원은 건드리지 않는다
 */
async function collectLeftovers(dockerBin: string): Promise<{ found: SandboxLeftovers; skipped: PruneResult['skipped'] }> {
  const [running, containers, images, volumes, networks] = await Promise.all([
    runningProjects(dockerBin),
    execFileAsync(dockerBin, ['ps', '-a', '--format', '{{.Names}}\t{{.Label "com.docker.compose.project"}}'], { cwd: tmpdir() }).then(({ stdout }) => stdout),
    execFileAsync(dockerBin, ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'], { cwd: tmpdir() }).then(({ stdout }) => stdout),
    execFileAsync(dockerBin, ['volume', 'ls', '--format', `{{.Name}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "${CACHE_LABEL}"}}`], { cwd: tmpdir() }).then(({ stdout }) => stdout),
    execFileAsync(dockerBin, ['network', 'ls', '--format', '{{.Name}}\t{{.Label "com.docker.compose.project"}}'], { cwd: tmpdir() }).then(({ stdout }) => stdout),
  ]);

  const found = emptyLeftovers();
  const skipped: PruneResult['skipped'] = [];

  for (const { name, project } of parseLabelled(containers)) {
    if (!isSandboxProject(project)) continue;
    if (running.has(project)) skipped.push({ resource: name, reason: '실행 중' });
    else found.containers.push(name);
  }

  for (const image of images.split('\n').map((line) => line.trim()).filter(Boolean)) {
    const sandbox = SANDBOX_IMAGE.exec(image)?.[1];
    if (!sandbox) continue;
    // 정규식이 어긋나 id 를 잘못 잘라도, 실행 중인 샌드박스 이름으로 시작하는 이미지는 건드리지 않는다
    if (running.has(sandbox) || [...running].some((project) => image.startsWith(`${project}-`))) {
      skipped.push({ resource: image, reason: '실행 중' });
    } else {
      found.images.push(image);
    }
  }

  for (const { name, project, labels } of parseLabelled(volumes)) {
    if (labels[0] === 'true') {
      skipped.push({ resource: name, reason: '공유 캐시 볼륨' });
      continue;
    }
    // 어느 프로젝트가 만들었는지 알 수 없는 볼륨은 지우지 않는다
    if (!project) {
      skipped.push({ resource: name, reason: 'compose 라벨 없음' });
      continue;
    }
    if (!isSandboxProject(project)) continue;
    if (running.has(project)) skipped.push({ resource: name, reason: '실행 중' });
    else found.volumes.push(name);
  }

  for (const { name, project } of parseLabelled(networks)) {
    if (!isSandboxProject(project)) continue;
    if (running.has(project)) skipped.push({ resource: name, reason: '실행 중' });
    else found.networks.push(name);
  }

  return { found, skipped };
}

/** b-studio가 만들었지만 쓰지 않는 Docker 자원을 찾는다. 아무것도 지우지 않는다 */
export async function findSandboxLeftovers(options: PruneOptions = {}): Promise<SandboxLeftovers> {
  return (await collectLeftovers(options.dockerBin ?? 'docker')).found;
}

/**
 * b-studio가 만들었지만 쓰지 않는 Docker 자원을 찾아 지운다.
 * 하나를 지우다 실패해도 나머지는 계속 지우고, 지우지 못한 자원은 이유와 함께 `skipped` 에 남긴다.
 * 강제 삭제(`-f`)를 쓰지 않으므로 사용 중인 자원은 지워지지 않는다
 */
export async function pruneSandboxLeftovers(options: PruneOptions = {}): Promise<PruneResult> {
  const dockerBin = options.dockerBin ?? 'docker';
  const { found, skipped } = await collectLeftovers(dockerBin);
  options.onFound?.(found);
  const removed = emptyLeftovers();
  if (options.dryRun) return { found, removed, skipped };

  for (const { kind, args } of KINDS) {
    for (const name of found[kind]) {
      try {
        await execFileAsync(dockerBin, [...args, name], { cwd: tmpdir() });
        removed[kind].push(name);
      } catch (error) {
        skipped.push({ resource: name, reason: failureReason(error) });
      }
    }
  }

  return { found, removed, skipped };
}

/** docker 명령이 실패한 이유. 여러 줄이면 첫 줄만 남긴다 */
function failureReason(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim().split('\n')[0]!;
  return error instanceof Error ? error.message : String(error);
}
