import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPlainRequest, PLAIN_BASELINE_TOOLS, runPlainBaseline, type PlainBaselineQuery, type PlainBaselineSdk } from './plain-baseline';
import { BENCH_TASKS } from './tasks';

const task = BENCH_TASKS[0]!;

type Step = { text: string; id?: string; usage?: Record<string, number> } | { write: { path: string; content: string } };

interface FakeOptions {
  steps?: Step[];
  result?: Record<string, unknown>;
}

/** Claude Code 프로세스를 흉내 내는 가짜 SDK. write 단계는 복사본에 파일을 실제로 쓴다(도구 대신) */
function fakeClaudeCode({ steps = [], result = {} }: FakeOptions = {}) {
  const state = { options: undefined as Options | undefined, prompt: '', closed: false };
  const sdk: PlainBaselineSdk = {
    query({ prompt, options }) {
      state.options = options;
      state.prompt = prompt;
      async function* run(): AsyncGenerator<SDKMessage> {
        yield { type: 'system', subtype: 'init', claude_code_version: '9.9.9', model: 'test-model', session_id: 's1' } as unknown as SDKMessage;
        let ids = 0;
        let lastText = '';
        for (const step of steps) {
          if ('write' in step) {
            const target = path.join(options.cwd!, step.write.path);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, step.write.content);
            continue;
          }
          const id = step.id ?? `msg_${++ids}`;
          lastText = step.text;
          yield {
            type: 'assistant',
            message: { id, content: [{ type: 'text', text: step.text }], ...(step.usage ? { usage: step.usage } : {}) },
            parent_tool_use_id: null,
            session_id: 's1',
          } as unknown as SDKMessage;
        }
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: lastText,
          stop_reason: 'end_turn',
          errors: [],
          modelUsage: { 'test-model': { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 1, cacheCreationInputTokens: 2 } },
          session_id: 's1',
          ...result,
        } as unknown as SDKMessage;
      }
      const query: PlainBaselineQuery = Object.assign(run(), {
        close: () => {
          state.closed = true;
        },
      });
      return query;
    },
  };
  return { sdk, state };
}

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(tmpdir(), 'plain-baseline-'));
  await mkdir(path.join(projectDir, 'web/app'), { recursive: true });
  await writeFile(path.join(projectDir, 'web/app/page.tsx'), 'export default function Page() {}');
  await writeFile(path.join(projectDir, 'studio.yaml'), 'name: bench-orders\n');
});

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

describe('runPlainBaseline', () => {
  it('파일 도구만 주고, 프리셋 시스템 프롬프트를 쓰고, 프로젝트 설정만 싣고, Bash는 주지 않는다', async () => {
    const { sdk, state } = fakeClaudeCode();

    await runPlainBaseline({ projectDir, task, model: 'sonnet', sdk });

    expect(state.options).toMatchObject({
      cwd: projectDir,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: [...PLAIN_BASELINE_TOOLS],
      allowedTools: [...PLAIN_BASELINE_TOOLS],
      permissionMode: 'dontAsk',
      settingSources: ['project'],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      model: 'sonnet',
      maxTurns: 60,
    });
    expect(state.options?.tools).not.toContain('Bash');
    expect(state.options?.allowedTools).not.toContain('Bash');
    for (const forbidden of ['Bash', 'WebFetch', 'WebSearch', 'Task']) {
      expect(state.options?.allowedTools, forbidden).not.toContain(forbidden);
    }
    expect(state.closed).toBe(true);
  });

  it('복사본에 훅·MCP 설정 파일이 있으면 모델을 부르기 전에 거부한다', async () => {
    const { sdk, state } = fakeClaudeCode();
    await mkdir(path.join(projectDir, '.claude'), { recursive: true });
    await writeFile(path.join(projectDir, '.claude/settings.json'), '{"hooks":{}}');
    await writeFile(path.join(projectDir, '.mcp.json'), '{}');

    await expect(runPlainBaseline({ projectDir, task, model: 'sonnet', sdk })).rejects.toThrow(/\.mcp\.json, \.claude\/settings\.json/);
    expect(state.options).toBeUndefined();
  });

  it('과제 전체 요청 + api 요청 + web 요청을 한 요청으로 보낸다', async () => {
    const { sdk, state } = fakeClaudeCode();
    await runPlainBaseline({ projectDir, task, sdk });

    expect(state.prompt).toBe(buildPlainRequest(task));
    expect(state.prompt).toBe([task.request, task.api.request, task.web.request].join('\n'));
  });

  it('같은 메시지 id는 한 번만 세고, 최대 입력 크기와 토큰 합계를 러너와 같은 방식으로 모은다', async () => {
    const { sdk } = fakeClaudeCode({
      steps: [
        { text: '읽었습니다.', id: 'm1', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 5 } },
        { text: '고쳤습니다.', id: 'm1', usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 7 } },
        { text: '끝.', id: 'm2', usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } },
      ],
    });

    const result = await runPlainBaseline({ projectDir, task, sdk });

    expect(result.status).toBe('done');
    expect(result.summary).toBe('끝.');
    // 서로 다른 id가 2개다 (id 2개, 메시지 3개)
    expect(result.modelCalls).toBe(2);
    expect(result.turns).toBe(2);
    // 호출 한 번의 최대 입력 크기: 200 + 2,000 + 7 = 2,207
    expect(result.maxContextTokens).toBe(2_207);
    // usage는 result의 누적값(modelUsage)을 쓴다
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 });
  });

  it('사용 한도 문구가 있으면 rate_limited로 본다', async () => {
    const { sdk } = fakeClaudeCode({ steps: [{ text: '시작합니다.' }], result: { is_error: true, result: 'rate limit reached' } });
    const result = await runPlainBaseline({ projectDir, task, sdk });
    expect(result.status).toBe('rate_limited');
    expect(result.summary).toContain('rate limit');
  });

  it('모델 호출이 오류로 끝나면 failed로 본다', async () => {
    const { sdk } = fakeClaudeCode({ result: { subtype: 'error_max_turns', errors: ['최대 턴 수'] } });
    const result = await runPlainBaseline({ projectDir, task, sdk });
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('최대 턴 수');
  });

  it('실행 전후 복사본을 비교해 더하거나 고친 파일만 changedFiles로 낸다', async () => {
    const { sdk } = fakeClaudeCode({
      steps: [
        { write: { path: 'api/src/Order.java', content: 'class Order {}' } },
        { write: { path: 'web/app/page.tsx', content: 'export default function Page() { return null; }' } },
      ],
    });

    const result = await runPlainBaseline({ projectDir, task, sdk });

    expect(result.changedFiles).toEqual(['api/src/Order.java', 'web/app/page.tsx']);
    // 그대로 둔 파일은 변경이 아니다
    expect(result.changedFiles).not.toContain('studio.yaml');
  });
});

describe('buildPlainRequest', () => {
  it('전체 요청·api·web을 줄바꿈으로 잇는다', () => {
    expect(buildPlainRequest(task)).toBe(`${task.request}\n${task.api.request}\n${task.web.request}`);
  });
});
