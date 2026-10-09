import type { McpServerConfig, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { LoadedProject } from '@b-studio/spec';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COMPACT_WINDOW, resolveCompactWindow, runClaudeCodeAgent, type ClaudeCodeQuery, type ClaudeCodeSdk } from './claude-code-runner';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT as contract } from './test-helpers';

let project: LoadedProject;

beforeEach(async () => {
  project = await createOrdersProject('claude-code-compact-test-');
});

const WINDOW = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

/**
 * 가짜 로컬 CLI 러너. query를 열 때마다 옵션을 기록한다.
 * failFirst면 첫 query는 네트워크 오류로 끝나 재시도가 새 query를 열게 한다. compact면 init 직후 compact_boundary를 낸다.
 */
function fakeSdk({ failFirst = false, compact }: { failFirst?: boolean; compact?: Record<string, unknown> } = {}) {
  const opened: Options[] = [];
  const sdk: ClaudeCodeSdk = {
    createSdkMcpServer: (config) => ({ type: 'sdk', name: config.name, instance: {} }) as unknown as McpServerConfig,
    query({ prompt, options }) {
      opened.push(options);
      const call = opened.length;
      async function* run(): AsyncGenerator<SDKMessage> {
        yield { type: 'system', subtype: 'init', claude_code_version: '9.9.9', model: 'test-model', session_id: 's1' } as unknown as SDKMessage;
        if (compact) yield { type: 'system', subtype: 'compact_boundary', session_id: 's1', compact_metadata: compact } as unknown as SDKMessage;
        for await (const _user of prompt) {
          const failed = failFirst && call === 1;
          yield {
            type: 'result',
            subtype: 'success',
            is_error: failed,
            result: failed ? 'ENOTFOUND api.anthropic.com' : '끝났습니다.',
            stop_reason: 'end_turn',
            errors: [],
            modelUsage: {},
            session_id: 's1',
          } as unknown as SDKMessage;
          if (failed) return;
        }
      }
      return Object.assign(run(), {
        accountInfo: async () => ({}),
        supportedModels: async () => [],
        interrupt: async () => {},
        close: () => {},
      }) as unknown as ClaudeCodeQuery;
    },
  };
  return { sdk, opened };
}

async function run(sdk: ClaudeCodeSdk, env: NodeJS.ProcessEnv, extra: { networkRetry?: boolean } = {}) {
  const events: AgentEvent[] = [];
  await runClaudeCodeAgent({
    request: '아무거나',
    intent: 'ask',
    project,
    sandbox: fakeSandbox(project, []),
    sdk,
    fetcher: async () => contract,
    env,
    onEvent: (event) => events.push(event),
    ...(extra.networkRetry ? { networkRetry: { wait: async () => {}, maxAttempts: 2, maxWaitMs: 60_000, baseDelayMs: 1 } } : {}),
  });
  return events;
}

describe('resolveCompactWindow', () => {
  it('비어 있으면 기본값 200,000', () => {
    expect(resolveCompactWindow(undefined)).toEqual({ window: DEFAULT_COMPACT_WINDOW });
    expect(resolveCompactWindow('  ')).toEqual({ window: DEFAULT_COMPACT_WINDOW });
    expect(DEFAULT_COMPACT_WINDOW).toBe(200_000);
  });

  it('0·off는 끈다(대소문자 무관)', () => {
    expect(resolveCompactWindow('0')).toEqual({ window: null });
    expect(resolveCompactWindow('off')).toEqual({ window: null });
    expect(resolveCompactWindow('OFF')).toEqual({ window: null });
  });

  it('50,000 이상 정수는 그대로 쓴다', () => {
    expect(resolveCompactWindow('50000')).toEqual({ window: 50_000 });
    expect(resolveCompactWindow(' 350000 ')).toEqual({ window: 350_000 });
  });

  it('숫자가 아니거나 너무 작거나 소수·음수면 기본값을 쓰고 무엇을 무시했는지 알린다', () => {
    for (const raw of ['abc', '49999', '1', '-5', '2e5', '200000.5']) {
      const setting = resolveCompactWindow(raw);
      expect(setting.window).toBe(DEFAULT_COMPACT_WINDOW);
      expect(setting.ignored).toContain(raw);
    }
  });
});

describe('로컬 CLI 러너의 자동 압축 기준 창', () => {
  it('기본값에서 query env에 200000을 넣는다', async () => {
    const { sdk, opened } = fakeSdk();
    const events = await run(sdk, {});
    expect(opened[0]!.env?.[WINDOW]).toBe('200000');
    expect(opened[0]!.env?.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('b-studio');
    expect(events.some((event) => event.type === 'warning')).toBe(false);
  });

  it('B_STUDIO_CLAUDE_CODE_COMPACT_WINDOW 값을 따른다', async () => {
    const { sdk, opened } = fakeSdk();
    await run(sdk, { B_STUDIO_CLAUDE_CODE_COMPACT_WINDOW: '350000' });
    expect(opened[0]!.env?.[WINDOW]).toBe('350000');
  });

  it('off면 넣지 않는다', async () => {
    const { sdk, opened } = fakeSdk();
    await run(sdk, { B_STUDIO_CLAUDE_CODE_COMPACT_WINDOW: 'off' });
    expect(opened[0]!.env).not.toHaveProperty(WINDOW);
  });

  it('사용자가 프로세스 환경에 직접 준 값은 덮어쓰지 않는다', async () => {
    const { sdk, opened } = fakeSdk();
    await run(sdk, { [WINDOW]: '123456', B_STUDIO_CLAUDE_CODE_COMPACT_WINDOW: '300000' });
    expect(opened[0]!.env?.[WINDOW]).toBe('123456');
  });

  it('잘못된 값은 기본값을 쓰고 무시한 값을 한 번 알린다', async () => {
    const { sdk, opened } = fakeSdk();
    const events = await run(sdk, { B_STUDIO_CLAUDE_CODE_COMPACT_WINDOW: '1000' });
    expect(opened[0]!.env?.[WINDOW]).toBe('200000');
    const warnings = events.filter((event) => event.type === 'warning');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ message: expect.stringContaining('B_STUDIO_CLAUDE_CODE_COMPACT_WINDOW=1000') });
  });

  it('compact_boundary를 context_compacted 이벤트로 낸다', async () => {
    const { sdk } = fakeSdk({ compact: { trigger: 'auto', pre_tokens: 961_058, post_tokens: 270_474, duration_ms: 1200 } });
    const events = await run(sdk, {});
    expect(events.filter((event) => event.type === 'context_compacted')).toEqual([
      { type: 'context_compacted', trigger: 'auto', preTokens: 961_058, postTokens: 270_474 },
    ]);
  });

  it('post_tokens가 없으면 postTokens 없이 낸다', async () => {
    const { sdk } = fakeSdk({ compact: { trigger: 'manual', pre_tokens: 500_000 } });
    const events = await run(sdk, {});
    expect(events.find((event) => event.type === 'context_compacted')).toEqual({ type: 'context_compacted', trigger: 'manual', preTokens: 500_000 });
  });

  it('네트워크 재시도로 연 새 query에도 같은 env가 들어간다', async () => {
    const { sdk, opened } = fakeSdk({ failFirst: true });
    await run(sdk, {}, { networkRetry: true });
    expect(opened).toHaveLength(2);
    expect(opened.map((options) => options.env?.[WINDOW])).toEqual(['200000', '200000']);
  });
});
