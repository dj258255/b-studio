import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { walkFiles } from './code-files';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-code-'));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

describe('walkFiles', () => {
  it('생성물 폴더와 비밀 파일을 빼고, 폴더마다 이름 순으로 모든 파일을 센다', async () => {
    const root = await project({
      'web/app/page.tsx': 'export default function Page() {}',
      'web/app/orders/page.tsx': 'orders',
      'web/node_modules/react/index.js': 'ignored',
      'web/.next/build.js': 'ignored',
      '.env': 'SECRET=1',
      'api/src/Main.java': 'class Main {}',
      'studio.yaml': 'name: demo',
    });
    expect(await walkFiles(root)).toEqual({
      files: ['api/src/Main.java', 'studio.yaml', 'web/app/orders/page.tsx', 'web/app/page.tsx'],
      truncated: false,
    });
  });

  it('상한을 넘으면 거기서 멈추고 알린다', async () => {
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`src/file-${String(index).padStart(2, '0')}.ts`, 'x']));
    const root = await project(files);
    const walk = await walkFiles(root, 5);
    expect(walk.truncated).toBe(true);
    expect(walk.files).toEqual(['src/file-00.ts', 'src/file-01.ts', 'src/file-02.ts', 'src/file-03.ts', 'src/file-04.ts']);
  });
});
