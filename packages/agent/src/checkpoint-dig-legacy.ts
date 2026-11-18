import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { native } from '@b-studio/sandbox';

/**
 * D1c 이전 `packages/agent/src/checkpoints.ts`의 `findNestedGitRepos`·`isDotGit`을 그대로 옮긴 것(차등 시험 기준값).
 * 시험만 import한다. 지금 구현은 `crates/bstudio-io/src/checkpoint_local.rs`의 `walk_repos`가 한다.
 */
function isDotGit(name: string): boolean {
  return native.checkpointIsDotGit(name);
}

export async function legacyFindNestedGitRepos(
  root: string,
  top: string | undefined,
  partitionIgnored: (relDirs: string[]) => Promise<Set<string>>,
  limit = 100,
): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (found.length >= limit) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 읽을 수 없는 폴더는 건너뛴다(권한 등)
    }
    const subdirs: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (isDotGit(entry.name)) {
        if (top === undefined || path.resolve(full) !== top) found.push(path.relative(root, full));
        continue; // .git 안으로는 들어가지 않는다
      }
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      subdirs.push(full);
    }
    if (found.length >= limit || subdirs.length === 0) return;
    const ignored = await partitionIgnored(subdirs.map((sub) => path.relative(root, sub)));
    for (const sub of subdirs) {
      if (found.length >= limit) return;
      if (!ignored.has(path.relative(root, sub))) await walk(sub);
    }
  };
  await walk(root);
  return found;
}
