import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { isDeniedPath, watchProjectFiles, type FileWatcher } from './file-watch';

let watcher: FileWatcher | undefined;
let root: string | undefined;

afterEach(async () => {
  watcher?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('시간 안에 조건을 만족하지 않았습니다');
    await sleep(50);
  }
}

describe('isDeniedPath', () => {
  it('생성물 폴더와 .env를 뺀다', () => {
    expect(isDeniedPath('web/node_modules/pkg/index.js')).toBe(true);
    expect(isDeniedPath('api/build/classes/Order.class')).toBe(true);
    expect(isDeniedPath('.git/index')).toBe(true);
    expect(isDeniedPath('web/.env.local')).toBe(true);
    expect(isDeniedPath('web\\.next\\cache')).toBe(true);
    expect(isDeniedPath('web/app/page.tsx')).toBe(false);
    expect(isDeniedPath('api/src/main/resources/application.yaml')).toBe(false);
  });
});

describe('watchProjectFiles', () => {
  it('에이전트 도구를 거치지 않고 생긴 파일을 모아서 알리고, 생성물과 .env 변경은 알리지 않는다', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'file-watch-'));
    await mkdir(path.join(root, 'web/node_modules/pkg'), { recursive: true });
    await mkdir(path.join(root, 'web/app'), { recursive: true });
    const calls: string[][] = [];
    watcher = watchProjectFiles(root, (files) => calls.push(files), { debounceMs: 200 });
    await sleep(200);

    await writeFile(path.join(root, 'web/node_modules/pkg/index.js'), 'module.exports = 1;\n');
    await writeFile(path.join(root, 'web/.env.local'), 'SECRET=1\n');
    await writeFile(path.join(root, 'web/app/generated.ts'), 'export const generated = true;\n');
    await writeFile(path.join(root, 'web/app/other.ts'), 'export const other = true;\n');

    const seen = () => calls.flat();
    await waitUntil(() => seen().includes('web/app/generated.ts') && seen().includes('web/app/other.ts'), 5_000);
    expect(seen().some((file) => file.includes('node_modules') || file.includes('.env'))).toBe(false);
    // 한꺼번에 생긴 변경은 몇 번으로 모인다
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it('닫은 뒤에 생긴 변경은 알리지 않는다', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'file-watch-'));
    const calls: string[][] = [];
    watcher = watchProjectFiles(root, (files) => calls.push(files), { debounceMs: 50 });
    await sleep(300);
    // macOS는 감시를 걸기 직전에 만든 폴더의 이벤트를 늦게 보내기도 하므로, 닫을 때까지 온 알림은 기준으로만 둔다
    const beforeClose = calls.length;
    watcher.close();

    await writeFile(path.join(root, 'late.ts'), 'export {};\n');
    await sleep(500);
    expect(calls).toHaveLength(beforeClose);
    expect(calls.flat()).not.toContain('late.ts');
  });
});
