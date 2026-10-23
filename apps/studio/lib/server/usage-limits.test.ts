import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claudeKeychainService,
  claudePlanLabel,
  codexPlanLabel,
  createUsageLimits,
  judgeStatus,
  markRecommended,
  readClaudeLimits,
  readCodexLimits,
  type AccountLimits,
  type UsageLimitDeps,
} from './usage-limits';

const NOW = Date.parse('2026-10-23T12:00:00Z');

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'usage-limits-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function credentials(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    claudeAiOauth: { accessToken: 'tok-123', refreshToken: 'ref-456', expiresAt: NOW + 3_600_000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_20x', ...overrides },
  });
}

function usageBody() {
  return {
    five_hour: { utilization: 37, resets_at: '2026-10-23T13:50:00Z' },
    seven_day: { utilization: 90.4, resets_at: '2026-10-26T02:00:00Z' },
    seven_day_opus: null,
  };
}

function deps(overrides: Partial<UsageLimitDeps> = {}): UsageLimitDeps {
  return {
    now: () => NOW,
    platform: 'linux',
    homeDir: dir,
    env: {},
    fetch: vi.fn(async () => Response.json(usageBody())),
    readKeychain: vi.fn(async () => undefined),
    readCodex: vi.fn(async () => ({ windows: [], reached: false })),
    ...overrides,
  };
}

describe('judgeStatus', () => {
  it('가장 많이 쓴 창으로 여유·주의·다 씀을 가른다', () => {
    expect(judgeStatus([{ kind: 'five_hour', usedPercent: 28 }, { kind: 'weekly', usedPercent: 18 }])).toBe('ok');
    expect(judgeStatus([{ kind: 'five_hour', usedPercent: 37 }, { kind: 'weekly', usedPercent: 90 }])).toBe('warn');
    expect(judgeStatus([{ kind: 'weekly', usedPercent: 70 }])).toBe('warn');
    expect(judgeStatus([{ kind: 'weekly', usedPercent: 95 }])).toBe('exhausted');
    expect(judgeStatus([{ kind: 'weekly', usedPercent: 100 }])).toBe('exhausted');
  });

  it('창이 없거나 모두 0%면 쉬는 중이다', () => {
    expect(judgeStatus([])).toBe('idle');
    expect(judgeStatus([{ kind: 'five_hour', usedPercent: 0 }, { kind: 'weekly', usedPercent: 0 }])).toBe('idle');
  });

  it('CLI가 한도에 닿았다고 하면 퍼센트와 상관없이 다 씀이다', () => {
    expect(judgeStatus([{ kind: 'weekly', usedPercent: 40 }], true)).toBe('exhausted');
  });
});

describe('markRecommended', () => {
  const base = (id: string, status: AccountLimits['status'], windows: AccountLimits['windows']): AccountLimits => ({ id, backend: 'claude-code', status, windows, source: 'claude-oauth' });

  it('다 쓰지 않은 계정 가운데 주간 여유가 가장 큰 것 하나만 추천한다', () => {
    const result = markRecommended([
      base('a', 'warn', [{ kind: 'five_hour', usedPercent: 37 }, { kind: 'weekly', usedPercent: 90 }]),
      base('b', 'ok', [{ kind: 'five_hour', usedPercent: 28 }, { kind: 'weekly', usedPercent: 18 }]),
      base('c', 'exhausted', [{ kind: 'weekly', usedPercent: 100 }]),
      base('d', 'ok', [{ kind: 'five_hour', usedPercent: 16 }, { kind: 'weekly', usedPercent: 76 }]),
    ]);
    expect(result.filter((item) => item.recommended).map((item) => item.id)).toEqual(['b']);
  });

  it('주간 여유가 같으면 5시간 여유가 큰 쪽을 고른다', () => {
    const result = markRecommended([
      base('a', 'ok', [{ kind: 'five_hour', usedPercent: 50 }, { kind: 'weekly', usedPercent: 10 }]),
      base('b', 'ok', [{ kind: 'five_hour', usedPercent: 5 }, { kind: 'weekly', usedPercent: 10 }]),
    ]);
    expect(result.find((item) => item.recommended)?.id).toBe('b');
  });

  it('모르는 계정·해당 없는 계정·다 쓴 계정만 있으면 추천하지 않는다', () => {
    const result = markRecommended([
      base('a', 'unknown', []),
      { ...base('b', 'unsupported', []), backend: 'gemini', source: 'none' },
      base('c', 'exhausted', [{ kind: 'five_hour', usedPercent: 100 }, { kind: 'weekly', usedPercent: 20 }]),
    ]);
    expect(result.some((item) => item.recommended)).toBe(false);
  });
});

describe('플랜 이름', () => {
  it('Claude 자격의 구독 종류와 한도 등급으로 플랜을 적는다', () => {
    expect(claudePlanLabel('max', 'default_claude_max_20x')).toBe('Max 20x');
    expect(claudePlanLabel('max', 'default_claude_max_5x')).toBe('Max 5x');
    expect(claudePlanLabel('pro', undefined)).toBe('Pro');
    expect(claudePlanLabel(undefined, undefined)).toBeUndefined();
  });

  it('Codex의 플랜 값을 사람이 읽는 이름으로 바꾼다', () => {
    expect(codexPlanLabel('promax')).toBe('Pro Max');
    expect(codexPlanLabel('plus')).toBe('Plus');
    expect(codexPlanLabel('unknown')).toBeUndefined();
    expect(codexPlanLabel(null)).toBeUndefined();
  });
});

describe('claudeKeychainService', () => {
  it('설정 폴더를 따로 주지 않으면 Claude Code 기본 이름이다', () => {
    expect(claudeKeychainService(undefined)).toBe('Claude Code-credentials');
  });

  it('설정 폴더를 주면 그 경로의 sha256 앞 8자를 붙인다', () => {
    // sha256('/Users/me/.claude-work') 앞 8자
    expect(claudeKeychainService('/Users/me/.claude-work')).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    expect(claudeKeychainService('/Users/me/.claude-work')).not.toBe(claudeKeychainService('/Users/me/.claude-home'));
  });
});

describe('readClaudeLimits', () => {
  it('자격 파일의 토큰으로 사용량을 읽어 5시간·주간 창과 플랜을 돌려준다', async () => {
    const configDir = path.join(dir, 'claude-a');
    await import('node:fs/promises').then((fs) => fs.mkdir(configDir));
    await writeFile(path.join(configDir, '.credentials.json'), credentials());
    const fetch = vi.fn(async () => Response.json(usageBody()));

    const result = await readClaudeLimits({ id: 'a', backend: 'claude-code', configDir }, deps({ fetch }));

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok-123');
    expect(new Headers(init.headers).get('anthropic-beta')).toBe('oauth-2025-04-20');
    expect(result).toMatchObject({
      plan: 'Max 20x',
      windows: [
        { kind: 'five_hour', usedPercent: 37, resetsAt: '2026-10-23T13:50:00.000Z' },
        { kind: 'weekly', usedPercent: 90.4, resetsAt: '2026-10-26T02:00:00.000Z' },
      ],
    });
  });

  it('설정 폴더가 없으면 홈의 .claude 자격 파일을 읽는다', async () => {
    await import('node:fs/promises').then((fs) => fs.mkdir(path.join(dir, '.claude')));
    await writeFile(path.join(dir, '.claude', '.credentials.json'), credentials());

    const result = await readClaudeLimits({ id: 'claude-code', backend: 'claude-code' }, deps());

    expect(result.windows).toHaveLength(2);
  });

  it('macOS에서는 Keychain을 먼저 읽고, 설정 폴더별 이름을 쓴다', async () => {
    const readKeychain = vi.fn(async () => credentials());
    const configDir = '/Users/me/.claude-work';

    await readClaudeLimits({ id: 'w', backend: 'claude-code', configDir }, deps({ platform: 'darwin', readKeychain }));

    expect(readKeychain).toHaveBeenCalledWith(claudeKeychainService(configDir));
  });

  it('설정 폴더를 준 계정의 Keychain 항목이 없으면 기본 계정 항목으로 넘어가지 않는다', async () => {
    const readKeychain = vi.fn(async (service: string) => (service === 'Claude Code-credentials' ? credentials() : undefined));
    const fetch = vi.fn(async () => Response.json(usageBody()));

    await expect(readClaudeLimits({ id: 'w', backend: 'claude-code', configDir: path.join(dir, 'none') }, deps({ platform: 'darwin', readKeychain, fetch }))).rejects.toThrow('로그인');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('토큰이 만료됐으면 부르지 않고 CLI에서 한 번 쓰라고 안내한다(토큰을 갱신하지 않는다)', async () => {
    await import('node:fs/promises').then((fs) => fs.mkdir(path.join(dir, '.claude')));
    await writeFile(path.join(dir, '.claude', '.credentials.json'), credentials({ expiresAt: NOW - 1000 }));
    const fetch = vi.fn(async () => Response.json(usageBody()));

    await expect(readClaudeLimits({ id: 'c', backend: 'claude-code' }, deps({ fetch }))).rejects.toThrow('한 번 쓰면');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('429면 물러나라는 오류를 낸다', async () => {
    await import('node:fs/promises').then((fs) => fs.mkdir(path.join(dir, '.claude')));
    await writeFile(path.join(dir, '.claude', '.credentials.json'), credentials());

    await expect(readClaudeLimits({ id: 'c', backend: 'claude-code' }, deps({ fetch: vi.fn(async () => new Response('slow down', { status: 429 })) }))).rejects.toMatchObject({ rateLimited: true });
  });

  it('오류 문구에 토큰과 응답 원문을 싣지 않는다', async () => {
    await import('node:fs/promises').then((fs) => fs.mkdir(path.join(dir, '.claude')));
    await writeFile(path.join(dir, '.claude', '.credentials.json'), credentials());

    const error = await readClaudeLimits({ id: 'c', backend: 'claude-code' }, deps({ fetch: vi.fn(async () => new Response('secret-body tok-123', { status: 500 })) })).catch((caught: Error) => caught);

    expect(String(error)).not.toContain('tok-123');
    expect(String(error)).not.toContain('secret-body');
  });
});

describe('readCodexLimits', () => {
  async function fakeAppServer(response: unknown, options: { silent?: boolean } = {}) {
    const script = path.join(dir, 'fake-app-server.mjs');
    await writeFile(
      script,
      `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(path.join(dir, 'requests.log'))};
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  appendFileSync(log, line + '\\n');
  const message = JSON.parse(line);
  if (${options.silent ? 'true' : 'false'}) return;
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'fake' } }) + '\\n');
  if (message.method === 'account/rateLimits/read') process.stdout.write(JSON.stringify({ id: message.id, ...${JSON.stringify(response)} }) + '\\n');
});
`,
    );
    return { command: process.execPath, args: [script] };
  }

  it('app-server에 initialize 뒤 한도를 묻고, 창 길이로 5시간·주간을 가른다', async () => {
    const server = await fakeAppServer({
      result: {
        rateLimits: {
          planType: 'promax',
          rateLimitReachedType: null,
          primary: { usedPercent: 26, windowDurationMins: 10080, resetsAt: 1_792_985_580 },
          secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_792_940_000 },
        },
      },
    });

    const result = await readCodexLimits({ codexHome: path.join(dir, 'codex-a'), ...server });

    expect(result.plan).toBe('Pro Max');
    expect(result.reached).toBe(false);
    expect(result.windows).toEqual([
      { kind: 'five_hour', usedPercent: 12, resetsAt: new Date(1_792_940_000_000).toISOString() },
      { kind: 'weekly', usedPercent: 26, resetsAt: new Date(1_792_985_580_000).toISOString() },
    ]);
    const { readFile } = await import('node:fs/promises');
    const sent = (await readFile(path.join(dir, 'requests.log'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method: string });
    expect(sent.map((message) => message.method)).toEqual(['initialize', 'initialized', 'account/rateLimits/read']);
  });

  it('한도에 닿았다는 값이 오면 reached로 알린다', async () => {
    const server = await fakeAppServer({ result: { rateLimits: { planType: 'plus', rateLimitReachedType: 'rate_limit_reached', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null }, secondary: null } } });

    const result = await readCodexLimits(server);

    expect(result.reached).toBe(true);
    expect(result.windows).toEqual([{ kind: 'five_hour', usedPercent: 100 }]);
  });

  it('오류 답이면 그 뜻을 담아 실패한다', async () => {
    const server = await fakeAppServer({ error: { code: -32600, message: 'not logged in' } });

    await expect(readCodexLimits(server)).rejects.toThrow('not logged in');
  });

  it('답이 없으면 시간 안에 끝내고 프로세스를 정리한다', async () => {
    const server = await fakeAppServer({}, { silent: true });

    await expect(readCodexLimits({ ...server, timeoutMs: 300 })).rejects.toThrow('답하지 않았습니다');
  });

  it('CODEX_HOME을 계정 폴더로 넘긴다', async () => {
    const script = path.join(dir, 'env.mjs');
    await writeFile(
      script,
      `import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
  if (message.method === 'account/rateLimits/read') process.stdout.write(JSON.stringify({ id: message.id, result: { rateLimits: { planType: process.env.CODEX_HOME === ${JSON.stringify(path.join(dir, 'acct'))} ? 'pro' : 'free', primary: null, secondary: null } } }) + '\\n');
});
`,
    );

    const result = await readCodexLimits({ command: process.execPath, args: [script], codexHome: path.join(dir, 'acct') });

    expect(result.plan).toBe('Pro');
  });
});

describe('createUsageLimits', () => {
  async function claudeHome() {
    await import('node:fs/promises').then((fs) => fs.mkdir(path.join(dir, '.claude'), { recursive: true }));
    await writeFile(path.join(dir, '.claude', '.credentials.json'), credentials());
  }

  it('계정마다 상태와 추천을 붙이고, Gemini는 해당 없음으로 둔다', async () => {
    await claudeHome();
    const readCodex = vi.fn(async () => ({ plan: 'Pro', reached: false, windows: [{ kind: 'weekly' as const, usedPercent: 26 }] }));
    const limits = createUsageLimits(deps({ readCodex }));

    const result = await limits.read([
      { id: 'claude-code', backend: 'claude-code' },
      { id: 'codex', backend: 'codex' },
      { id: 'gemini', backend: 'gemini' },
    ]);

    expect(result.map((item) => [item.id, item.status, item.source, item.recommended ?? false])).toEqual([
      ['claude-code', 'warn', 'claude-oauth', false],
      ['codex', 'ok', 'codex-app-server', true],
      ['gemini', 'unsupported', 'none', false],
    ]);
    expect(result[0]?.fetchedAt).toBe(new Date(NOW).toISOString());
  });

  it('Claude는 10분 안에 다시 묻지 않고, refresh여도 최소 간격을 지킨다', async () => {
    await claudeHome();
    let now = NOW;
    const fetch = vi.fn(async () => Response.json(usageBody()));
    const limits = createUsageLimits(deps({ fetch, now: () => now }));
    const accounts = [{ id: 'claude-code', backend: 'claude-code' }];

    await limits.read(accounts);
    now += 5 * 60_000;
    await limits.read(accounts, { refresh: true });
    expect(fetch).toHaveBeenCalledTimes(1);

    now += 6 * 60_000;
    await limits.read(accounts);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('Codex는 refresh면 1분 간격만 지키고 다시 묻는다', async () => {
    let now = NOW;
    const readCodex = vi.fn(async () => ({ plan: 'Pro', reached: false, windows: [] }));
    const limits = createUsageLimits(deps({ readCodex, now: () => now }));
    const accounts = [{ id: 'codex', backend: 'codex' }];

    await limits.read(accounts);
    now += 30_000;
    await limits.read(accounts, { refresh: true });
    expect(readCodex).toHaveBeenCalledTimes(1);
    now += 40_000;
    await limits.read(accounts, { refresh: true });
    expect(readCodex).toHaveBeenCalledTimes(2);
  });

  it('동시에 여러 번 불려도 한 번만 묻는다', async () => {
    await claudeHome();
    const fetch = vi.fn(async () => Response.json(usageBody()));
    const limits = createUsageLimits(deps({ fetch }));
    const accounts = [{ id: 'claude-code', backend: 'claude-code' }];

    await Promise.all([limits.read(accounts), limits.read(accounts), limits.read(accounts)]);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('429를 받으면 물러나는 간격을 두 배씩 늘리고, 지난 값을 오래된 값으로 보여 준다', async () => {
    await claudeHome();
    let now = NOW;
    let status = 200;
    const fetch = vi.fn(async () => (status === 200 ? Response.json(usageBody()) : new Response('', { status })));
    const limits = createUsageLimits(deps({ fetch, now: () => now }));
    const accounts = [{ id: 'claude-code', backend: 'claude-code' }];

    await limits.read(accounts);
    status = 429;
    now += 11 * 60_000;
    const limited = await limits.read(accounts);
    expect(limited[0]).toMatchObject({ status: 'warn', stale: true });
    expect(limited[0]?.error).toContain('잠시');

    now += 11 * 60_000; // 물러남이 20분이라 아직 묻지 않는다
    await limits.read(accounts);
    expect(fetch).toHaveBeenCalledTimes(2);
    now += 10 * 60_000;
    await limits.read(accounts);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('B_STUDIO_CLAUDE_USAGE_API=0이면 Claude 사용량 API를 부르지 않는다', async () => {
    await claudeHome();
    const fetch = vi.fn(async () => Response.json(usageBody()));
    const limits = createUsageLimits(deps({ fetch, env: { B_STUDIO_CLAUDE_USAGE_API: '0' } }));

    const [result] = await limits.read([{ id: 'claude-code', backend: 'claude-code' }]);

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'unknown', source: 'disabled' });
  });

  it('처음부터 읽지 못하면 모름으로 두고 까닭을 적는다', async () => {
    const limits = createUsageLimits(deps());

    const [result] = await limits.read([{ id: 'claude-code', backend: 'claude-code' }]);

    expect(result).toMatchObject({ status: 'unknown', windows: [] });
    expect(result?.error).toContain('로그인');
  });
});
