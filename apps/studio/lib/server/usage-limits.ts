/**
 * 계정마다 구독 한도(5시간·주간)를 읽는다(ADR-187). 터미널 작업대의 사용량 카드가 쓴다.
 *
 * - Codex: 계정의 `CODEX_HOME`으로 `codex app-server`를 잠깐 띄워 `account/rateLimits/read`를 묻는다. 한도를 쓰지 않는
 *   읽기다. 창은 슬롯 이름(primary·secondary)이 아니라 창 길이(300분·10080분)로 가른다.
 * - Claude: Claude Code의 `/usage`가 부르는 사용량 API(`/api/oauth/usage`)를 그 계정의 OAuth 토큰으로 부른다. 문서가 없는
 *   API라 바뀌거나 막힐 수 있고, 구독 토큰을 Claude Code 밖에서 쓰는 것이라 약관상 회색지대다. 그래서 계정마다 10분에 한 번만
 *   묻고, 429면 간격을 두 배씩 늘리고, `B_STUDIO_CLAUDE_USAGE_API=0`이면 끈다. 토큰은 읽기만 한다 — 갱신하거나 자격 저장소에
 *   다시 쓰지 않는다(만료됐으면 그 계정으로 Claude를 한 번 쓰면 CLI가 갱신한다). 토큰과 응답 원문은 오류·기록에 싣지 않는다.
 * - Gemini CLI에는 5시간·주간 한도가 없어 "해당 없음"으로 둔다.
 *
 * 계정 목록은 부르는 쪽이 준다(여러 계정 #885 전에는 CLI마다 기본 계정 하나).
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

export interface UsageAccount {
  id: string;
  /** 세션 백엔드 이름(claude-code·codex·gemini…) */
  backend: string;
  /** 계정의 설정 폴더(claude는 CLAUDE_CONFIG_DIR, codex는 CODEX_HOME). 없으면 CLI 기본 자리 */
  configDir?: string;
}

export type LimitKind = 'five_hour' | 'weekly' | 'other';

export interface LimitWindow {
  kind: LimitKind;
  /** 0~100 */
  usedPercent: number;
  /** ISO 시각. 모르면 없다 */
  resetsAt?: string;
  /** kind가 other일 때 창 길이(분) */
  minutes?: number;
}

/** ok 여유, warn 주의, exhausted 다 씀, idle 쉬는 중, unknown 모름(읽지 못함·꺼 둠), unsupported 해당 없음 */
export type LimitStatus = 'ok' | 'warn' | 'exhausted' | 'idle' | 'unknown' | 'unsupported';

export interface AccountLimits {
  id: string;
  backend: string;
  plan?: string;
  status: LimitStatus;
  windows: LimitWindow[];
  source: 'claude-oauth' | 'codex-app-server' | 'disabled' | 'none';
  /** 마지막으로 읽은 시각(ISO) */
  fetchedAt?: string;
  /** 이번에 읽지 못해 지난 값을 보여 주는 중 */
  stale?: boolean;
  /** 읽지 못한 까닭(사람이 읽는 한국어). 토큰·응답 원문은 담지 않는다 */
  error?: string;
  recommended?: boolean;
}

export interface CodexLimits {
  plan?: string;
  reached: boolean;
  windows: LimitWindow[];
}

export interface UsageLimitDeps {
  now: () => number;
  platform: NodeJS.Platform;
  homeDir: string;
  env: Record<string, string | undefined>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** macOS Keychain의 generic password 값. 없으면 undefined */
  readKeychain: (service: string) => Promise<string | undefined>;
  readCodex: (account: UsageAccount) => Promise<CodexLimits>;
}

export class UsageLimitError extends Error {
  readonly rateLimited: boolean;
  constructor(message: string, rateLimited = false) {
    super(message);
    this.name = 'UsageLimitError';
    this.rateLimited = rateLimited;
  }
}

const WARN_AT = 70;
const EXHAUSTED_AT = 95;

/** 가장 많이 쓴 창으로 상태를 정한다. CLI가 한도에 닿았다고 하면 퍼센트와 상관없이 다 씀 */
export function judgeStatus(windows: LimitWindow[], reached = false): LimitStatus {
  if (reached) return 'exhausted';
  const most = Math.max(0, ...windows.map((window) => window.usedPercent));
  if (most >= EXHAUSTED_AT) return 'exhausted';
  if (most >= WARN_AT) return 'warn';
  if (windows.length === 0 || most === 0) return 'idle';
  return 'ok';
}

function remaining(limits: AccountLimits, kind: LimitKind): number {
  const window = limits.windows.find((item) => item.kind === kind);
  return 100 - (window?.usedPercent ?? 0);
}

/** 다 쓰지 않은 계정 가운데 주간 여유가 가장 큰 것 하나에 추천을 단다(같으면 5시간 여유가 큰 쪽) */
export function markRecommended(accounts: AccountLimits[]): AccountLimits[] {
  let best: AccountLimits | undefined;
  for (const account of accounts) {
    if (account.status !== 'ok' && account.status !== 'warn' && account.status !== 'idle') continue;
    if (
      !best ||
      remaining(account, 'weekly') > remaining(best, 'weekly') ||
      (remaining(account, 'weekly') === remaining(best, 'weekly') && remaining(account, 'five_hour') > remaining(best, 'five_hour'))
    ) {
      best = account;
    }
  }
  return accounts.map((account) => (account === best ? { ...account, recommended: true } : account));
}

export function claudePlanLabel(subscriptionType: unknown, rateLimitTier: unknown): string | undefined {
  if (typeof subscriptionType !== 'string' || !subscriptionType) return undefined;
  const name = subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
  const multiple = typeof rateLimitTier === 'string' ? /(\d+)x$/.exec(rateLimitTier)?.[1] : undefined;
  return multiple ? `${name} ${multiple}x` : name;
}

const CODEX_PLAN_LABEL: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  promax: 'Pro Max',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

export function codexPlanLabel(planType: unknown): string | undefined {
  return typeof planType === 'string' ? CODEX_PLAN_LABEL[planType] : undefined;
}

/**
 * Claude Code가 macOS Keychain에 자격을 두는 항목 이름. `CLAUDE_CONFIG_DIR`를 주면 그 경로의 sha256 앞 8자를 붙인다.
 * 이 규칙은 Claude Code 2.x의 동작을 커뮤니티 보고로 맞춘 것이고 실측하지 않았다 — 틀리면 그 계정은 "로그인 필요"로 보인다
 */
export function claudeKeychainService(configDir: string | undefined): string {
  if (!configDir) return 'Claude Code-credentials';
  return `Claude Code-credentials-${createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;
}

interface ClaudeOauth {
  accessToken?: unknown;
  expiresAt?: unknown;
  subscriptionType?: unknown;
  rateLimitTier?: unknown;
}

async function readClaudeCredentials(account: UsageAccount, deps: UsageLimitDeps): Promise<ClaudeOauth | undefined> {
  const raw =
    (deps.platform === 'darwin' ? await deps.readKeychain(claudeKeychainService(account.configDir)) : undefined) ??
    (await readFile(path.join(account.configDir ?? path.join(deps.homeDir, '.claude'), '.credentials.json'), 'utf8').catch(() => undefined));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: ClaudeOauth };
    return parsed.claudeAiOauth;
  } catch {
    return undefined;
  }
}

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

function claudeWindow(kind: LimitKind, value: unknown): LimitWindow | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { utilization, resets_at: resetsAt } = value as { utilization?: unknown; resets_at?: unknown };
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return undefined;
  const window: LimitWindow = { kind, usedPercent: Math.min(100, Math.max(0, utilization)) };
  if (typeof resetsAt === 'string' && !Number.isNaN(Date.parse(resetsAt))) window.resetsAt = new Date(resetsAt).toISOString();
  return window;
}

export async function readClaudeLimits(account: UsageAccount, deps: UsageLimitDeps): Promise<{ plan?: string; windows: LimitWindow[] }> {
  const oauth = await readClaudeCredentials(account, deps);
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    throw new UsageLimitError('Claude 로그인 정보를 찾지 못했습니다. 그 계정으로 claude에 로그인하세요');
  }
  if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= deps.now()) {
    throw new UsageLimitError('Claude 로그인 토큰이 만료됐습니다. 그 계정으로 claude를 한 번 쓰면 갱신됩니다');
  }
  let response: Response;
  try {
    response = await deps.fetch(CLAUDE_USAGE_URL, {
      headers: { authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new UsageLimitError('Claude 사용량 API에 닿지 못했습니다');
  }
  if (response.status === 429) throw new UsageLimitError('Claude 사용량 API가 잠시 막혔습니다. 나중에 다시 묻습니다', true);
  if (response.status === 401 || response.status === 403) throw new UsageLimitError('Claude 로그인 토큰을 받아 주지 않았습니다. 그 계정으로 claude에 다시 로그인하세요');
  if (!response.ok) throw new UsageLimitError(`Claude 사용량 API가 ${response.status}로 답했습니다`);
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') throw new UsageLimitError('Claude 사용량 API의 답을 읽지 못했습니다');
  const windows = [claudeWindow('five_hour', body.five_hour), claudeWindow('weekly', body.seven_day)].filter((window): window is LimitWindow => window !== undefined);
  return { plan: claudePlanLabel(oauth.subscriptionType, oauth.rateLimitTier), windows };
}

interface CodexWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

function codexWindow(value: unknown, fallback: LimitKind): LimitWindow | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { usedPercent, windowDurationMins: minutes, resetsAt } = value as CodexWindow;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) return undefined;
  const kind: LimitKind = minutes === 300 ? 'five_hour' : minutes === 10080 ? 'weekly' : typeof minutes === 'number' ? 'other' : fallback;
  const window: LimitWindow = { kind, usedPercent: Math.min(100, Math.max(0, usedPercent)) };
  if (typeof resetsAt === 'number' && Number.isFinite(resetsAt)) window.resetsAt = new Date(resetsAt * 1000).toISOString();
  if (kind === 'other') window.minutes = minutes as number;
  return window;
}

const KIND_ORDER: Record<LimitKind, number> = { five_hour: 0, weekly: 1, other: 2 };

/**
 * `codex app-server`(stdio, 줄마다 JSON-RPC)를 띄워 한도를 한 번 묻고 끝낸다.
 * 메시지 이름과 모양은 codex 0.160.1의 `codex app-server generate-ts`로 확인했다
 */
export async function readCodexLimits(options: { command?: string; args?: string[]; codexHome?: string; timeoutMs?: number } = {}): Promise<CodexLimits> {
  const env = { ...process.env };
  if (options.codexHome) env.CODEX_HOME = options.codexHome;
  const child = spawn(options.command ?? 'codex', options.args ?? ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    return await new Promise<CodexLimits>((resolve, reject) => {
      const timer = setTimeout(() => reject(new UsageLimitError('codex app-server가 시간 안에 답하지 않았습니다')), options.timeoutMs ?? 10_000);
      const finish = (action: () => void) => {
        clearTimeout(timer);
        action();
      };
      child.on('error', (error: NodeJS.ErrnoException) =>
        finish(() => reject(new UsageLimitError(error.code === 'ENOENT' ? 'codex를 찾지 못했습니다' : `codex app-server를 띄우지 못했습니다: ${error.message}`))),
      );
      child.on('exit', () => finish(() => reject(new UsageLimitError('codex app-server가 답하기 전에 끝났습니다'))));
      child.stdin.on('error', () => undefined);
      createInterface({ input: child.stdout }).on('line', (line) => {
        let message: { id?: unknown; result?: unknown; error?: { message?: unknown }; method?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          return;
        }
        if (message.method !== undefined) return; // 알림·서버의 요청은 보지 않는다
        if (message.error) {
          const detail = typeof message.error.message === 'string' ? message.error.message.slice(0, 200) : '';
          finish(() => reject(new UsageLimitError(`Codex 한도를 읽지 못했습니다: ${detail}`)));
          return;
        }
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } });
          return;
        }
        if (message.id !== 2) return;
        const snapshot = ((message.result ?? {}) as { rateLimits?: Record<string, unknown> }).rateLimits ?? {};
        const windows = [codexWindow(snapshot.primary, 'five_hour'), codexWindow(snapshot.secondary, 'weekly')]
          .filter((window): window is LimitWindow => window !== undefined)
          .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
        finish(() => resolve({ plan: codexPlanLabel(snapshot.planType), reached: snapshot.rateLimitReachedType != null, windows }));
      });
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'b-studio', title: null, version: '0' }, capabilities: null } });
    });
  } finally {
    child.stdin.end();
    child.kill();
  }
}

interface CacheEntry {
  value?: AccountLimits;
  lastAttempt: number;
  nextAllowed: number;
  failures: number;
  inflight?: Promise<AccountLimits>;
}

const MINUTE = 60_000;
/** 그냥 부를 때 다시 묻는 간격과, refresh여도 지키는 최소 간격 */
const INTERVALS: Record<'claude-code' | 'codex', { ttl: number; min: number }> = {
  'claude-code': { ttl: 10 * MINUTE, min: 10 * MINUTE },
  codex: { ttl: 5 * MINUTE, min: MINUTE },
};
const MAX_BACKOFF = 2 * 60 * MINUTE;

export function createUsageLimits(deps: UsageLimitDeps) {
  const cache = new Map<string, CacheEntry>();

  async function fetchOne(account: UsageAccount, kind: 'claude-code' | 'codex', entry: CacheEntry): Promise<AccountLimits> {
    const now = deps.now();
    entry.lastAttempt = now;
    const source = kind === 'claude-code' ? 'claude-oauth' : 'codex-app-server';
    try {
      const read = kind === 'claude-code' ? { ...(await readClaudeLimits(account, deps)), reached: false } : await deps.readCodex(account);
      entry.failures = 0;
      entry.nextAllowed = now + INTERVALS[kind].min;
      entry.value = { id: account.id, backend: account.backend, plan: read.plan, status: judgeStatus(read.windows, read.reached), windows: read.windows, source, fetchedAt: new Date(now).toISOString() };
      if (entry.value.plan === undefined) delete entry.value.plan;
      return entry.value;
    } catch (error) {
      const rateLimited = error instanceof UsageLimitError && error.rateLimited;
      entry.failures = rateLimited ? entry.failures + 1 : 0;
      entry.nextAllowed = now + (rateLimited ? Math.min(MAX_BACKOFF, INTERVALS[kind].min * 2 ** entry.failures) : INTERVALS[kind].min);
      const message = error instanceof UsageLimitError ? error.message : '한도를 읽지 못했습니다';
      if (entry.value) return { ...entry.value, stale: true, error: message };
      return { id: account.id, backend: account.backend, status: 'unknown', windows: [], source, error: message };
    }
  }

  async function readOne(account: UsageAccount, refresh: boolean): Promise<AccountLimits> {
    const kind = account.backend === 'claude-code' || account.backend === 'codex' ? account.backend : undefined;
    if (!kind) return { id: account.id, backend: account.backend, status: 'unsupported', windows: [], source: 'none' };
    if (kind === 'claude-code' && deps.env.B_STUDIO_CLAUDE_USAGE_API === '0') {
      return { id: account.id, backend: account.backend, status: 'unknown', windows: [], source: 'disabled', error: 'Claude 사용량 API를 꺼 두었습니다(B_STUDIO_CLAUDE_USAGE_API=0)' };
    }
    const key = `${account.backend}\0${account.id}\0${account.configDir ?? ''}`;
    const entry = cache.get(key) ?? { lastAttempt: -Infinity, nextAllowed: -Infinity, failures: 0 };
    cache.set(key, entry);
    if (entry.inflight) return entry.inflight;
    const now = deps.now();
    const wait = refresh ? INTERVALS[kind].min : INTERVALS[kind].ttl;
    const due = now >= entry.nextAllowed && now - entry.lastAttempt >= wait;
    if (!due && entry.value) return entry.value;
    if (!due) return { id: account.id, backend: account.backend, status: 'unknown', windows: [], source: kind === 'claude-code' ? 'claude-oauth' : 'codex-app-server', error: '잠시 뒤 다시 묻습니다' };
    entry.inflight = fetchOne(account, kind, entry).finally(() => {
      entry.inflight = undefined;
    });
    return entry.inflight;
  }

  return {
    async read(accounts: UsageAccount[], options: { refresh?: boolean } = {}): Promise<AccountLimits[]> {
      const results = await Promise.all(accounts.map((account) => readOne(account, options.refresh === true)));
      return markRecommended(results);
    },
  };
}

/** 한도를 읽는 CLI. 그 밖의 CLI(commandcode·opencode)는 5시간·주간 한도가 없어 사용량 화면에 올리지 않는다 */
export const LIMIT_BACKENDS = ['claude-code', 'codex', 'gemini'] as const;
/** CLI의 기본 설정 폴더(홈 기준). 같은 폴더를 가리키는 계정을 하나로 보는 데 쓴다 */
const DEFAULT_CONFIG_DIR: Record<string, string> = { 'claude-code': '.claude', codex: '.codex', gemini: '.gemini' };

/**
 * 계정 목록(#885)에서 한도를 읽을 계정을 꺼낸다(#889). 한도가 있는 CLI만 두고, 같은 설정 폴더를 가리키는 계정은 앞의 하나만 둔다 —
 * 같은 로그인을 두 번 읽으면 Claude 사용량 API를 그만큼 더 부르고, 사용량 화면에 같은 계정이 둘 보인다
 */
export function limitAccounts(accounts: ReadonlyArray<{ id: string; backend: string; configDir?: string }>, homeDir: string): UsageAccount[] {
  const seen = new Set<string>();
  const result: UsageAccount[] = [];
  for (const account of accounts) {
    if (!(LIMIT_BACKENDS as readonly string[]).includes(account.backend)) continue;
    const dir = path.resolve(account.configDir ?? path.join(homeDir, DEFAULT_CONFIG_DIR[account.backend] ?? `.${account.backend}`));
    const key = `${account.backend}\0${dir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ id: account.id, backend: account.backend, ...(account.configDir ? { configDir: account.configDir } : {}) });
  }
  return result;
}

/** 계정 목록을 읽지 못했을 때 보는 CLI마다의 기본 계정 */
export const DEFAULT_LIMIT_ACCOUNTS: UsageAccount[] = [
  { id: 'claude-code', backend: 'claude-code' },
  { id: 'codex', backend: 'codex' },
  { id: 'gemini', backend: 'gemini' },
];

function readKeychain(service: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { timeout: 5_000 }, (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined);
    });
  });
}

const GLOBAL_KEY = Symbol.for('b-studio.usage-limits');

/** 스튜디오 프로세스에 하나. 개발 서버가 모듈을 다시 읽어도 캐시(물러남 포함)를 잃지 않게 globalThis에 둔다 */
export function usageLimits(): ReturnType<typeof createUsageLimits> {
  const holder = globalThis as unknown as Record<symbol, ReturnType<typeof createUsageLimits> | undefined>;
  holder[GLOBAL_KEY] ??= createUsageLimits({
    now: Date.now,
    platform: process.platform,
    homeDir: homedir(),
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    readKeychain,
    readCodex: (account) => readCodexLimits({ command: process.env.B_STUDIO_CODEX_BIN?.trim() || 'codex', codexHome: account.configDir }),
  });
  return holder[GLOBAL_KEY];
}
