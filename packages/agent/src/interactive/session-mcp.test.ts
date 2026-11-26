import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startToolServer, type ToolServer } from '../mcp-http-server';
import { ScriptedModelClient, type ScriptedTurn } from '../scripted-client';
import { runInteractiveSession } from './session';

/** MCP 도구가 세션 루프에 붙는 길: 모델 도구 목록, 쓰기 직전 훅(거절하면 서버를 부르지 않는다), 결과, 시작할 때 붙지 못하는 경우 */

let dir: string;
let work: string;
let server: ToolServer | undefined;
const served: Array<{ name: string; args: unknown }> = [];

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'session-mcp-'));
  work = path.join(dir, 'work');
  await mkdir(work);
  served.length = 0;
  server = await startToolServer({
    specs: [{ name: 'read_file', description: '파일을 읽는다', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] as never,
    run: async (name, args) => {
      served.push({ name, args });
      return { ok: true, content: `내용:${(args as { path?: string }).path}` };
    },
  });
});
afterEach(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeConfigs(denyMcp: boolean, address: { url: string; token: string } = { url: server!.url, token: server!.token }) {
  const log = path.join(dir, 'pre-tool.jsonl');
  writeFileSync(log, '');
  writeFileSync(
    path.join(dir, 'hook.mjs'),
    `import { appendFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const parsed = JSON.parse(input);
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(parsed) + '\\n');
  if (${JSON.stringify(denyMcp)} && parsed.tool_name.startsWith('mcp__')) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '관문이 막았습니다' } }));
});
`,
  );
  writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `'${process.execPath}' '${path.join(dir, 'hook.mjs')}'`, timeout: 20 }] }] } }));
  const mcp = path.join(dir, 'mcp.json');
  writeFileSync(mcp, JSON.stringify({ mcpServers: { 'b-studio': { type: 'http', url: address.url, headers: { Authorization: `Bearer ${address.token}` } } } }));
  chmodSync(mcp, 0o600);
  return { log, mcp };
}

async function run(turns: ScriptedTurn[], mcp: string) {
  const client = new ScriptedModelClient(turns);
  const stdin = new PassThrough();
  let stdout = '';
  const out = new Writable({
    write(chunk, _encoding, done) {
      stdout += chunk;
      done();
    },
  });
  const done = runInteractiveSession({ args: ['--mcp-config', mcp, '--settings', path.join(dir, 'settings.json'), '요청'], cwd: work, client, stdin, stdout: out });
  stdin.end();
  await done;
  return { client, stdout };
}

const lastToolResult = (client: ScriptedModelClient) => {
  const last = client.requests.at(-1)!.messages.at(-1)!.content as Array<{ type: string; content: string; is_error?: boolean }>;
  return last[0]!;
};

describe('자체 CLI의 MCP 도구', () => {
  it('모델 도구 목록에 mcp__서버__도구가 들고, 훅에는 claude와 같은 이름·입력으로 알리고, 결과를 모델에 돌려준다', async () => {
    const { log, mcp } = writeConfigs(false);
    const { client, stdout } = await run([{ toolCalls: [{ name: 'mcp__b-studio__read_file', input: { path: 'a.txt' } }] }, { text: '끝' }], mcp);
    expect(client.requests[0]!.tools.map((tool) => tool.name)).toContain('mcp__b-studio__read_file');
    expect(client.requests[0]!.tools.map((tool) => tool.name)).toContain('Bash');
    const hook = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(hook).toHaveLength(1);
    expect(hook[0]).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'mcp__b-studio__read_file', tool_input: { path: 'a.txt' }, tool_use_id: 'toolu_1' });
    expect(served).toEqual([{ name: 'read_file', args: { path: 'a.txt' } }]);
    expect(lastToolResult(client)).toMatchObject({ type: 'tool_result', content: '내용:a.txt' });
    expect(lastToolResult(client).is_error).toBeUndefined();
    expect(stdout).toContain('mcp__b-studio__read_file');
  });

  it('쓰기 직전 훅이 거절하면 서버의 tools/call을 부르지 않는다', async () => {
    const { mcp } = writeConfigs(true);
    const { client, stdout } = await run([{ toolCalls: [{ name: 'mcp__b-studio__read_file', input: { path: 'a.txt' } }] }, { text: '끝' }], mcp);
    expect(served).toEqual([]);
    expect(lastToolResult(client)).toMatchObject({ content: '관문이 막았습니다', is_error: true });
    expect(stdout).toContain('거절');
  });

  it('시작할 때 서버가 닫혀 있으면 이유를 화면에 적고 MCP 도구 없이 시작한다(그 이름의 호출은 알 수 없는 도구다)', async () => {
    const address = { url: server!.url, token: server!.token };
    await server!.close();
    server = undefined;
    const { log, mcp } = writeConfigs(false, address);
    const { client, stdout } = await run([{ toolCalls: [{ name: 'mcp__b-studio__read_file', input: { path: 'a.txt' } }] }, { text: '끝' }], mcp);
    expect(stdout).toMatch(/MCP 서버 b-studio에 연결하지 못해 그 도구 없이 시작합니다/);
    expect(stdout).not.toContain(address.token);
    expect(client.requests[0]!.tools.map((tool) => tool.name)).not.toContain('mcp__b-studio__read_file');
    expect(client.requests[0]!.tools.map((tool) => tool.name)).toContain('Read');
    expect(lastToolResult(client).is_error).toBe(true);
    // 알 수 없는 도구도 쓰기 직전 훅을 거친다(훅이 이름으로 판정한다)
    expect(readFileSync(log, 'utf8')).toContain('mcp__b-studio__read_file');
  });

  it('도구 호출이 실패해도 루프는 이어진다', async () => {
    const { mcp } = writeConfigs(false);
    const { client } = await run([{ toolCalls: [{ name: 'mcp__b-studio__read_file', input: {} }] }, { text: '끝' }], mcp);
    // path가 없는 입력은 서버의 입력 검사가 거절한다(도구 실패 결과). 세션은 모델에 결과를 돌려주고 끝난다
    expect(lastToolResult(client).is_error).toBe(true);
    expect(client.requests).toHaveLength(2);
  });
});
