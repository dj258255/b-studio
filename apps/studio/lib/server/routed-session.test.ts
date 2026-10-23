import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 규칙으로 고른 AI로 세션을 만들고 첫 요청을 보낸다(#822). 세션·프로젝트는 가짜로 바꾸고, 규칙 파일과 고르기는 진짜 코드를 쓴다.
 */
const fake = vi.hoisted(() => ({
  notReady: {} as Record<string, string>,
  created: [] as Array<{ projectId: string; owner: string; workspace: string; options: Record<string, unknown> }>,
  sent: [] as Array<{ id: string; text: string; options: Record<string, unknown> }>,
  designError: undefined as string | undefined,
}));

vi.mock('./sessions', async () => {
  const { StudioError } = await import('./errors');
  return {
    allowedBackends: () => new Set(['claude-code', 'codex']),
    resolveSessionBackend: () => 'claude-code',
    assertBackendReady: async (backend: string) => {
      if (fake.notReady[backend]) throw new StudioError(409, fake.notReady[backend]);
    },
    createSession: async (projectId: string, owner: string, workspace: string, options: Record<string, unknown>) => {
      fake.created.push({ projectId, owner, workspace, options });
      return { id: `s${fake.created.length}`, projectId, backend: options.backend };
    },
    sendMessage: (id: string, text: string, options: Record<string, unknown>) => {
      fake.sent.push({ id, text, options });
      return { runId: `r-${id}` };
    },
  };
});

vi.mock('./projects', () => ({ findProject: async (id: string) => (id === 'orders' ? { root: '/tmp/orders', spec: { name: 'orders' } } : undefined) }));
vi.mock('./design-pipeline', () => ({
  assertDesignApprovedForRequest: async () => {
    if (fake.designError) throw new Error(fake.designError);
  },
}));

import { resetBackendRulesCache, saveBackendRules } from './backend-rules';
import { resetProjectModelDefaultsCache } from './model-defaults';
import { startRoutedSession } from './routed-session';

const saved = { rules: process.env.B_STUDIO_BACKEND_RULES_FILE, models: process.env.B_STUDIO_MODEL_DEFAULTS_FILE };

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-routed-'));
  process.env.B_STUDIO_BACKEND_RULES_FILE = path.join(dir, 'rules.json');
  process.env.B_STUDIO_MODEL_DEFAULTS_FILE = path.join(dir, 'models.json');
  resetBackendRulesCache();
  resetProjectModelDefaultsCache();
  fake.notReady = {};
  fake.created = [];
  fake.sent = [];
  fake.designError = undefined;
});

afterEach(() => {
  for (const [key, value] of [['B_STUDIO_BACKEND_RULES_FILE', saved.rules], ['B_STUDIO_MODEL_DEFAULTS_FILE', saved.models]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('startRoutedSession', () => {
  it('규칙 두 개로 요청 두 개가 서로 다른 백엔드 세션으로 가고, 첫 요청이 바로 보내진다', async () => {
    saveBackendRules({ rules: [{ when: { risk: 'high' }, backend: 'claude-code', model: 'opus' }], fallback: { backend: 'codex' } });

    const risky = await startRoutedSession({ projectId: 'orders', user: 'kim', workspace: 'copy', request: '결제 완료 화면을 만들어 줘', intent: 'build' });
    const plain = await startRoutedSession({ projectId: 'orders', user: 'kim', workspace: 'copy', request: '버튼 글자를 바꿔 줘', intent: 'build' });

    expect(fake.created.map((call) => [call.options.backend, call.options.modelId, call.options.boot])).toEqual([
      ['claude-code', 'opus', 'on-demand'],
      ['codex', undefined, 'on-demand'],
    ]);
    expect(risky).toMatchObject({ runId: 'r-s1', routing: { backend: 'claude-code', rule: 0, matched: '위험' } });
    expect(plain).toMatchObject({ runId: 'r-s2', routing: { backend: 'codex', rule: 'fallback' } });
    expect(fake.sent[0]).toMatchObject({ id: 's1', text: '결제 완료 화면을 만들어 줘', options: { by: 'kim', intent: 'build', interactive: true, steering: true, allowBreaking: false } });
  });

  it('로그인 전인 백엔드는 건너뛰고 다음 후보로 만든다', async () => {
    saveBackendRules({ rules: [{ when: {}, backend: 'codex' }] });
    fake.notReady = { codex: '로컬 Codex를 쓸 수 없습니다: 로그인 필요' };
    const result = await startRoutedSession({ projectId: 'orders', user: 'kim', workspace: 'copy', request: '고쳐 줘', intent: 'build' });
    expect(result.routing).toMatchObject({ backend: 'claude-code', rule: 'default', skipped: [{ backend: 'codex' }] });
  });

  it('없는 프로젝트는 세션을 만들지 않고 404', async () => {
    await expect(startRoutedSession({ projectId: 'nope', user: 'kim', workspace: 'copy', request: '고쳐 줘', intent: 'build' })).rejects.toMatchObject({ status: 404 });
    expect(fake.created).toEqual([]);
  });

  it('세션을 만든 뒤 요청을 보내지 못하면 세션과 까닭을 함께 돌려준다', async () => {
    fake.designError = '승인되지 않은 설계가 다루는 요구사항입니다';
    const result = await startRoutedSession({ projectId: 'orders', user: 'kim', workspace: 'copy', request: 'R3 구현', intent: 'build' });
    expect(result.session).toMatchObject({ id: 's1' });
    expect(result.runId).toBeUndefined();
    expect(result.sendError).toBe('승인되지 않은 설계가 다루는 요구사항입니다');
    expect(fake.sent).toEqual([]);
  });

  it('직접 고른 AI로 만들고 첫 요청을 보낸다. 그 AI가 로그인 전이면 세션을 만들지 않는다', async () => {
    saveBackendRules({ rules: [{ when: {}, backend: 'claude-code' }] });
    const result = await startRoutedSession({ projectId: 'orders', user: 'kim', workspace: 'copy', request: '결제 화면 고쳐 줘', intent: 'build', direct: { backend: 'codex', model: 'gpt-5.5' } });
    expect(fake.created[0]?.options).toMatchObject({ backend: 'codex', modelId: 'gpt-5.5' });
    expect(result).toMatchObject({ runId: 'r-s1', routing: { backend: 'codex', rule: 'direct' } });

    fake.notReady = { codex: 'Codex 로그인 필요' };
    await expect(startRoutedSession({ projectId: 'orders', user: 'kim', workspace: 'copy', request: '고쳐 줘', intent: 'build', direct: { backend: 'codex' } })).rejects.toMatchObject({ status: 409 });
    expect(fake.created).toHaveLength(1);
  });

  it('질문은 설계 승인을 보지 않고 보낸다', async () => {
    fake.designError = '막힘';
    const result = await startRoutedSession({ projectId: 'orders', user: 'kim', workspace: 'copy', request: '구조를 설명해 줘', intent: 'ask' });
    expect(result.runId).toBe('r-s1');
    expect(fake.sent[0]?.options).toMatchObject({ intent: 'ask' });
  });
});

describe('계정까지 골라 세션을 만든다(#885)', () => {
  it('규칙이나 직접 고른 계정을 세션에 넘기고, 목록에 없는 계정은 건너뛴다', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'b-studio-routed-account-'));
    const savedEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, 'xdg');
    try {
      const { addAiAccount } = await import('./ai-accounts');
      const account = await addAiAccount({ name: '마르코', backend: 'codex', configDir: '~/.codex-marco' });
      saveBackendRules({ rules: [{ when: {}, backend: 'codex', accountId: 'acct-00000000' }, { when: {}, backend: 'codex', accountId: account.id }] });
      const routed = await startRoutedSession({ projectId: 'orders', user: 'kim', workspace: 'copy', request: '고쳐 줘', intent: 'build' });
      expect(routed.routing).toMatchObject({ backend: 'codex', accountId: account.id, rule: 1, skipped: [{ accountId: 'acct-00000000' }] });
      expect(fake.created[0]?.options).toMatchObject({ backend: 'codex', accountId: account.id });

      await startRoutedSession({ projectId: 'orders', user: 'kim', workspace: 'copy', request: '고쳐 줘', intent: 'build', direct: { backend: 'codex', accountId: account.id } });
      expect(fake.created[1]?.options).toMatchObject({ backend: 'codex', accountId: account.id });
      // 기본 계정은 넘기지 않는다
      await startRoutedSession({ projectId: 'orders', user: 'kim', workspace: 'copy', request: '고쳐 줘', intent: 'build', direct: { backend: 'codex' } });
      expect(fake.created[2]?.options).not.toHaveProperty('accountId');
    } finally {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
