import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addUserUsage, readUsage, userTokens, userUsage } from './usage-state';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stateDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-usage-'));
  roots.push(root);
  return path.join(root, 'usage');
}

const usage = (input: number) => ({ inputTokens: input, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });

describe('사람별 사용량 기록', () => {
  it('파일이 없으면 쓴 사람이 없고, 더한 값은 사람·기간별로 쌓인다', async () => {
    const dir = await stateDir();
    const day = new Date(2026, 8, 12, 9);
    expect(readUsage(dir)).toEqual({ version: 1, periods: {} });
    expect(userUsage('alice', 'day', day, dir)).toBeUndefined();
    expect(userTokens('alice', 'day', day, dir)).toBe(0);

    expect(await addUserUsage('alice', usage(100), 'day', day, dir)).toEqual(usage(100));
    await addUserUsage('alice', usage(50), 'day', day, dir);
    await addUserUsage('bob', usage(7), 'day', day, dir);

    expect(userUsage('alice', 'day', day, dir)).toEqual({ inputTokens: 150, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(userTokens('alice', 'day', day, dir)).toBe(170);
    expect(userTokens('bob', 'day', day, dir)).toBe(17);
    expect((await stat(path.join(dir, 'tokens.json'))).mode & 0o777).toBe(0o600);
  });

  it('기간이 바뀌면 처음부터 세고, 달 단위로도 셀 수 있다', async () => {
    const dir = await stateDir();
    const first = new Date(2026, 8, 12, 23);
    const next = new Date(2026, 8, 13, 1);
    await addUserUsage('alice', usage(100), 'day', first, dir);

    expect(userTokens('alice', 'day', next, dir)).toBe(0);
    // 같은 달이므로 달 단위로는 이어서 센다
    expect(userTokens('alice', 'month', next, dir)).toBe(0);
    await addUserUsage('alice', usage(30), 'month', next, dir);
    expect(userTokens('alice', 'month', new Date(2026, 8, 28), dir)).toBe(40);
    expect(userTokens('alice', 'month', new Date(2026, 9, 1), dir)).toBe(0);
  });

  it('동시에 더해도 하나도 잃지 않는다', async () => {
    const dir = await stateDir();
    const day = new Date(2026, 8, 12);
    await Promise.all(Array.from({ length: 20 }, () => addUserUsage('alice', usage(1), 'day', day, dir)));
    expect(userUsage('alice', 'day', day, dir)).toEqual({ inputTokens: 20, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('다른 프로세스가 파일을 바꾸면 다시 읽고, 형식이 틀리면 던진다', async () => {
    const dir = await stateDir();
    const day = new Date(2026, 8, 12);
    await addUserUsage('alice', usage(5), 'day', day, dir);
    expect(userTokens('alice', 'day', day, dir)).toBe(15);

    await writeFile(path.join(dir, 'tokens.json'), JSON.stringify({ version: 1, periods: { '2026-09-12': { alice: usage(999) } } }));
    expect(userTokens('alice', 'day', day, dir)).toBe(1009);

    await writeFile(path.join(dir, 'tokens.json'), '{"periods": 3}');
    expect(() => readUsage(dir)).toThrow('tokens.json');
  });
});
