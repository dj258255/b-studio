/**
 * API 모드 세션 터미널(이 컴퓨터 방식)의 턴 끝 게이트를 실제 Docker로 검증한다(#1369 단위 4).
 * e2e:terminal-orders와 같은 시나리오·같은 확인이다. 다른 점은 터미널에서 도는 CLI가 흉내 낸 CLI가 아니라
 * b-studio의 진짜 자체 에이전트 CLI(`apps/cli/src/agent-tty.ts`)이고, 모델은 이 파일 안의 가짜 OpenAI 호환 서버라는 것이다.
 *
 *  - 첫 시도는 엔티티의 오타로 api가 컴파일되지 않는다 → 턴 끝(Stop) 게이트가 실제로 서비스를 재시작해 실패를 보고,
 *    컴파일 오류 로그를 담아 턴 끝을 막는다(자체 CLI는 그 사유를 새 사용자 메시지로 모델에 돌려 이어서 일한다)
 *  - 모델이 오타를 고치고 다시 턴을 끝내면 게이트가 통과해 체크포인트를 남긴다
 *  - 체크포인트 뒤 실제 서비스 주소에서 API와 화면이 시드 데이터를 낸다
 *  - 모델 호출에는 모델 파일의 키가 갔고, 세션을 멈추면 관문 폴더에 파일이 남지 않는다
 *
 *   pnpm e2e:api-terminal-orders
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ORDERS_DEMO_SCENARIOS } from '@b-studio/agent';

type FileCall = { name: string; input: { path: string; content?: string; old_text?: string; new_text?: string } };
type ChatMessage = { role?: string; content?: unknown };

const KEY_ENV = 'B_STUDIO_E2E_API_TERMINAL_KEY';
const KEY = 'sk-fake-e2e-api-terminal-secret';
const MODEL_ID = 'api-term-orders';

async function main(): Promise<void> {
  // 처음 쓰는 컴퓨터(CI 실행기 등)에는 ~/.cache/b-studio가 없다. mkdtemp는 상위 폴더를 만들지 않는다
  await mkdir(path.join(homedir(), '.cache/b-studio'), { recursive: true });
  const root = await mkdtemp(path.join(homedir(), '.cache/b-studio/', 'api-terminal-orders-e2e-'));
  const failures: string[] = [];
  const check = (ok: boolean, label: string) => {
    log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failures.push(label);
  };
  let sessionId: string | undefined;
  let provider: Awaited<ReturnType<typeof fakeProvider>> | undefined;

  try {
    // e2e:agent의 orders-list가 쓰는 파일을 그대로 쓴다: 첫 턴의 write_file들, 고치는 edit_file 하나
    const scenario = ORDERS_DEMO_SCENARIOS.find((one) => one.id === 'orders-list');
    if (!scenario) throw new Error('orders-list 시나리오를 찾지 못했습니다');
    const calls = scenario.turns.flatMap((turn) => (turn.toolCalls ?? []) as FileCall[]);
    const writes = calls.filter((call) => call.name === 'write_file');
    const fix = calls.find((call) => call.name === 'edit_file');
    const entity = writes.find((call) => call.input.path === fix?.input.path);
    if (writes.length !== 5 || !fix || !entity?.input.content?.includes(fix.input.old_text!)) throw new Error('orders-list 시나리오의 모양이 바뀌었습니다(파일 다섯, 엔티티 고침 하나)');

    provider = await fakeProvider({
      requestMarker: scenario.request,
      writes: writes.map((call) => ({ file_path: call.input.path, content: call.input.content! })),
      fix: { file_path: fix.input.path, old_string: fix.input.old_text!, new_string: fix.input.new_text! },
    });

    const registryFile = path.join(root, 'models.json');
    await writeFile(
      registryFile,
      JSON.stringify([
        {
          id: MODEL_ID,
          provider: 'openai',
          model: MODEL_ID,
          label: 'API 터미널 e2e 가짜 모델',
          capabilities: ['tools', 'json'],
          contextWindow: 32_000,
          pricing: { inputPerMillion: 1, outputPerMillion: 2 },
          baselineQuality: 0.8,
          baselineLatencyMs: 100,
          baseUrl: provider.baseUrl,
          apiKeyEnv: KEY_ENV,
        },
      ]),
      { mode: 0o600 },
    );
    await mkdir(path.join(root, 'sessions'), { recursive: true });
    const gatewayRoot = path.join(root, 'gateway');

    process.env.B_STUDIO_MODE = 'api';
    process.env.B_STUDIO_TERMINAL = 'host';
    process.env[KEY_ENV] = KEY;
    process.env.B_STUDIO_MODEL_REGISTRY = registryFile;
    // 사용자의 관문 폴더를 건드리지 않는다
    process.env.B_STUDIO_AGENT_GATEWAY_DIR = gatewayRoot;
    process.env.B_STUDIO_PROJECTS_DIR = path.resolve(import.meta.dirname, '../../../examples');
    process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
    process.env.B_STUDIO_MODEL_OBSERVATIONS_FILE = path.join(root, 'model-observations.json');
    // 자체 CLI의 진입점과 로더는 스튜디오가 저장소의 apps/studio에서 돈다는 기준으로 찾는다(session-terminal.ts)
    process.chdir(path.resolve(import.meta.dirname, '..'));

    const sessions = await import('../lib/server/sessions');
    const { runTerminalTask, terminalLaneDriver } = await import('../lib/server/terminal-lane');
    const { LOCAL_USER } = await import('../lib/server/auth');

    const started = Date.now();
    const created = await sessions.createSession('orders', LOCAL_USER, 'copy', { backend: 'api' });
    sessionId = created.id;
    log(`세션 ${sessionId} (터미널 ${created.terminalMode ?? '-'}, 백엔드 ${created.backend ?? '-'})`);
    while (sessions.getSnapshot(sessionId)?.status !== 'ready') {
      const status = sessions.getSnapshot(sessionId)?.status;
      if (status === 'failed' || status === 'stopped') throw new Error(`세션이 준비되지 못했습니다: ${status} ${sessions.getSnapshot(sessionId)?.error ?? ''}`);
      if (Date.now() - started > 10 * 60_000) throw new Error('세션이 10분 안에 준비되지 않았습니다');
      await delay(1_000);
    }
    log(`세션 준비 (${((Date.now() - started) / 1_000).toFixed(1)}초)`);

    await terminalLaneDriver.open(sessionId);
    const result = await Promise.race([
      runTerminalTask(sessionId, scenario.request, { writableScope: undefined, doneTests: [] }),
      delay(15 * 60_000).then(() => {
        throw new Error(`터미널 실행이 15분 안에 끝나지 않았습니다\n${providerTrace(provider!)}`);
      }),
    ]);
    log(`실행 ${result.runId}: ${result.status} · ${result.summary.slice(0, 120)}`);

    const snapshot = sessions.getSnapshot(sessionId);
    const history = sessions.sessionHistory(sessionId);
    // 이 실행이 남긴 체크포인트는 세션 기록의 checkpoint 이벤트(runId)로 고른다(목록 순서에 기대지 않는다)
    const checkpointEvents = history.flatMap((event) => (event.type === 'checkpoint' && event.runId === result.runId ? [event.checkpoint] : []));
    const checkpoint = checkpointEvents.at(-1);
    log('\n확인');
    check(result.status === 'done', `실행 done (실제: ${result.status})`);
    check(provider.stages.includes('gate-blocked'), `자체 CLI가 게이트의 막는 사유를 모델에 돌려줌 (단계: ${provider.stages.join(' → ')})`);
    check(/cannot find symbol|customerNam/.test(provider.gateReason), `막는 사유에 api 컴파일 오류 로그가 있음 (${provider.gateReason.slice(0, 120).replaceAll('\n', ' ') || '사유 없음'})`);
    check(provider.stages.at(-1) === 'final-after-fix', `고친 뒤 모델이 마무리하고 더는 막히지 않음 (마지막 단계: ${provider.stages.at(-1)})`);
    check(checkpointEvents.length === 1, `이 실행의 체크포인트가 하나 (실제: ${checkpointEvents.length})`);
    check(Boolean(checkpoint) && writes.every((call) => checkpoint!.files.includes(call.input.path)), `체크포인트에 다섯 파일 (${checkpoint?.shortSha} · ${checkpoint?.files.length ?? 0}개)`);
    check(['run', 'contract_check', 'browser_check', 'test', 'review'].every((stage) => checkpoint?.passedStages?.includes(stage as never)), `체크포인트가 게이트 단계를 통과 (${checkpoint?.passedStages?.join(', ')})`);
    check(result.costUsd !== undefined && result.costUsd > 0, `비용은 CLI 텔레메트리의 합 (${result.costUsd})`);
    check(provider.auth.length >= 3 && new Set(provider.auth).size === 1 && provider.auth[0] === `Bearer ${KEY}`, `모델 호출 ${provider.auth.length}번 모두 모델 파일의 키를 실음`);
    const api = snapshot?.services.find((service) => service.name === 'api')?.url;
    const web = snapshot?.services.find((service) => service.name === 'web')?.url;
    const apiBody = api ? await fetchText(`${api}/api/orders`) : '(api 주소 없음)';
    const webBody = web ? await fetchText(`${web}/orders`) : '(web 주소 없음)';
    check(apiBody.includes('김토스'), `API 응답에 시드 데이터 (${apiBody.slice(0, 80)})`);
    check(webBody.includes('김토스'), '/orders 화면에 시드 데이터가 렌더링됨');

    await sessions.stopSession(sessionId).catch(() => {});
    sessionId = undefined;
    // 세션을 멈추면 관문 폴더(모델 파일의 키 포함)가 남지 않는다
    let left: string[] = [];
    for (let attempt = 0; attempt < 60; attempt++) {
      left = await readdir(gatewayRoot).catch(() => [] as string[]);
      if (left.length === 0) break;
      await delay(500);
    }
    check(left.length === 0, `세션을 멈춘 뒤 관문 폴더가 비어 있음 (남은 것: ${left.join(', ') || '없음'})`);
    if (failures.length) throw new Error(`실패한 확인 ${failures.length}개:\n- ${failures.join('\n- ')}\n${providerTrace(provider)}`);
    log(`\n✅ 실제 Docker API 모드 세션 터미널 게이트 E2E 통과 (${((Date.now() - started) / 1_000).toFixed(1)}초)`);
  } finally {
    if (sessionId) {
      const { stopSession } = await import('../lib/server/sessions').catch(() => ({ stopSession: async () => {} }));
      await stopSession(sessionId).catch(() => {});
    }
    if (provider) await new Promise<void>((resolve) => provider!.server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}

interface ProviderScript {
  /** 첫 요청 글에 든 문구(요청과 게이트가 돌려준 사유를 가르는 데 쓴다) */
  requestMarker: string;
  writes: Array<{ file_path: string; content: string }>;
  fix: { file_path: string; old_string: string; new_string: string };
}

type Stage = 'write-files' | 'final-before-gate' | 'gate-blocked' | 'final-after-fix';

/**
 * 받은 메시지로 단계를 정하는 OpenAI 호환 가짜 모델(호출 횟수가 아니라 대화 내용으로 정한다).
 *  - 게이트의 막는 사유(요청이 아닌 문자열 사용자 메시지)가 없고 도구 결과도 없다 → Write 다섯 호출
 *  - 사유가 없고 도구 결과가 있다 → 끝났다는 글(여기서 Stop 훅이 게이트를 돌린다)
 *  - 사유가 있고 그 뒤에 도구 결과가 없다 → 오타를 고치는 Edit
 *  - 사유가 있고 그 뒤에 도구 결과가 있다 → 마무리 글
 */
async function fakeProvider(script: ProviderScript): Promise<{ server: Server; baseUrl: string; auth: string[]; stages: Stage[]; gateReason: string }> {
  const state = { auth: [] as string[], stages: [] as Stage[], gateReason: '' };
  let id = 0;
  const server = createServer(async (request, response) => {
    const send = (body: unknown) => void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.method === 'GET' && request.url?.startsWith('/v1/models/')) return send({ id: MODEL_ID, object: 'model' });
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return void response.writeHead(404).end('{}');
    state.auth.push(String(request.headers.authorization));
    const body = JSON.parse(await readBody(request)) as { messages?: ChatMessage[] };
    const messages = body.messages ?? [];
    const gateAt = messages.findIndex((message) => message.role === 'user' && typeof message.content === 'string' && !message.content.includes(script.requestMarker));
    if (gateAt >= 0) state.gateReason = String(messages[gateAt]!.content);
    const toolResultsAfter = (from: number) => messages.slice(from + 1).filter((message) => message.role === 'tool').length;
    const toolCall = (name: string, args: unknown) => ({ id: `call_${++id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
    const usage = { prompt_tokens: 1000, completion_tokens: 100 };
    const reply = (stage: Stage, message: Record<string, unknown>, finish: 'stop' | 'tool_calls') => {
      state.stages.push(stage);
      send({ id: `chatcmpl_${++id}`, model: MODEL_ID, choices: [{ finish_reason: finish, message: { content: null, ...message } }], usage });
    };

    if (gateAt < 0) {
      if (toolResultsAfter(-1) === 0) return reply('write-files', { tool_calls: script.writes.map((one) => toolCall('Write', one)) }, 'tool_calls');
      return reply('final-before-gate', { content: 'GET /api/orders와 /orders 화면을 추가했습니다.' }, 'stop');
    }
    if (toolResultsAfter(gateAt) === 0) return reply('gate-blocked', { tool_calls: [toolCall('Edit', script.fix)] }, 'tool_calls');
    return reply('final-after-fix', { content: '오타로 인한 컴파일 에러를 고쳤습니다.' }, 'stop');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return Object.assign(state, { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function providerTrace(provider: { stages: Stage[]; auth: string[]; gateReason: string }): string {
  return `가짜 모델이 본 단계: ${provider.stages.join(' → ') || '(호출 없음)'} · 호출 ${provider.auth.length}번\n게이트가 돌려준 사유(앞 600자): ${provider.gateReason.slice(0, 600) || '(없음)'}`;
}

async function fetchText(url: string): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    return await response.text();
  } catch (error) {
    return `(요청 실패: ${String(error)})`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string): void {
  console.log(message);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  // 세션 터미널(PTY)과 관문 서버가 이벤트 루프를 붙잡아 두므로 끝나면 나간다
  .finally(() => setTimeout(() => process.exit(), 500).unref());
