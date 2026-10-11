import { execFile } from 'node:child_process';
import { readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LoadedProject } from '@b-studio/spec';
import { beforeEach, describe, expect, it } from 'vitest';
import { GATEWAY_BUILTIN_TOOLS, gatewayToolSpecs, guardBuiltinTool, runClaudeGatewayAgent, terminalGatewayNote } from './claude-gateway-runner';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT } from './test-helpers';
import { SANDBOX_TOOLS, WRITE_TOOLS } from './tools';
import { Workspace } from './workspace';

const execFileAsync = promisify(execFile);

/**
 * `claude` CLI처럼 행동하는 가짜. 모델을 부르지 않고 시나리오대로 파일을 직접 고친 뒤(내장 Edit·Write에 해당),
 * 멈출 때마다 --settings 파일의 Stop 훅 명령을 실제 CLI처럼 셸로 실행하고 그 출력(JSON)을 따른다.
 * 훅이 막으면({decision:'block'}) 사유를 받아 다음 회차로 넘어가고, 막지 않으면 끝낸다.
 */
const FAKE_CLI = String.raw`
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const scenario = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_SCENARIO, 'utf8'));
// 요청 글은 표준 입력으로 온다(진짜 CLI의 -p도 위치 인자가 없으면 표준 입력을 읽는다)
const prompt = readFileSync(0, 'utf8');
const settings = JSON.parse(readFileSync(valueOf('--settings'), 'utf8'));
const stopCommand = settings.hooks.Stop[0].hooks[0].command;
const preToolCommand = settings.hooks.PreToolUse[0].hooks[0].command;
const log = { args, prompt, systemPrompt: readFileSync(valueOf('--append-system-prompt-file'), 'utf8'), hooks: [], preTools: [], env: { gate: Boolean(process.env.B_STUDIO_GATE_TOKEN), mcp: Boolean(process.env.B_STUDIO_MCP_TOKEN) }, settings: readFileSync(valueOf('--settings'), 'utf8'), mcp: readFileSync(valueOf('--mcp-config'), 'utf8') };
const emit = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const write = (file, content, time) => {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(path.resolve(file), content);
  // time(초): 수정 시각을 정해진 값으로 맞춘다. 컨테이너 안 명령이 내용만 바꾸고 수정 시각을 되돌려 놓은 경우를 만든다
  if (time !== undefined) utimesSync(path.resolve(file), time, time);
};
const flush = () => writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(log));
// 진짜 CLI처럼 도구를 쓰기 직전에 PreToolUse 훅 명령을 셸로 실행하고, 거절(permissionDecision: deny)이면 도구를 쓰지 않는다
const preTool = (tool, input, broken) => {
  const hook = spawnSync('sh', ['-c', preToolCommand], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input }), env: broken ? { ...process.env, B_STUDIO_GATE_TOKEN: 'wrong' } : process.env, encoding: 'utf8' });
  let output = {};
  try { output = JSON.parse(hook.stdout || '{}'); } catch { output = { unparsed: hook.stdout }; }
  const decision = output.hookSpecificOutput?.permissionDecision;
  log.preTools.push({ tool, input, decision, reason: output.hookSpecificOutput?.permissionDecisionReason });
  return decision !== 'deny';
};

emit({ type: 'system', subtype: 'init', session_id: 'cli-session', model: 'test-model', claude_code_version: '9.9.9' });
let turns = 0;
let active = false;
let lastText = '';
for (const round of scenario.rounds) {
  for (const call of round.calls ?? []) preTool(call.tool, call.input, round.breakPreTool);
  // 링크는 CLI의 도구가 아니라 컨테이너 안 명령이 만든다(작업 복사본이 연결되어 있다). 훅을 거치지 않는다
  for (const link of round.links ?? []) symlinkSync(link.target, path.resolve(link.file));
  for (const item of round.writes ?? []) {
    // skipPreTool: 훅을 돌리지 않는 CLI를 흉내 낸다(훅이 빠져도 게이트가 막는지 보려고)
    if (round.skipPreTool || preTool('Write', { file_path: path.resolve(item.file), content: item.content }, round.breakPreTool)) write(item.file, item.content, item.time);
  }
  turns += 1;
  lastText = round.text ?? '';
  emit({ type: 'assistant', message: { id: 'msg-' + turns, content: [...(round.toolUses ?? []).map((name) => ({ type: 'tool_use', name, input: {} })), { type: 'text', text: lastText }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 } } });
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
  for (const item of round.writesAfterStop ?? []) write(item.file, item.content, item.time);
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
  writes?: Array<{ file: string; content: string; time?: number }>;
  text?: string;
  /** false면 훅을 부르지 않고 다음 회차로 간다(턴 상한·훅 실패로 훅 없이 끝나는 경우를 만든다) */
  stop?: boolean;
  /** 훅이 통과시킨 뒤에 파일을 더 바꾼다 */
  writesAfterStop?: Array<{ file: string; content: string; time?: number }>;
  /** 컨테이너 안 명령이 만든 것처럼 링크를 만든다(도구 호출 전 검사를 거치지 않는다) */
  links?: Array<{ file: string; target: string }>;
  /** 훅 명령이 인증에 실패하게 한다(게이트 서버에 닿지 못한 경우) */
  breakHook?: boolean;
  /** 이 회차에서 멈춰 기다린다(취소 시험) */
  hang?: boolean;
  /** 쓰지 않는 도구 호출(Read·Glob 등). PreToolUse 훅의 판정만 기록한다 */
  calls?: Array<{ tool: string; input: Record<string, unknown> }>;
  /** 모델이 낸 도구 호출 블록의 이름들(스트림에만 싣는다) */
  toolUses?: string[];
  /** 쓰기 전에 PreToolUse 훅을 돌리지 않는다(훅이 빠진 CLI) */
  skipPreTool?: boolean;
  /** PreToolUse 훅 명령이 검사 서버에 닿지 못하게 한다 */
  breakPreTool?: boolean;
}

interface FakeLog {
  args: string[];
  prompt: string;
  systemPrompt: string;
  hooks: Array<{ status: number | null; decision: { decision?: string; reason?: string } }>;
  preTools: Array<{ tool: string; input: Record<string, unknown>; decision?: string; reason?: string }>;
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

  it('도구 호출 전 검사를 지나친 변경이라도, 게이트가 검증할 수 없는 경로(.env)가 바뀌었으면 통과시키지 않는다', async () => {
    const { promise, log } = await run(
      [
        // 도구 호출 전 검사가 빠진 CLI라고 가정한다(skipPreTool). 그래도 게이트 쪽에서 막아야 한다
        { writes: [{ file: 'api/src/Order.java', content: FIXED }, { file: 'api/.env', content: 'TOKEN=abc\n' }], text: '끝냈습니다.', skipPreTool: true },
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
    const { args, prompt, systemPrompt, env, settings, mcp } = await log();

    const valueOf = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--restricted');
    expect(valueOf('--tools')!.split(',')).toEqual([...GATEWAY_BUILTIN_TOOLS]);
    expect(GATEWAY_BUILTIN_TOOLS).not.toContain('Bash');
    // 내장 도구는 허용 목록에 넣지 않는다. 넣으면 CLI가 경로와 무관하게 허용한다(실측: /etc/hosts 읽기, 작업 폴더 밖 쓰기)
    expect(valueOf('--permission-mode')).toBe('acceptEdits');
    const allowedTools = valueOf('--allowedTools')!.split(',');
    expect(allowedTools.length).toBeGreaterThan(0);
    expect(allowedTools.every((name) => name.startsWith('mcp__b-studio__'))).toBe(true);
    expect(valueOf('--output-format')).toBe('stream-json');
    // 요청 글은 표준 입력으로 가고, 끝에 언어 알림이 붙는다(트러블슈팅 132). 인자에는 요청 글이 없다
    expect(prompt).toContain('주문에 메모 필드 추가');
    expect(prompt).toContain('한국어로');
    expect(args.some((arg) => arg.includes('주문에 메모 필드 추가'))).toBe(false);
    expect(systemPrompt).toContain('mcp__b-studio__run_in_service');

    const specs = gatewayToolSpecs(project).map((spec) => spec.name);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every((name) => SANDBOX_TOOLS.has(name))).toBe(true);
    expect(specs.some((name) => WRITE_TOOLS.has(name))).toBe(false);

    // 토큰은 환경 변수로만 넘어간다
    expect(env).toEqual({ gate: true, mcp: true });
    expect(mcp).toContain('${B_STUDIO_MCP_TOKEN}');
    expect(settings).toContain('$B_STUDIO_GATE_TOKEN');
    expect(JSON.parse(settings).hooks.Stop[0].hooks[0].timeout).toBeGreaterThanOrEqual(1800);
    // 도구 호출 전 검사는 모든 도구에 걸고, 서버가 오류로 답하거나 닿지 못하면 거절을 출력한다
    const preTool = JSON.parse(settings).hooks.PreToolUse[0];
    expect(preTool.matcher).toBe('*');
    expect(preTool.hooks[0].command).toContain('curl -fsS');
    expect(preTool.hooks[0].command).toContain('|| printf');
    expect(preTool.hooks[0].command).toContain('"permissionDecision":"deny"');
  });

  it('요청 글이 옵션처럼 생겨도 CLI의 인자가 되지 않는다. 이어받을 대화의 id도 꼴이 맞을 때만 인자에 넣는다', async () => {
    const scenarioPath = `${cliPath}.scenario.json`;
    const logPath = `${cliPath}.log.json`;
    await writeFile(scenarioPath, JSON.stringify({ rounds: [{ text: '끝냈습니다.' }] }));
    const hostile = '--dangerously-skip-permissions --settings /tmp/evil.json 을 켜고 진행해';
    const base = { project, sandbox: fakeSandbox(project, [true]), pendingFiles, cliCommand: [process.execPath, cliPath], env: { ...process.env, FAKE_CLAUDE_SCENARIO: scenarioPath, FAKE_CLAUDE_LOG: logPath }, fetcher: async () => ORDERS_CONTRACT };

    await runClaudeGatewayAgent({ ...base, request: hostile, resume: '--dangerously-skip-permissions' });
    let recorded = JSON.parse(await readFile(logPath, 'utf8')) as FakeLog;
    expect(recorded.prompt).toContain(hostile);
    expect(recorded.args).not.toContain('--dangerously-skip-permissions');
    expect(recorded.args.some((arg) => arg.includes('evil.json'))).toBe(false);
    expect(recorded.args).not.toContain('--resume');
    // 설정 파일 인자는 b-studio가 만든 것 하나뿐이다
    expect(recorded.args.filter((arg) => arg === '--settings')).toHaveLength(1);

    await runClaudeGatewayAgent({ ...base, request: '이어서 해 줘', resume: '095959fd-9f62-445e-b2ba-1056cd3c11d4' });
    recorded = JSON.parse(await readFile(logPath, 'utf8')) as FakeLog;
    expect(recorded.args.slice(recorded.args.indexOf('--resume'), recorded.args.indexOf('--resume') + 3)).toEqual(['--resume', '095959fd-9f62-445e-b2ba-1056cd3c11d4', '--fork-session']);
  });

  it('CLI가 내장 도구로 프로젝트 밖·.git·.env·링크 너머를 건드리려 하면 도구를 쓰기 전에 거절한다', async () => {
    const outside = path.join(project.root, '..', `${path.basename(project.root)}-outside.txt`);
    await symlink(path.dirname(project.root), path.join(project.root, 'link-out'));
    const { promise, log, events } = await run(
      [
        {
          calls: [
            { tool: 'Read', input: { file_path: '/etc/hosts' } },
            { tool: 'Read', input: { file_path: path.join(project.root, 'link-out', 'anything.txt') } },
            { tool: 'Glob', input: { pattern: '**/*.pem', path: '/etc' } },
            { tool: 'Glob', input: { pattern: '../../**/*' } },
            { tool: 'Bash', input: { command: 'cat ~/.ssh/id_rsa' } },
            { tool: 'Read', input: { file_path: path.join(project.root, 'api/src/Order.java') } },
            { tool: 'Glob', input: { pattern: '**/*.java' } },
            { tool: 'mcp__b-studio__run_in_service', input: { service: 'api', command: ['ls'] } },
          ],
          writes: [
            { file: outside, content: 'x' },
            { file: '.git/config', content: '[core]\n\tfsmonitor = touch /tmp/pwned\n' },
            { file: '.git/b-studio-hooks/pre-commit', content: '#!/bin/sh\ntouch /tmp/pwned\n' },
            { file: 'api/.env', content: 'TOKEN=abc\n' },
            { file: 'api/src/Order.java', content: FIXED },
          ],
          text: '끝냈습니다.',
        },
      ],
      [true],
    );
    const before = await readFile(path.join(project.root, '.git/config'), 'utf8');
    const result = await promise;

    const { preTools } = await log();
    const decisionOf = (index: number) => preTools[index]!.decision;
    // 거절: 호스트 파일 읽기, 링크 너머, 프로젝트 밖 찾기, 위로 올라가는 패턴, 열지 않은 도구
    expect([0, 1, 2, 3, 4].map(decisionOf)).toEqual(['deny', 'deny', 'deny', 'deny', 'deny']);
    expect(preTools[1]!.reason).toContain('링크');
    // 통과: 프로젝트 안의 읽기·찾기, b-studio 도구
    expect([5, 6, 7].map(decisionOf)).toEqual([undefined, undefined, undefined]);
    // 쓰기: 밖·.git 둘·.env는 거절, 소스 파일만 통과
    expect(preTools.slice(8).map((entry) => entry.decision)).toEqual(['deny', 'deny', 'deny', 'deny', undefined]);

    await expect(stat(outside)).rejects.toThrow();
    await expect(stat(path.join(project.root, '.git/b-studio-hooks/pre-commit'))).rejects.toThrow();
    await expect(stat(path.join(project.root, 'api/.env'))).rejects.toThrow();
    expect(await readFile(path.join(project.root, '.git/config'), 'utf8')).toBe(before);
    // link-out은 이 테스트가 실행 전에 만들어 둔 링크다. 링크는 검증 대상으로 받지 않고, 실행 전부터 있던 것은 이번 실행의 탓으로 보지 않는다
    expect(result).toMatchObject({ status: 'done', changedFiles: ['api/src/Order.java'] });
    expect(events.filter((event) => event.type === 'warning')).toHaveLength(9);
  });

  it('게이트가 통과시킨 뒤 수정 시각과 크기를 그대로 두고 내용만 바꿔도 다시 검증한다', async () => {
    const same = FIXED.replace('memo', 'mema');
    expect(same.length).toBe(FIXED.length);
    // 두 판의 수정 시각을 초 단위의 같은 값으로 맞춘다(밀리초 아래 자리까지 같아야 수정 시각·크기 지문이 속는다)
    const time = 1_700_000_000;
    const { promise, sandbox } = await run(
      [{ writes: [{ file: 'api/src/Order.java', content: FIXED, time }], text: '끝냈습니다.', writesAfterStop: [{ file: 'api/src/Order.java', content: same, time }] }],
      [true, false],
    );
    const result = await promise;
    const info = await stat(path.join(project.root, 'api/src/Order.java'));
    expect([info.mtimeMs, info.size]).toEqual([time * 1000, FIXED.length]);

    // 지문이 수정 시각·크기였다면 "그대로"로 보고 첫 통과를 그대로 썼을 것이다
    expect(sandbox.restarts).toEqual(['api', 'api']);
    expect(result.status).toBe('failed');
  });

  it('실행 중에 프로젝트 안에 링크가 생기면(컨테이너 안 명령) 통과시키지 않는다', async () => {
    const { promise, log } = await run(
      [
        { writes: [{ file: 'api/src/Order.java', content: FIXED }], links: [{ file: 'api/src/Hosts.java', target: '/etc/hosts' }], text: '끝냈습니다.' },
        { text: '그대로 둡니다.', stop: false },
      ],
      [true, true, true],
    );
    const result = await promise;

    const { hooks } = await log();
    expect(hooks[0]!.decision.decision).toBe('block');
    expect(hooks[0]!.decision.reason).toContain('api/src/Hosts.java');
    expect(result.status).toBe('failed');
    expect(result.changedFiles).toEqual(['api/src/Order.java']);
  });

  it('도구 호출 전 검사에 닿지 못하면 도구를 쓰지 않는다(닫힌 쪽으로 실패)', async () => {
    const { promise, log } = await run([{ writes: [{ file: 'api/src/Order.java', content: FIXED }], text: '끝냈습니다.', breakPreTool: true }], [true]);
    const result = await promise;

    const { preTools } = await log();
    expect(preTools[0]).toMatchObject({ tool: 'Write', decision: 'deny' });
    expect(preTools[0]!.reason).toContain('경로 검사에 닿지 못해');
    expect(await readFile(path.join(project.root, 'api/src/Order.java'), 'utf8')).toBe('class Order { String customerNam; }\n');
    expect(result.changedFiles).toEqual([]);
  });

  it('내장 도구의 호출은 기록에 남기고, 열어 주지 않은 도구를 부르려 한 것은 호출로 세지 않고 경고로 남긴다', async () => {
    const { promise, events } = await run([{ toolUses: ['Read', 'Bash', 'mcp__b-studio__run_in_service'], writes: [{ file: 'api/src/Order.java', content: FIXED }], text: '끝냈습니다.' }], [true]);
    await promise;
    // b-studio 도구는 MCP 서버가 실제로 불렸을 때 남기므로 스트림의 블록으로는 세지 않는다
    expect(events.flatMap((event) => (event.type === 'tool_call' ? [event.name] : []))).toEqual(['Read']);
    expect(events.flatMap((event) => (event.type === 'warning' ? [event.message] : []))).toEqual(['모델이 이 세션에 없는 도구를 부르려 했습니다: Bash']);
  });

  it('턴 상한으로 끝난 실행은 마지막 검증의 결과를 따른다 (ADR-131)', async () => {
    const { promise } = await run([{ writes: [{ file: 'api/src/Order.java', content: FIXED }], text: '하던 중', stop: false }], [true], { scenario: { resultSubtype: 'error_max_turns' } });
    const result = await promise;
    expect(result.status).toBe('done');
    expect(result.summary).toContain('최대 턴 수');
    expect(result.incomplete).toBe('max_turns');
  });

  it('멈춤 훅이 이미 통과시킨 상태에서 턴 상한으로 끝나도 하다 만 것으로 표시한다', async () => {
    // 훅의 검증이 통과했고 그 뒤로 바뀐 것이 없으면 마지막 검증을 다시 돌리지 않는다. 그 길에서도 표시는 남아야 한다
    const { promise, sandbox } = await run([{ writes: [{ file: 'api/src/Order.java', content: FIXED }], text: '하던 중' }], [true], { scenario: { resultSubtype: 'error_max_turns' } });
    const result = await promise;
    expect(result.status).toBe('done');
    expect(result.incomplete).toBe('max_turns');
    expect(sandbox.restarts).toEqual(['api']);
  });

  it('취소하면 CLI를 끝내고 취소 사유를 던진다', async () => {
    const controller = new AbortController();
    const { promise } = await run([{ writes: [{ file: 'api/src/Order.java', content: FIXED }], text: '하는 중', hang: true }], [true], { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('사용자가 취소했습니다')), 400);
    await expect(promise).rejects.toThrow('사용자가 취소했습니다');
  });

  it('경로 검사는 CLI가 주는 절대 경로를 루트 기준으로 바꿔 파일 도구와 같은 규칙으로 본다', async () => {
    const workspace = new Workspace(project.root);
    const real = await realpath(project.root);
    const deniedReason = (tool: string, input: Record<string, unknown>) => guardBuiltinTool(workspace, tool, input);

    // 루트를 실제 위치(macOS의 /private/var/…)로 적어도 같은 파일로 본다
    expect(await deniedReason('Edit', { file_path: path.join(real, 'api/src/Order.java') })).toBeUndefined();
    expect(await deniedReason('Write', { file_path: path.join(project.root, 'api/src/New.java') })).toBeUndefined();
    expect(await deniedReason('Grep', { pattern: 'class', path: project.root, glob: '**/*.java' })).toBeUndefined();

    expect(await deniedReason('Write', { file_path: path.join(project.root, '.git/hooks/pre-commit') })).toContain('생성물이나 비밀 파일');
    expect(await deniedReason('Read', { file_path: path.join(project.root, '.GIT/config') })).toContain('생성물이나 비밀 파일');
    expect(await deniedReason('Write', { file_path: path.join(project.root, 'node_modules/x/index.js') })).toContain('생성물이나 비밀 파일');
    expect(await deniedReason('Read', { file_path: path.join(path.dirname(project.root), 'sibling.txt') })).toContain('프로젝트 밖');
    // CLI와 다르게 풀릴 수 있는 꼴은 받지 않는다: 상대 경로, 홈 폴더, 정리되지 않은 경로
    for (const file_path of ['api/src/Order.java', '~/.ssh/id_rsa', '~', `${project.root}/api/../../outside.txt`, `${project.root}/api/./src/Order.java`, `${project.root}//api/src/Order.java`, `${project.root}/api/src/`, ` ${project.root}/api/src/Order.java`]) {
      expect(await deniedReason('Read', { file_path }), file_path).toContain('정리된 절대 경로만');
    }
    expect(await deniedReason('Grep', { pattern: 'x', path: 'api' })).toContain('정리된 절대 경로만');
    // 찾기 패턴: 중괄호 갈래가 절대 경로·홈 폴더·위쪽을 가리키는 것도 거절한다
    for (const pattern of ['{/etc/passwd,x}', '{x,~/.ssh/*}', 'a/{b,../../c}/**', '{..,x}/y', '\\\\etc', '**/..']) {
      expect(await deniedReason('Glob', { pattern }), pattern).toContain('상대 패턴');
    }
    for (const pattern of ['**/*.{java,kt}', 'api/src/**', '*.md', 'a..b/**']) {
      expect(await deniedReason('Glob', { pattern }), pattern).toBeUndefined();
    }
    expect(await deniedReason('Write', { file_path: project.root })).toContain('루트 자체');
    expect(await deniedReason('Edit', {})).toContain('file_path가 없습니다');
    expect(await deniedReason('Read', { file_path: 42 })).toContain('읽지 못했습니다');
    expect(await deniedReason('Grep', { pattern: 'x', glob: '/etc/**' })).toContain('상대 패턴');
    expect(await deniedReason('Glob', { pattern: '~/.ssh/*' })).toContain('상대 패턴');
    expect(await deniedReason('NotebookEdit', { notebook_path: path.join(project.root, 'a.ipynb') })).toContain('쓸 수 없는 도구');
    expect(await deniedReason('WebFetch', { url: 'https://example.com' })).toContain('쓸 수 없는 도구');
    expect(await guardBuiltinTool(workspace, undefined, {})).toContain('도구 이름');
  });

  it('질문 모드는 받지 않는다', async () => {
    await expect(
      runClaudeGatewayAgent({ request: '설명해 줘', project, sandbox: fakeSandbox(project, []), pendingFiles, intent: 'ask', cliCommand: [process.execPath, cliPath] }),
    ).rejects.toThrow('질문 모드');
  });
});

describe('terminalGatewayNote (세션 터미널의 CLI가 대화를 시작할 때 받는 글, 이슈 #673)', () => {
  it('서비스가 이 컨테이너에서 돌지 않는다는 것, 쓸 도구, 커밋하지 않는다는 것, 검증 결과가 돌아오는 꼴을 알린다', async () => {
    const project = await createOrdersProject('b-studio-terminal-note-');
    const note = terminalGatewayNote(project);
    expect(project.managed.length).toBeGreaterThan(0);
    for (const [name] of project.managed) expect(note).toContain(name);
    for (const spec of gatewayToolSpecs(project)) expect(note).toContain(`mcp__b-studio__${spec.name}`);
    expect(note).toContain('커밋하지 않는다');
    expect(note).toContain('Stop hook feedback');
    // 훅의 덧붙임은 길이 상한이 있다(1만 자). 넉넉히 아래에 둔다
    expect(note.length).toBeLessThan(3000);
  });
});
