import { spawnSync } from 'node:child_process';

export interface GitState {
  /** 전체 해시. 짧은 해시는 저장소가 커지면 겹칠 수 있다 */
  commit: string;
  shortCommit: string;
  /** 커밋하지 않은 변경이 있었는지. git을 읽지 못하면 'unknown' */
  dirty: boolean | 'unknown';
  /** 변경된 경로(`git status --porcelain` 순서). 결과를 해석할 때 어느 파일이 커밋 밖이었는지 본다 */
  dirtyFiles: string[];
}

const UNKNOWN = '알 수 없음';

/**
 * 벤치를 돌린 코드 상태(이슈 #704). 예전에는 짧은 해시만 남겨, 작업 트리가 깨끗했는지는 보고서에 손으로 적었다(E2)
 */
export function gitState(cwd: string = process.cwd()): GitState {
  const run = (...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const head = run('rev-parse', 'HEAD');
  const short = run('rev-parse', '--short', 'HEAD');
  if (head.status !== 0 || short.status !== 0) return { commit: UNKNOWN, shortCommit: UNKNOWN, dirty: 'unknown', dirtyFiles: [] };
  const status = run('status', '--porcelain', '-z', '--untracked-files=all');
  if (status.status !== 0) return { commit: head.stdout.trim(), shortCommit: short.stdout.trim(), dirty: 'unknown', dirtyFiles: [] };
  // -z 형식: "XY 경로\0", 이름 바꾸기는 뒤에 원래 경로가 하나 더 온다
  const entries = status.stdout.split('\0').filter(Boolean);
  const dirtyFiles: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    dirtyFiles.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C') index++;
  }
  return { commit: head.stdout.trim(), shortCommit: short.stdout.trim(), dirty: dirtyFiles.length > 0, dirtyFiles };
}
