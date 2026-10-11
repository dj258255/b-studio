import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LoadedProject } from '@b-studio/spec';
import { beforeEach, describe, expect, it } from 'vitest';
import { GATEWAY_BUILTIN_TOOLS, gatewayToolSpecs, runClaudeGatewayAgent } from './claude-gateway-runner';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT } from './test-helpers';
import { SANDBOX_TOOLS, WRITE_TOOLS } from './tools';

const execFileAsync = promisify(execFile);

/**
 * `claude` CLI처럼 행동하는 가짜. 모델을 부르지 않고 시나리오대로 파일을 직접 고친 뒤(내장 Edit·Write에 해당),
 * 멈출 때마다 --settings 파일의 Stop 훅 명령을 실제 CLI처럼 셸로 실행하고 그 출력(JSON)을 따른다.
 * 훅이 막으면({decision:'block'}) 사유를 받아 다음 회차로 넘어가고, 막지 않으면 끝낸다.
 */
const FAKE_CLI = String.raw`
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const scenario = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCENARIO, 'utf8'));
const settings = JSON.parse(readFileSync(valueOf('--settings'), 'utf8'));
const stopCommand = settings.hooks.Stop[0].hooks[0].command;
const log = { args, hooks: [], env: { gate: Boolean(process.env.B_STUDIO_GATE_TOKEN), mcp: Boolean(process.env.B_STUDIO_MCP_TOKEN) }, settings: readFileSync(valueOf('--settings'), 'utf8'), mcp: readFileSync(valueOf('--mcp-config'), 'utf8') };
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const write = (file, content) => {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(path.resolve(file), content);
};
const flush = () => writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(log));

emit({ type: 'system', subtype: 'init', session_id: 'cli-session', model: 'test-model', claude_code_version: '9.9.9' });
let turns = 0;
let active = false;
let lastText = '';
for (const round of scenario.rounds) {
  for (const item of round.writes ?? []) write(item.file, item.content);
  turns += 1;
  lastText = round.text ?? '';
  emit({ type: 'assistant', message: { id: 'msg-' + turns, content: [{ type: 'text', text: lastText }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } });
  if (round.hang) {
    flush();
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
  if (round.stop === false) continue;
  const hook = spawnSync('sh', ['-c', stopCommand], { input: JSON.stringify({ hook_event_name: 'Stop', stop_hook_active: active, last_assistant_message: lastText }), env: round.breakHook ? { ...process.env, B_STUDIO_GATE_TOKEN: 'wrong' } : process.env, encoding: 'utf8' });
  let decision = {};
  try { decision = JSON.parse(hook.stdout || '{}'); } catch { decision = { unparsed: hook.stdout }; }
  log.hooks.push({ status: hook.status, decision });
  if (decision.decision === 'block') {
    active = true;
    emit({ type: 'user', message: { content: [{ type: 'text', text: 'Stop hook feedback:\n' + decision.reason }] } });
    continue;
  }
  for (const item of round.writesAfterStop ?? []) write(item.file, item.content);
  break;
}
flush();
emit({
  type: 'result',
  subtype: scenario.resultSubtype ?? 'success',
  is_error: false,
  result: lastText,
  num_turns: turns,
  duration_api_ms: 1234,
  errors: [],
  modelUsage: { 'test-model': { inputTokens: 10 * turns, outputTokens: 5 * turns, cacheReadInputTokens: 100 * turns, cacheCreationInputTokens: 0 } },
});
process.exit(scenario.exitCode ?? 0);
`;

interface Round {
  writes?: Array<{ file: string; content: string }>;
  text?: string;
  /** false면 훅을 부르지 않고 다음 회차로 간다(턴 상한·훅 실패로 훅 없이 끝나는 경우를 만든다) */
  stop?: boolean;
  /** 훅이 통과시킨 뒤에 파일을 더 바꾼다 */
  writesAfterStop?: Array<{ file: string; content: string }>;
  /** 훅 명령이 인증에 실패하게 한다(게이트 서버에 닿지 못한 경우) */
  breakHook?: boolean;
  /** 이 회차에서 멈춰 기다린다(취소 시험) */
  hang?: boolean;
}

interface FakeLog {
  args: string[];
  hooks: Array<{ status: number | null; decision: { decision?: string; reason?: string } }>;
  env: { gate: boolean; mcp: boolean };
  settings: string;
  mcp: string;
}

const BROKEN = 'class Order { String customerNam; String memo }\n';
const FIXED = 'class Order { String customerName; String memo; }\n';

describe('runClaudeGatewayAgent (러너 대신 CLI에 관문만 붙인다, 이슈 #670)', () => {
  let project: LoadedProject;
  let cliPath: string;

  beforeEach(async () => {
    project = await createOrdersProject('b-studio-gateway-');
    cliPath = path.join(project.root, '..', `${path.basename(project.root)}-fake-claude.mjs`);
    await writeFile(cliPath, FAKE_CLI);
    // 바뀐 파일을 git으로 안다(세션의 CheckpointStore.pendingFiles와 같은 방식)
    const git = (...args: string[]) => execFileAsync('git', ['-C', project.root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args]);
    await git('init', '-q');
    await git('add', '-A');
    await git('commit', '-q', '-m', 'init');
  });

  async function pendingFiles(): Promise<string[]> {
    const { stdout } = await execFileAsync('git', ['-C', project.root, 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
    return stdout
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.slice(3));
  }

  async function run(rounds: Round[], restartOutcomes: boolean[], extra: { scenario?: Record<string, unknown>; maxVerifyAttempts?: number; signal?: AbortSignal } = {}) {
    const scenarioPath = `${cliPath}.scenario.json`;
    const logPath = `${cliPath}.log.json`;
    await writeFile(scenarioPath, JSON.stringify({ rounds, ...extra.scenario }));
    const sandbox = fakeSandbox(project, restartOutcomes);
    const events: AgentEvent[] = [];
    const promise = runClaudeGatewayAgent({
      request: '주문에 메모 필드 추가',
      project,
      sandbox,
      pendingFiles,
      cliCommand: [process.execPath, cliPath],
      env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenarioPath, FAKE_CLAUDE_LOG: logPath },
      fetcher: async () => ORDERS_CONTRACT,
      onEvent: (event) => events.push(event),
      ...(extra.maxVerifyAttempts !== undefined ? { maxVerifyAttempts: extra.maxVerifyAttempts } : {}),
      ...(extra.signal ? { signal: extra.signal } : {}),
    });
    const log = async (): Promise<FakeLog> => JSON.parse(await readFile(logPath, 'utf8')) as FakeLog;
    return { promise, sandbox, events, log };
  }

  it('CLI가 내장 도구로 직접 고친 파일을 게이트가 검증한다. 실패하면 멈춤 훅으로 사유를 돌려주고, 고친 뒤 통과하면 끝낸다', async () => {
    const { promise, sandbox, events, log } = await run(
      [
        { writes: [{ file: 'api/src/Order.java', content: BROKEN }], text: '메모 필드를 추가했습니다.' },
        { writes: [{ file: 'api/src/Order.java', content: FIXED }], text: '컴파일 에러를 고쳤습니다.' },
      ],
      [false, true],
    );
    const result = await promise;

    expect(result).toMatchObject({ status: 'done', summary: '컴파일 에러를 고쳤습니다.', verifyAttempts: 1, turns: 2, sessionId: 'cli-session' });
    // b-studio 도구를 거치지 않은 변경인데도 검증 대상에 들어갔다
    expect(result.changedFiles).toEqual(['api/src/Order.java']);
    expect(sandbox.restarts).toEqual(['api', 'api']);

    const { hooks } = await log();
    expect(hooks).toHaveLength(2);
    expect(hooks[0]!.decision.decision).toBe('block');
    expect(hooks[0]!.decision.reason).toContain('[b-studio 검증 게이트]');
    expect(hooks[0]!.decision.reason).toContain('cannot find symbol');
    // 통과하면 막지 않는다
    expect(hooks[1]!.decision.decision).toBeUndefined();

    expect(events[0]).toMatchObject({ type: 'session', backend: 'Claude Code CLI 관문 (CLI 9.9.9)', model: 'test-model' });
    expect(events.filter((event) => event.type === 'text').map((event) => event.type === 'text' && event.text)).toEqual(['메모 필드를 추가했습니다.', '컴파일 에러를 고쳤습니다.']);
    expect(events.some((event) => event.type === 'verify_start')).toBe(true);
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 200 });
    expect(result.metrics?.modelMs).toBe(1234);
  });

  it('훅이 한 번도 불리지 않고 CLI가 끝나도 러너가 마지막에 게이트를 돌린다 — 실패하면 완료로 보지 않는다', async () => {
    const { promise, sandbox, log } = await run([{ writes: [{ file: 'api/src/Order.java', content: BROKEN }], text: '끝냈습니다.', stop: false }], [false]);
    const result = await promise;

    expect((await log()).hooks).toHaveLength(0);
    expect(sandbox.restarts).toEqual(['api']);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('마지막 검증을 통과하지 못했습니다');
  });

  it('훅 없이 끝난 실행도 마지막 검증을 통과하면 완료다', async () => {
    const { promise, sandbox } = await run([{ writes: [{ file: 'api/src/Order.java', content: FIXED }], text: '끝냈습니다.', stop: false }], [true]);
    const result = await promise;

    expect(sandbox.restarts).toEqual(['api']);
    expect(result).toMatchObject({ status: 'done', summary: '끝냈습니다.', changedFiles: ['api/src/Order.java'] });
  });

  it('훅 명령이 게이트 서버에 닿지 못해도(인증 실패) 검증 없이 통과하지 않는다', async () => {
    const { promise, sandbox, log } = await run([{ writes: [{ file: 'api/src/Order.java', content: BROKEN }], text: '끝냈습니다.', breakHook: true }], [false]);
    const result = await promise;

    // 훅은 막지 못했다(게이트 서버가 401로 거절). CLI는 그대로 끝났다
    expect((await log()).hooks[0]!.decision.decision).toBeUndefined();
    expect(sandbox.restarts).toEqual(['api']);
    expect(result.status).toBe('failed');
  });

  it('훅이 통과시킨 뒤에 파일이 또 바뀌면 그 변경도 마지막에 검증한다', async () => {
    const { promise, sandbox } = await run(
      [{ writes: [{ file: 'api/src/Order.java', content: FIXED }], text: '끝냈습니다.', writesAfterStop: [{ file: 'api/src/Memo.java', content: 'class Memo {}\n' }] }],
      [true, false],
    );
    const result = await promise;

    expect(sandbox.restarts).toEqual(['api', 'api']);
    expect(result.status).toBe('failed');
    expect(result.changedFiles).toEqual(['api/src/Memo.java', 'api/src/Order.java']);
  });

  it('게이트가 검증할 수 없는 경로(.env)를 바꾸면 통과시키지 않고 사유를 돌려준다. 남아 있는 한 끝까지 통과시키지 않는다', async () => {
    const { promise, log } = await run(
      [
        { writes: [{ file: 'api/src/Order.java', content: FIXED }, { file: 'api/.env', content: 'TOKEN=abc\n' }], text: '끝냈습니다.' },
        { writes: [{ file: 'api/src/Order.java', content: FIXED }], text: '다시 끝냈습니다.', stop: false },
      ],
      [true, true, true],
    );
    const result = await promise;

    const { hooks } = await log();
    expect(hooks[0]!.decision.decision).toBe('block');
    expect(hooks[0]!.decision.reason).toContain('api/.env');
    expect(hooks[0]!.decision.reason).toContain('검증할 수 없는 경로');
    // .env가 그대로 남아 있으므로 마지막 검증도 통과시키지 않는다
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('api/.env');
  });

  it('CLI가 내장 도구로 보호 경로를 직접 고쳐도 리뷰 단계가 막는다(도구 쪽에서 막을 기회가 없다)', async () => {
    // 러너 방식은 b-studio의 쓰기 도구가 보호 경로를 먼저 거절한다. 관문 방식의 CLI는 그 도구를 거치지 않으므로 게이트가 유일한 자리다
    project = { ...project, spec: { ...project.spec, workflow: { protectedPaths: ['api/src'] } } } as LoadedProject;
    const { promise, log } = await run(
      [
        { writes: [{ file: 'api/src/Order.java', content: FIXED }], text: '끝냈습니다.' },
        { text: '보호 경로라 더 하지 않았습니다.', stop: false },
      ],
      [true, true, true],
    );
    const result = await promise;

    const { hooks } = await log();
    expect(hooks[0]!.decision.decision).toBe('block');
    expect(hooks[0]!.decision.reason).toContain('보호 경로');
    expect(result.status).toBe('failed');
    expect(result.passedStages).not.toContain('review');
  });

  it('게이트 재시도 상한을 다 쓰면 더 막지 않고 실패로 끝낸다', async () => {
    const { promise, log } = await run(
      [
        { writes: [{ file: 'api/src/Order.java', content: BROKEN }], text: '첫 시도' },
        { writes: [{ file: 'api/src/Order.java', content: `${BROKEN}// 2\n` }], text: '둘째 시도' },
        { writes: [{ file: 'api/src/Order.java', content: `${BROKEN}// 3\n` }], text: '셋째 시도' },
      ],
      [false, false, false],
      { maxVerifyAttempts: 2 },
    );
    const result = await promise;

    const { hooks } = await log();
    expect(hooks.map((hook) => hook.decision.decision)).toEqual(['block', undefined]);
    expect(result).toMatchObject({ status: 'failed', verifyAttempts: 2 });
    expect(result.summary).toContain('검증 게이트를 2번 통과하지 못했습니다');
  });

  it('CLI에는 파일 도구만 열고 Bash는 주지 않는다. b-studio 도구는 샌드박스 도구만 MCP로 내주고, 토큰은 파일에 쓰지 않는다', async () => {
    const { promise, log } = await run([{ writes: [{ file: 'api/src/Order.java', content: FIXED }], text: '끝냈습니다.' }], [true]);
    await promise;
    const { args, env, settings, mcp } = await log();

    const valueOf = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain('--strict-mcp-config');
    expect(valueOf('--tools')!.split(',')).toEqual([...GATEWAY_BUILTIN_TOOLS]);
    expect(GATEWAY_BUILTIN_TOOLS).not.toContain('Bash');
    expect(valueOf('--output-format')).toBe('stream-json');
    // 요청 글 끝에 언어 알림이 붙는다(트러블슈팅 132)
    expect(valueOf('-p')).toContain('주문에 메모 필드 추가');
    expect(valueOf('-p')).toContain('한국어로');

    const specs = gatewayToolSpecs(project).map((spec) => spec.name);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((name) => SANDBOX_TOOLS.has(name))).toBe(true);
    expect(specs.some((name) => WRITE_TOOLS.has(name))).toBe(false);

    // 토큰은 환경 변수로만 넘어간다
    expect(env).toEqual({ gate: true, mcp: true });
    expect(mcp).toContain('${B_STUDIO_MCP_TOKEN}');
    expect(settings).toContain('$B_STUDIO_GATE_TOKEN');
    expect(JSON.parse(settings).hooks.Stop[0].hooks[0].timeout).toBeGreaterThanOrEqual(1800);
  });

  it('턴 상한으로 끝난 실행은 마지막 검증의 결과를 따른다 (ADR-131)', async () => {
    const { promise } = await run([{ writes: [{ file: 'api/src/Order.java', content: FIXED }], text: '하던 중', stop: false }], [true], { scenario: { resultSubtype: 'error_max_turns' } });
    const result = await promise;
    expect(result.status).toBe('done');
    expect(result.summary).toContain('최대 턴 수');
  });

  it('취소하면 CLI를 끝내고 취소 사유를 던진다', async () => {
    const controller = new AbortController();
    const { promise } = await run([{ writes: [{ file: 'api/src/Order.java', content: FIXED }], text: '하는 중', hang: true }], [true], { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('사용자가 취소했습니다')), 400);
    await expect(promise).rejects.toThrow('사용자가 취소했습니다');
  });

  it('질문 모드는 받지 않는다', async () => {
    await expect(
      runClaudeGatewayAgent({ request: '설명해 줘', project, sandbox: fakeSandbox(project, []), pendingFiles, intent: 'ask', cliCommand: [process.execPath, cliPath] }),
    ).rejects.toThrow('질문 모드');
  });
});
