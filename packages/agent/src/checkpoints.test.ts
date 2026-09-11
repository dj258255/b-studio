import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointError, CheckpointStore, redactCredentials, RemoteConflictError } from './checkpoints';

const execFileAsync = promisify(execFile);

let root: string;
const savedEnv = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'checkpoints-test-'));
  // 개발자 PC의 전역 git 설정에 영향받지 않도록 빈 설정으로 시작한다
  const globalConfig = path.join(root, '..', `${path.basename(root)}.gitconfig`);
  await writeFile(globalConfig, '');
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';

  await mkdir(path.join(root, 'api/src'), { recursive: true });
  await writeFile(path.join(root, 'api/src/Order.java'), 'class Order {}\n');
});

afterEach(() => {
  process.env.GIT_CONFIG_GLOBAL = savedEnv.global;
  process.env.GIT_CONFIG_NOSYSTEM = savedEnv.nosystem;
  if (savedEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  if (savedEnv.nosystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
});

const write = (file: string, content: string) => writeFile(path.join(root, file), content);
const read = (file: string) => readFile(path.join(root, file), 'utf8');

describe('CheckpointStore', () => {
  it('시크릿 값이 들어간 파일이나 메시지는 커밋하지 않고, 값을 에러에 넣지 않는다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await write('api/src/PaymentClient.java', 'class PaymentClient { String key = "sk_live_1234567890"; }\n');
    const findSecrets = (text: string) => (text.includes('sk_live_1234567890') ? ['PAYMENT_API_KEY'] : []);

    const error = await store.commit('요청: 결제 연동', undefined, { findSecrets }).then(
      () => expect.unreachable(),
      (e: unknown) => e as CheckpointError,
    );

    expect(error).toBeInstanceOf(CheckpointError);
    expect(error.message).toContain('api/src/PaymentClient.java (PAYMENT_API_KEY)');
    expect(error.message).not.toContain('sk_live_1234567890');
    expect(await store.list()).toHaveLength(1);
    expect(await store.pendingFiles()).toEqual(['api/src/PaymentClient.java']);

    await write('api/src/PaymentClient.java', 'class PaymentClient { String key = System.getenv("PAYMENT_API_KEY"); }\n');
    await expect(store.commit('요청: 결제 연동', '키는 sk_live_1234567890', { findSecrets })).rejects.toThrow('커밋 메시지 (PAYMENT_API_KEY)');
    expect(await store.commit('요청: 결제 연동', undefined, { findSecrets })).toMatchObject({ files: ['api/src/PaymentClient.java'] });
  });

  it('지금 상태를 첫 체크포인트로 남기고 샌드박스 생성물은 제외한다', async () => {
    await mkdir(path.join(root, 'web/node_modules/next'), { recursive: true });
    await write('web/node_modules/next/index.js', '');
    const store = new CheckpointStore(root);

    const first = await store.init();

    expect(first).toMatchObject({ message: '세션 시작', files: ['api/src/Order.java'] });
    expect(await store.pendingFiles()).toEqual([]);
  });

  it('바뀐 파일이 없으면 커밋하지 않고, 있으면 체크포인트로 남긴다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    expect(await store.commit('요청: 아무것도 안 함')).toBeUndefined();

    await write('api/src/Order.java', 'class Order { String memo; }\n');
    await write('api/src/V2.sql', 'alter table orders add column memo text;\n');
    const checkpoint = await store.commit('요청: 메모 필드 추가');

    expect(checkpoint).toMatchObject({ message: '요청: 메모 필드 추가', files: ['api/src/Order.java', 'api/src/V2.sql'] });
    expect((await store.list()).map((c) => c.message)).toEqual(['요청: 메모 필드 추가', '세션 시작']);
  });

  it('버리면 수정과 새 파일이 모두 사라지고, 버린 변경을 patch로 돌려준다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await write('api/src/Order.java', 'class Order { int broken }\n');
    await write('api/src/New.java', 'class New {}\n');

    const { files, patch } = await store.discard();

    expect(files).toEqual(['api/src/New.java', 'api/src/Order.java']);
    expect(patch).toContain('+class Order { int broken }');
    expect(patch).toContain('+class New {}');
    expect(await read('api/src/Order.java')).toBe('class Order {}\n');
    await expect(read('api/src/New.java')).rejects.toThrow();
    expect(await store.pendingFiles()).toEqual([]);
  });

  it('이전 체크포인트로 복원하면 그 사이에 바뀐 파일 목록을 돌려준다', async () => {
    const store = new CheckpointStore(root);
    const first = await store.init();
    await write('api/src/Order.java', 'class Order { String memo; }\n');
    await store.commit('요청: 메모');
    await write('api/src/Draft.java', 'class Draft {}\n');

    const { checkpoint, files } = await store.restore(first.shortSha);

    expect(checkpoint.sha).toBe(first.sha);
    expect(files).toEqual(['api/src/Draft.java', 'api/src/Order.java']);
    expect(await read('api/src/Order.java')).toBe('class Order {}\n');
    expect((await store.list()).map((c) => c.message)).toEqual(['세션 시작']);
  });

  it('사용자 전역 커밋 훅이 모든 커밋을 거부해도 체크포인트는 남는다', async () => {
    const hooks = path.join(root, '..', `${path.basename(root)}-hooks`);
    await mkdir(hooks, { recursive: true });
    await writeFile(path.join(hooks, 'commit-msg'), '#!/bin/sh\necho "rejected by global hook" >&2\nexit 1\n');
    await chmod(path.join(hooks, 'commit-msg'), 0o755);
    await writeFile(process.env.GIT_CONFIG_GLOBAL!, `[core]\n\thooksPath = ${hooks}\n[commit]\n\tgpgsign = true\n`);

    const store = new CheckpointStore(root);
    await expect(store.init()).resolves.toMatchObject({ message: '세션 시작' });
    await rm(hooks, { recursive: true, force: true });
  });

  it('형식이 틀리거나 기록에 없는 체크포인트는 거부한다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await expect(store.restore('HEAD~1; rm -rf /')).rejects.toThrow(CheckpointError);
    await expect(store.restore('deadbeef')).rejects.toThrow('찾을 수 없습니다');
  });

  it('원본 Git 저장소가 없는 세션은 원격 정보가 없고 올릴 수 없다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    expect(await store.repository()).toBeUndefined();
    await expect(store.push()).rejects.toThrow('원격 저장소와 연결되지 않은 세션');
  });
});

/** 커밋 작성자를 명령마다 넘긴다. 테스트는 빈 전역 설정으로 돌기 때문이다 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
  return stdout.trim();
}

/** origin(bare 저장소)으로 main을 올려 둔 원본 저장소를 만든다 */
async function createSourceRepository() {
  const base = path.join(root, 'remote-test');
  const remote = path.join(base, 'orders.git');
  const source = path.join(base, 'orders');
  await mkdir(path.join(source, 'api/src'), { recursive: true });
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await writeFile(path.join(source, 'api/src/Order.java'), 'class Order {}\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'init');
  await writeFile(path.join(source, 'README.md'), '# orders\n');
  await git(source, 'add', '-A');
  await git(source, 'commit', '-q', '-m', 'docs');
  await git(source, 'remote', 'add', 'origin', remote);
  await git(source, 'push', '-q', 'origin', 'main');
  return { base, remote, source, workDir: path.join(base, 'sessions', 'orders-s1') };
}

const BRANCH = 'b-studio/orders-s1';

/** 리뷰어가 세션 브랜치를 받아 커밋 하나를 올린다 */
async function pushReviewerCommit(base: string, remote: string, file: string, content: string, message: string): Promise<string> {
  const reviewer = await mkdtemp(path.join(base, 'reviewer-'));
  await execFileAsync('git', ['clone', '-q', '--branch', BRANCH, remote, reviewer]);
  await mkdir(path.dirname(path.join(reviewer, file)), { recursive: true });
  await writeFile(path.join(reviewer, file), content);
  await git(reviewer, 'add', '-A');
  await git(reviewer, 'commit', '-q', '-m', message);
  await git(reviewer, 'push', '-q', 'origin', 'HEAD');
  return git(reviewer, 'rev-parse', 'HEAD');
}

describe('CheckpointStore 원격 변경 가져오기', () => {
  it('리뷰어 커밋을 병합 커밋 하나로 가져오고, 받아들인 뒤 올리면 원격을 덮어쓰지 않고 이어 붙인다', async () => {
    const { base, source, remote, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    const order = path.join(workDir, 'api/src/Order.java');

    await writeFile(order, 'class Order { String a; }\n');
    await store.commit('요청: A');
    await store.push();
    const theirs = await pushReviewerCommit(base, remote, 'NOTE.md', 'review\n', 'review note');
    await writeFile(order, 'class Order { String b; }\n');
    const b = (await store.commit('요청: B'))!;
    await expect(store.push()).rejects.toThrow('원격 변경을 가져온 뒤 다시 올리세요');

    const result = await store.integrateRemote();
    expect(result).toMatchObject({
      status: 'merged',
      remoteSha: theirs,
      files: ['NOTE.md'],
      previous: b.sha,
      commits: [{ sha: theirs, subject: 'review note', author: 'test' }],
      checkpoint: { message: '원격 커밋 1개 가져오기', files: ['NOTE.md'] },
    });
    expect(await readFile(path.join(workDir, 'NOTE.md'), 'utf8')).toBe('review\n');
    expect(await readFile(order, 'utf8')).toBe('class Order { String b; }\n');

    // 리뷰어 커밋은 체크포인트로 보이지 않고, 가져온 결과가 체크포인트 하나로 남는다
    expect((await store.list()).map((checkpoint) => checkpoint.message)).toEqual(['원격 커밋 1개 가져오기', '요청: B', '요청: A', '세션 시작 (main 브랜치)']);
    expect((await store.sessionCommits()).map((commit) => commit.subject)).toEqual(['요청: A', '요청: B', '원격 커밋 1개 가져오기']);
    expect(await store.patch(result.checkpoint!.sha)).toContain('+review');

    await store.acceptRemote(result);
    expect(await store.push()).toEqual({ sha: result.checkpoint!.sha, commits: 3, forced: false });
    await expect(git(remote, 'merge-base', '--is-ancestor', theirs, `refs/heads/${BRANCH}`)).resolves.toBe('');
  });

  it('원격 커밋과 같은 곳을 고쳤으면 아무것도 바꾸지 않고 충돌한 파일을 알린다', async () => {
    const { base, source, remote, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    const order = path.join(workDir, 'api/src/Order.java');

    await writeFile(order, 'class Order { String a; }\n');
    await store.commit('요청: A');
    await store.push();
    await pushReviewerCommit(base, remote, 'api/src/Order.java', 'class Order { String reviewer; }\n', 'reviewer edit');
    await writeFile(order, 'class Order { String mine; }\n');
    const mine = (await store.commit('요청: 내 변경'))!;

    const error = await store.integrateRemote().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RemoteConflictError);
    expect((error as RemoteConflictError).conflicts).toEqual(['api/src/Order.java']);
    expect(await git(workDir, 'rev-parse', 'HEAD')).toBe(mine.sha);
    expect(await store.pendingFiles()).toEqual([]);
    expect(await readFile(order, 'utf8')).toBe('class Order { String mine; }\n');
    await expect(git(workDir, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD')).rejects.toThrow();
  });

  it('원격에 브랜치가 없거나 지금 기록에 이미 들어 있으면 가져올 것이 없다', async () => {
    const { source, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    const head = await git(workDir, 'rev-parse', 'HEAD');
    expect(await store.integrateRemote()).toEqual({ status: 'up-to-date', commits: [], files: [], previous: head });

    await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String a; }\n');
    const a = (await store.commit('요청: A'))!;
    await store.push();
    expect(await store.integrateRemote()).toEqual({ status: 'up-to-date', remoteSha: a.sha, commits: [], files: [], previous: a.sha });
  });

  it('올린 뒤 되돌린 기록에는 버린 체크포인트 없이 원격에만 있는 변경을 옮겨 오고, 받아들이기 전에는 원격 상태로 기록하지 않는다', async () => {
    const { base, source, remote, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    const order = path.join(workDir, 'api/src/Order.java');

    await writeFile(order, 'class Order { String a; }\n');
    const a = (await store.commit('요청: A'))!;
    await writeFile(order, 'class Order { String b; }\n');
    await store.commit('요청: B');
    await store.push();
    await store.restore(a.sha);
    const theirs = await pushReviewerCommit(base, remote, 'NOTE.md', 'review\n', 'review note');

    const result = await store.integrateRemote();
    expect(result).toMatchObject({ status: 'picked', remoteSha: theirs, files: ['NOTE.md'], previous: a.sha, commits: [{ subject: 'review note' }] });
    // 버린 B의 변경은 다시 들어오지 않는다
    expect(await readFile(order, 'utf8')).toBe('class Order { String a; }\n');
    expect(await readFile(path.join(workDir, 'NOTE.md'), 'utf8')).toBe('review\n');

    // 검증에 실패해 가져오기를 되돌렸다면, 원격 상태로 기록하지 않았으므로 올려도 리뷰어 커밋을 덮어쓰지 않는다
    await store.restore(a.sha);
    await expect(store.acceptRemote(result)).rejects.toThrow('원격 상태로 기록하지 않았습니다');
    await expect(store.push()).rejects.toThrow('덮어쓰지 않았습니다');
    expect(await git(remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(theirs);

    // 다시 가져와 받아들이면 원격 브랜치를 지금 기록으로 맞춘다. 리뷰어 변경은 내용으로 남는다
    const again = await store.integrateRemote();
    await store.acceptRemote(again);
    expect(await store.push()).toMatchObject({ sha: again.checkpoint!.sha, forced: true });
    expect(await git(remote, 'show', `refs/heads/${BRANCH}:NOTE.md`)).toBe('review');
  });
});

describe('CheckpointStore 원격 저장소 연동', () => {
  it('원본을 복제해 세션 브랜치를 만들고, 기록에는 세션 시작 이후만 보인다', async () => {
    const { source, remote, workDir } = await createSourceRepository();
    const { store, start, source: info } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });

    expect(info).toEqual({ base: 'main', originUrl: remote, dirtyFiles: 0, subdir: '' });
    expect(start).toMatchObject({ sha: await git(source, 'rev-parse', 'HEAD'), message: '세션 시작 (main 브랜치)', files: ['README.md', 'api/src/Order.java'] });
    expect(await git(workDir, 'branch', '--show-current')).toBe(BRANCH);
    expect(await store.patch(start.sha)).toContain('세션을 시작한 시점');

    await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String memo; }\n');
    await store.commit('요청: 메모 추가', '검증 통과\n- api: 재시작 후 준비 완료\n\n# 에이전트 요약 제목');

    expect((await store.list()).map((checkpoint) => checkpoint.message)).toEqual(['요청: 메모 추가', '세션 시작 (main 브랜치)']);
    expect(await store.repository()).toEqual({
      remoteUrl: remote,
      base: 'main',
      branch: BRANCH,
      subdir: undefined,
      pushedSha: undefined,
      remoteSha: undefined,
      pullRequestUrl: undefined,
    });
    // 마크다운 제목(#)이 커밋 정리 규칙에 지워지지 않아야 한다
    expect(await store.sessionCommits()).toMatchObject([
      { subject: '요청: 메모 추가', body: '검증 통과\n- api: 재시작 후 준비 완료\n\n# 에이전트 요약 제목', files: ['api/src/Order.java'] },
    ]);
  });

  it('올리면 원격에 세션 브랜치가 생기고, 기준 브랜치에서 갈라져 있다', async () => {
    const { source, remote, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    await expect(store.push()).rejects.toThrow('올릴 체크포인트가 없습니다');

    await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String memo; }\n');
    const checkpoint = (await store.commit('요청: 메모 추가'))!;

    expect(await store.push()).toEqual({ sha: checkpoint.sha, commits: 1, forced: false });
    expect(await git(remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(checkpoint.sha);
    expect(await git(remote, 'rev-parse', `refs/heads/${BRANCH}^`)).toBe(await git(remote, 'rev-parse', 'refs/heads/main'));
    expect((await store.repository())?.pushedSha).toBe(checkpoint.sha);
  });

  it('되돌린 뒤 다시 올리면 원격 브랜치를 맞추고, 다른 사람이 올린 커밋은 덮어쓰지 않는다', async () => {
    const { base, source, remote, workDir } = await createSourceRepository();
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    const order = path.join(workDir, 'api/src/Order.java');

    await writeFile(order, 'class Order { String a; }\n');
    const a = (await store.commit('요청: A'))!;
    await writeFile(order, 'class Order { String b; }\n');
    await store.commit('요청: B');
    await store.push();

    await store.restore(a.sha);
    expect(await store.push()).toEqual({ sha: a.sha, commits: 1, forced: true });
    expect(await git(remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(a.sha);

    // 리뷰어가 같은 브랜치에 커밋을 올린다
    const reviewer = path.join(base, 'reviewer');
    await execFileAsync('git', ['clone', '-q', '--branch', BRANCH, remote, reviewer]);
    await writeFile(path.join(reviewer, 'NOTE.md'), 'review\n');
    await git(reviewer, 'add', '-A');
    await git(reviewer, 'commit', '-q', '-m', 'review note');
    await git(reviewer, 'push', '-q', 'origin', 'HEAD');
    const theirs = await git(reviewer, 'rev-parse', 'HEAD');

    await writeFile(order, 'class Order { String c; }\n');
    await store.commit('요청: C');
    await expect(store.push()).rejects.toThrow('덮어쓰지 않았습니다');
    expect(await git(remote, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(theirs);
  });

  it('원본의 커밋하지 않은 변경은 세션에 들어가지 않고 개수만 알려 준다', async () => {
    const { source, workDir } = await createSourceRepository();
    await writeFile(path.join(source, 'DRAFT.md'), 'wip\n');
    await writeFile(path.join(source, 'README.md'), '# changed\n');

    const { source: info } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });

    expect(info.dirtyFiles).toBe(2);
    await expect(readFile(path.join(workDir, 'DRAFT.md'), 'utf8')).rejects.toThrow();
    expect(await readFile(path.join(workDir, 'README.md'), 'utf8')).toBe('# orders\n');
  });

  it('origin이 없는 원본은 원본 저장소에 세션 브랜치를 올린다', async () => {
    const { source, workDir } = await createSourceRepository();
    await git(source, 'remote', 'remove', 'origin');
    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });

    await writeFile(path.join(workDir, 'api/src/Order.java'), 'class Order { String memo; }\n');
    const checkpoint = (await store.commit('요청: 메모 추가'))!;
    await store.push();

    expect((await store.repository())?.remoteUrl).toBe(await realpath(source));
    expect(await git(source, 'rev-parse', `refs/heads/${BRANCH}`)).toBe(checkpoint.sha);
    // 원본의 체크아웃 브랜치와 작업 트리는 그대로다
    expect(await git(source, 'branch', '--show-current')).toBe('main');
  });

  it('모노레포 하위 폴더는 명시하면 저장소 전체를 복제하고, 경로는 프로젝트 폴더 기준으로 주고받는다', async () => {
    const { source, remote, workDir } = await createSourceRepository();
    const project = path.join(source, 'api');
    // 프로젝트 안의 변경만 센다
    await writeFile(path.join(project, 'DRAFT.md'), 'wip\n');
    await writeFile(path.join(source, 'OTHER.md'), 'other team\n');
    expect(await CheckpointStore.inspectSource(project)).toBeUndefined();
    expect(await CheckpointStore.inspectSource(project, { allowSubfolder: true })).toEqual({ base: 'main', originUrl: remote, dirtyFiles: 1, subdir: 'api' });

    const { store, start, projectRoot } = await CheckpointStore.clone(project, workDir, { branch: BRANCH, allowSubfolder: true });
    expect(projectRoot).toBe(path.join(workDir, 'api'));
    expect(start.files).toEqual(['src/Order.java']);
    expect(await readFile(path.join(workDir, 'README.md'), 'utf8')).toBe('# orders\n');
    expect((await store.repository())?.subdir).toBe('api');

    await writeFile(path.join(projectRoot, 'src/Order.java'), 'class Order { String memo; }\n');
    await writeFile(path.join(projectRoot, 'src/Memo.java'), 'class Memo {}\n');
    expect(await store.pendingFiles()).toEqual(['src/Memo.java', 'src/Order.java']);
    const checkpoint = (await store.commit('요청: 메모'))!;
    expect(checkpoint.files).toEqual(['src/Memo.java', 'src/Order.java']);
    expect(await store.patch(checkpoint.sha)).toContain('+++ b/src/Order.java');

    await writeFile(path.join(projectRoot, 'src/Order.java'), 'broken\n');
    expect(await store.discard()).toMatchObject({ files: ['src/Order.java'] });
    expect(await store.restore(start.sha)).toMatchObject({ files: ['src/Memo.java', 'src/Order.java'] });

    await writeFile(path.join(projectRoot, 'src/Memo.java'), 'class Memo {}\n');
    await store.commit('요청: 메모 다시');
    await store.push();
    // 원격에는 저장소 루트 기준 경로로 올라간다
    expect(await git(remote, 'show', `refs/heads/${BRANCH}:api/src/Memo.java`)).toBe('class Memo {}');
    // 서버를 다시 시작해도 작업 복사본만으로 프로젝트 폴더를 찾는다
    expect(await new CheckpointStore(workDir).projectRoot()).toBe(path.join(workDir, 'api'));
  });

  it('Git 저장소 루트가 아닌 폴더는 복제하지 않고, 세션 이전 기록으로는 되돌리지 않는다', async () => {
    const { source, workDir } = await createSourceRepository();
    expect(await CheckpointStore.inspectSource(path.join(source, 'api'))).toBeUndefined();
    await expect(CheckpointStore.clone(path.join(source, 'api'), workDir, { branch: BRANCH })).rejects.toThrow(CheckpointError);

    const { store } = await CheckpointStore.clone(source, workDir, { branch: BRANCH });
    const firstCommit = await git(source, 'rev-list', '--max-parents=0', 'HEAD');
    await expect(store.restore(firstCommit)).rejects.toThrow('세션 기록에 없는');
  });

  it('git 오류 메시지에서 주소의 자격 증명을 지운다', () => {
    expect(redactCredentials("fatal: unable to access 'https://bot:ghp_secret@github.com/acme/orders.git/': 403")).toBe(
      "fatal: unable to access 'https://***@github.com/acme/orders.git/': 403",
    );
  });
});
