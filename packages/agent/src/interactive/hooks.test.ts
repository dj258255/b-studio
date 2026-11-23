import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHookRunner } from './hooks';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'interactive-hooks-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 이벤트 하나에 명령 훅 하나를 건 러너 */
async function runnerWith(event: string, body: string, timeout?: number) {
  const script = path.join(dir, 'hook.mjs');
  await writeFile(script, body);
  const hook = { type: 'command', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, ...(timeout !== undefined ? { timeout } : {}) };
  return createHookRunner({ settings: { hooks: { [event]: [{ hooks: [hook] }] } }, cwd: dir, sessionId: 's' });
}

const denied = (answer: Record<string, unknown>) => (answer.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === 'deny';

describe('훅의 답을 끝까지 받지 못하면(막는 검사)', () => {
  it('쓰기 직전(PreToolUse) 훅이 0이 아닌 코드로 끝나거나 JSON이 아닌 출력을 내거나 시간을 넘기면 거절로 읽는다', async () => {
    expect(denied(await (await runnerWith('PreToolUse', 'process.exit(1)')).call('PreToolUse', { tool_name: 'Write' }))).toBe(true);
    expect(denied(await (await runnerWith('PreToolUse', "process.stdout.write('not json')")).call('PreToolUse', { tool_name: 'Write' }))).toBe(true);
    expect(denied(await (await runnerWith('PreToolUse', 'setTimeout(() => {}, 5000)', 1)).call('PreToolUse', { tool_name: 'Write' }))).toBe(true);
  });

  it('빈 출력과 0 종료는 허용이다(훅이 할 말이 없다)', async () => {
    expect(await (await runnerWith('PreToolUse', '')).call('PreToolUse', { tool_name: 'Write' })).toEqual({});
  });

  it('종료 코드 2는 CLI 규약의 막음이다: 쓰기 직전은 거절, 턴 끝은 막음, 사유는 stderr', async () => {
    const body = "process.stderr.write('규칙 위반'); process.exit(2)";
    const pre = await (await runnerWith('PreToolUse', body)).call('PreToolUse', { tool_name: 'Write' });
    expect(denied(pre)).toBe(true);
    expect((pre.hookSpecificOutput as { permissionDecisionReason?: string }).permissionDecisionReason).toBe('규칙 위반');
    expect(await (await runnerWith('Stop', body)).call('Stop', {})).toEqual({ decision: 'block', reason: '규칙 위반' });
  });

  it('턴 끝(Stop) 훅의 실패는 막지 않는다(실패로 막으면 턴이 끝나지 않는다)', async () => {
    expect(await (await runnerWith('Stop', 'process.exit(1)')).call('Stop', {})).toEqual({});
  });
});
