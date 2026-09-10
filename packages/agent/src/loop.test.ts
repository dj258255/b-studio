import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ContainerState, LogLine, Sandbox, ServiceEndpoint } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OpenApiDocument } from './contract-diff';
import { runAgent, type AgentEvent } from './loop';
import { ScriptedModelClient } from './scripted-client';

let project: LoadedProject;

const contract: OpenApiDocument = {
  paths: { '/api/orders': { get: {} } },
  components: { schemas: { OrderResponse: { properties: { id: { type: 'integer' }, memo: { type: 'string' } } } } },
};

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'loop-test-'));
  await mkdir(path.join(root, 'api/src'), { recursive: true });
  await writeFile(path.join(root, 'api/src/Order.java'), 'class Order { String customerNam; }\n');
  project = {
    root,
    spec: { name: 'orders' },
    managed: [['api', { source: 'managed', template: 'spring-boot', path: 'api', port: 8080, preview: 'openapi', contract: { extract: '/v3/api-docs' } }]],
  } as unknown as LoadedProject;
});

/** restart 결과를 순서대로 돌려주는 가짜 샌드박스 */
function fakeSandbox(restartOutcomes: boolean[]): Sandbox & { restarts: string[] } {
  const restarts: string[] = [];
  return {
    id: 'fake',
    project,
    restarts,
    async start() {
      return [];
    },
    async sync() {
      return { elapsedMs: 0, checks: 1 };
    },
    async restart(service: string): Promise<ServiceEndpoint> {
      restarts.push(service);
      if (restartOutcomes.shift() === false) throw new Error('컨테이너가 종료됐습니다');
      return { service, containerPort: 8080, url: 'http://127.0.0.1:1' };
    },
    async endpoint(service: string) {
      return { service, containerPort: 8080, url: 'http://127.0.0.1:1' };
    },
    async state(): Promise<ContainerState> {
      return 'running';
    },
    async *logs(): AsyncIterable<LogLine> {
      yield { service: 'api', text: 'Order.java:1: error: cannot find symbol', at: new Date() };
    },
    async exec() {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async destroy() {},
  };
}

function collect(events: AgentEvent[]) {
  return (event: AgentEvent) => events.push(event);
}

describe('runAgent', () => {
  it('검증 게이트가 실패하면 결과를 돌려주고, 고친 뒤 통과해야 완료한다', async () => {
    const client = new ScriptedModelClient([
      { toolCalls: [{ name: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerNam; String memo;' } }] },
      { text: '메모 필드를 추가했습니다.' },
      { toolCalls: [{ name: 'edit_file', input: { path: 'api/src/Order.java', old_text: 'customerNam;', new_text: 'customerName;' } }] },
      { text: '컴파일 에러를 고쳤습니다.' },
    ]);
    const sandbox = fakeSandbox([false, true]);
    const events: AgentEvent[] = [];

    const result = await runAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox,
      client,
      fetcher: async () => contract,
      onEvent: collect(events),
    });

    expect(result).toMatchObject({ status: 'done', summary: '컴파일 에러를 고쳤습니다.', verifyAttempts: 1, turns: 4 });
    expect(result.changedFiles).toEqual(['api/src/Order.java']);
    expect(events.filter((e) => e.type === 'verify_result').map((e) => e.type === 'verify_result' && e.report.ok)).toEqual([false, true]);
    expect(sandbox.restarts).toEqual(['api', 'api']);

    // 게이트 결과는 로그와 함께 다음 요청에 사용자 메시지로 들어간다
    const feedback = client.requests[2]!.messages.at(-1)!;
    expect(feedback.role).toBe('user');
    expect(String(feedback.content)).toContain('[b-studio 검증 게이트]');
    expect(String(feedback.content)).toContain('cannot find symbol');
  });

  it('허용하지 않은 호환 깨짐은 재시도 한도 안에서 실패로 끝난다', async () => {
    const client = new ScriptedModelClient([
      { toolCalls: [{ name: 'write_file', input: { path: 'api/src/Order.java', content: 'class Order {}' } }] },
      { text: '메모 필드를 뺐습니다.' },
    ]);
    let calls = 0;
    const withoutMemo: OpenApiDocument = structuredClone(contract);
    delete withoutMemo.components!.schemas!.OrderResponse!.properties!.memo;

    const result = await runAgent({
      request: '정리해줘',
      project,
      sandbox: fakeSandbox([true]),
      client,
      maxVerifyAttempts: 1,
      fetcher: async () => (calls++ === 0 ? contract : withoutMemo),
    });

    expect(result.status).toBe('failed');
    expect(result.report?.contracts[0]?.changes).toMatchObject([{ kind: 'property-removed', target: 'OrderResponse.memo', breaking: true }]);
  });

  it('도구 실패는 is_error로 돌려주고 루프를 멈추지 않는다', async () => {
    const client = new ScriptedModelClient([
      { toolCalls: [{ name: 'read_file', input: { path: '../../etc/passwd' } }] },
      { text: '읽을 수 없는 경로입니다.' },
    ]);

    const result = await runAgent({ request: '읽어줘', project, sandbox: fakeSandbox([]), client, fetcher: async () => contract });

    expect(result).toMatchObject({ status: 'done', verifyAttempts: 0 });
    const toolResult = client.requests[1]!.messages.at(-1)!.content;
    expect(toolResult).toMatchObject([{ type: 'tool_result', is_error: true }]);
  });

  it('파일을 바꾸지 않았으면 검증 없이 끝난다', async () => {
    const sandbox = fakeSandbox([]);
    const result = await runAgent({
      request: '설명해줘',
      project,
      sandbox,
      client: new ScriptedModelClient([{ text: '이 프로젝트는 주문 API입니다.' }]),
      fetcher: async () => contract,
    });
    expect(result).toMatchObject({ status: 'done', turns: 1 });
    expect(sandbox.restarts).toEqual([]);
  });

  it('대화 기록을 넘기면 다음 요청이 이전 맥락을 이어받는다', async () => {
    const conversation: Parameters<typeof runAgent>[0]['conversation'] = [];
    const client = new ScriptedModelClient([{ text: '주문 API입니다.' }, { text: '앞에서 말한 주문 API에 필드를 더할 수 있습니다.' }]);
    const base = { project, sandbox: fakeSandbox([]), client, conversation, fetcher: async () => contract };

    await runAgent({ ...base, request: '이 프로젝트는 뭐야?' });
    await runAgent({ ...base, request: '거기에 뭘 더할 수 있어?' });

    expect(client.requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(conversation).toHaveLength(4);
  });

  it('실행 중 예외가 나면 이번 실행분을 대화 기록에서 되돌린다', async () => {
    const conversation: Parameters<typeof runAgent>[0]['conversation'] = [
      { role: 'user', content: '이전 요청' },
      { role: 'assistant', content: '이전 답변' },
    ];
    const client = new ScriptedModelClient([{ toolCalls: [{ name: 'read_file', input: { path: 'api/src/Order.java' } }] }]);

    await expect(
      runAgent({ request: '읽고 설명해줘', project, sandbox: fakeSandbox([]), client, conversation, fetcher: async () => contract }),
    ).rejects.toThrow('스크립트에 남은 턴이 없습니다');
    expect(conversation).toHaveLength(2);
  });

  it('거절되면 바로 실패한다', async () => {
    const result = await runAgent({
      request: '...',
      project,
      sandbox: fakeSandbox([]),
      client: new ScriptedModelClient([{ stopReason: 'refusal' }]),
      fetcher: async () => contract,
    });
    expect(result).toMatchObject({ status: 'failed', summary: '모델이 요청을 거절했습니다 (scripted)' });
  });
});
