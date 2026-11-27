import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointStore } from './checkpoints';

vi.setConfig({ testTimeout: 30_000 });
const execFileAsync = promisify(execFile);

/**
 * 이슈 #1444: 에이전트가 셸에서 진짜 인덱스에 건 `skip-worktree`·`assume-unchanged` 표시는 git status·add가 그 파일을 읽지 않게 만든다.
 * 표시를 건 파일의 변경을 못 본 채 빈 목록·체크포인트 없음으로 답하면 게이트의 바뀐 파일 목록과 보호 경로 확인이 그 파일을 놓친다.
 * 그래서 pendingFiles·pendingChanges·commit은 표시를 건 경로의 변경을 보면 \"확인하지 못함\"으로 던진다(사용자 인덱스는 고치지 않는다).
 */
let root: string;
const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'index-flag-'));
  const globalConfig = path.join(root, '..', `${path.basename(root)}.gitconfig`);
  await writeFile(globalConfig, '');
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  await mkdir(path.join(root, 'web'), { recursive: true });
  await writeFile(path.join(root, 'web/a.test.ts'), 'x\n');
  await writeFile(path.join(root, 'web/b.ts'), 'y\n');
});

afterEach(async () => {
  for (const [key, value] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.nosystem]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe.each(['--skip-worktree', '--assume-unchanged'])('인덱스 표시 %s를 건 파일', (flag) => {
  async function setup() {
    const store = new CheckpointStore(root);
    await store.init();
    await execFileAsync('git', ['-C', root, 'update-index', flag, 'web/a.test.ts']);
    await writeFile(path.join(root, 'web/a.test.ts'), "x\nit.skip('a', f);\n");
    await rm(path.join(root, 'web/b.ts'));
    await execFileAsync('git', ['-C', root, 'update-index', flag, 'web/b.ts']);
    return store;
  }

  it('pendingFiles·pendingChanges는 표시를 건 파일의 변경·삭제를 못 본 채 비어 돌려주지 않고 던진다(확인하지 못함)', async () => {
    const store = await setup();
    await expect(store.pendingFiles()).rejects.toThrow(/인덱스 표시/);
    await expect(store.pendingChanges()).rejects.toThrow(/인덱스 표시/);
    await expect(store.pendingFingerprint()).rejects.toThrow(/인덱스 표시/);
  });

  it('commit·commitPaths는 표시를 건 파일의 변경이 있으면 체크포인트를 만들지 않고 던진다', async () => {
    const store = await setup();
    await expect(store.commit('요청: 시험 건너뛰기')).rejects.toThrow(/인덱스 표시/);
    await expect(store.commitPaths(['web/a.test.ts'], '시험')).rejects.toThrow(/인덱스 표시/);
  });

  it('pendingTestChanges(새 코드)는 둘 다 본다', async () => {
    const store = await setup();
    const entries = await store.pendingTestChanges();
    expect(entries.map((entry) => `${entry.status} ${entry.path}`).sort()).toEqual(['D web/b.ts', 'M web/a.test.ts']);
  });
});

describe('인덱스 표시가 걸려 있어도 바뀌지 않았거나 sparse로 빠진 파일은 막지 않는다', () => {
  it('표시만 걸고 파일을 고치지 않았으면 평소처럼 동작한다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await execFileAsync('git', ['-C', root, 'update-index', '--skip-worktree', '--assume-unchanged', 'web/a.test.ts']);
    await writeFile(path.join(root, 'web/c.ts'), 'z\n');
    expect(await store.pendingFiles()).toEqual(['web/c.ts']);
    expect(await store.commit('요청: c')).toBeDefined();
  });

  it('sparse-checkout으로 작업 폴더에서 빠진 skip-worktree 파일은 삭제로 보지 않는다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await execFileAsync('git', ['-C', root, 'config', 'core.sparseCheckout', 'true']);
    await execFileAsync('git', ['-C', root, 'update-index', '--skip-worktree', 'web/b.ts']);
    await rm(path.join(root, 'web/b.ts'));
    await writeFile(path.join(root, 'web/c.ts'), 'z\n');
    expect(await store.pendingFiles()).toEqual(['web/c.ts']);
    expect(await store.commit('요청: c')).toBeDefined();
  });

  it('sparse여도 작업 폴더에 있는 skip-worktree 파일을 고치면 막는다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await execFileAsync('git', ['-C', root, 'config', 'core.sparseCheckout', 'true']);
    await execFileAsync('git', ['-C', root, 'update-index', '--skip-worktree', 'web/b.ts']);
    await writeFile(path.join(root, 'web/b.ts'), 'changed\n');
    // git이 이 설정에서 변경을 직접 보여 주면 그대로 목록에 있고, 못 보여 주면 던진다. 어느 쪽이든 조용히 빠지지는 않는다
    const seen = await store.pendingFiles().then((files) => files.includes('web/b.ts'), (error: Error) => /인덱스 표시/.test(error.message));
    expect(seen).toBe(true);
  });

  it('assume-unchanged 파일은 sparse여도 지워지면 막는다', async () => {
    const store = new CheckpointStore(root);
    await store.init();
    await execFileAsync('git', ['-C', root, 'config', 'core.sparseCheckout', 'true']);
    await execFileAsync('git', ['-C', root, 'update-index', '--assume-unchanged', 'web/b.ts']);
    await rm(path.join(root, 'web/b.ts'));
    await expect(store.pendingFiles()).rejects.toThrow(/인덱스 표시/);
  });
});
