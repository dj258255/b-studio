/**
 * API 모드 세션 터미널(이 컴퓨터 방식)의 턴 끝 게이트를 실제 Docker로 검증한다(#1369 단위 4).
 * e2e:terminal-orders와 같은 시나리오·같은 확인이다. 다른 점은 터미널에서 도는 CLI가 흉내 낸 CLI가 아니라
 * b-studio의 진짜 자체 에이전트 CLI(`apps/cli/src/agent-tty.ts`)이고, 모델은 이 파일 안의 가짜 OpenAI 호환 서버라는 것이다.
 *
 *  - 첫 시도는 엔티티의 오타로 api가 컴파일되지 않는다 → 턴 끝(Stop) 게이트가 실제로 서비스를 재시작해 실패를 보고,
 *    컴파일 오류 로그를 담아 턴 끝을 막는다(자체 CLI는 그 사유를 새 사용자 메시지로 모델에 돌려 이어서 일한다)
 *  - 모델이 오타를 고치고 다시 턴을 끝내면 게이트가 통과해 체크포인트를 남긴다
 *  - 체크포인트 뒤 실제 서비스 주소에서 API와 화면이 시드 데이터를 낸다
 *  - 같은 세션의 두 번째 요청(order-memo): 주문 응답에 memo를 더한다. 게이트가 한 번에 통과하고, 계약 변경은 OrderResponse.memo 추가 하나(breaking 아님),
 *    /orders 화면에 메모가 나오고, 체크포인트가 하나 늘어난다
 *  - 세 번째 요청(drop-memo): 그 필드를 지운다. 게이트가 호환 깨짐(property-removed OrderResponse.memo)으로 막고 test 단계를 돌리지 않는다.
 *    가짜 모델은 사유를 받아도 고치지 않는다 → 게이트 재시도 상한(3번)에 닿아 실행이 failed로 닫히고 마지막 체크포인트로 되돌아간다(체크포인트는 늘지 않는다)
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
  let provider: FakeProvider | undefined;

  try {
    // e2e:agent의 시나리오 대본을 그대로 쓴다: orders-list(파일 다섯 + 오타 고침), order-memo(필드 추가), drop-memo(필드 삭제)
    const find = (id: string) => {
      const one = ORDERS_DEMO_SCENARIOS.find((candidate) => candidate.id === id);
      if (!one) throw new Error(`${id} 시나리오를 찾지 못했습니다`);
      return one;
    };
    const scenario = find('orders-list');
    const memoScenario = find('order-memo');
    const dropScenario = find('drop-memo');
    const callsOf = (one: (typeof ORDERS_DEMO_SCENARIOS)[number]) => one.turns.flatMap((turn) => (turn.toolCalls ?? []) as FileCall[]);
    const calls = callsOf(scenario);
    const writes = calls.filter((call) => call.name === 'write_file');
    const fix = calls.find((call) => call.name === 'edit_file');
    const entity = writes.find((call) => call.input.path === fix?.input.path);
    if (writes.length !== 5 || !fix || !entity?.input.content?.includes(fix.input.old_text!)) throw new Error('orders-list 시나리오의 모양이 바뀌었습니다(파일 다섯, 엔티티 고침 하나)');
    const memoCalls = callsOf(memoScenario);
    const dropCalls = callsOf(dropScenario);
    if (memoCalls.length !== 8 || dropCalls.length !== 2) throw new Error('order-memo(호출 8)·drop-memo(호출 2) 시나리오의 모양이 바뀌었습니다');

    provider = await fakeProvider([
      { id: 'orders-list', marker: scenario.request, calls: writes.map(toTool), gateFix: toTool(fix), firstFinal: 'GET /api/orders와 /orders 화면을 추가했습니다.', fixedFinal: '오타로 인한 컴파일 에러를 고쳤습니다.' },
      { id: 'order-memo', marker: memoScenario.request, calls: memoCalls.map(toTool), firstFinal: 'V2 마이그레이션, 엔티티, 응답, 화면에 배송 메모를 추가했습니다.' },
      // 게이트가 돌려보내도 고치지 않고 끝내는 모델: 실행이 어떻게 닫히는지 본다
      { id: 'drop-memo', marker: dropScenario.request, calls: dropCalls.map(toTool), firstFinal: '응답에서 쓰지 않는 필드를 정리했습니다.', ignoredFinal: '그대로 두겠습니다. 응답에서 쓰지 않는 필드를 정리했습니다.' },
    ]);

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
    const listStages = provider.stagesOf('orders-list');
    check(listStages.includes('gate-blocked'), `자체 CLI가 게이트의 막는 사유를 모델에 돌려줌 (단계: ${listStages.join(' → ')})`);
    const listReason = provider.gateReasons['orders-list'] ?? '';
    check(/cannot find symbol|customerNam/.test(listReason), `막는 사유에 api 컴파일 오류 로그가 있음 (${listReason.slice(0, 120).replaceAll('\n', ' ') || '사유 없음'})`);
    check(listStages.at(-1) === 'final-after-fix', `고친 뒤 모델이 마무리하고 더는 막히지 않음 (마지막 단계: ${listStages.at(-1)})`);
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


    // ── 같은 세션에서 이어지는 두 번째 요청: 주문 응답에 memo 추가(order-memo) ──
    const eventsOf = (runId: string) => sessions.sessionHistory(sessionId!).flatMap((event) => (event.type === 'agent' && event.runId === runId ? [event.event] : []));
    const gateReports = (runId: string) => eventsOf(runId).flatMap((event) => (event.type === 'verify_result' ? [event.report] : []));
    const checkpointsOf = (runId: string) => sessions.sessionHistory(sessionId!).flatMap((event) => (event.type === 'checkpoint' && event.runId === runId ? [event.checkpoint] : []));
    const checkpointCount = (): number => sessions.getSnapshot(sessionId!)?.checkpoints.length ?? 0;
    const run = (request: string) =>
      Promise.race([
        runTerminalTask(sessionId!, request, { writableScope: undefined, doneTests: [] }),
        delay(15 * 60_000).then(() => {
          throw new Error(`터미널 실행이 15분 안에 끝나지 않았습니다\n${providerTrace(provider!)}`);
        }),
      ]);

    log(`\n▶ ${memoScenario.title}`);
    const beforeMemo = checkpointCount();
    const memoStarted = Date.now();
    const memoResult = await run(memoScenario.request);
    log(`실행 ${memoResult.runId}: ${memoResult.status} · ${memoResult.summary.slice(0, 120)} (${((Date.now() - memoStarted) / 1_000).toFixed(1)}초)`);
    const memoGates = gateReports(memoResult.runId);
    const memoChanges = memoGates.at(-1)?.contracts[0]?.changes ?? [];
    const memoCheckpoints = checkpointsOf(memoResult.runId);
    const memoSnapshot = sessions.getSnapshot(sessionId);
    const memoWeb = memoSnapshot?.services.find((service) => service.name === 'web')?.url;
    const memoWebBody = memoWeb ? await fetchText(`${memoWeb}/orders`) : '(web 주소 없음)';
    log('확인');
    check(memoResult.status === 'done', `order-memo: 실행 done (실제: ${memoResult.status} · ${memoResult.summary.slice(0, 200)})`);
    check(memoGates.length === 1 && memoGates[0]!.ok, `order-memo: 게이트 한 번에 통과 (실제: ${memoGates.map((gate) => gate.ok).join(', ') || '게이트 없음'})`);
    check(
      memoChanges.length === 1 && memoChanges[0]!.target === 'OrderResponse.memo' && !memoChanges[0]!.breaking,
      `order-memo: 계약 변경은 OrderResponse.memo 추가 하나이고 breaking이 아님 (실제: ${memoChanges.map((change) => `${change.target}${change.breaking ? '(breaking)' : ''}`).join(', ') || '변경 없음'})`,
    );
    check(memoWebBody.includes('문 앞에 놓아주세요'), 'order-memo: /orders 화면에 배송 메모가 렌더링됨');
    check(checkpointCount() === beforeMemo + 1 && memoCheckpoints.length === 1, `order-memo: 체크포인트가 하나 늘어남 (${beforeMemo} → ${checkpointCount()}, 이 실행의 체크포인트 이벤트 ${memoCheckpoints.length}개)`);
    check(['run', 'contract_check', 'browser_check', 'test', 'review'].every((stage) => memoCheckpoints.at(-1)?.passedStages?.includes(stage as never)), `order-memo: 체크포인트가 게이트 단계를 통과 (${memoCheckpoints.at(-1)?.passedStages?.join(', ')})`);
    check(provider.stagesOf('order-memo').join(' → ') === 'write-files → final-before-gate', `order-memo: 모델은 막히지 않고 끝냄 (단계: ${provider.stagesOf('order-memo').join(' → ')})`);

    // ── 세 번째 요청: 쓰는 곳이 있는 필드를 지운다(drop-memo). 게이트가 호환 깨짐으로 막고, 모델은 고치지 않는다 ──
    log(`\n▶ ${dropScenario.title}`);
    const beforeDrop = checkpointCount();
    const dropStarted = Date.now();
    const dropResult = await run(dropScenario.request);
    log(`실행 ${dropResult.runId}: ${dropResult.status} · ${dropResult.summary.slice(0, 200)} (${((Date.now() - dropStarted) / 1_000).toFixed(1)}초)`);
    const dropEvents = eventsOf(dropResult.runId);
    const dropGates = gateReports(dropResult.runId);
    const dropFailed = dropEvents.flatMap((event) => (event.type === 'failed' ? [event.result] : []));
    const dropReport = dropGates[0];
    const dropBreaking = dropGates.flatMap((gate) => gate.contracts.flatMap((contract) => contract.changes.filter((change) => change.breaking)));
    const passedStages = new Set(dropFailed.at(-1)?.passedStages ?? []);
    const dropChecks = dropFailed.at(-1)?.checks ?? [];
    check(dropResult.status === 'failed' && dropResult.summary.includes('검증 게이트를 3번 통과하지 못했습니다'), `drop-memo: 재시도 상한(3번)에 닿아 실행 failed (실제: ${dropResult.status} · ${dropResult.summary.slice(0, 80).replaceAll('\n', ' ')})`);
    check(dropGates.length >= 1 && dropGates.every((gate) => !gate.ok), `drop-memo: 게이트가 통과시키지 않음 (게이트 ${dropGates.length}번: ${dropGates.map((gate) => gate.ok).join(', ')})`);
    check(dropBreaking.some((change) => change.kind === 'property-removed' && change.target === 'OrderResponse.memo'), `drop-memo: 호환 깨짐으로 OrderResponse.memo 삭제를 감지 (${dropBreaking.map((change) => `${change.kind}:${change.target}`).join(', ') || '없음'})`);
    check(dropReport !== undefined && dropReport.restarted.length > 0 && dropReport.restarted.every((service) => service.ready), `drop-memo: api 재시작 자체는 성공 (${dropReport?.restarted.map((service) => `${service.service}:${service.ready}`).join(', ') || '재시작 기록 없음'})`);
    check(!passedStages.has('test' as never) && !dropChecks.some((one) => one.stage === 'test'), `drop-memo: 계약 실패 뒤에는 test 단계를 실행하지 않음 (통과한 단계: ${[...passedStages].join(', ') || '없음'})`);
    check(checkpointsOf(dropResult.runId).length === 0 && checkpointCount() === beforeDrop, `drop-memo: 체크포인트가 늘지 않음 (${beforeDrop} → ${checkpointCount()})`);
    // 터미널 경로의 닫힘: 게이트가 막는 사유를 모델에 돌려주고(고치지 않으면 반복), 재시도 상한(3번)에 닿으면 실행을 실패로 닫고 마지막 체크포인트로 되돌린다
    const dropStages = provider.stagesOf('drop-memo');
    // 게이트 3번째 실패는 사유를 돌려주지 않고 실행을 닫는다: 모델이 사유를 받는 것은 2번이다
    check(
      dropGates.length === 3 && dropStages.join(' → ') === 'write-files → final-before-gate → gate-ignored → gate-ignored',
      `drop-memo: 게이트가 두 번 사유를 돌려주고 세 번째 실패에서 닫음, 모델은 고치지 않음 (게이트 ${dropGates.length}번, 단계: ${dropStages.join(' → ')})`,
    );
    check(/property-removed|OrderResponse\.memo|호환/.test(provider.gateReasons['drop-memo'] ?? ''), `drop-memo: 돌려준 사유에 호환 깨짐이 있음 (${(provider.gateReasons['drop-memo'] ?? '').slice(0, 160).replaceAll('\n', ' ')})`);
    const afterDrop = sessions.getSnapshot(sessionId);
    const apiAfterDrop = afterDrop?.services.find((service) => service.name === 'api')?.url;
    const apiAfterBody = apiAfterDrop ? await fetchText(`${apiAfterDrop}/api/orders`) : '(api 주소 없음)';
    check(apiAfterBody.includes('"memo"'), `drop-memo: 실패로 닫으며 마지막 체크포인트로 되돌려 API 응답에 memo가 남음 (${apiAfterBody.slice(0, 100)})`);

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

type ToolCall = { name: 'Write' | 'Edit'; args: Record<string, string> };

/** e2e:agent의 대본 호출(write_file·edit_file)을 자체 CLI의 도구 호출(Write·Edit)로 옮긴다 */
function toTool(call: FileCall): ToolCall {
  if (call.name === 'write_file') return { name: 'Write', args: { file_path: call.input.path, content: call.input.content! } };
  return { name: 'Edit', args: { file_path: call.input.path, old_string: call.input.old_text!, new_string: call.input.new_text! } };
}

/** 한 요청에 대한 가짜 모델의 행동 */
interface Phase {
  id: string;
  /** 요청 글에 든 문구(요청과 게이트가 돌려준 사유를 가르는 데 쓴다) */
  marker: string;
  /** 요청을 받으면 한 번에 내는 도구 호출 */
  calls: ToolCall[];
  firstFinal: string;
  /** 게이트가 막으면 이 호출로 고친 뒤 fixedFinal로 마무리한다. 없으면 고치지 않고 ignoredFinal만 말한다 */
  gateFix?: ToolCall;
  fixedFinal?: string;
  ignoredFinal?: string;
}

type Stage = 'write-files' | 'final-before-gate' | 'gate-blocked' | 'final-after-fix' | 'gate-ignored';

interface FakeProvider {
  server: Server;
  baseUrl: string;
  auth: string[];
  /** 요청(phase id)마다 가짜 모델이 지난 단계 */
  stages: Array<{ id: string; stage: Stage }>;
  stagesOf(id: string): Stage[];
  /** 요청마다 게이트가 돌려준 사유(그 요청의 첫 게이트 사유 글) */
  gateReasons: Record<string, string>;
}

/**
 * 받은 메시지로 단계를 정하는 OpenAI 호환 가짜 모델(호출 횟수가 아니라 대화 내용으로 정한다). 한 세션에서 요청이 이어지므로
 * 대화에서 가장 나중에 온 요청 글(phase.marker를 담은 사용자 글)을 찾아 그 뒤만 본다.
 *  - 요청 뒤에 게이트의 막는 사유(요청이 아닌 문자열 사용자 메시지)가 없고 도구 결과도 없다 → 대본의 도구 호출
 *  - 사유가 없고 도구 결과가 있다 → 끝났다는 글(여기서 Stop 훅이 게이트를 돌린다)
 *  - 사유가 있다: 고치는 phase는 Edit → 마무리 글, 고치지 않는 phase는 사유가 몇 번 오든 같은 글만 말한다
 */
async function fakeProvider(phases: Phase[]): Promise<FakeProvider> {
  const state = { auth: [] as string[], stages: [] as Array<{ id: string; stage: Stage }>, gateReasons: {} as Record<string, string> };
  let id = 0;
  const server = createServer(async (request, response) => {
    const send = (body: unknown) => void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.method === 'GET' && request.url?.startsWith('/v1/models/')) return send({ id: MODEL_ID, object: 'model' });
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return void response.writeHead(404).end('{}');
    state.auth.push(String(request.headers.authorization));
    const body = JSON.parse(await readBody(request)) as { messages?: ChatMessage[] };
    const messages = body.messages ?? [];
    const isString = (message: ChatMessage): message is ChatMessage & { content: string } => message.role === 'user' && typeof message.content === 'string';
    let requestAt = -1;
    let phase: Phase | undefined;
    messages.forEach((message, index) => {
      const hit = isString(message) ? phases.find((one) => message.content.includes(one.marker)) : undefined;
      if (hit) {
        requestAt = index;
        phase = hit;
      }
    });
    if (!phase) return void response.writeHead(400).end(JSON.stringify({ error: { message: '알 수 없는 요청입니다' } }));
    const current: Phase = phase;
    const gateAt = messages.findIndex((message, index) => index > requestAt && isString(message) && !phases.some((one) => message.content.includes(one.marker)));
    if (gateAt >= 0) state.gateReasons[current.id] ??= String(messages[gateAt]!.content);
    const toolResultsAfter = (from: number) => messages.slice(from + 1).filter((message) => message.role === 'tool').length;
    const toolCall = (call: ToolCall) => ({ id: `call_${++id}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } });
    const usage = { prompt_tokens: 1000, completion_tokens: 100 };
    const reply = (stage: Stage, message: Record<string, unknown>, finish: 'stop' | 'tool_calls') => {
      state.stages.push({ id: current.id, stage });
      send({ id: `chatcmpl_${++id}`, model: MODEL_ID, choices: [{ finish_reason: finish, message: { content: null, ...message } }], usage });
    };

    if (gateAt < 0) {
      if (toolResultsAfter(requestAt) === 0) return reply('write-files', { tool_calls: current.calls.map(toolCall) }, 'tool_calls');
      return reply('final-before-gate', { content: current.firstFinal }, 'stop');
    }
    if (!current.gateFix) return reply('gate-ignored', { content: current.ignoredFinal ?? '그대로 두겠습니다.' }, 'stop');
    if (toolResultsAfter(gateAt) === 0) return reply('gate-blocked', { tool_calls: [toolCall(current.gateFix)] }, 'tool_calls');
    return reply('final-after-fix', { content: current.fixedFinal ?? '고쳤습니다.' }, 'stop');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return Object.assign(state, {
    server,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    stagesOf: (phaseId: string) => state.stages.filter((one) => one.id === phaseId).map((one) => one.stage),
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function providerTrace(provider: FakeProvider): string {
  const reasons = Object.entries(provider.gateReasons).map(([phase, reason]) => `  ${phase}: ${reason.slice(0, 600)}`);
  return `가짜 모델이 본 단계: ${provider.stages.map((one) => `${one.id}:${one.stage}`).join(' → ') || '(호출 없음)'} · 호출 ${provider.auth.length}번\n게이트가 돌려준 사유(앞 600자):\n${reasons.join('\n') || '  (없음)'}`;
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
