import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withRemovedDirectories } from './sync-paths';

describe('withRemovedDirectories', () => {
  it('지운 파일과 함께 사라진 폴더만 더하고, 남아 있는 폴더는 더하지 않는다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'sync-paths-'));
    await mkdir(path.join(root, 'web/app'), { recursive: true });
    await writeFile(path.join(root, 'web/app/page.tsx'), 'export default function Page() {}\n');

    const targets = await withRemovedDirectories(root, ['web/app/page.tsx', 'web/app/orders/items/page.tsx', 'web/app/gone.tsx']);

    expect(targets).toEqual(['web/app/page.tsx', 'web/app/orders/items/page.tsx', 'web/app/gone.tsx', 'web/app/orders/items', 'web/app/orders']);
  });
});
