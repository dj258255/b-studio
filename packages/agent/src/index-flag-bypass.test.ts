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
 * 이슈 #1436 보강 점검(고치지 않고 확인만 한다): 에이전트가 셸에서 진짜 인덱스에 건 `skip-worktree`·`assume-unchanged` 표시를
 * 기존 체크포인트 코드(pendingFiles·pendingChanges·commit)가 어떻게 읽는지 본다. 이 시험이 적은 기대값은 **지금 코드의 동작**이다 —
 * 표시를 건 파일의 변경을 이 함수들이 보지 못하면 게이트의 바뀐 파일 목록(ChangeTracker)과 보호 경로 확인도 그 파일을 보지 못한다.
 * 기대값이 바뀌면(고치면) 이 시험을 뒤집는다.
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

  it('pendingFiles·pendingChanges는 표시를 건 파일의 변경·삭제를 보지 못한다', async () => {
    const store = await setup();
    expect(await store.pendingFiles()).toEqual([]);
    expect(await store.pendingChanges()).toEqual([]);
  });

  it('commit은 표시를 건 파일의 변경을 담지 않는다(바뀐 파일이 없다고 본다)', async () => {
    const store = await setup();
    const checkpoint = await store.commit('요청: 시험 건너뛰기');
    expect(checkpoint).toBeUndefined();
  });

  it('pendingTestChanges(새 코드)는 둘 다 본다', async () => {
    const store = await setup();
    const entries = await store.pendingTestChanges();
    expect(entries.map((entry) => `${entry.status} ${entry.path}`).sort()).toEqual(['D web/b.ts', 'M web/a.test.ts']);
  });
});
