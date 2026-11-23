import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageWindow } from '@/lib/usage';
import { addUserUsage as addNew, readUsage as readNew, userTokens as tokensNew, userUsage as usageNew } from './usage-state';
import { book, digestOf, loadTable } from './frozen-vectors';

/**
 * 사람별 사용량 파일 벡터(ADR-209, 4f B3c): 같은 더하기 열을 Rust 주인에게 주고 파일 내용(바이트)·돌려준 합계·읽기 결과가 옛 `addUserUsage`가 낸 값
 * (`usage-state-vectors.json`에 고정)과 같은지, 권한이 맞는지 본다.
 * 의도한 차이(옛 코드는 NaN으로 계산해 한도 비교가 조용히 거짓이 되던 자리다. 옛 값은 더는 돌리지 않고, 새 쪽의 동작만 단언한다):
 *  - 의도한 차이 4: 항목의 값이 수가 아니면 읽을 수 없는 파일로 던진다
 *  - 의도한 차이 5: 항목에 값이 없거나 null이면 0으로 읽는다(옛 더하기의 `?? 0`과 같다. 옛 읽기는 `undefined + …`로 NaN이었다)
 *  - 의도한 차이 6: 사람 이름이 `__proto__`여도 그 이름의 사용량으로 센다(옛 구현은 쓰지 못하고 읽으면 NaN이었다)
 */
const OLD = book(loadTable(new URL('./usage-state-vectors.json', import.meta.url)));
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newDirOnly(): Promise<{ newDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-usage-vec-'));
  roots.push(root);
  return { newDir: path.join(root, 'new', 'usage') };
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

describe('사람별 사용량 파일 벡터', () => {
  it('무작위 더하기 열 800개: 매번 돌려준 합계와 파일 바이트(지문)가 옛 값과 같다(기간 일·월, 45일치로 정리 포함)', async () => {
    const { newDir } = await newDirOnly();
    const next = prng(20_261_116);
    const pick = <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
    for (let step = 0; step < 800; step++) {
      const window: UsageWindow = next() < 0.8 ? 'day' : 'month';
      // 앞 400번은 한 달 안, 뒤는 날짜를 넓게 흩어 40개 정리를 만든다
      const day = new Date(2026, step < 400 ? 8 : Math.floor(next() * 5), 1 + Math.floor(next() * 28), Math.floor(next() * 24));
      const person = pick(PEOPLE);
      const amount = usage(...([0, 1, 7, 1234, 98_765_432].map(() => Math.floor(next() * 3) === 0 ? 0 : Math.floor(next() * 5_000)).slice(0, 4) as [number, number, number, number]));
      const after = await addNew(person, amount, window, day, newDir);
      expect(after, `step ${step}`).toEqual(OLD.get(`random add ${step} total`));
      expect(digestOf(await readFile(path.join(newDir, 'tokens.json'), 'utf8')), `step ${step}`).toBe(OLD.get(`random add ${step} file`));
    }
    expect(readNew(newDir)).toEqual(OLD.get('random final read'));
    // 권한: 폴더 0700, 파일 0600
    expect((await stat(newDir)).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(newDir, 'tokens.json'))).mode & 0o777).toBe(0o600);
  });

  it('옛 판이 쓴 파일을 새 판이 읽고 이어 더한다: 모든 (사람, 기간)의 읽기가 옛 값과 같고 이어 더한 바이트도 같다', async () => {
    const { newDir } = await newDirOnly();
    const days = [new Date(2026, 8, 12, 9), new Date(2026, 8, 13, 9), new Date(2026, 9, 1, 9)];
    // 옛 판이 쓴 바이트(옛 `addUserUsage`를 일·월로 18번씩 부른 결과)를 새 폴더에 그대로 둔다
    await mkdir(newDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(newDir, 'tokens.json'), OLD.get('seed file') as string, { mode: 0o600 });
    for (const window of ['day', 'month'] as const) {
      for (const day of days) {
        for (const person of [...PEOPLE.slice(0, 6), 'nobody']) {
          expect(usageNew(person, window, day, newDir), `${person} ${window}`).toEqual(OLD.get(`seed usage ${person} ${window} ${day.getTime()}`));
          expect(tokensNew(person, window, day, newDir)).toBe(OLD.get(`seed tokens ${person} ${window} ${day.getTime()}`));
        }
      }
    }
    await addNew('alice', usage(9, 9, 9, 9), 'day', days[2]!, newDir);
    expect(await readFile(path.join(newDir, 'tokens.json'), 'utf8')).toBe(OLD.get('seed file after add'));
  });

  it('의도한 차이 5: 값이 없거나 null인 항목은 더할 때는 옛 판과 같고(빠진 값은 0), 읽을 때는 옛 판이 NaN이던 자리를 0으로 읽는다', async () => {
    const { newDir } = await newDirOnly();
    const content = JSON.stringify({
      version: 1,
      periods: { '2026-09-12': { bob: { inputTokens: 3 }, carol: { inputTokens: null, outputTokens: 4 }, dan: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, extra: 'x' } } },
    });
    await mkdir(newDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(newDir, 'tokens.json'), content);
    const day = new Date(2026, 8, 12, 9);
    // 완전한 항목과 없는 사람은 옛 값과 같다(옛 값 dan 10, erin 0)
    for (const person of ['dan', 'erin']) expect(tokensNew(person, 'day', day, newDir), person).toBe(OLD.get(`partial tokens ${person}`));
    // 빠진 값이 있는 항목: 옛 읽기는 NaN이었고, 새 읽기는 0으로 센 값
    expect(OLD.get('partial tokens bob')).toBeNaN();
    expect(tokensNew('bob', 'day', day, newDir)).toBe(3);
    expect(OLD.get('partial tokens carol')).toBeNaN();
    expect(tokensNew('carol', 'day', day, newDir)).toBe(4);
    // 더하기는 같다(옛 `?? 0`). 다른 필드(extra)는 더한 항목에서 사라지는 것도 같다
    for (const person of ['bob', 'carol', 'dan']) {
      expect(await addNew(person, usage(1, 1, 1, 1), 'day', day, newDir), person).toEqual(OLD.get(`partial add ${person}`));
    }
    expect(await readFile(path.join(newDir, 'tokens.json'), 'utf8')).toBe(OLD.get('partial file after add'));
  });

  it('의도한 차이 4: 항목의 값이 수가 아니면 새 판은 읽을 수 없는 파일로 던진다(옛 판은 NaN으로 계산해 한도 비교가 조용히 거짓이 됐다)', async () => {
    const { newDir } = await newDirOnly();
    const content = JSON.stringify({ version: 1, periods: { '2026-09-12': { alice: { inputTokens: 'abc', outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } } });
    await mkdir(newDir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(newDir, 'tokens.json'), content);
    const day = new Date(2026, 8, 12, 9);
    expect(() => tokensNew('alice', 'day', day, newDir)).toThrow('tokens.json');
    await expect(addNew('alice', usage(1, 0, 0, 0), 'day', day, newDir)).rejects.toThrow('tokens.json');
    // 덮어쓰지 않았다
    expect(await readFile(path.join(newDir, 'tokens.json'), 'utf8')).toBe(content);
  });

  it('의도한 차이 6: 사람 이름이 `__proto__`여도 새 판은 그 이름의 사용량으로 센다(옛 판은 사용량을 쓰지 못하고 NaN으로 읽어 한도가 꺼졌다)', async () => {
    const { newDir } = await newDirOnly();
    const day = new Date(2026, 8, 12, 9);
    await addNew('alice', usage(5, 0, 0, 0), 'day', day, newDir);
    await addNew('__proto__', usage(7, 0, 0, 0), 'day', day, newDir);
    expect(OLD.get('proto tokens')).toBeNaN();
    expect(tokensNew('__proto__', 'day', day, newDir)).toBe(7);
    expect(tokensNew('alice', 'day', day, newDir)).toBe(5);
  });
});
