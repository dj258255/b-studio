import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '@/lib/studio-events';

/**
 * 새 요청을 터미널로 보낸다(#836). 규칙으로 고른 AI의 CLI 터미널을 열고, CLI가 뜨면 첫 요청을 붙여 넣는다.
 * 세션·프로젝트는 가짜, 규칙 파일과 고르기는 진짜 코드다. 터미널은 가짜 driver로 바꿔 끼운다
 */
const fake = vi.hoisted(() => ({
  notReady: {} as Record<string, string>,
  created: [] as Array<{ projectId: string; options: Record<string, unknown> }>,
  sent: [] as Array<{ id: string; text: string }>,
  designError: undefined as string | undefined,
}));

vi.mock('./sessions', async () => {
  const { StudioError } = await import('./errors');
  return {
    allowedBackends: () => new Set(['claude-code', 'codex', 'commandcode']),
    resolveSessionBackend: () => 'claude-code',
    assertBackendReady: async (backend: string) => {
      if (fake.notReady[backend]) throw new StudioError(409, fake.notReady[backend]);
    },
    createSession: async (projectId: string, _owner: string, _workspace: string, options: Record<string, unknown>) => {
      fake.created.push({ projectId, options });
      return { id: `s${fake.created.length}`, projectId, backend: options.backend };
    },
    sendMessage: (id: string, text: string) => {
      fake.sent.push({ id, text });
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
import { startRoutedSession, type RoutedTerminalDeps } from './routed-session';

/** 가짜 터미널. cliAfter번 확인한 뒤에 CLI가 뜬 것으로 보이고, 붙여 넣은 Enter마다 startOnEnter번째에 run_started를 보낸다 */
function terminal(options: { cliAfter?: number; never?: boolean; startOnEnter?: number; mode?: 'host' | 'container'; allowed?: boolean } = {}) {
  const writes: Array<{ id: string; data: string }> = [];
  const opened: string[] = [];
  const listeners = new Map<string, (event: StudioEvent) => void>();
  let checks = 0;
  let enters = 0;
  const deps: Partial<RoutedTerminalDeps> = {
    allowed: () => options.allowed ?? true,
    mode: () => options.mode ?? 'host',
    driver: {
      open: async (id) => void opened.push(id),
      cliAlive: () => !options.never && ++checks > (options.cliAfter ?? 0),
      write: (id, data) => {
        writes.push({ id, data });
        if (data === '\r' && ++enters === (options.startOnEnter ?? 1)) {
          listeners.get(id)?.({ type: 'run_started', runId: 'run-t', via: 'terminal', request: 'x' } as unknown as StudioEvent);
        }
      },
    },
    subscribe: (id, listener) => {
      listeners.set(id, listener);
      return () => listeners.delete(id);
    },
    cliTimeoutMs: 50,
    submitTimeoutMs: 20,
    pollMs: 1,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  return { deps, writes, opened };
}

const saved = { rules: process.env.B_STUDIO_BACKEND_RULES_FILE, models: process.env.B_STUDIO_MODEL_DEFAULTS_FILE };

beforeEach(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-routed-terminal-'));
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

const base = { projectId: 'orders', user: 'kim', workspace: 'copy' as const, intent: 'build' as const, terminal: true as const };

describe('startRoutedSession — 터미널로(#836)', () => {
  it('고른 AI로 세션을 만들고 터미널을 열고, CLI가 뜬 뒤 첫 요청을 붙여 넣고 Enter를 보낸다. 대화 러너로는 보내지 않는다', async () => {
    saveBackendRules({ rules: [{ when: {}, backend: 'codex' }] });
    const t = terminal({ cliAfter: 2 });
    const result = await startRoutedSession({ ...base, request: '주문 목록 화면을 고쳐 줘' }, t.deps);

    expect(fake.created[0]?.options).toMatchObject({ backend: 'codex', boot: 'on-demand' });
    expect(t.opened).toEqual(['s1']);
    expect(t.writes).toEqual([
      { id: 's1', data: '\x1b[200~주문 목록 화면을 고쳐 줘\x1b[201~' },
      { id: 's1', data: '\r' },
    ]);
    expect(fake.sent).toEqual([]);
    expect(result).toMatchObject({ session: { id: 's1' }, routing: { backend: 'codex', rule: 0 }, terminal: { opened: true, pasted: true } });
    expect(result.terminal?.pasteError).toBeUndefined();
    expect(result.runId).toBeUndefined();
  });

  it('질문은 읽기만 표시를 붙여 넣는다', async () => {
    const t = terminal();
    await startRoutedSession({ ...base, intent: 'ask', request: '구조를 설명해 줘' }, t.deps);
    expect(t.writes[0]?.data).toBe('\x1b[200~[읽기만] 구조를 설명해 줘\x1b[201~');
  });

  it('터미널을 쓸 수 없는 설정이면 고르기 전에 400, 세션을 만들지 않는다', async () => {
    const t = terminal({ allowed: false });
    await expect(startRoutedSession({ ...base, request: '고쳐 줘' }, t.deps)).rejects.toMatchObject({ status: 400 });
    expect(fake.created).toEqual([]);
  });

  it('터미널에서 띄울 수 없는 AI는 다음 후보로 넘어간다. 컨테이너 방식에서는 Codex도 건너뛴다', async () => {
    saveBackendRules({ rules: [{ when: {}, backend: 'commandcode' }, { when: {}, backend: 'codex' }], fallback: { backend: 'claude-code' } });
    const host = await startRoutedSession({ ...base, request: '고쳐 줘' }, terminal().deps);
    expect(host.routing).toMatchObject({ backend: 'codex', rule: 1, skipped: [{ backend: 'commandcode' }] });

    const container = await startRoutedSession({ ...base, request: '고쳐 줘' }, terminal({ mode: 'container' }).deps);
    expect(container.routing).toMatchObject({ backend: 'claude-code', rule: 'fallback' });
    expect(container.routing.skipped.map((skip) => skip.backend)).toEqual(['commandcode', 'codex']);
  });

  it('직접 고른 AI가 터미널에서 띄울 수 없으면 400, 세션을 만들지 않는다', async () => {
    await expect(startRoutedSession({ ...base, request: '고쳐 줘', direct: { backend: 'commandcode' } }, terminal().deps)).rejects.toMatchObject({ status: 400 });
    await expect(startRoutedSession({ ...base, request: '고쳐 줘', direct: { backend: 'codex' } }, terminal({ mode: 'container' }).deps)).rejects.toMatchObject({ status: 400 });
    expect(fake.created).toEqual([]);
  });

  it('CLI가 시간 안에 뜨지 않으면 붙여 넣지 않고 세션·터미널과 까닭을 돌려준다', async () => {
    const t = terminal({ never: true });
    const result = await startRoutedSession({ ...base, request: '고쳐 줘' }, t.deps);
    expect(t.opened).toEqual(['s1']);
    expect(t.writes).toEqual([]);
    expect(result.terminal).toMatchObject({ opened: true, pasted: false });
    expect(result.terminal?.pasteError).toMatch(/CLI가 뜨지 않아/);
  });

  it('붙여 넣은 뒤 실행이 시작되지 않으면 Enter를 한 번 더 보낸다. 그래도 안 되면 붙여 넣은 사실과 까닭을 함께 돌려준다', async () => {
    const second = terminal({ startOnEnter: 2 });
    const ok = await startRoutedSession({ ...base, request: '고쳐 줘' }, second.deps);
    expect(second.writes.filter((write) => write.data === '\r')).toHaveLength(2);
    expect(ok.terminal).toEqual({ opened: true, pasted: true });

    const never = terminal({ startOnEnter: 99 });
    const stuck = await startRoutedSession({ ...base, request: '고쳐 줘' }, never.deps);
    expect(never.writes.filter((write) => write.data === '\r')).toHaveLength(2);
    expect(stuck.terminal).toMatchObject({ opened: true, pasted: true });
    expect(stuck.terminal?.pasteError).toMatch(/Enter/);
  });

  it('만들기 요청의 설계 승인이 막히면 터미널을 열지 않고 세션과 까닭을 돌려준다', async () => {
    fake.designError = '승인되지 않은 설계가 다루는 요구사항입니다';
    const t = terminal();
    const result = await startRoutedSession({ ...base, request: 'R3 구현' }, t.deps);
    expect(t.opened).toEqual([]);
    expect(result).toMatchObject({ session: { id: 's1' }, sendError: '승인되지 않은 설계가 다루는 요구사항입니다' });
    expect(result.terminal).toBeUndefined();
  });
});
