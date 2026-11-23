/**
 * 세션 터미널 한 길(지원 경로: desk + 이 컴퓨터 방식 터미널)의 턴 끝 게이트를 실제 Docker로 검증한다(#1365).
 * e2e:agent의 orders-list(채팅식 실행)와 같은 파일을, 스스로 훅·텔레메트리를 부르는 가짜 CLI가 터미널에서 쓴다.
 *
 *  - 첫 시도는 엔티티의 오타로 api가 컴파일되지 않는다 → 턴 끝(Stop) 게이트가 실제로 서비스를 재시작해 실패를 보고,
 *    컴파일 오류 로그를 담아 CLI의 턴 끝을 막는다
 *  - CLI가 오타를 고치고 다시 턴을 끝내면 게이트가 통과해 체크포인트를 남긴다
 *  - 체크포인트 뒤 실제 서비스 주소에서 API와 화면이 시드 데이터를 낸다
 *
 *   pnpm e2e:terminal-orders
 */
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ORDERS_DEMO_SCENARIOS } from '@b-studio/agent';

const FAKE_CLI = path.resolve(import.meta.dirname, '../server/baseline/fake-claude-agent.mjs');
type FileCall = { name: string; input: { path: string; content?: string; old_text?: string; new_text?: string } };
type Action = { kind: string; event?: string; path?: string; denied?: boolean; reason?: string; output?: { decision?: string; reason?: string } };

async function main(): Promise<void> {
  // 처음 쓰는 컴퓨터(CI 실행기 등)에는 ~/.cache/b-studio가 없다. mkdtemp는 상위 폴더를 만들지 않는다
  await mkdir(path.join(homedir(), '.cache/b-studio'), { recursive: true });
  const root = await mkdtemp(path.join(homedir(), '.cache/b-studio/', 'terminal-orders-e2e-'));
  const failures: string[] = [];
  const check = (ok: boolean, label: string) => {
    log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failures.push(label);
  };
  let sessionId: string | undefined;
  const actionLog = path.join(root, 'claude-actions.jsonl');

  try {
    // e2e:agent의 orders-list가 쓰는 파일을 그대로 쓴다: 첫 턴의 write_file들, 고치는 edit_file 하나
    const scenario = ORDERS_DEMO_SCENARIOS.find((one) => one.id === 'orders-list');
    if (!scenario) throw new Error('orders-list 시나리오를 찾지 못했습니다');
    const calls = scenario.turns.flatMap((turn) => (turn.toolCalls ?? []) as FileCall[]);
    const writes = calls.filter((call) => call.name === 'write_file');
    const fix = calls.find((call) => call.name === 'edit_file');
    const entity = writes.find((call) => call.input.path === fix?.input.path);
    if (writes.length !== 5 || !fix || !entity?.input.content?.includes(fix.input.old_text!)) throw new Error('orders-list 시나리오의 모양이 바뀌었습니다(파일 다섯, 엔티티 고침 하나)');
    const fixed = entity.input.content.replace(fix.input.old_text!, fix.input.new_text!);

    // 쓰기마다 앞에 텔레메트리를 둔다(텔레메트리 없는 쓰기가 이어지면 서버가 쓰기를 막는다)
    let request = 0;
    const telemetry = () => ({ telemetry: { requestId: `req_orders_${++request}`, input: 300, output: 60, costUsd: 0.01 } });
    const script = {
      scripts: [
        {
          match: { request: '주문 목록 API와 화면' },
          steps: [
            ...writes.flatMap((call) => [telemetry(), { write: { path: call.input.path, content: call.input.content! } }]),
            { stop: { text: 'GET /api/orders와 /orders 화면을 추가했습니다.' } },
            // 게이트가 턴 끝을 막으면(컴파일 실패) 오타를 고치고 다시 끝낸다
            telemetry(),
            { write: { path: entity.input.path, content: fixed } },
            { stop: { text: '오타로 인한 컴파일 에러를 고쳤습니다.' } },
          ],
        },
      ],
    };
    const scriptFile = path.join(root, 'claude-script.json');
    await writeFile(scriptFile, JSON.stringify(script));
    const binDir = path.join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    const claude = path.join(binDir, 'claude');
    // 터미널은 정해 둔 환경 변수만 CLI에 넘기므로 대본·기록 경로를 감싸개에 박아 넣는다
    await writeFile(claude, `#!/bin/sh\nexec ${q(process.execPath)} ${q(FAKE_CLI)} ${q(path.join(root, 'claude-launch.jsonl'))} ${q(actionLog)} ${q(scriptFile)} "$@"\n`);
    await chmod(claude, 0o755);
    await mkdir(path.join(root, 'sessions'), { recursive: true });
    await mkdir(path.join(root, 'claude-config'), { recursive: true });

    process.env.B_STUDIO_MODE = 'claude-code';
    process.env.B_STUDIO_TERMINAL = 'host';
    // 진짜 claude가 뜨지 않게 한다: 터미널은 이 경로를, 로그인 확인은 PATH의 첫 claude를 쓴다
    process.env.B_STUDIO_CLAUDE_BIN = claude;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
    // 사용자의 claude 설정 파일(~/.claude.json)과 관문 폴더를 건드리지 않는다
    process.env.B_STUDIO_CLAUDE_CONFIG_DIR = path.join(root, 'claude-config');
    process.env.B_STUDIO_AGENT_GATEWAY_DIR = path.join(root, 'gateway');
    process.env.B_STUDIO_PROJECTS_DIR = path.resolve(import.meta.dirname, '../../../examples');
    process.env.B_STUDIO_SESSIONS_DIR = path.join(root, 'sessions');
    process.env.B_STUDIO_MODEL_OBSERVATIONS_FILE = path.join(root, 'model-observations.json');

    const sessions = await import('../lib/server/sessions');
    const { runTerminalTask, terminalLaneDriver } = await import('../lib/server/terminal-lane');
    const { LOCAL_USER } = await import('../lib/server/auth');

    const started = Date.now();
    const created = await sessions.createSession('orders', LOCAL_USER, 'copy', {});
    sessionId = created.id;
    log(`세션 ${sessionId} (터미널 ${created.terminalMode ?? '-'})`);
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
      delay(15 * 60_000).then(async () => {
        throw new Error(`터미널 실행이 15분 안에 끝나지 않았습니다\n${await tail(actionLog)}`);
      }),
    ]);
    log(`실행 ${result.runId}: ${result.status} · ${result.summary.slice(0, 120)}`);

    const actions = (await readFile(actionLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Action);
    const stops = actions.filter((action) => action.kind === 'hook' && action.event === 'Stop');
    const snapshot = sessions.getSnapshot(sessionId);
    const checkpoint = snapshot?.checkpoints.at(-1);
    log('\n확인');
    check(result.status === 'done', `실행 done (실제: ${result.status})`);
    check(actions.filter((action) => action.kind === 'write' && action.denied).length === 0, '쓰기 직전 훅이 쓰기를 막지 않음');
    check(stops.length === 2, `턴 끝(Stop)을 두 번 부름 (실제: ${stops.length})`);
    check(stops[0]?.output?.decision === 'block' && /cannot find symbol|customerNam/.test(stops[0].output.reason ?? ''), `첫 턴 끝을 게이트가 api 컴파일 오류 로그와 함께 막음 (${(stops[0]?.output?.reason ?? '막지 않음').slice(0, 120).replaceAll('\n', ' ')})`);
    check(stops[1] !== undefined && stops[1].output?.decision !== 'block', '고친 뒤의 턴 끝은 막지 않음');
    check(Boolean(checkpoint) && writes.every((call) => checkpoint!.files.includes(call.input.path)), `체크포인트에 다섯 파일 (${checkpoint?.shortSha} · ${checkpoint?.files.length ?? 0}개)`);
    check(['run', 'contract_check', 'browser_check', 'test', 'review'].every((stage) => checkpoint?.passedStages?.includes(stage as never)), `체크포인트가 게이트 단계를 통과 (${checkpoint?.passedStages?.join(', ')})`);
    check(result.costUsd !== undefined && result.costUsd > 0, `비용은 CLI 텔레메트리의 합 (${result.costUsd})`);
    const api = snapshot?.services.find((service) => service.name === 'api')?.url;
    const web = snapshot?.services.find((service) => service.name === 'web')?.url;
    const apiBody = api ? await fetchText(`${api}/api/orders`) : '(api 주소 없음)';
    const webBody = web ? await fetchText(`${web}/orders`) : '(web 주소 없음)';
    check(apiBody.includes('김토스'), `API 응답에 시드 데이터 (${apiBody.slice(0, 80)})`);
    check(webBody.includes('김토스'), '/orders 화면에 시드 데이터가 렌더링됨');

    await sessions.stopSession(sessionId).catch(() => {});
    sessionId = undefined;
    if (failures.length) throw new Error(`실패한 확인 ${failures.length}개:\n- ${failures.join('\n- ')}\n${await tail(actionLog)}`);
    log(`\n✅ 실제 Docker 세션 터미널 게이트 E2E 통과 (${((Date.now() - started) / 1_000).toFixed(1)}초)`);
  } finally {
    if (sessionId) {
      const { stopSession } = await import('../lib/server/sessions').catch(() => ({ stopSession: async () => {} }));
      await stopSession(sessionId).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  }
}

async function fetchText(url: string): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    return await response.text();
  } catch (error) {
    return `(요청 실패: ${String(error)})`;
  }
}

/** 셸 감싸개에 넣을 경로를 홑따옴표로 감싼다 */
function q(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** 실패를 읽을 수 있게 가짜 CLI의 동작 기록 끝부분을 돌려준다 */
async function tail(file: string): Promise<string> {
  const text = await readFile(file, 'utf8').catch(() => '(가짜 CLI 동작 기록 없음)');
  return `가짜 CLI 동작 기록(끝 40줄):\n${text.split('\n').slice(-40).join('\n')}`;
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
