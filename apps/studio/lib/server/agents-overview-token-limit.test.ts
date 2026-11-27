import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionSnapshot } from '@/lib/studio-events';
import { buildAgentOverview, sessionTokenLimitView, withDeskFacts, type SessionOverviewSource } from './agents-overview';
import { addUserUsageSync } from './usage-state';

// 세션 토큰 한도 사용 비율(#1427)

const usage = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return { id: 's1', projectId: 'orders', projectName: 'orders', workDir: '/tmp/orders', status: 'ready', mode: 'claude-code', running: false, services: [], checkpoints: [], owner: 'kim', ...overrides };
}

const saved = { usage: process.env.B_STUDIO_USAGE_DIR };
beforeEach(async () => {
  process.env.B_STUDIO_USAGE_DIR = await mkdtemp(path.join(tmpdir(), 'b-studio-agents-limit-'));
});
afterEach(() => {
  delete process.env.B_STUDIO_USER_TOKEN_LIMIT;
  if (saved.usage === undefined) delete process.env.B_STUDIO_USAGE_DIR;
  else process.env.B_STUDIO_USAGE_DIR = saved.usage;
});

describe('sessionTokenLimitView', () => {
  it('한도가 없으면 없다', () => {
    expect(sessionTokenLimitView(snapshot({ tokens: usage(5000) }))).toBeUndefined();
  });
  it('세션 한도는 스냅샷의 합계로 센다', () => {
    expect(sessionTokenLimitView(snapshot({ tokenLimit: 1000, tokens: usage(850) }))).toEqual({ kind: 'session', limit: 1000, used: 850, percent: 85 });
  });
  it('사람 한도는 세션 주인의 사용량 파일로 센다. 더 빠듯한 쪽을 싣는다', () => {
    process.env.B_STUDIO_USER_TOKEN_LIMIT = '100';
    addUserUsageSync('kim', usage(90), 'day');
    expect(sessionTokenLimitView(snapshot({ tokenLimit: 1000, tokens: usage(100) }))).toMatchObject({ kind: 'user', limit: 100, used: 90, percent: 90 });
  });
  it('사람 사용량 파일을 읽지 못하면 %를 싣지 않는다(0%가 아니다)', () => {
    process.env.B_STUDIO_USER_TOKEN_LIMIT = '100';
    process.env.B_STUDIO_USAGE_DIR = '/dev/null/없는-폴더';
    const view = sessionTokenLimitView(snapshot());
    expect(view).toEqual({ kind: 'user', limit: 100 });
  });
  it('세션 주인을 모르면 사람 한도는 보지 않는다', () => {
    process.env.B_STUDIO_USER_TOKEN_LIMIT = '100';
    expect(sessionTokenLimitView(snapshot({ owner: undefined }))).toBeUndefined();
  });
});

describe('/api/agents 항목에 싣기', () => {
  const source = (overrides: Partial<SessionOverviewSource> = {}): SessionOverviewSource => ({ snapshot: snapshot(), recent: [], updatedAt: '2026-10-22T11:00:00.000Z', ...overrides });
  it('수집기가 준 값을 그대로 싣고, 안 주면 필드가 없다', () => {
    const [withLimit] = withDeskFacts([source()], { terminal: () => undefined, costUsd: () => undefined, tokenLimit: () => ({ kind: 'session', limit: 1000, used: 800, percent: 80 }) });
    expect(buildAgentOverview({ sessions: [withLimit!], plans: [], fleets: [] }).items[0]?.tokenLimit).toEqual({ kind: 'session', limit: 1000, used: 800, percent: 80 });
    const [plain] = withDeskFacts([source()], { terminal: () => undefined, costUsd: () => undefined });
    expect('tokenLimit' in buildAgentOverview({ sessions: [plain!], plans: [], fleets: [] }).items[0]!).toBe(false);
  });
});
