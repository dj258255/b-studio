/**
 * 폴더 열기(ADR-067)로 등록한 프로젝트의 원본 폴더를 원격(origin)과 맞춘다(ADR-0XX, "원격 main 받아오기").
 *
 * 세션은 저마다 작업 복사본(또는 내 폴더 세션은 원본 그 자체)에서 PR을 올리고 끝나지만, 원본 폴더의 브랜치는
 * 아무도 다시 받아오지 않는다 — 다른 사람이 그 PR을 원격에서 머지해도 원본 폴더의 main은 그 사실을 모른다.
 * 그 상태로 새 세션을 시작하면 이미 머지된 변경이 없는 낡은 main에서 또 시작하게 된다.
 *
 * 안전하게만 받는다: 작업 트리가 깨끗하고(커밋하지 않은 변경이 없고) fast-forward로만 받을 수 있을 때만 받는다.
 * `reset --hard`나 force는 쓰지 않는다 — 갈라졌으면(diverged) 사람에게 그대로 넘긴다.
 */
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { StudioError } from './errors';

const execFileAsync = promisify(execFile);

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

  const dirty = (await git(root, ['status', '--porcelain=v1', '--untracked-files=normal'])).trim();
  if (dirty) throw new StudioError(409, '커밋하지 않은 변경이 있어 받아올 수 없습니다. 먼저 커밋하거나 되돌린 뒤 다시 시도하세요');

  await git(root, ['fetch', '--quiet', '--no-tags', 'origin', branch]).catch((error) => {
    throw new StudioError(400, `원격에서 받아오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  });

  const localSha = (await git(root, ['rev-parse', 'HEAD'])).trim();
  const remoteSha = (await gitOrUndefined(root, ['rev-parse', `origin/${branch}`]))?.trim();
  if (!remoteSha) throw new StudioError(409, `원격에 ${branch} 브랜치가 없습니다`);
  if (localSha === remoteSha) return { branch, status: 'up-to-date', commits: [] };

  const localIsAncestor = await isAncestor(root, localSha, remoteSha);
  if (!localIsAncestor) {
    // 이 폴더가 원격보다 앞서 있을 뿐이면(아직 올리지 않은 커밋) 받아올 것이 없는 정상 상태다
    if (await isAncestor(root, remoteSha, localSha)) return { branch, status: 'up-to-date', commits: [] };
    throw new StudioError(409, `이 폴더의 ${branch}가 원격과 다르게 갈라졌습니다(fast-forward로 받을 수 없습니다). 직접 병합하거나 되돌린 뒤 다시 시도하세요`);
  }

  const commits = await listCommits(root, localSha, remoteSha);
  await git(root, ['merge', '--ff-only', remoteSha]).catch((error) => {
    throw new StudioError(400, `fast-forward 병합에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
  });
  return { branch, status: 'fast-forwarded', commits };
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
