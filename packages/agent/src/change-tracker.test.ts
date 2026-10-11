import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChangeTracker, rejectedChangeFeedback } from './change-tracker';
import { Workspace } from './workspace';

let root: string;
let pending: string[];
const write = (file: string, content: string) => writeFile(path.join(root, file), content);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'change-tracker-test-'));
  await mkdir(path.join(root, 'api/src'), { recursive: true });
  pending = [];
});

describe('ChangeTracker (b-studio 도구를 거치지 않은 변경을 게이트에 알린다, 이슈 #670·#677)', () => {
  it('바뀐 파일을 게이트가 보는 목록에 넣고, 내용이 그대로면 다시 알리지 않는다', async () => {
    const workspace = new Workspace(root);
    const tracker = new ChangeTracker(workspace, async () => pending);
    await write('api/src/Order.java', 'class Order {}\n');
    pending = ['api/src/Order.java'];
    expect(await tracker.sync()).toEqual({ changed: ['api/src/Order.java'], rejected: [] });
    expect(workspace.changedFiles()).toEqual(['api/src/Order.java']);
    expect(await tracker.sync()).toEqual({ changed: [], rejected: [] });
    await write('api/src/Order.java', 'class Order { String memo; }\n');
    expect(await tracker.sync()).toEqual({ changed: ['api/src/Order.java'], rejected: [] });
  });

  it('기본은 처음부터 있던 다루지 못하는 경로를 봐준다(실패한 실행이 되돌려지는 자리). 그 뒤에 생기거나 바뀌면 알린다', async () => {
    const tracker = new ChangeTracker(new Workspace(root), async () => pending);
    await write('.env', 'KEY=before\n');
    pending = ['.env'];
    expect(await tracker.sync()).toEqual({ changed: [], rejected: [] });
    expect(await tracker.sync()).toEqual({ changed: [], rejected: [] });
    await write('.env', 'KEY=after\n');
    expect(await tracker.sync()).toEqual({ changed: [], rejected: ['.env'] });
  });

  it('봐주지 않게 하면(되돌리지 않는 자리) 처음부터 있던 비밀 파일과 링크도 매번 알린다', async () => {
    const tracker = new ChangeTracker(new Workspace(root), async () => pending, { tolerateExisting: false });
    await write('.env', 'KEY=left-by-previous-run\n');
    await symlink('/etc/hosts', path.join(root, 'api/src/hosts'));
    await write('api/src/Order.java', 'class Order {}\n');
    pending = ['.env', 'api/src/Order.java', 'api/src/hosts'];
    expect(await tracker.sync()).toEqual({ changed: ['api/src/Order.java'], rejected: ['.env', 'api/src/hosts'] });
    // 그대로 두면 다음에도 알린다(한 번 알렸다고 넘어가지 않는다)
    expect(await tracker.sync()).toEqual({ changed: [], rejected: ['.env', 'api/src/hosts'] });
    await rm(path.join(root, '.env'));
    await rm(path.join(root, 'api/src/hosts'));
    pending = ['api/src/Order.java'];
    expect(await tracker.sync()).toEqual({ changed: [], rejected: [] });
  });

  it('알린 파일과 그 지문을 내준다. 변경 목록에서 빠진 파일(되돌려 놓은 것)은 더 들고 있지 않는다', async () => {
    const tracker = new ChangeTracker(new Workspace(root), async () => pending, { fingerprint: async (files) => new Map(files.map((file) => [file, `blob:${file.length}`])) });
    pending = ['api/src/Order.java', 'api/src/New.java'];
    await tracker.sync();
    expect(Object.fromEntries(tracker.tracked)).toEqual({ 'api/src/Order.java': 'blob:18', 'api/src/New.java': 'blob:16' });
    pending = ['api/src/Order.java'];
    await tracker.sync();
    expect([...tracker.tracked.keys()]).toEqual(['api/src/Order.java']);
    // 내준 것을 고쳐도 추적기의 것은 바뀌지 않는다
    (tracker.tracked as Map<string, string>).clear();
    expect(tracker.tracked.size).toBe(1);
  });

  it('지문이 링크라고 하면 받지 않는다(지문을 만드는 쪽이 달라도 같은 규칙이다)', async () => {
    const tracker = new ChangeTracker(new Workspace(root), async () => pending, { tolerateExisting: false, fingerprint: async (files) => new Map(files.map((file) => [file, 'link:/etc/hosts'])) });
    pending = ['api/src/Order.java'];
    expect(await tracker.sync()).toEqual({ changed: [], rejected: ['api/src/Order.java'] });
    expect(tracker.tracked.size).toBe(0);
  });

  it('돌려주는 글에 경로를 적고 어떻게 풀지 알린다', () => {
    const text = rejectedChangeFeedback(['.env', 'dist/out.js']);
    expect(text).toContain('- .env');
    expect(text).toContain('- dist/out.js');
    expect(text).toContain('.gitignore');
  });
});
