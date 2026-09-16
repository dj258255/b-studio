/**
 * 작업 분해의 실제 실행 경로를 외부 과금 없이 검증한다.
 *
 *  - 모델이 낸 계획을 검증해 레인 2개로 나눈다 (lane A: a1 → a2, lane B: b)
 *  - 계획은 승인을 기다리며 멈추고, approveTaskPlan을 부른 뒤에야 레인 세션이 생긴다
 *  - a2는 a1이 만든 파일을 읽어야 끝낼 수 있다 → 같은 레인은 한 세션에서 차례로 돈다
 *  - b는 먼저 lane A의 범위에 쓰려다 실행기에 막히고, 자기 범위에만 쓴다 → 작업별 쓰기 범위가 실제로 걸린다
 *  - 두 레인의 결과를 새 세션에서 같은 게이트로 다시 적용해 한 체크포인트로 합친다
 *
 *   pnpm e2e:task-plan
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';

const PROJECT = 'planorders';
type Message = { role?: string; content?: unknown };

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(homedir(), '.cache/b-studio/', 'task-plan-e2e-'));
  const provider = await fakeProvider();
  const failures: string[] = [];
  const check = (ok: boolean, label: string) => {
    log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failures.push(label);
  };
  let sessionIds: string[] = [];

  try {
    const projects = path.join(root, 'projects');
    await cp(path.resolve(import.meta.dirname, '../../../examples/orders'), path.join(projects, PROJECT), {
      recursive: true,
      filter: (source) => !/[/\\](node_modules|\.next|build|\.gradle)([/\\]|$)/.test(source),
    });
    const specFile = path.join(projects, PROJECT, 'studio.yaml');
    await writeFile(specFile, (await readFile(specFile, 'utf8')).replace(/^name: orders$/m, `name: ${PROJECT}`));

    const registryFile = path.join(root, 'models.json');
    await writeFile(
      registryFile,
      JSON.stringify([
        {
          id: 'local-planner',
          provider: 'openai',
          model: 'planner',
          label: 'Local planner',
          capabilities: ['tools', 'json'],
          contextWindow: 32_000,
          pricing: { inputPerMillion: 1, outputPerMillion: 2 },
          baselineQuality: 0.8,
          baselineLatencyMs: 100,
          baseUrl: provider.baseUrl,
        },
      ]),
      { mode: 0o600 },
    );
    await mkdir(path.join(root, 'sessions'), { recursive: true });
    Object.assign(process.env, {
      B_STUDIO_MODE: 'api',
      B_STUDIO_AUTH: 'none',
      B_STUDIO_MODEL_REGISTRY: registryFile,
      B_STUDIO_PROJECTS_DIR: projects,
      B_STUDIO_SESSIONS_DIR: path.join(root, 'sessions'),
      B_STUDIO_TASK_PLANS_DIR: path.join(root, 'task-plans'),
      B_STUDIO_MODEL_OBSERVATIONS_FILE: path.join(root, 'model-observations.json'),
    });

    const { approveTaskPlan, createTaskPlan, getTaskPlan } = await import('../lib/server/task-plans');
    const { getSnapshot, stopSession } = await import('../lib/server/sessions');
    const { LOCAL_USER } = await import('../lib/server/auth');

    const started = Date.now();
    const created = await createTaskPlan({ projectId: PROJECT, request: 'plan-a 메모 두 개와 plan-b 메모를 추가해줘', modelId: 'local-planner', owner: LOCAL_USER });
    let plan = created;
    let previous = '';
    const trace = () => {
      const current = `${plan.status} | ${plan.lanes.map((lane) => `${lane.id}=${lane.status}[${lane.tasks.map((task) => `${task.id}:${task.status}`).join(' ')}]`).join(' ')} | 통합=${plan.integration?.status ?? '-'}`;
      if (current !== previous) {
        log(`${((Date.now() - started) / 1_000).toFixed(0)}s ${current}`);
        previous = current;
      }
    };

    // 승인 게이트: 계획이 검증을 통과하면 사람이 승인할 때까지 여기서 멈춘다
    while (plan.status !== 'awaiting_approval' && plan.status !== 'failed') {
      if (Date.now() - started > 40 * 60_000) throw new Error('작업 분해가 40분 안에 승인 대기에 이르지 않았습니다');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      plan = getTaskPlan(created.id, LOCAL_USER);
      trace();
    }
    log('\n▶ 승인 게이트');
    check(plan.status === 'awaiting_approval', `계획이 사람 승인을 기다림 (실제: ${plan.status}${plan.error ? ` · ${plan.error}` : ''})`);
    check(plan.lanes.length > 0 && plan.lanes.every((lane) => lane.sessionId === undefined), `승인 전에는 레인 세션이 하나도 없음 (${plan.lanes.map((lane) => lane.id).join(', ') || '레인 없음'})`);

    // 승인하고 나서야 레인이 돈다
    approveTaskPlan(created.id, LOCAL_USER);
    plan = getTaskPlan(created.id, LOCAL_USER);

    while (plan.status !== 'done' && plan.status !== 'failed') {
      if (Date.now() - started > 40 * 60_000) throw new Error('작업 분해가 40분 안에 끝나지 않았습니다');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      plan = getTaskPlan(created.id, LOCAL_USER);
      trace();
    }
    sessionIds = [...plan.lanes.flatMap((lane) => (lane.sessionId ? [lane.sessionId] : [])), ...(plan.integration?.sessionId ? [plan.integration.sessionId] : [])];

    log('\n▶ 결과');
    check(plan.status === 'done', `작업 분해 완료 (실제: ${plan.status}${plan.error ? ` · ${plan.error}` : ''})`);
    const laneA = plan.lanes.find((lane) => lane.tasks.some((task) => task.id === 'note-a1'));
    const laneB = plan.lanes.find((lane) => lane.tasks.some((task) => task.id === 'note-b'));
    check(plan.lanes.length === 2 && laneA?.tasks.map((task) => task.id).join(',') === 'note-a1,note-a2', `레인 2개, lane A는 a1 → a2 순서 (${plan.lanes.map((lane) => lane.tasks.map((task) => task.id).join('→')).join(' | ')})`);
    check(Boolean(laneA?.sessionId && laneB?.sessionId && laneA.sessionId !== laneB.sessionId), '레인마다 다른 세션');
    check(provider.state.scopeDenied, 'lane B가 lane A 범위에 쓰려던 호출을 실행기가 막음 (도구 결과에 writable scope 사유)');
    check(provider.state.a2SawA1, 'a2가 같은 세션에서 a1이 만든 파일을 읽음');
    const overlap = provider.state.firstCall.b !== undefined && provider.state.lastCall.a !== undefined && provider.state.firstCall.b < provider.state.lastCall.a;
    log(`  · 동시 실행 관찰: lane B 첫 호출이 lane A 마지막 호출보다 ${overlap ? '먼저' : '늦게'} 들어옴`);

    const integration = plan.integration;
    const expected = ['web/plan-a/one.md', 'web/plan-a/two.md', 'web/plan-b/one.md'];
    check(expected.every((file) => integration?.files.includes(file)) && !integration?.files.includes('web/plan-a/intrude.md'), `통합 대상 파일 (${integration?.files.join(', ')})`);
    const workDir = integration?.sessionId ? getSnapshot(integration.sessionId)?.workDir : undefined;
    const two = workDir ? await readFile(path.join(workDir, 'web/plan-a/two.md'), 'utf8').catch(() => '') : '';
    check(two.includes('a2 saw: from-a1'), `통합 세션의 two.md 내용 (${two.trim()})`);
    const checkpoint = integration?.sessionId ? getSnapshot(integration.sessionId)?.checkpoints[0] : undefined;
    check(
      ['run', 'contract_check', 'browser_check', 'test', 'review'].every((stage) => checkpoint?.passedStages?.includes(stage as never)),
      `통합 체크포인트가 게이트를 다시 통과 (${checkpoint?.shortSha} · ${checkpoint?.passedStages?.join(', ')})`,
    );
    log(`\n소요 ${((Date.now() - started) / 1_000).toFixed(1)}초`);

    for (const id of sessionIds) await stopSession(id).catch(() => {});
    sessionIds = [];
  } finally {
    if (sessionIds.length > 0) {
      const { stopSession } = await import('../lib/server/sessions');
      for (const id of sessionIds) await stopSession(id).catch(() => {});
    }
    await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }

  if (failures.length > 0) {
    log(`\n❌ ${failures.length}개 실패`);
    process.exitCode = 1;
  } else {
    log('\n✅ 작업 분해 E2E 통과');
  }
}

/** 계획 요청에는 JSON 계획을, 작업 요청에는 작업 표지에 맞는 도구 호출을 돌려주는 OpenAI 호환 모델 */
async function fakeProvider() {
  const state = { scopeDenied: false, a2SawA1: false, firstCall: {} as Record<string, number>, lastCall: {} as Record<string, number> };
  const plan = {
    tasks: [
      { id: 'note-a1', title: 'A 첫 메모', request: '[task:note-a1] web/plan-a/one.md를 만든다', paths: ['web/plan-a'] },
      { id: 'note-a2', title: 'A 둘째 메모', request: '[task:note-a2] one.md를 읽고 two.md를 만든다', paths: ['web/plan-a'], dependsOn: ['note-a1'] },
      { id: 'note-b', title: 'B 메모', request: '[task:note-b] web/plan-b/one.md를 만든다', paths: ['web/plan-b'] },
    ],
  };

  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models/')) return json(response, 200, { id: 'planner', object: 'model' });
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return json(response, 404, { error: { message: 'not found' } });
    const body = JSON.parse(await text(request)) as { tools?: unknown[]; messages?: Message[] };
    const messages = body.messages ?? [];
    if (!body.tools) return reply(response, { text: JSON.stringify(plan) });

    // 레인 세션은 대화를 이어 쓰므로, 가장 최근 작업 표지가 든 사용자 메시지 뒤의 도구 결과 수로 단계를 정한다
    const markerAt = messages.findLastIndex((message) => message.role === 'user' && /\[task:[a-z0-9-]+\]/.test(String(message.content ?? '')));
    const task = /\[task:([a-z0-9-]+)\]/.exec(String(messages[markerAt]?.content ?? ''))?.[1];
    const results = messages.slice(markerAt + 1).filter((message) => message.role === 'tool').map((message) => String(message.content ?? ''));
    const step = results.length;
    const lane = task === 'note-b' ? 'b' : 'a';
    const now = Date.now();
    state.firstCall[lane] ??= now;
    state.lastCall[lane] = now;

    const write = (file: string, content: string) => reply(response, { tool: { name: 'write_file', args: { path: file, content } } });
    const done = () => reply(response, { text: `${task} 완료` });
    if (task === 'note-a1') return step === 0 ? write('web/plan-a/one.md', 'from-a1\n') : done();
    if (task === 'note-a2') {
      if (step === 0) return reply(response, { tool: { name: 'read_file', args: { path: 'web/plan-a/one.md' } } });
      if (step === 1) {
        state.a2SawA1 = results[0]!.includes('from-a1');
        return write('web/plan-a/two.md', state.a2SawA1 ? 'a2 saw: from-a1\n' : 'a2 missing a1\n');
      }
      return done();
    }
    if (task === 'note-b') {
      if (step === 0) return write('web/plan-a/intrude.md', 'lane B should not write here\n');
      if (step === 1) {
        state.scopeDenied = results[0]!.includes('writable scope');
        return write('web/plan-b/one.md', 'from-b\n');
      }
      return done();
    }
    return done();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return { server, state, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` };
}

let callId = 0;
function reply(response: ServerResponse, output: { text?: string; tool?: { name: string; args: unknown } }): void {
  callId += 1;
  json(response, 200, {
    id: `message-${callId}`,
    model: 'planner',
    choices: [
      output.tool
        ? { finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: `call-${callId}`, type: 'function', function: { name: output.tool.name, arguments: JSON.stringify(output.tool.args) } }] } }
        : { finish_reason: 'stop', message: { content: output.text } },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 10 },
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function text(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function log(message: string): void {
  console.log(message);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
