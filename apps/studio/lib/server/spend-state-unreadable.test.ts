import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSpendStore } from './spend-state';

/**
 * 읽을 수 없는 `spend.json`을 빈 기록으로 읽어 시작해 덮어쓰지 않는다(4f B3c, 트러블슈팅 228).
 * 화면용 기록이라 한도에 쓰지 않고, 읽지 못해도 실행을 막지 않는다. 폴더는 임시 폴더만 쓴다.
 */
const roots: string[] = [];
const usage = { inputTokens: 5, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const input = { at: new Date(2026, 9, 26, 12).getTime(), backend: 'codex', model: 'gpt-5.5', usage };

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => (await rm(root, { recursive: true, force: true }), undefined)));
});

async function folder(): Promise<{ dir: string; file: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-spend-unreadable-'));
  roots.push(root);
  const dir = path.join(root, 'usage');
  await mkdir(dir, { recursive: true });
  return { dir, file: path.join(dir, 'spend.json') };
}

const GOOD = JSON.stringify({ version: 1, days: { '2026-10-25': { claude: { m: { usage, calls: 3 } } } } });

describe('읽을 수 없는 spend.json', () => {
  it('읽기 오류(없는 것이 아니라 권한 따위)면 빈 기록으로 시작해 덮어쓰지 않는다', async () => {
    const { dir, file } = await folder();
    await writeFile(file, GOOD);
    await chmod(file, 0o000);
    try {
      const store = createSpendStore(dir, { flushMs: 0 });
      store.note(input);
      await store.flush();
      // 화면은 이번에 모은 것을 보여 주되(실행은 막지 않는다), 파일은 그대로다
      expect(store.read().days['2026-10-26']).toBeDefined();
    } finally {
      await chmod(file, 0o600);
    }
    expect(await readFile(file, 'utf8')).toBe(GOOD);
  });

  it('깨진 파일은 비운 채 시작하되, 덮어쓰기 전에 원본을 spend.json.broken으로 남긴다', async () => {
    const { dir, file } = await folder();
    await writeFile(file, '{깨진');
    const store = createSpendStore(dir, { flushMs: 0 });
    store.note(input);
    await store.flush();
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, days: { '2026-10-26': { codex: { 'gpt-5.5': { calls: 1 } } } } });
    expect(await readFile(`${file}.broken`, 'utf8')).toBe('{깨진');
  });

  it('없는 파일은 처음이라 그대로 쓴다', async () => {
    const { dir, file } = await folder();
    const store = createSpendStore(dir, { flushMs: 0 });
    store.note(input);
    await store.flush();
    expect(JSON.parse(await readFile(file, 'utf8')).days['2026-10-26'].codex['gpt-5.5'].calls).toBe(1);
  });
});
