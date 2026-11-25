import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/** 진짜 진입점 프로세스를 띄워 훅·텔레메트리·모델 호출이 계약대로 맞물리는지 본다(가짜 모델 서버, 임시 폴더, 127.0.0.1) */
const root = path.resolve(import.meta.dirname, '../../../..');
const tsx = path.join(root, 'node_modules/tsx/dist/cli.mjs');
const entry = path.join(root, 'apps/cli/src/agent-tty.ts');
const KEY = 'sk-test-secret-123';

let dir: string;
let work: string;
let log: string;
let telemetry: http.Server;
let provider: http.Server;
let authHeaders: string[];
let telemetryBodies: any[];

async function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}
const portOf = (server: http.Server) => (server.address() as AddressInfo).port;
const readBody = (request: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => resolve(body));
  });

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'agent-tty-'));
  work = path.join(dir, 'work');
  await mkdir(work);
  log = path.join(dir, 'hooks.jsonl');
  await writeFile(log, '');
  authHeaders = [];
  telemetryBodies = [];
  telemetry = await listen(async (request, response) => {
    telemetryBodies.push(JSON.parse(await readBody(request)));
    response.writeHead(200).end('{}');
  });
  provider = await listen(async (request, response) => {
    const send = (body: unknown) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return void response.writeHead(404).end('{}');
    authHeaders.push(String(request.headers.authorization));
    const body = JSON.parse(await readBody(request)) as { messages: Array<{ role: string }> };
    if (!body.messages.some((message) => message.role === 'tool')) {
      return send({
        id: 'm1',
        model: 'fake-model',
        choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: 'notes/hello.txt', content: 'hi\n' }) } }] } }],
        usage: { prompt_tokens: 1000, completion_tokens: 100 },
      });
    }
    send({ id: 'm2', model: 'fake-model', choices: [{ finish_reason: 'stop', message: { content: '끝냈습니다' } }], usage: { prompt_tokens: 2000, completion_tokens: 50 } });
  });
  await writeFile(
    path.join(dir, 'hook.mjs'),
    `import { appendFileSync } from 'node:fs';
const event = process.argv[2];
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ event, input: JSON.parse(input) }) + '\\n');
  if (event === 'PreToolUse') process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }));
  else process.stdout.write('{}');
});
`,
  );
  const hook = (event: string) => [{ hooks: [{ type: 'command', command: `'${process.execPath}' '${path.join(dir, 'hook.mjs')}' ${event}`, timeout: 20 }] }];
  await writeFile(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${portOf(telemetry)}/v1/logs` },
      hooks: { SessionStart: hook('SessionStart'), UserPromptSubmit: hook('UserPromptSubmit'), PreToolUse: hook('PreToolUse'), Stop: hook('Stop') },
    }),
  );
});

afterEach(async () => {
  await Promise.all([telemetry, provider].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await rm(dir, { recursive: true, force: true });
});

function writeModel(mode: number) {
  const file = path.join(dir, 'agent-model.json');
  writeFileSync(
    file,
    JSON.stringify({
      profile: { id: 'fake', provider: 'openai', model: 'fake-model', label: 'Fake', capabilities: ['tools'], contextWindow: 32000, pricing: { inputPerMillion: 1, outputPerMillion: 2 }, baselineQuality: 0.8, baselineLatencyMs: 100, baseUrl: `http://127.0.0.1:${portOf(provider)}/v1` },
      apiKey: KEY,
    }),
  );
  chmodSync(file, mode);
}

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    const child = spawn(process.execPath, [tsx, entry, ...args], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    // 첫 요청을 인자로 주었으므로 stdin을 닫아 세션을 끝낸다
    child.stdin.end();
  });
}

const hooksLog = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { event: string; input: Record<string, any> });

describe('agent-tty 진입점 프로세스', () => {
  it('--version은 버전 줄을 찍고 0으로 끝난다', async () => {
    const result = await run(['--version']);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+ \(b-studio agent\)\n$/);
  }, 60_000);

  it('모델 파일의 모델로 훅·도구·텔레메트리가 맞물려 돈다', async () => {
    writeModel(0o600);
    const result = await run(['--settings', path.join(dir, 'settings.json'), 'notes/hello.txt를 만들어줘']);
    expect(result.code).toBe(0);
    expect(readFileSync(path.join(work, 'notes/hello.txt'), 'utf8')).toBe('hi\n');
    const calls = hooksLog();
    expect(calls.map((call) => call.event)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']);
    const pre = calls[2]!.input;
    expect(pre.tool_name).toBe('Write');
    expect(path.isAbsolute(pre.tool_input.file_path)).toBe(true);
    expect(pre.tool_input.file_path.endsWith(path.join('notes', 'hello.txt'))).toBe(true);
    // 모델 서버에는 모델 파일의 키가 갔다
    expect(authHeaders).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
    // 비용은 프로필 단가에서: (1000*1 + 100*2)/1e6, (2000*1 + 50*2)/1e6
    const attrs = telemetryBodies.map((body) => Object.fromEntries(body.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map((a: any) => [a.key, a.value])));
    expect(attrs.map((a) => a.cost_usd.doubleValue)).toEqual([0.0012, 0.0021]);
    expect(result.stdout).not.toContain(KEY);
    expect(result.stderr).not.toContain(KEY);
    expect(JSON.stringify(telemetryBodies)).not.toContain(KEY);
  }, 60_000);

  it('권한이 600이 아닌 모델 파일이면 훅을 부르지 않고 1로 끝난다', async () => {
    writeModel(0o644);
    const result = await run(['--settings', path.join(dir, 'settings.json'), '만들어줘']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('권한이 600이 아닙니다');
    expect(result.stderr).not.toContain(KEY);
    expect(existsSync(path.join(work, 'notes'))).toBe(false);
    expect(hooksLog()).toEqual([]);
    expect(telemetryBodies).toEqual([]);
    expect(authHeaders).toEqual([]);
  }, 60_000);

  it('모델 파일의 설정이 올바르지 않으면 훅을 부르지 않고 1로 끝난다', async () => {
    writeModel(0o600);
    const file = path.join(dir, 'agent-model.json');
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    parsed.profile.provider = 'nope';
    writeFileSync(file, JSON.stringify(parsed));
    const result = await run(['--settings', path.join(dir, 'settings.json'), '만들어줘']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('모델 설정이 올바르지 않습니다');
    expect(hooksLog()).toEqual([]);
  }, 60_000);
});
