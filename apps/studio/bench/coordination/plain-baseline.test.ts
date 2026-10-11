import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace } from '@b-studio/agent';
import { buildPlainRequest, confineToProject, PLAIN_BASELINE_TOOLS, runPlainBaseline, type PlainBaselineQuery, type PlainBaselineSdk } from './plain-baseline';
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
      // 내장 도구를 허용 목록에 넣지 않는다. 넣으면 경로와 무관하게 허용된다(#671)
      allowedTools: [],
      permissionMode: 'acceptEdits',
      settingSources: ['project'],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      model: 'sonnet',
      maxTurns: 60,
    });
    expect(state.options?.tools).not.toContain('Bash');
    for (const forbidden of ['Bash', 'WebFetch', 'WebSearch', 'Task']) {
      expect(state.options?.tools, forbidden).not.toContain(forbidden);
    }
    // 도구를 쓰기 직전의 경로 검사가 걸려 있다. 모든 도구에 건다(matcher 없음)
    expect(state.options?.hooks?.PreToolUse).toHaveLength(1);
    expect(state.options?.hooks?.PreToolUse?.[0]?.matcher).toBeUndefined();
    expect(state.options?.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(state.closed).toBe(true);
  });

  it('파일 도구를 프로젝트 복사본 안으로 가둔다: 밖의 경로, 링크를 거치는 경로, 숨긴 경로를 거절한다 (#671)', async () => {
    const outside = path.join(projectDir, '..', `${path.basename(projectDir)}-outside`);
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'x');
    await symlink(outside, path.join(projectDir, 'link-out'));
    const confine = confineToProject(new Workspace(projectDir));
    const decide = async (tool_name: string, tool_input: unknown) => {
      const output = (await confine({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't1' } as never, 't1', { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
      return output.hookSpecificOutput?.permissionDecision ?? 'pass';
    };
    // 복사본 안의 평범한 파일은 결정을 내리지 않는다(허용은 CLI의 권한이 한다)
    expect(await decide('Read', { file_path: path.join(projectDir, 'api/src/Order.java') })).toBe('pass');
    expect(await decide('Write', { file_path: path.join(projectDir, 'api/src/New.java'), content: 'x' })).toBe('pass');
    expect(await decide('Grep', { pattern: 'Order', path: projectDir })).toBe('pass');
    // 실측에서 뚫렸던 것들
    expect(await decide('Read', { file_path: path.join(outside, 'secret.txt') })).toBe('deny');
    expect(await decide('Read', { file_path: '/etc/hosts' })).toBe('deny');
    expect(await decide('Write', { file_path: path.join(outside, 'escape.txt'), content: 'x' })).toBe('deny');
    expect(await decide('Write', { file_path: path.join(projectDir, 'link-out/via-link.txt'), content: 'x' })).toBe('deny');
    expect(await decide('Grep', { pattern: 'x', path: outside })).toBe('deny');
    expect(await decide('Glob', { pattern: '../**/*.txt' })).toBe('deny');
    expect(await decide('Write', { file_path: path.join(projectDir, '.git/config'), content: 'x' })).toBe('deny');
    // 주지 않은 도구와 읽을 수 없는 입력도 거절한다
    expect(await decide('Bash', { command: 'cat /etc/hosts' })).toBe('deny');
    expect(await decide('Read', {})).toBe('deny');
    expect(await decide('Read', { file_path: 'relative/path.txt' })).toBe('deny');
    // 다른 종류의 훅 입력에는 결정을 내리지 않는다
    expect(await confine({ hook_event_name: 'Stop' } as never, undefined, { signal: new AbortController().signal })).toEqual({});
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
    // 모델별 단가로 환산하려고 모델 이름별 토큰도 남긴다(S0 행과 같은 계산)
    expect(result.usageByModel).toEqual({ 'test-model': { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2 } });
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
