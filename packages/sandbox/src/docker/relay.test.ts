import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { bindMounts, planRelay, RELAY_SCRIPT } from './relay';

const execFileAsync = promisify(execFile);

describe('planRelay', () => {
  const root = '/Users/dev/orders';
  const mounts = bindMounts(
    {
      web: { volumes: [{ type: 'bind', source: '/Users/dev/orders/web', target: '/app' }, { type: 'volume', target: '/app/node_modules' }] },
      api: { volumes: [{ type: 'bind', source: '/Users/dev/orders/api', target: '/app' }] },
      tools: { volumes: [{ type: 'bind', source: '/Users/dev/orders', target: '/workspace' }] },
      db: {},
    },
    new Set(['web', 'api']),
  );

  it('새 폴더는 옮기고, 새 파일과 지운 경로는 부모 폴더 하나에 한 번 알린다', () => {
    const plan = planRelay(
      root,
      [
        { file: 'web/app/new', kind: 'directory' },
        { file: 'web/app/new/page.tsx', kind: 'file' },
        { file: 'web/app/orders/new.tsx', kind: 'file' },
        { file: 'web/app/orders/other.tsx', kind: 'file' },
        { file: 'web/app/old', kind: 'deleted' },
        { file: 'web/app/old/page.tsx', kind: 'deleted' },
        { file: 'api/src/New.java', kind: 'file' },
        { file: 'README.md', kind: 'file' },
        { file: 'web/', kind: 'directory' },
        { file: '../outside.txt', kind: 'file' },
      ],
      mounts,
    );

    expect(Object.fromEntries(plan)).toEqual({
      tools: [{ action: 'nudge', containerPath: '/workspace', files: ['README.md', 'web'] }],
      api: [{ action: 'nudge', containerPath: '/app/src', files: ['api/src/New.java'] }],
      web: [
        { action: 'move', containerPath: '/app/app/new', files: ['web/app/new'] },
        { action: 'nudge', containerPath: '/app/app', files: ['web/app/old'] },
        { action: 'nudge', containerPath: '/app/app/orders', files: ['web/app/orders/new.tsx', 'web/app/orders/other.tsx'] },
      ],
    });
  });

  it('마운트되지 않은 경로는 건너뛴다', () => {
    const onlyApi = bindMounts({ api: { volumes: [{ type: 'bind', source: '/Users/dev/orders/api', target: '/app' }] } }, new Set(['api']));
    expect(planRelay(root, [{ file: 'web/app/x.tsx', kind: 'file' }], onlyApi).size).toBe(0);
  });
});

describe('RELAY_SCRIPT', () => {
  it('새 폴더는 옮겼다 되돌리고, 폴더 알림은 임시 폴더를 남기지 않으며, 없는 경로는 건너뛴다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'relay-'));
    await mkdir(path.join(dir, 'new route'));
    await writeFile(path.join(dir, 'new route', 'page.tsx'), 'export default 1;\n');
    await writeFile(path.join(dir, 'file.ts'), 'x\n');

    const args = [`m:${path.join(dir, 'new route')}`, `n:${dir}`, `m:${path.join(dir, 'missing')}`, `n:${path.join(dir, 'gone')}`, `m:${path.join(dir, 'file.ts')}`];
    const { stdout } = await execFileAsync('sh', ['-c', RELAY_SCRIPT, 'sh', ...args]);

    expect(stdout.split('\n').filter(Boolean)).toEqual([args[0], args[1]]);
    expect(await readFile(path.join(dir, 'new route', 'page.tsx'), 'utf8')).toBe('export default 1;\n');
    expect((await readdir(dir)).sort()).toEqual(['file.ts', 'new route']);
  });
});
