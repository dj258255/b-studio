import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentCliScript } from './harness';

/**
 * 스스로 훅을 부르는 가짜 CLI(`fake-claude-agent.mjs`)의 단위 시험(#1358).
 * 진짜 관문 대신 기록용 가짜 훅 명령(순서·입력을 한 파일에 적고, 시험이 정한 답을 준다)과 가짜 텔레메트리 서버를 쓴다.
 * 이 가짜가 틀리면 Fleet·작업 분해의 기준 사진이 틀린 CLI 위에 서므로, 순서와 입력의 모양을 여기서 따로 고정한다
 */
const FAKE = path.join(import.meta.dirname, 'fake-claude-agent.mjs');

interface Line {
  kind: 'hook' | 'telemetry';
  event?: string;
  input?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
}

let dir: string;
let server: http.Server;
let order: string;
let replies: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'fake-agent-'));
  await mkdir(path.join(dir, 'work'));
  order = path.join(dir, 'order.jsonl');
  replies = path.join(dir, 'replies.json');
  await writeFile(order, '');
  await writeFile(replies, '{}');
  // 가짜 훅 명령: 이벤트(argv[2])와 stdin 입력을 순서 파일에 적고, 이벤트의 답 목록에서 하나를 꺼내 stdout에 낸다(없으면 빈 줄)
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
  const hook = (event: string, extra: Record<string, unknown> = {}) => ({ ...extra, hooks: [{ type: 'command', command: `'${process.execPath}' '${path.join(dir, 'hook.mjs')}' ${event}`, timeout: 20 }] });
  await writeFile(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/logs`, OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'Authorization=Bearer tok-1' },
      hooks: {
        SessionStart: [hook('session-start')],
        UserPromptSubmit: [hook('prompt')],
        // 읽기 도구는 부르지 않는 쪽 matcher(진짜 설정과 같은 꼴): Write는 첫 항목에만 맞는다
        PreToolUse: [hook('pre-tool', { matcher: '^(?!(?:Read|Glob)$).+' }), hook('activity', { matcher: '^(?:Read|Glob)$' })],
        Stop: [hook('stop')],
      },
    }),
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const reply = (answers: Record<string, unknown[]>) => writeFile(replies, JSON.stringify(answers));

/** 가짜 CLI를 띄우고 `input`을 stdin으로 보낸 뒤(그리고 닫은 뒤) 끝나기를 기다린다. 순서 파일과 동작 기록을 돌려준다 */
async function run(script: AgentCliScript, args: string[], input: string[] = []): Promise<{ lines: Line[]; actions: Array<Record<string, unknown>>; launches: Array<{ args: string[]; cwd: string }>; stdout: string }> {
  await writeFile(path.join(dir, 'script.json'), JSON.stringify(script));
  const child = spawn(process.execPath, [FAKE, path.join(dir, 'launch.jsonl'), path.join(dir, 'actions.jsonl'), path.join(dir, 'script.json'), '--mcp-config', 'm.json', '--settings', path.join(dir, 'settings.json'), ...args], { cwd: path.join(dir, 'work') });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const exited = new Promise<void>((resolve) => child.on('close', () => resolve()));
  for (const piece of input) {
    child.stdin.write(piece);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  child.stdin.end();
  await exited;
  const jsonl = async (file: string) => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { lines: await jsonl(order), actions: await jsonl(path.join(dir, 'actions.jsonl')), launches: await jsonl(path.join(dir, 'launch.jsonl')), stdout };
}

const names = (lines: Line[]) => lines.map((line) => (line.kind === 'hook' ? line.event : line.kind));
const work = (file: string) => readFileSync(path.join(dir, 'work', file), 'utf8');

const writeThenStop: AgentCliScript = {
  scripts: [{ steps: [{ telemetry: { requestId: 'req_1', model: 'm-1', input: 10, output: 5, costUsd: 0.5 } }, { write: { path: 'app/a.txt', content: '쓴 내용\n' } }, { stop: { text: '고쳤습니다.' } }] }],
};

describe('가짜 CLI(스스로 훅을 부르는 판)', () => {
  it('--version과 auth status에는 터미널용 가짜와 같이 답한다', async () => {
    const out = (args: string[]) =>
      new Promise<string>((resolve) => {
        const child = spawn(process.execPath, [FAKE, 'l', 'a', 's', ...args]);
        let text = '';
        child.stdout.on('data', (chunk) => (text += chunk));
        child.on('close', () => resolve(text));
      });
    expect(await out(['--version'])).toBe('9.9.9 (fake)\n');
    expect(JSON.parse(await out(['auth', 'status']))).toMatchObject({ loggedIn: true, authMethod: 'claude.ai' });
  });

  it('첫 요청(마지막 인자): 세션 시작 → 요청 → 텔레메트리 → 쓰기 직전 → 파일 → 턴 끝 순서로 부르고, 받은 인자를 남긴다', async () => {
    const { lines, launches, actions } = await run(writeThenStop, ['--model=m-1', '요청: 고쳐 주세요']);
    // 텔레메트리가 쓰기 직전 훅보다 먼저다(서버는 텔레메트리 없이 쓰기 훅이 많으면 쓰기를 막는다)
    expect(names(lines)).toEqual(['session-start', 'prompt', 'telemetry', 'pre-tool', 'stop']);
    expect(launches[0]!.args).toEqual(['--mcp-config', 'm.json', '--settings', path.join(dir, 'settings.json'), '--model=m-1', '요청: 고쳐 주세요']);
    expect(work('app/a.txt')).toBe('쓴 내용\n');
    expect(actions.filter((action) => action.kind === 'paste')).toEqual([{ kind: 'paste', text: '요청: 고쳐 주세요', via: 'argv' }]);
  });

  it('훅 입력의 모양: 대화 id·작업 폴더·기록 경로·이벤트 이름과 이벤트별 칸(fakeCli()와 같은 꼴)', async () => {
    const { lines, launches } = await run(writeThenStop, ['요청']);
    const input = (event: string) => lines.find((line) => line.event === event)!.input!;
    const cwd = launches[0]!.cwd;
    const base = { session_id: 'conversation-1', cwd, transcript_path: '/dev/null' };
    expect(input('session-start')).toEqual({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
    expect(input('prompt')).toEqual({ ...base, hook_event_name: 'UserPromptSubmit', prompt: '요청' });
    expect(input('pre-tool')).toEqual({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'app/a.txt'), content: '쓴 내용\n' }, tool_use_id: 'toolu_1' });
    expect(input('stop')).toEqual({ ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: '고쳤습니다.' });
  });

  it('텔레메트리: 설정의 끝점으로 머리글(Authorization)과 함께 api_request 로그를 보낸다', async () => {
    const { lines } = await run(writeThenStop, ['요청']);
    const sent = lines.find((line) => line.kind === 'telemetry')!;
    expect(sent.headers).toMatchObject({ authorization: 'Bearer tok-1' });
    const attributes = (sent.body as { resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ attributes: Array<{ key: string; value: Record<string, unknown> }> }> }> }> }).resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes;
    expect(Object.fromEntries(attributes.map((attribute) => [attribute.key, Object.values(attribute.value)[0]]))).toEqual({
      'event.name': 'api_request',
      model: 'm-1',
      input_tokens: '10',
      output_tokens: '5',
      cache_read_tokens: '0',
      cache_creation_tokens: '0',
      cost_usd: 0.5,
      duration_ms: '100',
      request_id: 'req_1',
    });
  });

  it('쓰기 직전 훅이 거절(permissionDecision: deny)하면 파일을 쓰지 않고 기록에 거절로 남긴다. 거절이 아니면 쓴다', async () => {
    await reply({ 'pre-tool': [{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '범위 밖' } }] });
    const denied = await run(writeThenStop, ['요청']);
    expect(() => work('app/a.txt')).toThrow();
    expect(denied.actions.filter((action) => action.kind === 'write')).toEqual([{ kind: 'write', path: 'app/a.txt', denied: true }]);
    // 거절돼도 대본은 이어진다(모델이 다음에 무엇을 할지는 대본이 정한다)
    expect(names(denied.lines).at(-1)).toBe('stop');
    await reply({ 'pre-tool': [{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }] });
    await run(writeThenStop, ['요청']);
    expect(work('app/a.txt')).toBe('쓴 내용\n');
  });

  it('matcher가 `*`이거나 비면 모든 도구에 맞고(진짜 CLI와 같이), 정규식은 도구 이름 전체에 맞춘다', async () => {
    const settingsFile = path.join(dir, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    const command = (event: string) => settings.hooks.SessionStart[0].hooks[0].command.replace(/session-start$/, event);
    settings.hooks.PreToolUse = [
      { matcher: '*', hooks: [{ type: 'command', command: command('pre-tool'), timeout: 20 }] },
      { matcher: '', hooks: [{ type: 'command', command: command('activity'), timeout: 20 }] },
      { matcher: 'Writ', hooks: [{ type: 'command', command: command('never'), timeout: 20 }] },
    ];
    await writeFile(settingsFile, JSON.stringify(settings));
    const { lines, actions } = await run(writeThenStop, ['요청']);
    expect(actions.filter((action) => action.kind === 'error')).toEqual([]);
    expect(names(lines).filter((name) => name !== undefined && ['pre-tool', 'activity', 'never'].includes(name))).toEqual(['pre-tool', 'activity']);
    expect(work('app/a.txt')).toBe('쓴 내용\n');
  });

  it('Stop 훅이 decision: block으로 답하면 대본의 다음 단계로 이어가고(stop_hook_active: true), 아니면 남은 단계를 건너뛰고 끝낸다', async () => {
    const twoRounds: AgentCliScript = {
      scripts: [{ steps: [{ write: { path: 'a.txt', content: '1' } }, { stop: { text: '첫 시도' } }, { write: { path: 'a.txt', content: '2' } }, { stop: { text: '다시' } }, { write: { path: 'late.txt', content: 'x' } }, { stop: { text: '안 불림' } }] }],
    };
    await reply({ stop: [{ decision: 'block', reason: '검증 실패' }] });
    const blocked = await run(twoRounds, ['요청']);
    expect(names(blocked.lines)).toEqual(['session-start', 'prompt', 'pre-tool', 'stop', 'pre-tool', 'stop']);
    expect(blocked.lines.filter((line) => line.event === 'stop').map((line) => line.input!.stop_hook_active)).toEqual([false, true]);
    expect(work('a.txt')).toBe('2');
    expect(() => work('late.txt')).toThrow();
    expect(blocked.actions.at(-1)).toEqual({ kind: 'end', reason: 'stopped' });
  });

  it('붙여 넣기(bracketed paste)와 그 뒤 Enter를 알아보고 그 글로 요청한다: 여러 줄, 조각난 표식, 입력 줄이 빈 Enter는 무시', async () => {
    const { lines, actions } = await run(writeThenStop, [], ['\r', '\x1b[20', '0~첫 줄\n둘째 줄\x1b[201', '~', '\r']);
    expect(names(lines)).toEqual(['session-start', 'prompt', 'telemetry', 'pre-tool', 'stop']);
    expect(lines.find((line) => line.event === 'prompt')!.input).toMatchObject({ prompt: '첫 줄\n둘째 줄' });
    expect(actions.filter((action) => action.kind === 'paste')).toEqual([{ kind: 'paste', text: '첫 줄\n둘째 줄', via: 'paste' }]);
  });

  it('Enter 없이 붙여 넣기만 하면 요청하지 않는다. 요청 둘이 이어 오면 차례로 처리한다', async () => {
    const onlyPaste = await run(writeThenStop, [], ['\x1b[200~보내지 않음\x1b[201~']);
    expect(names(onlyPaste.lines)).toEqual(['session-start']);
    await writeFile(order, '');
    const two = await run({ scripts: [{ steps: [{ stop: { text: '끝' } }] }] }, [], ['\x1b[200~하나\x1b[201~\r\x1b[200~둘\x1b[201~\r']);
    expect(two.lines.filter((line) => line.event === 'prompt').map((line) => line.input!.prompt)).toEqual(['하나', '둘']);
    expect(names(two.lines)).toEqual(['session-start', 'prompt', 'stop', 'prompt', 'stop']);
  });

  it('대본은 모델 이름과 요청 글로 고른다: 처음 맞는 것. 맞는 것이 없으면 Stop 훅 없이 닫는다', async () => {
    const script: AgentCliScript = {
      scripts: [
        { match: { model: 'model-a' }, steps: [{ write: { path: 'a.txt', content: 'A' } }, { stop: { text: 'a' } }] },
        { match: { request: '카드 B' }, steps: [{ write: { path: 'b.txt', content: 'B' } }, { stop: { text: 'b' } }] },
      ],
    };
    await run(script, ['--model', 'model-a-2', '요청']);
    expect(work('a.txt')).toBe('A');
    await run(script, ['--model', 'other', '카드 B를 하세요']);
    expect(work('b.txt')).toBe('B');
    await writeFile(order, '');
    const none = await run(script, ['--model=other', '관계없는 요청']);
    expect(names(none.lines)).toEqual(['session-start', 'prompt']);
    expect(none.actions.at(-1)).toEqual({ kind: 'end', reason: 'no-script' });
  });
});
