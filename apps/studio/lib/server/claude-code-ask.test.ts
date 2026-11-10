import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeClaudeCli, type FakeCliScenario } from '../../../../packages/agent/src/fake-claude-cli';
import { claudeCodeAsk, type ClaudeCodeAskOptions } from './claude-code-ask';

/** 가짜 CLI(실제 모델·네트워크·로그인 없음)로 질문 경로를 돌린다. 받은 인자·표준 입력·파일을 기록해 둔다 */
function setup(scenario: FakeCliScenario = {}, extra: Partial<ClaudeCodeAskOptions> = {}) {
  const fake = fakeClaudeCli({ turns: [[{ text: '{"ok":true}' }]], ...scenario });
  // 실행 파일이 프로젝트 폴더 안이면 띄우지 않는다. 가짜 CLI는 node의 절대 경로라 임시 폴더를 cwd로 쓰면 된다
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'claude-code-ask-')));
  const ask = claudeCodeAsk({ cwd, ...fake.cli, stop: { termAfterMs: 50, killAfterMs: 500 }, ...extra });
  return { fake, cwd, ask };
}

describe('claudeCodeAsk', () => {
  it('기본값은 파일·명령 도구를 모두 닫고 한 번만 묻는다(--tools 비움, 허용 목록 없음, --max-turns 1)', async () => {
    const { fake, cwd, ask } = setup();

    const answer = await ask({ system: '시스템 지침', user: '질문 글' });

    expect(answer.text).toBe('{"ok":true}');
    const log = fake.logs()[0]!;
    // 내장 도구 전부 끔(여는 쪽으로 틀리지 않는다): --tools 가 있고 값이 비어 있다
    expect(log.args).toContain('--tools');
    expect(fake.argOf(log, '--tools')).toBe('');
    // 허용 목록을 아예 싣지 않고, 허용되지 않은 도구는 묻지 않고 거부한다
    expect(log.args).not.toContain('--allowedTools');
    expect(fake.argOf(log, '--permission-mode')).toBe('dontAsk');
    expect(fake.argOf(log, '--max-turns')).toBe('1');
    // 설정·훅·MCP를 싣지 않고, 세션을 남기지 않는다
    expect(fake.argOf(log, '--setting-sources')).toBe('');
    expect(log.args).toContain('--strict-mcp-config');
    expect(log.args).not.toContain('--mcp-config');
    expect(log.args).toContain('--no-session-persistence');
    // 위험한 권한 우회 플래그가 없다
    expect(log.args).not.toContain('--dangerously-skip-permissions');
    expect(log.args.join(' ')).not.toMatch(/bypassPermissions|acceptEdits/);
    // 질문은 인자가 아니라 표준 입력으로, 시스템 지침은 0600 파일로 간다
    expect(log.args).not.toContain('질문 글');
    expect(log.args).not.toContain('시스템 지침');
    expect(log.stdin.map((line) => line.message?.content)).toEqual(['질문 글']);
    expect(log.systemPrompt).toEqual({ text: '시스템 지침', mode: 0o600 });
    expect(log.cwd).toBe(cwd);
    expect(log.args).not.toContain('--model');
    expect(log.args).not.toContain('--effort');
    expect(log.tools).toEqual([]);
  });

  it('webTools: true는 WebSearch·WebFetch만 열고 턴 상한을 늘린다(파일·명령 도구는 그대로 닫는다)', async () => {
    const { fake, ask } = setup({ turns: [[{ text: '추천 답' }]] }, { webTools: true });

    const answer = await ask({ system: 's', user: 'u' });

    expect(answer.text).toBe('추천 답');
    const log = fake.logs()[0]!;
    expect(fake.argOf(log, '--tools')).toBe('WebSearch,WebFetch');
    expect(fake.argOf(log, '--allowedTools')).toBe('WebSearch,WebFetch');
    expect(Number(fake.argOf(log, '--max-turns'))).toBeGreaterThan(1);
    // 웹 도구를 열어도 프로젝트/사용자 설정·MCP는 여전히 싣지 않는다
    expect(fake.argOf(log, '--setting-sources')).toBe('');
    expect(log.args).toContain('--strict-mcp-config');
    expect(log.args).not.toContain('--mcp-config');
    // 열린 도구 이름 말고는 어떤 인자에도 파일·명령 도구가 없다
    expect(log.args.join(' ')).not.toMatch(/\b(Bash|Write|Edit|Read|NotebookEdit)\b/);
  });

  it('webTools를 생략하거나 false로 주면 기본값(도구 없음)과 같다', async () => {
    const { fake, ask } = setup({}, { webTools: false });
    await ask({ system: 's', user: 'u' });
    const log = fake.logs()[0]!;
    expect(fake.argOf(log, '--tools')).toBe('');
    expect(log.args).not.toContain('--allowedTools');
    expect(fake.argOf(log, '--max-turns')).toBe('1');
  });

  it('모델·노력 단계는 줬을 때만 넘기고, usage는 result의 modelUsage에서 온다(러너와 같은 규칙)', async () => {
    const { fake, ask } = setup(
      { turns: [[{ text: '{"contracts":[]}' }]], modelUsages: [{ 'test-model': { inputTokens: 120, outputTokens: 30, cacheReadInputTokens: 40, cacheCreationInputTokens: 5 } }] },
      { model: 'sonnet', effort: 'medium' },
    );

    const answer = await ask({ system: 's', user: 'u' });

    expect(answer.usage).toEqual({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 40, cacheWriteTokens: 5 });
    const log = fake.logs()[0]!;
    expect(fake.argOf(log, '--model')).toBe('sonnet');
    expect(fake.argOf(log, '--effort')).toBe('medium');
  });

  it('모델이 실패를 돌려주면 이유를 담아 던진다(사용 한도 문구도 그대로 남긴다)', async () => {
    const { ask } = setup({ result: { subtype: 'error_during_execution', is_error: true, errors: ['Claude usage limit reached'] } });
    await expect(ask({ system: 's', user: 'u' })).rejects.toThrow(/사용 한도|usage limit/);
  });

  it('빈 응답이면 실패시킨다', async () => {
    const { ask } = setup({ turns: [[{ text: '   ' }]], result: { result: '' } });
    await expect(ask({ system: 's', user: 'u' })).rejects.toThrow(/빈 응답/);
  });

  it('CLI가 결과 없이 끝나면 통과시키지 않고 종료 코드와 표준 오류를 담아 던진다', async () => {
    const { ask } = setup({ invocations: [{ exitWithoutResult: 3, stderr: '로그인이 필요합니다' }] });
    await expect(ask({ system: 's', user: 'u' })).rejects.toThrow(/결과를 보내지 않고 종료.*종료 코드 3.*로그인이 필요합니다/);
  });

  it('받은 글이 있어도 result가 오지 않았으면 통과시키지 않는다(사용량을 모른다)', async () => {
    const { ask } = setup({ noResult: true });
    await expect(ask({ system: 's', user: 'u' })).rejects.toThrow(/결과를 보내지 않고 종료/);
  });

  it('CLI 실행 파일을 띄우지 못하면 이유를 담아 던진다', async () => {
    const { ask } = setup({}, { command: '/no/such/claude', commandArgs: [] });
    await expect(ask({ system: 's', user: 'u' })).rejects.toThrow(/결과를 보내지 않고 종료.*실행하지 못함/);
  });

  it('취소하면 CLI를 끝내고 취소 이유를 던진다(결과 없음이 아니라 취소다)', async () => {
    const { fake, ask } = setup({ turns: [[{ hang: true }]] });
    const controller = new AbortController();
    const pending = ask({ system: 's', user: 'u' }, controller.signal);
    // CLI가 입력을 받아 멈춘 모델 응답을 기다릴 때까지
    for (let i = 0; i < 100 && !(fake.logs()[0]?.stdin.length ?? 0); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(new Error('사용자가 취소했습니다'));
    await expect(pending).rejects.toThrow('사용자가 취소했습니다');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.logs()[0]!.signals).toContain('SIGTERM');
  });

  it('이미 취소된 신호면 CLI를 띄우지 않는다', async () => {
    const { fake, ask } = setup();
    const controller = new AbortController();
    controller.abort(new Error('먼저 취소'));
    await expect(ask({ system: 's', user: 'u' }, controller.signal)).rejects.toThrow('먼저 취소');
    expect(fake.logs()).toEqual([]);
  });
});
