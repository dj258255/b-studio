import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioError } from './errors';
import { fetchOriginMain } from './project-source-sync';

const execFileAsync = promisify(execFile);
const made: string[] = [];

async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-origin-main-'));
  made.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  return stdout.trim();
}

/** 원격(bare) 저장소와, 거기서 클론한 "폴더 열기"로 연 원본 폴더를 만든다 */
async function setupRepo(): Promise<{ remote: string; root: string }> {
  const base = await tmp();
  const remote = path.join(base, 'origin.git');
  const root = path.join(base, 'project');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', root]);
  await writeFile(path.join(root, 'README.md'), '# hi\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '-q', '-m', 'init');
  await git(root, 'remote', 'add', 'origin', remote);
  await git(root, 'push', '-q', 'origin', 'main');
  return { remote, root };
}

/** 다른 클론으로 원격의 main에 커밋 하나를 더 올린다(= PR이 머지된 상황을 흉내 낸다) */
async function pushToRemote(remote: string, file: string, content: string, message: string): Promise<void> {
  const other = await tmp();
  await execFileAsync('git', ['clone', '-q', '--branch', 'main', remote, other]);
  await writeFile(path.join(other, file), content);
  await git(other, 'add', '-A');
  await git(other, 'commit', '-q', '-m', message);
  await git(other, 'push', '-q', 'origin', 'main');
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('fetchOriginMain(ADR-101, 원격 main 받아오기)', () => {
  it('Git 저장소가 아니면 거부한다', async () => {
    const root = await tmp();
    await expect(fetchOriginMain(root)).rejects.toThrow(/Git 저장소/);
  });

  it(
    '저장소의 하위 폴더(꼭대기가 아님)는 거부한다',
    async () => {
      const { root } = await setupRepo();
      const sub = path.join(root, 'apps', 'web');
      await mkdir(sub, { recursive: true });
      await expect(fetchOriginMain(sub)).rejects.toThrow(/꼭대기/);
    },
    15_000,
  );

  it(
    'origin이 없으면 거부한다',
    async () => {
      const base = await tmp();
      const root = path.join(base, 'solo');
      await execFileAsync('git', ['init', '-q', '-b', 'main', root]);
      await writeFile(path.join(root, 'a.txt'), 'a');
      await git(root, 'add', '-A');
      await git(root, 'commit', '-q', '-m', 'init');
      await expect(fetchOriginMain(root)).rejects.toThrow(/원격\(origin\)이 없습니다/);
    },
    15_000,
  );

  it(
    '커밋하지 않은 변경이 있으면 거부한다(작업 트리가 깨끗해야 한다)',
    async () => {
      const { root } = await setupRepo();
      await writeFile(path.join(root, 'README.md'), '# 손으로 고친 내용\n');
      await expect(fetchOriginMain(root)).rejects.toThrow(/커밋하지 않은 변경/);
    },
    15_000,
  );

  it(
    '받을 커밋이 없으면 up-to-date다',
    async () => {
      const { root } = await setupRepo();
      const result = await fetchOriginMain(root);
      expect(result).toMatchObject({ branch: 'main', status: 'up-to-date', commits: [] });
      expect(result.previousShortSha).toBe(result.shortSha);
    },
    15_000,
  );

  it(
    '이 폴더가 원격보다 앞서 있을 뿐이면(커밋했지만 아직 안 올림) up-to-date로 본다(거부하지 않는다)',
    async () => {
      const { root } = await setupRepo();
      await writeFile(path.join(root, 'local-only.txt'), '아직 안 올린 변경\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '-q', '-m', '아직 안 올림');

      const result = await fetchOriginMain(root);
      expect(result).toMatchObject({ branch: 'main', status: 'up-to-date', commits: [] });
    },
    15_000,
  );

  it(
    '원격에 새 커밋이 있으면 fast-forward로 받아오고, 받은 커밋 목록과 작업 트리 내용을 돌려준다',
    async () => {
      const { remote, root } = await setupRepo();
      const before = await git(root, 'rev-parse', '--short', 'HEAD');
      await pushToRemote(remote, 'CHANGELOG.md', '# changes\n', 'PR 머지됨');

      const result = await fetchOriginMain(root);

      expect(result.branch).toBe('main');
      expect(result.status).toBe('fast-forwarded');
      expect(result.commits).toHaveLength(1);
      expect(result.commits[0]).toMatchObject({ subject: 'PR 머지됨' });
      await expect(readFile(path.join(root, 'CHANGELOG.md'), 'utf8')).resolves.toBe('# changes\n');
      // 화면이 "main을 <old>→<new>로 받아왔습니다"를 보여줄 수 있게 받아오기 전후 짧은 SHA를 함께 돌려준다
      expect(result.previousShortSha).toBe(before);
      expect(result.shortSha).toBe(await git(root, 'rev-parse', '--short', 'HEAD'));
      expect(result.previousShortSha).not.toBe(result.shortSha);
    },
    15_000,
  );

  it(
    '같은 폴더를 동시에 두 번 받아오면(화면이 요청을 두 번 보내는 등) 참조 잠금 경합 없이 둘 다 끝나고, ' +
      '줄을 서느라 늦게 처리된 쪽도 "이미 최신"이 아니라 실제로 받아온 커밋을 성공으로 보여준다',
    async () => {
      const { remote, root } = await setupRepo();
      const before = await git(root, 'rev-parse', '--short', 'HEAD');
      await pushToRemote(remote, 'CHANGELOG.md', '# changes\n', 'PR 머지됨');

      const [first, second] = await Promise.all([fetchOriginMain(root), fetchOriginMain(root)]);

      // 둘 다 "cannot lock ref"로 깨지지 않고 끝나야 하고(이 테스트는 그 자체로 그것을 검증한다 — 하나라도 던지면 실패한다),
      // 둘 다 같은 커밋을 성공으로 보여줘야 한다(둘 중 하나가 "이미 최신"으로 조용히 끝나면 안 된다)
      for (const result of [first, second]) {
        expect(result.status).toBe('fast-forwarded');
        expect(result.commits.map((commit) => commit.subject)).toEqual(['PR 머지됨']);
        expect(result.previousShortSha).toBe(before);
        expect(result.shortSha).toBe(await git(root, 'rev-parse', '--short', 'HEAD'));
      }
    },
    15_000,
  );

  it(
    '여러 커밋이 머지됐으면 오래된 것부터 모두 돌려준다',
    async () => {
      const { remote, root } = await setupRepo();
      await pushToRemote(remote, 'a.txt', 'a\n', '첫 번째 PR');
      await pushToRemote(remote, 'b.txt', 'b\n', '두 번째 PR');

      const result = await fetchOriginMain(root);

      expect(result.status).toBe('fast-forwarded');
      expect(result.commits.map((commit) => commit.subject)).toEqual(['첫 번째 PR', '두 번째 PR']);
    },
    15_000,
  );

  it(
    '로컬과 원격이 다르게 갈라졌으면(fast-forward 불가능) 거부하고 아무것도 바꾸지 않는다',
    async () => {
      const { remote, root } = await setupRepo();
      await pushToRemote(remote, 'remote-change.txt', '원격 변경\n', '원격에서 바뀜');
      await writeFile(path.join(root, 'local-change.txt'), '로컬 변경\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '-q', '-m', '로컬에서 바뀜');

      const before = await git(root, 'rev-parse', 'HEAD');
      await expect(fetchOriginMain(root)).rejects.toThrow(/갈라졌습니다/);
      expect(await git(root, 'rev-parse', 'HEAD')).toBe(before);
    },
    15_000,
  );

  it(
    'detached HEAD면 받아올 브랜치를 정할 수 없다고 거부한다',
    async () => {
      const { root } = await setupRepo();
      const head = await git(root, 'rev-parse', 'HEAD');
      await git(root, 'checkout', '-q', head);
      await expect(fetchOriginMain(root)).rejects.toThrow(/브랜치가 아니라 커밋/);
    },
    15_000,
  );

  it('StudioError로 거부해 HTTP 상태 코드를 그대로 쓸 수 있다', async () => {
    const root = await tmp();
    await expect(fetchOriginMain(root)).rejects.toBeInstanceOf(StudioError);
  });

  it(
    '다른 git 프로세스가 origin/main 참조를 잠깐 쥐고 있었어도(cannot lock ref) 한 번 더 시도해 받아온다',
    async () => {
      const { remote, root } = await setupRepo();
      // 로컬의 origin/main 추적 참조를 먼저 만들어 둔다(이 커밋을 가리킨다). pushToRemote로 원격만 앞서가게 해
      // 다음 fetch가 실제로 이 참조를 옮기려다 잠금과 부딪히게 만든다
      await git(root, 'fetch', '-q', '--no-tags', 'origin', 'main');
      await pushToRemote(remote, 'CHANGELOG.md', '# changes\n', 'PR 머지됨');

      const lockFile = path.join(root, '.git', 'refs', 'remotes', 'origin', 'main.lock');
      await writeFile(lockFile, '');
      // 첫 시도가 잠금에 걸려 실패할 시간을 준 뒤, 재시도 사이의 대기 시간(LOCK_RETRY_DELAY_MS) 안에 잠금을 치워
      // "다른 프로세스가 막 끝낸" 상황을 흉내 낸다
      const clearLock = new Promise((resolve) => setTimeout(resolve, 60)).then(() => rm(lockFile, { force: true }));

      const result = await fetchOriginMain(root);
      await clearLock;

      expect(result.status).toBe('fast-forwarded');
      expect(result.commits.map((commit) => commit.subject)).toEqual(['PR 머지됨']);
    },
    15_000,
  );
});
