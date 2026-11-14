/**
 * 게이트의 선언한 검사 실행을 Rust로 옮기기 전(ADR-195 4f A5b-2) `gate.ts`의 `VerificationGate.#runDeclaredChecks`·`#runLoadChecks`·`#clearTestReports`·`#runTest`·
 * `#reviveIfOomKilled`·`#runConcurrencyCheck`를 그대로 둔 것이다. 차등 시험(`declared-checks-differential.test.ts`)이 같은 시나리오를 이 옛 구현과 지금 구현에 넣어 견준다.
 * 제품 코드는 이 파일을 쓰지 않는다. 지우지 않는다(4g에서 함께 지운다).
 *
 * 옛 코드가 `this.…`로 읽고 쓰던 것은 `DeclaredHost`(`GateHost.declared`)로 읽는다. 옛 `#loadPlatformFailure`·`#concurrencyNotes` 필드는 이 실행 안의 지역 값이다.
 * 순서와 분기는 옛 코드의 한 줄도 바꾸지 않았다.
 */
import { formatBytes, SandboxError } from '@b-studio/sandbox';
import type { WorkflowConcurrencyCheck, WorkflowLoadCheck, WorkflowStage, WorkflowTest } from '@b-studio/spec';
import type { DeclaredHost } from './gate-check';
import { legacyCheckPage } from './check-page-legacy';
import { CHECK_CONCURRENCY, describeConcurrencyExpect, evidenceOrNone, OUTPUT_TAIL_LINES, readJsonPath, TEST_TIMEOUT_MS } from './gate';
import { finishEvidence, testEvidence } from './check-evidence';
import { judgeLoad, loadRequestFor } from './load-check';
import { runTaskGraph, type TaskNode } from './task-graph';
import { clearTestReportsCommand, reportRootsForIncludes } from './test-run';
import type { WorkflowCheck } from './workflow';

export interface LegacyDeclared {
  checks: WorkflowCheck[];
  loadPlatformFailure: string | undefined;
}

class Run {
  loadPlatformFailure: string | undefined;
  readonly concurrencyNotes = new Map<string, string>();
  constructor(readonly host: DeclaredHost) {}

  stage(stage: WorkflowStage): void {
    this.host.onEvent({ type: 'stage', stage, source: 'platform' });
  }
}

/** 옛 `#runDeclaredChecks()` */
export async function legacyRunDeclaredChecks(host: DeclaredHost): Promise<LegacyDeclared> {
  const run = new Run(host);
  const checks = await legacyDeclaredInner(run);
  return { checks, loadPlatformFailure: run.loadPlatformFailure };
}

async function legacyDeclaredInner(run: Run): Promise<WorkflowCheck[]> {
  const { host } = run;
  const workflow = host.project.spec.workflow;
  const pages = workflow?.pageChecks ?? [];
  const tests = workflow?.tests ?? [];
  const concurrency = workflow?.concurrencyChecks ?? [];
  const loads = workflow?.loadChecks ?? [];
  const auto = await host.autoPages(pages);
  run.loadPlatformFailure = undefined;
  if (pages.length === 0 && tests.length === 0 && concurrency.length === 0 && loads.length === 0 && auto.pages.length === 0 && auto.skipped.length === 0) return [];

  const meta: Array<Pick<WorkflowCheck, 'stage' | 'name'>> = [];
  const nodes: TaskNode<string[] | void>[] = [];
  host.pageMaps.steps.clear();
  host.pageMaps.compares.clear();
  host.pageMaps.blocked.clear();
  host.pageMaps.loadMs.clear();
  host.pageMaps.warnings.clear();
  run.concurrencyNotes.clear();
  const seen = new Map<string, number>();
  const unique = (name: string): string => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name} #${count}`;
  };
  for (const page of pages) {
    const browser = page.viewport ? `browser ${page.viewport.width}x${page.viewport.height}` : 'browser';
    const steps = page.steps?.length ? `, 단계 ${page.steps.length}개` : '';
    const name = unique(`${page.service} ${page.path}${page.mode === 'browser' ? ` (${browser}${steps})` : ''}`);
    meta.push({ stage: 'browser_check', name });
    nodes.push({ id: `page:${name}`, run: ({ signal }) => legacyCheckPage(host, page, name, signal) });
  }
  for (const entry of auto.pages) {
    const name = unique(entry.name);
    meta.push({ stage: 'browser_check', name });
    nodes.push({
      id: `page:${name}`,
      run: ({ signal }) =>
        legacyCheckPage(host, entry.page, name, signal, { auto: true, ...(entry.probedId !== undefined ? { probedId: entry.probedId } : {}), ...(entry.sampled ? { sampled: entry.sampled } : {}) }),
    });
  }
  for (const test of tests) {
    meta.push({ stage: 'test', name: test.name });
    nodes.push({ id: `test:${test.name}`, maxAttempts: test.maxAttempts, run: ({ signal }) => runTest(run, test, signal) });
  }
  for (const check of concurrency) {
    meta.push({ stage: 'concurrency_check', name: check.name });
    nodes.push({ id: `concurrency:${check.name}`, run: ({ signal }) => runConcurrencyCheck(run, check, check.name, signal) });
  }
  if (pages.length > 0 || auto.pages.length > 0) run.stage('browser_check');
  if (tests.length > 0) run.stage('test');
  if (concurrency.length > 0) run.stage('concurrency_check');

  if (tests.length > 0) await clearTestReports(run, tests);
  const results = await runTaskGraph(nodes, { concurrency: CHECK_CONCURRENCY, signal: host.signal });
  const checks = results.map((result, index) => {
    const entry = meta[index]!;
    const steps = host.pageMaps.steps.get(entry.name);
    const compare = host.pageMaps.compares.get(entry.name);
    const loadMs = host.pageMaps.loadMs.get(entry.name);
    const note = run.concurrencyNotes.get(entry.name);
    const blocked = host.pageMaps.blocked.get(entry.name) ?? [];
    const warnings = host.pageMaps.warnings.get(entry.name) ?? [];
    const detail = [result.error, note, blocked.length > 0 ? `다른 출처 요청 ${blocked.length}건을 막았습니다` : undefined, ...warnings]
      .filter((line) => line !== undefined)
      .join('\n');
    const ok = result.status === 'succeeded';
    const evidence = ok && result.value ? result.value : undefined;
    return {
      ...entry,
      ok,
      attempts: result.attempts,
      detail: detail || undefined,
      ...(evidence?.length ? { evidence } : {}),
      ...(steps ? { steps } : {}),
      ...(compare ? { compare } : {}),
      ...(loadMs !== undefined ? { metrics: { loadMs } } : {}),
    };
  });
  const loadChecks = await runLoadChecks(run, loads);
  return [...checks, ...loadChecks, ...auto.skipped];
}

async function runLoadChecks(run: Run, loads: readonly WorkflowLoadCheck[]): Promise<WorkflowCheck[]> {
  if (loads.length === 0) return [];
  run.stage('load_check');
  const { sandbox, signal } = run.host;
  const redact = (line: string) => sandbox.redact(line);
  const checks: WorkflowCheck[] = [];
  for (const check of loads) {
    signal?.throwIfAborted();
    const entry = { stage: 'load_check' as const, name: check.name, attempts: 1 };
    if (!sandbox.runLoad) {
      const detail = '이 샌드박스 제공자는 부하 확인(workflow.loadChecks)을 지원하지 않습니다. 로컬 Docker 제공자에서만 잴 수 있습니다';
      run.loadPlatformFailure ??= `부하 확인 '${check.name}': ${detail}`;
      checks.push({ ...entry, ok: false, detail });
      continue;
    }
    try {
      const judged = judgeLoad(check, await sandbox.runLoad(loadRequestFor(check), { signal }));
      const ok = judged.problems.length === 0;
      const evidence = ok ? evidenceOrNone(() => finishEvidence(judged.evidence, redact)) : [];
      checks.push({ ...entry, ok, detail: redact([judged.note, ...judged.problems].join('\n')), ...(evidence.length ? { evidence } : {}) });
    } catch (error) {
      signal?.throwIfAborted();
      const detail = redact(error instanceof Error ? error.message : String(error));
      if (error instanceof SandboxError && error.platform) run.loadPlatformFailure ??= `부하 확인 '${check.name}': ${detail}`;
      checks.push({ ...entry, ok: false, detail });
    }
  }
  return checks;
}

async function clearTestReports(run: Run, tests: readonly WorkflowTest[]): Promise<void> {
  const { host } = run;
  const services = new Set(tests.map((test) => test.service));
  await Promise.all(
    [...services].map(async (service) => {
      const spec = host.project.managed.find(([name]) => name === service)?.[1];
      if (!spec) return;
      await host.sandbox.exec(service, clearTestReportsCommand(reportRootsForIncludes(spec.includes)), host.signal ? { signal: host.signal } : {}).catch(() => {});
    }),
  );
}

async function runTest(run: Run, test: WorkflowTest, signal: AbortSignal): Promise<string[]> {
  const { sandbox } = run.host;
  const timeout = AbortSignal.timeout(TEST_TIMEOUT_MS);
  const startedAt = performance.now();
  const result = await sandbox.exec(test.service, test.command, { signal: AbortSignal.any([signal, timeout]) });
  if (result.exitCode !== 0) {
    const revived = await reviveIfOomKilled(run, test.service, signal);
    const output = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');
    throw new Error(`종료 코드 ${result.exitCode}${revived ? `\n환경 문제: ${test.service} 컨테이너가 ${revived} 종료됐습니다. 코드 문제가 아닐 수 있습니다 — 서비스를 다시 띄웠습니다(다음 시도에서 이어집니다)` : ''}\n${output}`);
  }
  return evidenceOrNone(() => finishEvidence(testEvidence(test.service, test.command, performance.now() - startedAt), (line) => sandbox.redact(line)));
}

async function reviveIfOomKilled(run: Run, service: string, signal: AbortSignal): Promise<string | undefined> {
  const { sandbox } = run.host;
  const usage = (await sandbox.stats().catch(() => [])).find((candidate) => candidate.service === service);
  if (!usage?.oomKilled) return undefined;
  await sandbox.restart(service, { signal }).catch(() => {});
  return `메모리 한도${usage.memoryLimitBytes ? ` (${formatBytes(usage.memoryLimitBytes)})` : ''}를 넘어`;
}

async function runConcurrencyCheck(run: Run, check: WorkflowConcurrencyCheck, name: string, signal: AbortSignal): Promise<void> {
  const { sandbox, requestService: request } = run.host;
  const endpoint = await sandbox.endpoint(check.service);
  const url = new URL(check.path, endpoint.url);
  if (url.origin !== new URL(endpoint.url).origin) throw new Error('path must stay on the service host');

  const responses = await Promise.all(
    Array.from({ length: check.concurrent }, () =>
      request(url.href, {
        method: check.method,
        ...(check.headers ? { headers: check.headers } : {}),
        ...(check.method !== 'GET' && check.body !== undefined ? { body: check.body } : {}),
        signal,
      }),
    ),
  );
  const successCount = responses.filter((response) => response.status >= 200 && response.status < 300).length;
  const counts = new Map<number, number>();
  for (const response of responses) counts.set(response.status, (counts.get(response.status) ?? 0) + 1);
  const statusDetail = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([status, count]) => `${status}:${count}`)
    .join(', ');

  const parts = [`성공 ${successCount}/${check.concurrent} (기대: ${describeConcurrencyExpect(check.expect)})`, `상태 ${statusDetail}`];
  const problems: string[] = [];
  const { successCount: expectedCount, allStatusIn, then } = check.expect;
  if (expectedCount?.exactly !== undefined && successCount !== expectedCount.exactly) {
    problems.push(`성공 ${successCount}/${check.concurrent} (기대: 정확히 ${expectedCount.exactly})`);
  }
  if (expectedCount?.atMost !== undefined && successCount > expectedCount.atMost) {
    problems.push(`성공 ${successCount}/${check.concurrent} (기대: 최대 ${expectedCount.atMost})`);
  }
  if (allStatusIn && !responses.every((response) => allStatusIn.includes(response.status))) {
    const outside = [...new Set(responses.map((response) => response.status).filter((status) => !allStatusIn.includes(status)))].join(', ');
    problems.push(`기대 밖 상태 코드: ${outside} (기대: ${allStatusIn.join(', ')})`);
  }
  if (then) {
    const thenUrl = new URL(then.path, endpoint.url);
    if (thenUrl.origin !== new URL(endpoint.url).origin) throw new Error('path must stay on the service host');
    const response = await request(thenUrl.href, { method: 'GET', signal });
    const actual = readJsonPath(response.text, then.jsonPath);
    parts.push(`${then.jsonPath} = ${JSON.stringify(actual)}`);
    if (actual !== then.equals) problems.push(`${then.jsonPath} 값이 ${JSON.stringify(actual)} (기대: ${JSON.stringify(then.equals)})`);
  }

  const note = parts.join(' · ');
  if (problems.length > 0) throw new Error(sandbox.redact([note, ...problems].join('\n')));
  run.concurrencyNotes.set(name, note);
}
