import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chargeUserUsage, judgeLimits, judgeRunLimits, newLedger, userLimitSetting } from './session-limits';
import { userTokens } from './usage-state';

/**
 * 토큰 한도 판정의 껍데기(ADR-209, 4f B3c): 원장(이 실행이 더하려 한 양·저장을 마친 몫)과 사람별 사용량 파일 읽기 실패의 처리.
 * 사용량 폴더는 임시 폴더(`B_STUDIO_USAGE_DIR`)만 쓴다.
 */
let root: string;
let usageDir: string;
const saved = { dir: process.env.B_STUDIO_USAGE_DIR, limit: process.env.B_STUDIO_USER_TOKEN_LIMIT, window: process.env.B_STUDIO_USER_TOKEN_WINDOW };
const usage = (n: number) => ({ inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'b-studio-session-limits-'));
  usageDir = path.join(root, 'usage');
  process.env.B_STUDIO_USAGE_DIR = usageDir;
  process.env.B_STUDIO_USER_TOKEN_LIMIT = '1000';
  delete process.env.B_STUDIO_USER_TOKEN_WINDOW;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [key, value] of [['B_STUDIO_USAGE_DIR', saved.dir], ['B_STUDIO_USER_TOKEN_LIMIT', saved.limit], ['B_STUDIO_USER_TOKEN_WINDOW', saved.window]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await chmod(usageDir, 0o700).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

describe('사람 한도 설정', () => {
  it('보낸 사람을 모르거나 한도를 정하지 않았으면 없고, 잘못된 설정은 던진다', () => {
    expect(userLimitSetting(undefined)).toBeUndefined();
    expect(userLimitSetting('kim')).toEqual({ limit: 1000, window: 'day' });
    process.env.B_STUDIO_USER_TOKEN_WINDOW = 'month';
    expect(userLimitSetting('kim')).toEqual({ limit: 1000, window: 'month' });
    process.env.B_STUDIO_USER_TOKEN_LIMIT = 'abc';
    expect(() => userLimitSetting('kim')).toThrow('B_STUDIO_USER_TOKEN_LIMIT');
    delete process.env.B_STUDIO_USER_TOKEN_LIMIT;
    expect(userLimitSetting('kim')).toBeUndefined();
  });
});

describe('원장: 저장을 마친 몫은 쓰기가 성공한 뒤에만 늘어난다', () => {
  it('성공하면 누적과 저장 몫이 같이 늘고 파일에도 쓰인다', () => {
    const ledger = newLedger();
    chargeUserUsage('kim', usage(300), 'day', ledger);
    chargeUserUsage('kim', usage(200), 'day', ledger);
    expect(ledger).toEqual({ accum: 500, saved: 500 });
    expect(userTokens('kim', 'day')).toBe(500);
  });

  it('늘어난 것이 없으면(0) 건너뛴다', () => {
    const ledger = newLedger();
    chargeUserUsage('kim', usage(0), 'day', ledger);
    expect(ledger).toEqual({ accum: 0, saved: 0 });
  });

  it('쓰지 못하면 누적만 늘고 저장 몫은 그대로다(조용히 버리지 않는다)', async () => {
    await mkdir(usageDir, { recursive: true });
    await chmod(usageDir, 0o500);
    const ledger = newLedger();
    chargeUserUsage('kim', usage(300), 'day', ledger);
    expect(ledger).toEqual({ accum: 300, saved: 0 });
    expect(console.error).toHaveBeenCalled();
    // 한도 판정은 저장하지 못한 증가분을 센다
    expect(judgeLimits({ sessionTokens: 0, by: 'kim', ledger: { accum: 1000, saved: 0 } })).toBe('user');
  });

  it('깨진 파일에는 쓰지 않고 누적만 늘며 파일은 그대로다', async () => {
    await mkdir(usageDir, { recursive: true });
    await writeFile(path.join(usageDir, 'tokens.json'), '{깨진');
    const ledger = newLedger();
    chargeUserUsage('kim', usage(300), 'day', ledger);
    expect(ledger).toEqual({ accum: 300, saved: 0 });
  });
});

describe('판정', () => {
  it('세션 한도가 먼저이고 그때는 사용량 파일을 읽지 않는다', async () => {
    await mkdir(usageDir, { recursive: true });
    await writeFile(path.join(usageDir, 'tokens.json'), '{깨진');
    expect(judgeLimits({ sessionTokens: 100, sessionLimit: 100, by: 'kim' })).toBe('session');
  });

  it('사람 몫 = 파일 합계 − 저장 몫 + 누적', () => {
    const ledger = newLedger();
    chargeUserUsage('kim', usage(400), 'day', ledger);
    chargeUserUsage('lee', usage(300), 'day');
    // 파일: kim 400. 누적 800(이 실행이 더 쓴 400은 아직 저장 전)이면 사람 몫은 400 - 400 + 800 = 800
    expect(judgeLimits({ sessionTokens: 0, by: 'kim', ledger: { accum: 800, saved: 400 } })).toBe('ok');
    expect(judgeLimits({ sessionTokens: 0, by: 'kim', ledger: { accum: 1000, saved: 400 } })).toBe('user');
    // 요청 시작: 파일 합계만
    expect(judgeLimits({ sessionTokens: 0, by: 'kim' })).toBe('ok');
    chargeUserUsage('kim', usage(600), 'day');
    expect(judgeLimits({ sessionTokens: 0, by: 'kim' })).toBe('user');
  });

  it('사람을 모르면 사람 한도는 보지 않는다', () => {
    expect(judgeLimits({ sessionTokens: 0, ledger: { accum: 5000, saved: 0 } })).toBe('ok');
  });

  it('읽을 수 없는 파일: 요청 시작은 던지고, 실행 중은 던지지 않고 usage_unreadable로 판정한다', async () => {
    await mkdir(usageDir, { recursive: true });
    await writeFile(path.join(usageDir, 'tokens.json'), '{깨진');
    expect(() => judgeLimits({ sessionTokens: 0, by: 'kim' })).toThrow('tokens.json');
    expect(judgeRunLimits({ sessionTokens: 0, by: 'kim', ledger: newLedger() })).toBe('usage_unreadable');
    // 사람 한도가 없으면 읽지 않으므로 영향이 없다
    delete process.env.B_STUDIO_USER_TOKEN_LIMIT;
    expect(judgeRunLimits({ sessionTokens: 0, by: 'kim' })).toBe('ok');
  });
});
