import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { native } from '@b-studio/sandbox';
import { afterEach, describe, expect, it } from 'vitest';
import { periodKey } from '@/lib/usage';
import { judgeLimits } from './session-limits';
import { book, loadTable } from './frozen-vectors';
import { addUserUsage } from './usage-state';

/**
 * 토큰 한도 판정 벡터(ADR-209, 4f B3c): 새 코어의 판정(`native.judgeTokenLimit`)을 옛 TS 판정 셋이 입력 조합 전체와 무작위 열에 낸 판정과 견준다.
 * 옛 판정은 `session-limits-vectors.json`에 입력 순서대로 한 글자씩 고정했다(`o`=ok, `s`=session, `u`=user; 요청 시작·대화·터미널 판정 세 줄).
 * 다른 칸은 결함을 고친 자리뿐이고, 의도한 차이마다 이름 붙은 시험이 방향까지 고정한다:
 *  - 의도한 차이 1(결함 1): 대화 경로는 이 실행이 저장을 마친 몫을 겹쳐 세지 않는다(옛 판정은 일찍 멈췄다)
 *  - 의도한 차이 2: 터미널 경로는 저장이 끝나지 않은 증가분도 센다(옛 판정은 늦게 멈췄다)
 *  - 의도한 차이 3: 수가 아닌 입력(NaN·무한·음수)은 한도에 닿은 것으로 본다(옛 비교는 NaN에서 항상 거짓이라 조용히 통과했다)
 * 요청 시작(이 실행 누적 0·저장 0)은 모든 칸에서 옛 판정과 같다.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Verdict = 'ok' | 'session' | 'user';

interface Facts {
  sessionTokens: number;
  sessionLimit?: number;
  userLimit?: number;
  fileTotal: number;
  runTotal?: number;
  saved: number;
  accum: number;
}

const OLD = book(loadTable(new URL('./session-limits-vectors.json', import.meta.url)));
const CODE: Record<string, Verdict> = { o: 'ok', s: 'session', u: 'user' };
/** 옛 판정 세 줄. 입력(`allCases()`)의 순서와 같다 */
const OLD_START = OLD.get('start') as string;
const OLD_CONVERSATION = OLD.get('conversation') as string;
const OLD_TERMINAL = OLD.get('terminal') as string;
const oldAt = (line: string, index: number): Verdict => CODE[line[index]!]!;

function fresh(facts: Facts): Verdict {
  return native.judgeTokenLimit(facts.sessionTokens, facts.sessionLimit, facts.userLimit, facts.fileTotal, facts.saved, facts.accum);
}

const SESSION_LIMITS = [undefined, 100];
const SESSION_TOKENS = [0, 99, 100, 101, 5_000];
const USER_LIMITS = [undefined, 1000];
const FILE_TOTALS = [0, 1, 599, 600, 799, 800, 999, 1000, 1001, 5_000];
const SHARES = [0, 200, 400, 1000];

/** 저장을 마친 몫은 이 실행 누적을 넘지 못하고(저장한 것은 쓰려던 것의 일부), 파일 합계에 들어 있으므로 파일 합계도 넘지 못한다 */
function* grid(): Generator<Facts> {
  for (const sessionLimit of SESSION_LIMITS)
    for (const sessionTokens of SESSION_TOKENS)
      for (const userLimit of USER_LIMITS)
        for (const fileTotal of FILE_TOTALS)
          for (const accum of SHARES)
            for (const saved of SHARES) {
              if (saved > accum || saved > fileTotal) continue;
              yield { sessionTokens, ...(sessionLimit !== undefined ? { sessionLimit } : {}), ...(userLimit !== undefined ? { userLimit } : {}), fileTotal, saved, accum, runTotal: accum };
            }
}

function* randomFacts(count: number): Generator<Facts> {
  let seed = 0x9e3779b9;
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const near = (limit: number) => Math.max(0, Math.floor(limit * (0.3 + next() * 1.4)) + Math.floor(next() * 3) - 1);
  for (let at = 0; at < count; at++) {
    const sessionLimit = next() < 0.5 ? undefined : 1 + Math.floor(next() * 5_000);
    const userLimit = next() < 0.5 ? undefined : 1 + Math.floor(next() * 5_000);
    const accum = Math.floor(next() * 3_000);
    const saved = Math.floor(next() * (accum + 1));
    const fileTotal = saved + Math.floor(next() * 4_000);
    yield {
      sessionTokens: near(sessionLimit ?? 2_000),
      ...(sessionLimit !== undefined ? { sessionLimit } : {}),
      ...(userLimit !== undefined ? { userLimit } : {}),
      fileTotal,
      saved,
      accum,
      runTotal: accum,
    };
  }
}

function* allCases(): Generator<Facts> {
  yield* grid();
  yield* randomFacts(20_000);
}

describe('토큰 한도 판정 차등', () => {
  it('요청 시작(누적 0·저장 0)은 모든 칸에서 옛 판정과 같다', () => {
    let cases = 0;
    for (const facts of allCases()) {
      const start = { ...facts, saved: 0, accum: 0, runTotal: 0 };
      expect(fresh(start), JSON.stringify(start)).toBe(oldAt(OLD_START, cases));
      cases += 1;
    }
    expect(cases).toBeGreaterThan(20_000);
    expect(OLD_START).toHaveLength(cases);
  });

  it('의도한 차이 1: 대화 경로는 저장을 마친 몫을 겹쳐 세지 않는다 — 저장한 몫이 없으면 같고, 있으면 옛 판정이 멈추던 칸에서만 멈추지 않는다', () => {
    let same = 0;
    let fixed = 0;
    let index = -1;
    for (const facts of allCases()) {
      index += 1;
      const old = oldAt(OLD_CONVERSATION, index);
      const now = fresh(facts);
      if (old === now) {
        same += 1;
        continue;
      }
      // 다른 칸: 저장을 마친 몫이 있고, 옛 판정은 사람 한도로 멈췄지만 새 판정은 통과시킨 칸뿐이다
      expect(facts.saved, JSON.stringify(facts)).toBeGreaterThan(0);
      expect({ old, now }, JSON.stringify(facts)).toEqual({ old: 'user', now: 'ok' });
      // 이 칸의 실제 사람 몫(파일 − 저장 + 누적)은 한도 아래다
      expect(facts.fileTotal - facts.saved + facts.accum, JSON.stringify(facts)).toBeLessThan(facts.userLimit!);
      fixed += 1;
    }
    expect(same).toBeGreaterThan(1_000);
    expect(fixed).toBeGreaterThan(50);
  });

  it('의도한 차이 2: 터미널 경로는 저장이 끝나지 않은 증가분도 센다 — 모두 저장했으면 같고, 남았으면 옛 판정이 통과시키던 칸에서만 멈춘다', () => {
    let same = 0;
    let fixed = 0;
    let index = -1;
    for (const facts of allCases()) {
      index += 1;
      const old = oldAt(OLD_TERMINAL, index);
      const now = fresh(facts);
      if (old === now) {
        same += 1;
        continue;
      }
      expect(facts.accum, JSON.stringify(facts)).toBeGreaterThan(facts.saved);
      expect({ old, now }, JSON.stringify(facts)).toEqual({ old: 'ok', now: 'user' });
      expect(facts.fileTotal - facts.saved + facts.accum, JSON.stringify(facts)).toBeGreaterThanOrEqual(facts.userLimit!);
      fixed += 1;
    }
    expect(same).toBeGreaterThan(1_000);
    expect(fixed).toBeGreaterThan(50);
  });

  it('두 경로가 같은 입력을 같게 읽는다: 모두 저장했고 누적이 파일 안에 있으면 대화·터미널·새 판정이 같다', () => {
    let index = -1;
    for (const facts of allCases()) {
      index += 1;
      if (facts.saved !== facts.accum) continue;
      // 저장 몫이 누적과 같을 때 옛 터미널 판정(파일 합계)과 새 판정은 같다
      expect(fresh(facts), JSON.stringify(facts)).toBe(oldAt(OLD_TERMINAL, index));
    }
  });

  it('의도한 차이 3: 수가 아닌 입력은 한도에 닿은 것으로 본다', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
      expect(native.judgeTokenLimit(bad, 100, undefined, 0, 0, 0), `세션 합계 ${bad}`).toBe('session');
      expect(native.judgeTokenLimit(0, 100, undefined, 0, 0, 0)).toBe('ok');
      for (const [file, saved, accum] of [[bad, 0, 0], [0, bad, 0], [0, 0, bad]] as const) {
        expect(native.judgeTokenLimit(0, undefined, 1000, file, saved, accum), `${file},${saved},${accum}`).toBe('user');
      }
    }
    for (const bad of [Number.NaN, 0, -5]) {
      expect(native.judgeTokenLimit(0, bad, undefined, 0, 0, 0), `세션 한도 ${bad}`).toBe('session');
      expect(native.judgeTokenLimit(0, undefined, bad, 0, 0, 0), `사람 한도 ${bad}`).toBe('user');
    }
    // 옛 비교는 NaN에서 거짓이었다(조용히 통과): 옛 값 'ok'
    expect(OLD.get('nan start verdict')).toBe('ok');
    // 한도가 없으면 그 쪽 입력은 보지 않는다
    expect(native.judgeTokenLimit(Number.NaN, undefined, undefined, Number.NaN, Number.NaN, Number.NaN)).toBe('ok');
  });

  it('기간 일·월: 새 파일·새 판정이 옛 판정(고정한 값)과 같은 사람 몫을 본다(요청 시작)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'b-studio-limits-diff-'));
    roots.push(root);
    const dir = path.join(root, 'usage');
    const days = [new Date(2026, 8, 12, 9), new Date(2026, 8, 13, 1), new Date(2026, 9, 1, 0, 30)];
    const usage = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    for (const [index, day] of days.entries()) await addUserUsage('alice', usage(300 + index * 100), 'day', day, dir);
    await addUserUsage('alice', usage(50), 'month', days[0]!, dir);
    process.env.B_STUDIO_USAGE_DIR = dir;
    const savedEnv = { limit: process.env.B_STUDIO_USER_TOKEN_LIMIT, window: process.env.B_STUDIO_USER_TOKEN_WINDOW };
    try {
      for (const window of ['day', 'month'] as const) {
        for (const limit of [1, 300, 301, 350, 400, 500, 1000]) {
          for (const day of days) {
            process.env.B_STUDIO_USER_TOKEN_LIMIT = String(limit);
            process.env.B_STUDIO_USER_TOKEN_WINDOW = window;
            const old = OLD.get(`period ${window} ${limit} ${day.getTime()}`);
            expect(judgeLimits({ sessionTokens: 0, by: 'alice' }, day), `${window} ${limit} ${periodKey(window, day)}`).toBe(old);
          }
        }
      }
    } finally {
      delete process.env.B_STUDIO_USAGE_DIR;
      for (const [key, value] of [['B_STUDIO_USER_TOKEN_LIMIT', savedEnv.limit], ['B_STUDIO_USER_TOKEN_WINDOW', savedEnv.window]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
