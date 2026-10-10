import { afterEach, describe, expect, it } from 'vitest';
import { startDryProvider, type DryProviderHandle } from './dry-provider';
import { handoffAsk, handoffTestFor, withHandoffAsk } from './handoff';
import { BENCH_TASKS, planFor } from './tasks';

let provider: DryProviderHandle | undefined;
afterEach(async () => {
  await provider?.close();
  provider = undefined;
});

async function ask(content: string): Promise<{ finish: string; tool?: { name: string; path: string } }> {
  provider ??= await startDryProvider();
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content }] }),
  });
  const body = (await response.json()) as { choices: Array<{ finish_reason: string; message: { tool_calls?: Array<{ function: { name: string; arguments: string } }> } }> };
  const choice = body.choices[0]!;
  const call = choice.message.tool_calls?.[0];
  return { finish: choice.finish_reason, ...(call ? { tool: { name: call.function.name, path: (JSON.parse(call.function.arguments) as { path: string }).path } } : {}) };
}

describe('--dry 가짜 상류', () => {
  it('부탁 문장이 붙은 api 작업 요청에도 예전과 같이 컨트롤러를 쓴다', async () => {
    const task = BENCH_TASKS[0]!;
    const file = handoffTestFor(task.id)!.file;
    const plain = planFor(task, 'S0').tasks[0]!;
    const withAsk = withHandoffAsk(planFor(task, 'S0'), file).tasks[0]!;
    expect(withAsk.request).toContain(handoffAsk(file));
    const before = await ask(plain.request);
    const after = await ask(withAsk.request);
    expect(after).toEqual(before);
    expect(after.tool).toEqual({ name: 'write_file', path: 'api/src/main/java/com/example/api/OrderController.java' });
  });
});
