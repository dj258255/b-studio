import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * `next dev`로 뜬 개발 서버는 메인 체크아웃(apps/studio)에서 돈다. 이 프로세스가 떠 있는 동안 누군가
 * `git pull`을 하면 세션이 들고 있는 클래스 인스턴스는 옛 코드 그대로인데(예: "commitPaths is not a
 * function") 화면은 아무 것도 모른다. 부팅 시점의 커밋을 한 번만 기록해 두고 지금 커밋과 비교해, 바뀌었으면
 * 화면이 "앱을 다시 시작하세요"를 알릴 수 있게 한다. 운영 빌드(`next build && next start`)에서는
 * `isDevMode`가 false라 아무 것도 읽지 않는다.
 */
export interface DevStatus {
  /** 부팅 시점(이 모듈을 처음 쓸 때)의 커밋(짧은 해시) */
  bootHead: string;
  /** 지금 커밋. 확인할 수 없으면(일시적인 git 오류 등) bootHead와 같다고 본다 */
  headNow: string;
  /** 코드가 바뀌었는가(bootHead !== headNow) */
  codeChanged: boolean;
  /** 부팅 뒤 pnpm-lock.yaml이 바뀌었는가(다시 시작할 때 설치가 필요하다는 뜻) */
  lockfileChanged: boolean;
}

/** 테스트가 git·파일시스템을 실제로 부르지 않고 갈아 끼울 수 있게 하는 바깥 세계 */
export interface DevStatusDeps {
  /** 지금 커밋(짧은 해시). git 저장소가 아니면(운영 빌드 등) undefined */
  gitHead: () => Promise<string | undefined>;
  /** pnpm-lock.yaml의 해시. 읽지 못하면 undefined */
  lockfileHash: () => Promise<string | undefined>;
  isDevMode: () => boolean;
}

/** 테스트가 process.env 대신 필요한 값만 넘길 수 있게 좁힌 형태(auth.ts의 Env와 같은 결) */
type Env = Record<string, string | undefined>;

/** `next build`로 만든 운영 빌드에서는 아무 것도 하지 않는다 — next dev만 NODE_ENV를 development로 둔다 */
export function isDevMode(env: Env = process.env): boolean {
  return env.NODE_ENV !== 'production';
}

/** apps/studio에서 두 단계 위 — 모노레포 루트(.git·pnpm-lock.yaml이 있는 곳). 실행 시점에만 정해지는 경로다 */
function repoRoot(): string {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), '../..');
}

async function realGitHead(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot() });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function realLockfileHash(): Promise<string | undefined> {
  try {
    const content = await readFile(/* turbopackIgnore: true */ path.join(repoRoot(), 'pnpm-lock.yaml'));
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return undefined;
  }
}

export const realDevStatusDeps: DevStatusDeps = { gitHead: realGitHead, lockfileHash: realLockfileHash, isDevMode };

let boot: { head: string; lockHash: string | undefined } | undefined;

/** 부팅 시점 값을 한 번만 읽어 둔다(그 뒤로는 요청마다 git을 다시 부르지 않는다) */
async function bootState(deps: DevStatusDeps): Promise<{ head: string; lockHash: string | undefined } | undefined> {
  if (boot !== undefined) return boot;
  const head = await deps.gitHead();
  if (head === undefined) return undefined;
  boot = { head, lockHash: await deps.lockfileHash() };
  return boot;
}

/** 지금 상태를 부팅 시점과 비교한다. 운영 빌드거나 git 저장소를 찾을 수 없으면 undefined */
export async function currentDevStatus(deps: DevStatusDeps = realDevStatusDeps): Promise<DevStatus | undefined> {
  if (!deps.isDevMode()) return undefined;
  const base = await bootState(deps);
  if (base === undefined) return undefined;
  const headNow = (await deps.gitHead()) ?? base.head;
  const lockNow = await deps.lockfileHash();
  return { bootHead: base.head, headNow, codeChanged: headNow !== base.head, lockfileChanged: lockNow !== base.lockHash };
}

/** 테스트 전용: 부팅 캐시를 비워 다음 호출이 deps를 다시 읽게 한다 */
export function resetDevStatusBootCache(): void {
  boot = undefined;
}
