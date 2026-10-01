/**
 * 폴더 열기(ADR-067)로 등록한 프로젝트의 원본 폴더를 원격(origin)과 맞춘다(ADR-101, "원격 main 받아오기").
 *
 * 세션은 저마다 작업 복사본(또는 내 폴더 세션은 원본 그 자체)에서 PR을 올리고 끝나지만, 원본 폴더의 브랜치는
 * 아무도 다시 받아오지 않는다 — 다른 사람이 그 PR을 원격에서 머지해도 원본 폴더의 main은 그 사실을 모른다.
 * 그 상태로 새 세션을 시작하면 이미 머지된 변경이 없는 낡은 main에서 또 시작하게 된다.
 *
 * 안전하게만 받는다: 작업 트리가 깨끗하고(커밋하지 않은 변경이 없고) fast-forward로만 받을 수 있을 때만 받는다.
 * `reset --hard`나 force는 쓰지 않는다 — 갈라졌으면(diverged) 사람에게 그대로 넘긴다.
 *
 * 같은 폴더를 겨냥한 `git fetch`가 동시에 둘 들어오면(예: 화면이 요청을 두 번 보내거나, 다른 탭에서 같은 프로젝트를
 * 열어 둔 경우) 둘 다 origin/main 참조를 갱신하려다 "cannot lock ref"로 실패할 수 있다. 폴더 경로별 뮤텍스로
 * 한 번에 하나씩만 돌리고, 그래도 다른 프로세스(사용자 터미널의 git 등)와 겹치면 한 번은 자동으로 다시 시도한다.
 */
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { StudioError } from './errors';

const execFileAsync = promisify(execFile);

/** 저장소 실제 경로별 뮤텍스. 같은 폴더를 겨냥한 fetch는 끝날 때까지 다음 호출을 줄 세운다 */
const repoLocks = new Map<string, Promise<void>>();

async function withRepoLock<T>(root: string, run: () => Promise<T>): Promise<T> {
  const key = await realpath(root).catch(() => path.resolve(root));
  const previous = repoLocks.get(key) ?? Promise.resolve();
  let release: () => void;
  // 이 호출이 끝났음을 알리는 신호(release를 부를 때까지 묶여 있는다) — run()이 던져도 이 자체는 거부되지 않는다
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const myTail = previous.then(() => mine);
  repoLocks.set(key, myTail);
  await previous;
  try {
    return await run();
  } finally {
    release!();
    // 내 뒤에 아무도 줄을 서지 않았으면(맵의 값이 여전히 내 자리) 비워 둔다 — 안 그러면 더는 안 쓸 Promise를 계속 들고 있는다
    if (repoLocks.get(key) === myTail) repoLocks.delete(key);
  }
}

const CANNOT_LOCK_REF = /cannot lock ref/i;

export interface RemoteMainCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
}

export interface FetchOriginMainResult {
  branch: string;
  /** up-to-date: 받을 커밋이 없다(이미 최신이거나 이 폴더가 더 앞서 있다). fast-forwarded: 받아서 작업 트리까지 갱신했다 */
  status: 'up-to-date' | 'fast-forwarded';
  /** 오래된 것부터. up-to-date면 빈 배열 */
  commits: RemoteMainCommit[];
  /** 이 호출을 시작할 때의 짧은 SHA. fast-forwarded면 shortSha와 다르다(지금 이 호출이 직접 받았든, 줄을 서는 동안 다른 호출이 먼저 받았든) */
  previousShortSha: string;
  /** 지금(끝난 뒤) 짧은 SHA */
  shortSha: string;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' },
  });
  return stdout;
}

/** 실패해도 멈추지 않을 확인(예: 원격이 없을 수 있다)에 쓴다 */
async function gitOrUndefined(root: string, args: string[]): Promise<string | undefined> {
  return git(root, args).then((out) => out, () => undefined);
}

/** 알려진 git 실패를 짧은 한국어 한 줄로 바꾼다. 원문은 StudioError.details로 따로 들고 다닌다(화면의 "자세히" 토글용) */
function describeGitFailure(raw: string): string {
  if (CANNOT_LOCK_REF.test(raw)) return '다른 작업이 같은 참조를 막 갱신하고 있어 받아오지 못했습니다. 잠시 후 다시 시도하세요';
  if (/could not resolve host|network is unreachable|temporary failure in name resolution|timed out/i.test(raw)) return '네트워크에 연결할 수 없습니다';
  if (/permission denied|authentication failed|could not read username|invalid credentials/i.test(raw)) return '원격 저장소에 접근할 권한이 없습니다(인증을 확인하세요)';
  if (/couldn'?t find remote ref|unknown revision/i.test(raw)) return '원격에서 브랜치를 찾지 못했습니다';
  return '원격 작업이 실패했습니다';
}

function gitError(prefix: string, error: unknown): StudioError {
  const raw = error instanceof Error ? error.message : String(error);
  return new StudioError(400, `${prefix}: ${describeGitFailure(raw)}`, raw);
}

/** 다른 git 프로세스가 참조를 쥐고 있던 틈을 한 번은 그냥 넘겨 보낸다(그 프로세스가 금방 끝나는 경우가 대부분이다) */
const LOCK_RETRY_DELAY_MS = 150;

/** cannot lock ref로 실패하면(다른 git 프로세스가 같은 참조를 막 갱신하던 중이었을 수 있다) 잠깐 기다렸다 한 번만 더 시도한다 */
async function fetchWithRetry(root: string, branch: string): Promise<void> {
  try {
    await git(root, ['fetch', '--quiet', '--no-tags', 'origin', branch]);
  } catch (first) {
    if (!CANNOT_LOCK_REF.test(first instanceof Error ? first.message : String(first))) throw gitError('원격에서 받아오지 못했습니다', first);
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
    await git(root, ['fetch', '--quiet', '--no-tags', 'origin', branch]).catch((second) => {
      throw gitError('원격에서 받아오지 못했습니다', second);
    });
  }
}

export async function fetchOriginMain(root: string): Promise<FetchOriginMainResult> {
  // project-registry.excludeFromGit과 같은 기준: 이 폴더 자체가 저장소 꼭대기여야 한다(모노레포의 하위 폴더를 연 것이 아니어야 한다).
  // git이 돌려주는 경로는 심볼릭 링크를 다 푼 실제 경로라, root도 같이 풀어야 한다(macOS의 /tmp→/private/tmp 등)
  const toplevel = await gitOrUndefined(root, ['rev-parse', '--show-toplevel']);
  const resolvedRoot = await realpath(root).catch(() => path.resolve(root));
  if (!toplevel || (await realpath(toplevel.trim()).catch(() => toplevel.trim())) !== resolvedRoot) {
    throw new StudioError(409, '이 프로젝트 폴더는 Git 저장소의 꼭대기가 아닙니다(Git 저장소가 아니거나, 더 큰 저장소의 하위 폴더일 수 있습니다)');
  }

  const originUrl = await gitOrUndefined(root, ['remote', 'get-url', 'origin']);
  if (!originUrl?.trim()) throw new StudioError(409, '이 프로젝트에는 원격(origin)이 없습니다');

  const branch = (await gitOrUndefined(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim();
  if (!branch) throw new StudioError(409, '지금 브랜치가 아니라 커밋을 바로 보고 있어서(detached HEAD) 받아올 브랜치를 정할 수 없습니다');

  // 락을 기다리는 동안(동시에 들어온 다른 요청이 먼저 처리되는 동안) main이 이미 받아와졌을 수 있다 — 그때도
  // "이미 최신"이 아니라 성공으로 보여주기 위해, 줄을 서기 전 지금 HEAD를 기억해 둔다
  const headBefore = (await git(root, ['rev-parse', 'HEAD'])).trim();

  return withRepoLock(root, () => fetchOriginMainLocked(root, branch, headBefore));
}

async function fetchOriginMainLocked(root: string, branch: string, headBefore: string): Promise<FetchOriginMainResult> {
  const dirty = (await git(root, ['status', '--porcelain=v1', '--untracked-files=normal'])).trim();
  if (dirty) throw new StudioError(409, '커밋하지 않은 변경이 있어 받아올 수 없습니다. 먼저 커밋하거나 되돌린 뒤 다시 시도하세요');

  await fetchWithRetry(root, branch);

  const localSha = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const remoteSha = (await gitOrUndefined(root, ['rev-parse', `origin/${branch}`]))?.trim();
  if (!remoteSha) throw new StudioError(409, `원격에 ${branch} 브랜치가 없습니다`);

  if (localSha !== remoteSha) {
    if (!(await isAncestor(root, localSha, remoteSha))) {
      // 이 폴더가 원격보다 앞서 있을 뿐이면(아직 올리지 않은 커밋) 받아올 것이 없는 정상 상태다 — 그대로 둔다
      if (!(await isAncestor(root, remoteSha, localSha))) {
        throw new StudioError(409, `이 폴더의 ${branch}가 원격과 다르게 갈라졌습니다(fast-forward로 받을 수 없습니다). 직접 병합하거나 되돌린 뒤 다시 시도하세요`);
      }
    } else {
      await git(root, ['merge', '--ff-only', remoteSha]).catch((error) => {
        throw gitError('받아온 커밋을 fast-forward로 합치지 못했습니다', error);
      });
    }
  }

  const finalSha = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const previousShortSha = (await git(root, ['rev-parse', '--short', headBefore])).trim();
  if (finalSha === headBefore) return { branch, status: 'up-to-date', commits: [], previousShortSha, shortSha: previousShortSha };
  // 지금 이 호출이 직접 합쳤든, 락을 기다리는 사이 다른 호출이 먼저 합쳐 놓았든 사용자에게는 똑같이 성공으로 보여준다
  const shortSha = (await git(root, ['rev-parse', '--short', finalSha])).trim();
  return { branch, status: 'fast-forwarded', commits: await listCommits(root, headBefore, finalSha), previousShortSha, shortSha };
}

async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  return git(root, ['merge-base', '--is-ancestor', ancestor, descendant]).then(() => true, () => false);
}

async function listCommits(root: string, from: string, to: string): Promise<RemoteMainCommit[]> {
  const out = await git(root, ['log', '--reverse', '--format=%H%x00%h%x00%s%x00%an%x1e', `${from}..${to}`]);
  return out
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha, shortSha, subject, author] = entry.split('\x00');
      return { sha: sha ?? '', shortSha: shortSha ?? '', subject: subject ?? '', author: author ?? '' };
    });
}
