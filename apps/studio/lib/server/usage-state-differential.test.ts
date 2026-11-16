import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageWindow } from '@/lib/usage';
import { addUserUsage as addNew, readUsage as readNew, userTokens as tokensNew, userUsage as usageNew } from './usage-state';
import { addUserUsage as addOld, readUsage as readOld, userTokens as tokensOld, userUsage as usageOld } from './usage-state-legacy';

/**
 * 사람별 사용량 파일 차등(ADR-209, 4f B3c): 같은 더하기 열을 옛 `addUserUsage`와 Rust 주인에게 주고 파일 내용(바이트)·권한·돌려준 합계·읽기 결과가 같은지 견준다.
 * 의도한 차이(둘 다 옛 코드가 NaN으로 계산해 한도 비교가 조용히 거짓이 되던 자리다):
 *  - 의도한 차이 4: 항목의 값이 수가 아니면 읽을 수 없는 파일로 던진다
 *  - 의도한 차이 5: 항목에 값이 없거나 null이면 0으로 읽는다(옛 더하기의 `?? 0`과 같다. 옛 읽기는 `undefined + …`로 NaN이었다)
 *  - 의도한 차이 6: 사람 이름이 `__proto__`여도 그 이름의 사용량으로 센다(옛 구현은 쓰지 못하고 읽으면 NaN이었다)
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function twoDirs(): Promise<{ oldDir: string; newDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-usage-diff-'));
  roots.push(root);
  return { oldDir: path.join(root, 'old', 'usage'), newDir: path.join(root, 'new', 'usage') };
}

function prng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PEOPLE = ['alice', 'bob', 'kim', '10', '9', '2', 'zed', '한글', 'a b', 'q"uote', 'back\\slash', 'tab\tname', 'new\nline', '😀', 'x.y@z.kr'];
const usage = (a: number, b: number, c: number, d: number) => ({ inputTokens: a, outputTokens: b, cacheReadTokens: c, cacheWriteTokens: d });

describe('사람별 사용량 파일 차등', () => {
  it('무작위 더하기 열 800개: 매번 돌려준 합계와 파일 바이트가 같다(기간 일·월, 45일치로 정리 포함)', async () => {
    const { oldDir, newDir } = await twoDirs();
    const next = prng(20_261_116);
    const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
    for (let step = 0; step < 800; step++) {
      const window: UsageWindow = next() < 0.8 ? 'day' : 'month';
      // 앞 400번은 한 달 안, 뒤는 날짜를 넓게 흩어 40개 정리를 만든다
      const day = new Date(2026, step < 400 ? 8 : Math.floor(next() * 5), 1 + Math.floor(next() * 28), Math.floor(next() * 24));
      const person = pick(PEOPLE);
      const amount = usage(...([0, 1, 7, 1234, 98_765_432].map(() => Math.floor(next() * 3) === 0 ? 0 : Math.floor(next() * 5_000)).slice(0, 4) as [number, number, number, number]));
      const before = await addOld(person, amount, window, day, oldDir);
      const after = await addNew(person, amount, window, day, newDir);
      expect(after, `step ${step}`).toEqual(before);
      expect(await readFile(path.join(newDir, 'tokens.json'), 'utf8'), `step ${step}`).toBe(await readFile(path.join(oldDir, 'tokens.json'), 'utf8'));
    }
    expect(readNew(newDir)).toEqual(readOld(oldDir));
    // 권한: 폴더 0700, 파일 0600
    for (const dir of [oldDir, newDir]) {
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(dir, 'tokens.json'))).mode & 0o777).toBe(0o600);
    }
  });

  it('옛 판이 쓴 파일을 새 판이 읽고 이어 더한다: 모든 (사람, 기간)의 읽기가 같고 이어 더한 바이트도 같다', async () => {
    const { oldDir, newDir } = await twoDirs();
    const days = [new Date(2026, 8, 12, 9), new Date(2026, 8, 13, 9), new Date(2026, 9, 1, 9)];
    for (const [index, day] of days.entries()) {
      for (const person of PEOPLE.slice(0, 6)) {
        await addOld(person, usage(index + 1, 2, 3, 4), 'day', day, oldDir);
        await addOld(person, usage(5, index, 0, 1), 'month', day, oldDir);
      }
    }
    // 옛 판이 쓴 바이트를 새 폴더에 그대로 둔다
    await mkdir(newDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(newDir, 'tokens.json'), await readFile(path.join(oldDir, 'tokens.json')), { mode: 0o600 });
    for (const window of ['day', 'month'] as const) {
      for (const day of days) {
        for (const person of [...PEOPLE.slice(0, 6), 'nobody']) {
          expect(usageNew(person, window, day, newDir), `${person} ${window}`).toEqual(usageOld(person, window, day, oldDir));
          expect(tokensNew(person, window, day, newDir)).toBe(tokensOld(person, window, day, oldDir));
        }
      }
    }
    await addOld('alice', usage(9, 9, 9, 9), 'day', days[2]!, oldDir);
    await addNew('alice', usage(9, 9, 9, 9), 'day', days[2]!, newDir);
    expect(await readFile(path.join(newDir, 'tokens.json'), 'utf8')).toBe(await readFile(path.join(oldDir, 'tokens.json'), 'utf8'));
  });

  it('의도한 차이 5: 값이 없거나 null인 항목은 더할 때는 옛 판과 같고(빠진 값은 0), 읽을 때는 옛 판이 NaN이던 자리를 0으로 읽는다', async () => {
    const { oldDir, newDir } = await twoDirs();
    const content = JSON.stringify({
      version: 1,
      periods: { '2026-09-12': { bob: { inputTokens: 3 }, carol: { inputTokens: null, outputTokens: 4 }, dan: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, extra: 'x' } } },
    });
    for (const dir of [oldDir, newDir]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(dir, 'tokens.json'), content);
    }
    const day = new Date(2026, 8, 12, 9);
    // 완전한 항목과 없는 사람은 같다
    for (const person of ['dan', 'erin']) expect(tokensNew(person, 'day', day, newDir), person).toBe(tokensOld(person, 'day', day, oldDir));
    // 빠진 값이 있는 항목: 옛 읽기는 NaN, 새 읽기는 0으로 센 값
    expect(tokensOld('bob', 'day', day, oldDir)).toBeNaN();
    expect(tokensNew('bob', 'day', day, newDir)).toBe(3);
    expect(tokensOld('carol', 'day', day, oldDir)).toBeNaN();
    expect(tokensNew('carol', 'day', day, newDir)).toBe(4);
    // 더하기는 같다(옛 `?? 0`). 다른 필드(extra)는 더한 항목에서 사라지는 것도 같다
    for (const person of ['bob', 'carol', 'dan']) {
      expect(await addNew(person, usage(1, 1, 1, 1), 'day', day, newDir), person).toEqual(await addOld(person, usage(1, 1, 1, 1), 'day', day, oldDir));
    }
    expect(await readFile(path.join(newDir, 'tokens.json'), 'utf8')).toBe(await readFile(path.join(oldDir, 'tokens.json'), 'utf8'));
  });

  it('의도한 차이 4: 항목의 값이 수가 아니면 옛 판은 NaN으로 계산해 한도 비교가 조용히 거짓이 되고, 새 판은 읽을 수 없는 파일로 던진다', async () => {
    const { oldDir, newDir } = await twoDirs();
    const content = JSON.stringify({ version: 1, periods: { '2026-09-12': { alice: { inputTokens: 'abc', outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } } });
    for (const dir of [oldDir, newDir]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(path.join(dir, 'tokens.json'), content);
    }
    const day = new Date(2026, 8, 12, 9);
    // 옛 판: 'abc1' 같은 글자나 NaN이 나와 `>= 한도`가 거짓이다(한도가 꺼진다)
    expect(tokensOld('alice', 'day', day, oldDir) >= 1).toBe(false);
    expect(() => tokensNew('alice', 'day', day, newDir)).toThrow('tokens.json');
    await expect(addNew('alice', usage(1, 0, 0, 0), 'day', day, newDir)).rejects.toThrow('tokens.json');
    // 덮어쓰지 않았다
    expect(await readFile(path.join(newDir, 'tokens.json'), 'utf8')).toBe(content);
  });

  it('의도한 차이 6: 사람 이름이 `__proto__`면 옛 판은 사용량을 쓰지 못하고 NaN으로 읽어 한도가 꺼지고, 새 판은 그 이름의 사용량으로 센다', async () => {
    const { oldDir, newDir } = await twoDirs();
    const day = new Date(2026, 8, 12, 9);
    for (const [add, dir] of [[addOld, oldDir], [addNew, newDir]] as const) await add('alice', usage(5, 0, 0, 0), 'day', day, dir);
    await addOld('__proto__', usage(7, 0, 0, 0), 'day', day, oldDir);
    await addNew('__proto__', usage(7, 0, 0, 0), 'day', day, newDir);
    expect(tokensOld('__proto__', 'day', day, oldDir)).toBeNaN();
    expect(tokensNew('__proto__', 'day', day, newDir)).toBe(7);
    expect(tokensNew('alice', 'day', day, newDir)).toBe(5);
  });
});
