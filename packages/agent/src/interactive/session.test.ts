import { appendFileSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRequest, ModelClient } from '../agent-types';
import { ScriptedModelClient, type ScriptedTurn } from '../scripted-client';
import { runInteractiveSession } from './session';

/**
 * 대화형 에이전트 코어의 시험. 바깥 계약은 fake-claude-agent.test.ts와 같은 방식으로 고정한다:
 * 기록용 진짜 훅 명령(순서·입력을 한 파일에 적고 시험이 정한 답을 준다)과 가짜 텔레메트리 서버, 임시 폴더
 */
interface Line {
  kind: 'hook' | 'telemetry';
  event?: string;
  input?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
}

let dir: string;
let work: string;
let server: http.Server;
let order: string;
let replies: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'interactive-session-'));
  work = path.join(dir, 'work');
  await mkdir(work);
  order = path.join(dir, 'order.jsonl');
  replies = path.join(dir, 'replies.json');
  await writeFile(order, '');
  await writeFile(replies, '{}');
  await writeFile(
    path.join(dir, 'hook.mjs'),
    `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const event = process.argv[2];
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(order)}, JSON.stringify({ kind: 'hook', event, input: JSON.parse(input) }) + '\\n');
  const all = JSON.parse(readFileSync(${JSON.stringify(replies)}, 'utf8'));
  const answer = (all[event] ?? []).shift();
  writeFileSync(${JSON.stringify(replies)}, JSON.stringify(all));
  process.stdout.write(answer === undefined ? '' : JSON.stringify(answer));
});
`,
  );
  server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      appendFileSync(order, `${JSON.stringify({ kind: 'telemetry', headers: request.headers, body: JSON.parse(body) })}\n`);
      response.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await writeSettings();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const hook = (event: string, extra: Record<string, unknown> = {}) => ({ ...extra, hooks: [{ type: 'command', command: `'${process.execPath}' '${path.join(dir, 'hook.mjs')}' ${event}`, timeout: 20 }] });

async function writeSettings(overrides: Record<string, unknown> = {}) {
  await writeFile(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/logs`, OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'Authorization=Bearer tok-1' },
      hooks: {
        SessionStart: [hook('session-start')],
        UserPromptSubmit: [hook('prompt')],
        PreToolUse: [hook('pre-tool', { matcher: '^(?!(?:Read|Glob)$).+' }), hook('activity', { matcher: '^(?:Read|Glob)$' })],
        Stop: [hook('stop')],
      },
      ...overrides,
    }),
  );
}

const reply = (answers: Record<string, unknown[]>) => writeFile(replies, JSON.stringify(answers));

const writeThenStop: ScriptedTurn[] = [{ toolCalls: [{ name: 'Write', input: { file_path: 'app/a.txt', content: '쓴 내용\n' } }] }, { text: '고쳤습니다.' }];

/** 사용량을 정해 주는 대본 모델(ScriptedModelClient는 사용량이 0이다) */
class UsageClient implements ModelClient {
  readonly #inner: ScriptedModelClient;
  calls = 0;
  constructor(
    turns: ScriptedTurn[],
    readonly usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 },
  ) {
    this.#inner = new ScriptedModelClient(turns);
  }
  get requests(): AgentRequest[] {
    return this.#inner.requests;
  }
  async createMessage(request: AgentRequest): Promise<Anthropic.Beta.BetaMessage> {
    this.calls++;
    const message = await this.#inner.createMessage(request);
    return { ...message, usage: this.usage } as Anthropic.Beta.BetaMessage;
  }
}

interface RunOptions {
  client?: ModelClient;
  turns?: ScriptedTurn[];
  args?: string[];
  input?: string[];
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  maxModelCalls?: number;
}

async function run(options: RunOptions) {
  const client = options.client ?? new ScriptedModelClient(options.turns ?? writeThenStop);
  const stdin = new PassThrough();
  let stdout = '';
  const out = new Writable({
    write(chunk, _encoding, done) {
      stdout += chunk;
      done();
    },
  });
  const done = runInteractiveSession({
    args: ['--mcp-config', 'm.json', '--settings', path.join(dir, 'settings.json'), ...(options.args ?? [])],
    cwd: work,
    client,
    stdin,
    stdout: out,
    pricing: options.pricing,
    maxModelCalls: options.maxModelCalls,
  });
  for (const piece of options.input ?? []) {
    stdin.write(piece);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  stdin.end();
  await done;
  const lines = (await readFile(order, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Line);
  return { lines, stdout, client };
}

const names = (lines: Line[]) => lines.map((line) => (line.kind === 'hook' ? line.event : line.kind));
const file = (name: string) => readFileSync(path.join(work, name), 'utf8');
const attributesOf = (line: Line) =>
  Object.fromEntries((line.body as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ attributes: Array<{ key: string; value: Record<string, unknown> }> }> }> }> }).resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes.map((attribute) => [attribute.key, Object.values(attribute.value)[0]]));

describe('대화형 에이전트 코어(claude CLI와 같은 바깥 계약)', () => {
  it('첫 요청(마지막 인자): 세션 시작 → 요청 → 모델 → 텔레메트리 → 쓰기 직전 → 파일 → 모델 → 텔레메트리 → 턴 끝 순서', async () => {
    const { lines, stdout } = await run({ args: ['--model=m-1', '요청: 고쳐 주세요'] });
    expect(names(lines)).toEqual(['session-start', 'prompt', 'telemetry', 'pre-tool', 'telemetry', 'stop']);
    expect(file('app/a.txt')).toBe('쓴 내용\n');
    expect(lines.find((line) => line.event === 'prompt')!.input).toMatchObject({ prompt: '요청: 고쳐 주세요' });
    expect(stdout).toContain('고쳤습니다.');
    expect(stdout).toContain('Write');
  });

  it('훅 입력의 모양: 대화 id·작업 폴더·기록 경로·이벤트 이름과 이벤트별 칸', async () => {
    const { lines } = await run({ args: ['요청'] });
    const input = (event: string) => lines.find((line) => line.event === event)!.input!;
    const base = { session_id: 'conversation-1', cwd: work, transcript_path: '/dev/null' };
    expect(input('session-start')).toEqual({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
    expect(input('prompt')).toEqual({ ...base, hook_event_name: 'UserPromptSubmit', prompt: '요청' });
    expect(input('pre-tool')).toEqual({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(work, 'app/a.txt'), content: '쓴 내용\n' }, tool_use_id: 'toolu_1' });
    expect(input('stop')).toEqual({ ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '고쳤습니다.' });
  });

  it('텔레메트리: 설정의 끝점으로 머리글과 함께 api_request 로그를 보내고, 단가가 있으면 비용을 싣는다', async () => {
    const client = new UsageClient(writeThenStop);
    const { lines } = await run({ client, args: ['--model=m-1', '요청'], pricing: { inputPerMillion: 3, outputPerMillion: 15 } });
    const sent = lines.filter((line) => line.kind === 'telemetry');
    expect(sent).toHaveLength(2);
    expect(sent[0]!.headers).toMatchObject({ authorization: 'Bearer tok-1' });
    expect(attributesOf(sent[0]!)).toMatchObject({
      'event.name': 'api_request',
      model: 'm-1',
      input_tokens: '1000',
      output_tokens: '500',
      cache_read_tokens: '7',
      cache_creation_tokens: '3',
      cost_usd: (1000 * 3 + 500 * 15) / 1_000_000,
    });
    expect(attributesOf(sent[0]!).request_id).toMatch(/^msg_scripted_/);
    expect(typeof attributesOf(sent[0]!).duration_ms).toBe('string');
    expect(attributesOf(sent[0]!).request_id).not.toBe(attributesOf(sent[1]!).request_id);
  });

  it('단가가 없으면 cost_usd 칸을 보내지 않는다(0도 아니다)', async () => {
    const { lines } = await run({ client: new UsageClient(writeThenStop), args: ['요청'] });
    const sent = lines.filter((line) => line.kind === 'telemetry');
    expect(sent.length).toBeGreaterThan(0);
    for (const line of sent) expect(Object.keys(attributesOf(line))).not.toContain('cost_usd');
  });

  it('끝점이 없으면 조용히 건너뛰고, 끝점이 죽어 있어도 루프는 끝까지 간다', async () => {
    await writeSettings({ env: {} });
    const none = await run({ args: ['요청'] });
    expect(names(none.lines)).toEqual(['session-start', 'prompt', 'pre-tool', 'stop']);
    await writeFile(order, '');
    await writeSettings({ env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://127.0.0.1:1/v1/logs' } });
    const dead = await run({ args: ['요청'] });
    expect(names(dead.lines)).toEqual(['session-start', 'prompt', 'pre-tool', 'stop']);
    expect(file('app/a.txt')).toBe('쓴 내용\n');
  });

  it('쓰기 직전 훅이 거절(permissionDecision: deny)하면 파일을 쓰지 않고, 거절 사유를 is_error 도구 결과로 모델에 돌려준다', async () => {
    await reply({ 'pre-tool': [{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '범위 밖' } }] });
    const client = new ScriptedModelClient(writeThenStop);
    const { lines } = await run({ client, args: ['요청'] });
    expect(() => file('app/a.txt')).toThrow();
    const second = client.requests[1]!.messages.at(-1)!;
    expect(second.content).toEqual([{ type: 'tool_result', tool_use_id: expect.any(String), content: '범위 밖', is_error: true }]);
    // 거절돼도 루프는 이어져 턴 끝까지 간다
    expect(names(lines).at(-1)).toBe('stop');
    // 거절이 아니면 쓴다
    await reply({ 'pre-tool': [{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }] });
    await run({ args: ['요청'] });
    expect(file('app/a.txt')).toBe('쓴 내용\n');
  });

  it('Bash: 훅은 claude와 같은 입력 모양으로 불리고, 허용하면 작업 폴더에서 실행하며, 거절하면 실행하지 않는다', async () => {
    const turns: ScriptedTurn[] = [{ toolCalls: [{ name: 'Bash', input: { command: 'printf hi > bash.txt', timeout: 5000, description: '파일 만들기' } }] }, { text: '끝' }];
    const first = await run({ turns, args: ['요청'] });
    expect(first.lines.find((line) => line.event === 'pre-tool')!.input).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'printf hi > bash.txt', timeout: 5000, description: '파일 만들기' } });
    expect(file('bash.txt')).toBe('hi');
    await rm(path.join(work, 'bash.txt'));
    await reply({ 'pre-tool': [{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '명령 거절' } }] });
    const client = new ScriptedModelClient(turns);
    await run({ client, args: ['요청'] });
    expect(() => file('bash.txt')).toThrow();
    expect(client.requests[1]!.messages.at(-1)!.content).toEqual([{ type: 'tool_result', tool_use_id: expect.any(String), content: '명령 거절', is_error: true }]);
  });

  it('화면에는 제어 문자를 지운 글만 쓴다(도구 입력·출력과 모델의 글). Bash는 file_path를 함께 보내도 명령을 보인다', async () => {
    const turns: ScriptedTurn[] = [
      { toolCalls: [{ name: 'Bash', input: { command: 'printf "\\033]52;c;aGk=\\007\\033[2J"; exit 4', file_path: 'docs/ok.md' } }] },
      { text: '끝\u001b[2J\u009b31m 줄\n다음 줄' },
    ];
    await reply({ 'pre-tool': [{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }] });
    const { stdout } = await run({ turns, args: ['요청'] });
    expect(stdout).not.toMatch(/[\u001b\u009b\u0007]/);
    expect(stdout).toContain('Bash printf');
    expect(stdout).not.toContain('Bash docs/ok.md');
    expect(stdout).toContain('끝[2J31m 줄\n다음 줄');
  });

  it('matcher가 `*`이거나 비면 모든 도구에 맞고, 정규식은 도구 이름 전체에 맞춘다', async () => {
    const command = (event: string) => hook(event).hooks[0]!;
    await writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: '*', hooks: [command('pre-tool')] },
          { matcher: '', hooks: [command('activity')] },
          { matcher: 'Writ', hooks: [command('never')] },
        ],
      },
    });
    const { lines } = await run({ args: ['요청'] });
    expect(names(lines).filter((name) => name !== undefined && ['pre-tool', 'activity', 'never'].includes(name))).toEqual(['pre-tool', 'activity']);
    expect(file('app/a.txt')).toBe('쓴 내용\n');
  });

  it('읽기 도구(Read/Glob)는 읽기용 훅(activity)만 부른다', async () => {
    await writeFile(path.join(work, 'x.txt'), '내용');
    const { lines } = await run({ turns: [{ toolCalls: [{ name: 'Read', input: { file_path: 'x.txt' } }] }, { text: '읽음' }], args: ['요청'] });
    expect(names(lines)).toEqual(['session-start', 'prompt', 'telemetry', 'activity', 'telemetry', 'stop']);
    expect(lines.find((line) => line.event === 'activity')!.input).toMatchObject({ tool_name: 'Read', tool_input: { file_path: path.join(work, 'x.txt') } });
  });

  it('Stop 훅이 decision: block으로 답하면 사유를 모델에 돌려 이어가고(stop_hook_active: true), 아니면 끝낸다', async () => {
    await reply({ stop: [{ decision: 'block', reason: '검증 실패' }] });
    const client = new ScriptedModelClient([{ toolCalls: [{ name: 'Write', input: { file_path: 'a.txt', content: '1' } }] }, { text: '첫 시도' }, { toolCalls: [{ name: 'Write', input: { file_path: 'a.txt', content: '2' } }] }, { text: '다시' }, { text: '안 불림' }]);
    const { lines } = await run({ client, args: ['요청'] });
    expect(names(lines).filter((name) => name !== 'telemetry')).toEqual(['session-start', 'prompt', 'pre-tool', 'stop', 'pre-tool', 'stop']);
    expect(lines.filter((line) => line.event === 'stop').map((line) => line.input!.stop_hook_active)).toEqual([false, true]);
    expect(file('a.txt')).toBe('2');
    expect(client.remainingTurns).toBe(1);
    // 막은 사유가 사용자 메시지로 모델에 간다
    expect(client.requests[2]!.messages.at(-1)).toEqual({ role: 'user', content: '검증 실패' });
  });

  it('UserPromptSubmit 훅이 decision: block으로 답하면 모델을 부르지 않고 사유를 보인다', async () => {
    await reply({ prompt: [{ decision: 'block', reason: '지금은 받지 않음' }] });
    const client = new ScriptedModelClient(writeThenStop);
    const { lines, stdout } = await run({ client, args: ['요청'] });
    expect(names(lines)).toEqual(['session-start', 'prompt']);
    expect(client.requests).toHaveLength(0);
    expect(stdout).toContain('지금은 받지 않음');
  });

  it('붙여 넣기(bracketed paste)와 그 뒤 Enter를 알아보고 그 글로 요청한다: 여러 줄, 조각난 표식, 빈 Enter는 무시', async () => {
    const { lines } = await run({ input: ['\r', '\x1b[20', '0~첫 줄\n둘째 줄\x1b[201', '~', '\r'] });
    expect(names(lines)).toEqual(['session-start', 'prompt', 'telemetry', 'pre-tool', 'telemetry', 'stop']);
    expect(lines.find((line) => line.event === 'prompt')!.input).toMatchObject({ prompt: '첫 줄\n둘째 줄' });
  });

  it('Enter 없이 붙여 넣기만 하면 요청하지 않는다. 요청 둘이 이어 오면 차례로 처리한다(대화가 이어진다)', async () => {
    const only = await run({ input: ['\x1b[200~보내지 않음\x1b[201~'] });
    expect(names(only.lines)).toEqual(['session-start']);
    await writeFile(order, '');
    const client = new ScriptedModelClient([{ text: '하나 끝' }, { text: '둘 끝' }]);
    const two = await run({ client, input: ['\x1b[200~하나\x1b[201~\r\x1b[200~둘\x1b[201~\r'] });
    expect(two.lines.filter((line) => line.event === 'prompt').map((line) => line.input!.prompt)).toEqual(['하나', '둘']);
    expect(names(two.lines).filter((name) => name !== 'telemetry')).toEqual(['session-start', 'prompt', 'stop', 'prompt', 'stop']);
    expect(client.requests[1]!.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('첫 요청(인자)과 붙여 넣은 요청이 함께 오면 인자 요청이 먼저다', async () => {
    const client = new ScriptedModelClient([{ text: '하나' }, { text: '둘' }]);
    const { lines } = await run({ client, args: ['인자 요청'], input: ['\x1b[200~붙인 요청\x1b[201~\r'] });
    expect(lines.filter((line) => line.event === 'prompt').map((line) => line.input!.prompt)).toEqual(['인자 요청', '붙인 요청']);
  });

  it('요청 하나의 모델 호출 상한에 닿으면 멈추고 알린다(Stop은 부르지 않는다)', async () => {
    const loop = Array.from({ length: 10 }, () => ({ toolCalls: [{ name: 'Glob', input: { pattern: '*' } }] }));
    const client = new ScriptedModelClient(loop);
    const { lines, stdout } = await run({ client, args: ['요청'], maxModelCalls: 3 });
    expect(client.requests).toHaveLength(3);
    expect(stdout).toContain('상한(3회)');
    expect(names(lines)).not.toContain('stop');
  });

  it('모델 호출이 던져도 세션은 죽지 않고 알린 뒤 다음 요청을 받는다', async () => {
    const client = new ScriptedModelClient([{ text: '둘째만 남음' }]);
    let first = true;
    const flaky: ModelClient = {
      createMessage: async (request) => {
        if (first) {
          first = false;
          throw new Error('네트워크 끊김');
        }
        return client.createMessage(request);
      },
    };
    const { stdout, lines } = await run({ client: flaky, input: ['\x1b[200~하나\x1b[201~\r\x1b[200~둘\x1b[201~\r'] });
    expect(stdout).toContain('네트워크 끊김');
    expect(names(lines).filter((name) => name === 'stop')).toHaveLength(1);
  });

  it('작업 폴더 밖 쓰기는 훅이 허용해도 실행에서 거절되고(is_error), 훅은 시도를 본다', async () => {
    await mkdir(path.join(dir, 'outside'));
    await symlink(path.join(dir, 'outside'), path.join(work, 'dirlink'));
    const turns: ScriptedTurn[] = [
      { toolCalls: [{ name: 'Write', input: { file_path: '../outside/a.txt', content: 'x' } }, { name: 'Write', input: { file_path: 'dirlink/b.txt', content: 'x' } }] },
      { text: '끝' },
    ];
    const client = new ScriptedModelClient(turns);
    const { lines } = await run({ client, args: ['요청'] });
    expect(lines.filter((line) => line.event === 'pre-tool')).toHaveLength(2);
    const results = client.requests[1]!.messages.at(-1)!.content as Array<{ is_error?: boolean }>;
    expect(results.map((result) => result.is_error)).toEqual([true, true]);
    await expect(readFile(path.join(dir, 'outside/a.txt'))).rejects.toThrow();
    await expect(readFile(path.join(dir, 'outside/b.txt'))).rejects.toThrow();
  });
});
