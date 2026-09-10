/**
 * 실제 Docker 샌드박스에서 에이전트 루프 전체를 검증하는 시나리오.
 * 모델 대신 스크립트를 쓰므로 API 키가 필요 없다. 검증 대상은 모델의 코딩 능력이 아니라
 * "도구 → 파일 변경 → 파일 반영 확인 → 서비스 재시작 → 준비 판정 → 계약 비교 → 피드백"이 실제로 맞물리는지다.
 *
 *   pnpm e2e:agent
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { LocalDockerProvider, type Sandbox } from '@b-studio/sandbox';
import { loadProject } from '@b-studio/spec';
import { ORDERS_DEMO_SCENARIOS, runAgent, ScriptedModelClient, type AgentEvent, type AgentResult, type DemoScenario } from '../src/index';

const EXAMPLE = path.resolve(import.meta.dirname, '../../../examples/orders');

type Expectation = (result: AgentResult, events: AgentEvent[], sandbox: Sandbox) => Promise<string[]>;

const expectations: Record<DemoScenario['id'], Expectation> = {
  async 'orders-list'(result, events, sandbox) {
    const gates = events.flatMap((e) => (e.type === 'verify_result' ? [e.report] : []));
    const web = await get(sandbox, 'web', '/orders');
    const api = await get(sandbox, 'api', '/api/orders');
    return [
      check(result.status === 'done', `상태 done (실제: ${result.status})`),
      check(gates.length === 2 && !gates[0]!.ok && gates[1]!.ok, `게이트 [실패, 통과] (실제: ${gates.map((g) => g.ok).join(', ')})`),
      check(gates[0]?.restarted.some((r) => r.service === 'api' && !r.ready && r.logTail?.some((l) => l.includes('cannot find symbol'))) ?? false, '첫 게이트가 api 컴파일 에러 로그를 담음'),
      check(gates[1]?.contracts[0]?.changes.some((c) => c.target === 'GET /api/orders' && !c.breaking) ?? false, '계약에 GET /api/orders 추가'),
      check(api.includes('김토스'), `API 응답에 시드 데이터 (${api.slice(0, 80)})`),
      check(web.includes('김토스'), '/orders 화면에 시드 데이터가 렌더링됨'),
    ];
  },
  async 'order-memo'(result, events, sandbox) {
    const gates = events.flatMap((e) => (e.type === 'verify_result' ? [e.report] : []));
    const changes = gates.at(-1)?.contracts[0]?.changes ?? [];
    const web = await get(sandbox, 'web', '/orders');
    return [
      check(result.status === 'done', `상태 done (실제: ${result.status})`),
      check(gates.length === 1 && gates[0]!.ok, '게이트 한 번에 통과'),
      check(changes.length === 1 && changes[0]!.target === 'OrderResponse.memo' && !changes[0]!.breaking, `계약 변경은 OrderResponse.memo 추가 하나 (실제: ${changes.map((c) => c.target).join(', ')})`),
      check(web.includes('문 앞에 놓아주세요'), '/orders 화면에 배송 메모가 렌더링됨'),
    ];
  },
  async 'drop-memo'(result) {
    const breaking = result.report?.contracts.flatMap((c) => c.changes.filter((change) => change.breaking)) ?? [];
    return [
      check(result.status === 'failed', `상태 failed (실제: ${result.status})`),
      check(result.report?.restarted.every((r) => r.ready) ?? false, 'api 재시작 자체는 성공'),
      check(breaking.some((c) => c.kind === 'property-removed' && c.target === 'OrderResponse.memo'), '호환 깨짐으로 OrderResponse.memo 삭제를 감지'),
    ];
  },
};

async function main(): Promise<number> {
  const workDir = path.join(homedir(), '.cache/b-studio/e2e', `orders-${Date.now()}`);
  await mkdir(path.dirname(workDir), { recursive: true });
  await cp(EXAMPLE, workDir, { recursive: true, filter: (source) => !/[/\\](node_modules|\.next|build|\.gradle)([/\\]|$)/.test(source) });
  log(`작업 복사본: ${workDir}`);

  const project = await loadProject(workDir);
  const sandbox = await new LocalDockerProvider().create(project);
  const failures: string[] = [];

  try {
    const started = Date.now();
    await sandbox.start();
    log(`샌드박스 준비 (${seconds(started)})`);

    for (const scenario of ORDERS_DEMO_SCENARIOS) {
      log(`\n▶ ${scenario.title}`);
      const events: AgentEvent[] = [];
      const client = new ScriptedModelClient(scenario.turns);
      const scenarioStarted = Date.now();
      const result = await runAgent({
        request: scenario.request,
        project,
        sandbox,
        client,
        allowBreaking: scenario.allowBreaking,
        maxVerifyAttempts: scenario.maxVerifyAttempts,
        onEvent: (event) => {
          events.push(event);
          if (event.type === 'verify_start') log(`  게이트: ${event.files.length}개 파일 → 반영 확인·재시작·계약 비교`);
          if (event.type === 'verify_result') log(event.text.split('\n').map((line) => `    ${line}`).join('\n'));
        },
      });
      log(`  결과: ${result.status} · ${result.turns}턴 · 게이트 실패 ${result.verifyAttempts}회 · ${seconds(scenarioStarted)}`);

      for (const line of await expectations[scenario.id](result, events, sandbox)) {
        log(`  ${line}`);
        if (line.startsWith('✗')) failures.push(`${scenario.title}: ${line}`);
      }
      if (client.remainingTurns > 0) failures.push(`${scenario.title}: 스크립트 턴 ${client.remainingTurns}개가 남음`);
    }
  } finally {
    await sandbox.destroy();
    if (failures.length === 0) await rm(workDir, { recursive: true, force: true });
  }

  log(failures.length === 0 ? '\n✅ 모든 시나리오 통과' : `\n❌ 실패 ${failures.length}건\n${failures.join('\n')}\n작업 복사본을 남겨 둡니다: ${workDir}`);
  return failures.length === 0 ? 0 : 1;
}

async function get(sandbox: Sandbox, service: string, requestPath: string): Promise<string> {
  const endpoint = await sandbox.endpoint(service);
  const response = await fetch(new URL(requestPath, endpoint.url), { signal: AbortSignal.timeout(120_000) });
  return response.text();
}

function check(condition: boolean, label: string): string {
  return `${condition ? '✓' : '✗'} ${label}`;
}

function seconds(since: number): string {
  return `${((Date.now() - since) / 1000).toFixed(1)}s`;
}

function log(message: string): void {
  console.log(message);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
