import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CheckpointError, CheckpointStore } from './checkpoints';

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
});
