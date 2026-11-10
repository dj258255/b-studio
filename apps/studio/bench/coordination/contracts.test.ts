import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeClaudeCli, type FakeCliScenario } from '../../../../packages/agent/src/fake-claude-cli';
import { claudeCodeContractAsk } from './contracts';

/**
 * 가짜 CLI로 Claude Code 프로세스를 흉내 낸다. 실제 모델 호출 없이 인자와 파싱만 확인한다.
 * 계약 호출은 한 번의 실행이라서 assistant 텍스트 하나와 result 하나만 흉내 내면 된다.
 */
function fakeClaudeCode(options: { text?: string; result?: FakeCliScenario['result'] } = {}) {
  const fake = fakeClaudeCli({
    turns: [options.text !== undefined ? [{ text: options.text }] : []],
    modelUsages: [{ 'test-model': { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 40, cacheCreationInputTokens: 5 } }],
    ...(options.result ? { result: options.result } : {}),
  });
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'contracts-ask-')));
  return { fake, cwd, cli: { ...fake.cli, stop: { termAfterMs: 50, killAfterMs: 500 } } };
}

describe('claudeCodeContractAsk', () => {
  it('도구·설정 없이 한 번만 묻고, 계약 텍스트와 usage를 돌려준다', async () => {
    const { fake, cwd, cli } = fakeClaudeCode({ text: '{"contracts":[{"body":"GET /api/orders → 200 JSON 배열","refs":["api"]}]}' });

    const answer = await claudeCodeContractAsk({ cwd, model: 'sonnet', ...cli })({ system: '계약 시스템', user: '전체 요청: 주문 목록' });

    expect(answer.text).toContain('"contracts"');
    // usage는 result의 modelUsage에서 온다(러너와 같은 규칙)
    expect(answer.usage).toEqual({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 40, cacheWriteTokens: 5 });
    const logs = fake.logs();
    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(fake.prompts()).toEqual(['전체 요청: 주문 목록']);
    // 입력을 닫아 CLI가 끝났다
    expect(log.stdinClosed).toBe(true);

    // 계약 한 번 호출에 필요한 최소 옵션. 도구·설정·세션을 남기지 않는다
    expect(fake.argOf(log, '--tools')).toBe('');
    expect(log.args).not.toContain('--allowedTools');
    expect(fake.argOf(log, '--max-turns')).toBe('1');
    expect(log.args).toContain('--no-session-persistence');
    expect(fake.argOf(log, '--setting-sources')).toBe('');
    expect(log.args).not.toContain('--mcp-config');
    expect(log.args).toContain('--strict-mcp-config');
    expect(log.systemPrompt?.text).toBe('계약 시스템');
    expect(fake.argOf(log, '--model')).toBe('sonnet');
    expect(log.cwd).toBe(cwd);
  });

  it('--model이 없으면 모델을 고정하지 않는다(계정 기본)', async () => {
    const { fake, cwd, cli } = fakeClaudeCode({ text: '{"contracts":[]}' });
    await claudeCodeContractAsk({ cwd, ...cli })({ system: 's', user: 'u' });
    expect(fake.logs()[0]!.args).not.toContain('--model');
  });

  it('모델이 실패를 돌려주면 이유를 담아 던진다(사용 한도 문구도 그대로 남긴다)', async () => {
    const { cwd, cli } = fakeClaudeCode({ result: { subtype: 'error_during_execution', is_error: true, errors: ['Claude usage limit reached'] } });

    await expect(claudeCodeContractAsk({ cwd, ...cli })({ system: 's', user: 'u' })).rejects.toThrow(/사용 한도|usage limit/);
  });

  it('빈 응답이면 계약으로 쓰지 않고 실패시킨다', async () => {
    const { cwd, cli } = fakeClaudeCode({ text: '   ' });
    await expect(claudeCodeContractAsk({ cwd, ...cli })({ system: 's', user: 'u' })).rejects.toThrow(/빈 응답/);
  });
});
