import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startToolServer, type ToolServer } from '../mcp-http-server';
import type { ToolOutcome } from '../tools';
import { connectMcpServers, mapMcpResult, mcpToolName, readMcpConfig, McpConfigError, type McpTools } from './mcp';

const SPECS = [
  { name: 'echo', description: '그대로 돌려준다', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'big', description: '아주 긴 글', input_schema: { type: 'object', properties: {} } },
  { name: 'fail', description: '실패', input_schema: { type: 'object', properties: {} } },
  { name: 'slow', description: '느림', input_schema: { type: 'object', properties: {} } },
  { name: 'read.file', description: '이름에 점', input_schema: { type: 'object', properties: {} } },
] as never;

let dir: string;
let file: string;
const servers: ToolServer[] = [];
const rawServers: http.Server[] = [];
const connected: McpTools[] = [];
const calls: Array<{ name: string; args: unknown }> = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mcp-config-'));
  file = path.join(dir, 'mcp.json');
  calls.length = 0;
});
afterEach(async () => {
  for (const tools of connected.splice(0)) await tools.close();
  for (const server of servers.splice(0)) await server.close();
  for (const server of rawServers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

function write(content: unknown, mode = 0o600) {
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  chmodSync(file, mode);
}

async function startServer(run?: (name: string, args: unknown) => Promise<ToolOutcome>): Promise<ToolServer> {
  const server = await startToolServer({
    specs: SPECS,
    run:
      run ??
      (async (name, args) => {
        calls.push({ name, args });
        if (name === 'big') return { ok: true, content: 'x'.repeat(200_000) };
        if (name === 'fail') return { ok: false, content: '일부러 실패' };
        if (name === 'slow') await new Promise((resolve) => setTimeout(resolve, 3000));
        return { ok: true, content: `받음: ${JSON.stringify(args)}` };
      }),
  });
  servers.push(server);
  return server;
}
const configFor = (server: ToolServer, name = 'b-studio') => ({ mcpServers: { [name]: { type: 'http', url: server.url, headers: { Authorization: `Bearer ${server.token}` } } } });

async function connect(options: Partial<Parameters<typeof connectMcpServers>[1]> = {}) {
  const notices: string[] = [];
  const tools = await connectMcpServers([file], { notice: (line) => notices.push(line), ...options });
  connected.push(tools);
  return { tools, notices };
}

describe('MCP 설정 파일 읽기', () => {
  it('http 서버를 읽고, 다른 종류는 건너뛰며 까닭을 적는다', () => {
    write({ mcpServers: { a: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer t' } }, b: { type: 'sse', url: 'http://x/sse' }, c: { command: 'node' }, d: { type: 'http', url: 'file:///etc/passwd' } } });
    const config = readMcpConfig(file);
    expect(config.servers).toEqual([{ name: 'a', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer t' } }]);
    expect(config.skipped).toHaveLength(3);
    expect(config.skipped.join('\n')).toMatch(/b\(종류 sse/);
    expect(config.skipped.join('\n')).toMatch(/c\(종류 없음/);
  });

  it('링크면 600의 올바른 파일을 가리켜도 거절한다', () => {
    const real = path.join(dir, 'real.json');
    writeFileSync(real, JSON.stringify({ mcpServers: {} }));
    chmodSync(real, 0o600);
    symlinkSync(real, file);
    expect(() => readMcpConfig(file)).toThrow(/링크/);
  });

  it('그룹·다른 사용자가 읽을 수 있으면 거절한다', () => {
    write({ mcpServers: {} }, 0o640);
    expect(() => readMcpConfig(file)).toThrow(/600이 아닙니다/);
    write({ mcpServers: {} }, 0o604);
    expect(() => readMcpConfig(file)).toThrow(McpConfigError);
  });

  it('FIFO면 열다가 멈추지 않고 거절한다(자식 프로세스에서 시간 상한을 두고)', () => {
    execFileSync('mkfifo', ['-m', '600', file]);
    const loader = fileURLToPath(import.meta.resolve('tsx'));
    const script = `import { readMcpConfig } from ${JSON.stringify(fileURLToPath(new URL('./mcp.ts', import.meta.url)))};
try { readMcpConfig(${JSON.stringify(file)}); console.log('읽음'); } catch (error) { console.log(error.message); }`;
    const out = execFileSync(process.execPath, ['--import', loader, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
    expect(out).toMatch(/일반 파일이 아닙니다/);
  });

  it('다른 사용자 소유 파일은 거절한다(root로 돌 때만 시험할 수 있다)', () => {
    // 일반 사용자는 남의 파일을 만들 수 없다. 소유자 검사는 process.getuid와 견주는 한 줄이라 getuid를 바꿔 같은 분기를 지난다
    write({ mcpServers: {} });
    const original = process.getuid;
    process.getuid = () => (original!.call(process) === 0 ? 1 : 0) as number;
    try {
      expect(() => readMcpConfig(file)).toThrow(/주인이 이 사용자가 아닙니다/);
    } finally {
      process.getuid = original;
    }
  });

  it('없는 파일·JSON이 아닌 파일·모양이 틀린 파일·JSON 글 직접 전달은 거절한다', () => {
    expect(() => readMcpConfig(path.join(dir, 'none.json'))).toThrow(/없거나/);
    write('이건 JSON이 아님');
    expect(() => readMcpConfig(file)).toThrow(/JSON이 아닙니다/);
    write([]);
    expect(() => readMcpConfig(file)).toThrow(/mcpServers/);
    expect(() => readMcpConfig('{"mcpServers":{}}')).toThrow(/파일 경로만/);
  });
});

describe('도구 이름', () => {
  it('claude와 같이 mcp__서버__도구이고 허용되지 않는 글자는 _로 바꾼다', () => {
    expect(mcpToolName('b-studio', 'read_file')).toBe('mcp__b-studio__read_file');
    expect(mcpToolName('my server', 'a.b')).toBe('mcp__my_server__a_b');
  });
});

describe('MCP 서버에 붙기', () => {
  it('목록을 mcp__서버__도구 이름과 입력 스키마로 모델에 내놓는다', async () => {
    const server = await startServer();
    write(configFor(server));
    const { tools, notices } = await connect();
    expect(notices).toEqual([]);
    expect(tools.definitions.map((tool) => tool.name)).toEqual(['mcp__b-studio__echo', 'mcp__b-studio__big', 'mcp__b-studio__fail', 'mcp__b-studio__slow', 'mcp__b-studio__read_file']);
    expect(tools.definitions[0]).toMatchObject({ description: '그대로 돌려준다', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } });
    expect(tools.has('mcp__b-studio__echo')).toBe(true);
    expect(tools.has('echo')).toBe(false);
  });

  it('호출은 서버에 원래 이름과 입력으로 가고 글을 돌려받는다', async () => {
    const server = await startServer();
    write(configFor(server));
    const { tools } = await connect();
    const outcome = await tools.call('mcp__b-studio__echo', { text: '안녕' });
    expect(outcome).toEqual({ text: '받음: {"text":"안녕"}', isError: false });
    expect(calls).toEqual([{ name: 'echo', args: { text: '안녕' } }]);
    // 이름이 바뀐 도구도 서버에는 원래 이름으로 간다
    await tools.call('mcp__b-studio__read_file', {});
    expect(calls.at(-1)!.name).toBe('read.file');
  });

  it('서버의 isError는 실패한 도구 결과다', async () => {
    const server = await startServer();
    write(configFor(server));
    const { tools } = await connect();
    expect(await tools.call('mcp__b-studio__fail', {})).toMatchObject({ isError: true, text: expect.stringContaining('일부러 실패') });
  });

  it('긴 결과는 상한까지만 남기고 버린 양을 적는다', async () => {
    const server = await startServer();
    write(configFor(server));
    const { tools } = await connect({ maxOutputChars: 1000 });
    const outcome = await tools.call('mcp__b-studio__big', {});
    expect(outcome.isError).toBe(false);
    expect(outcome.text.length).toBeLessThan(1200);
    expect(outcome.text).toMatch(/199000자를 버렸습니다/);
  });

  it('응답 본문이 바이트 상한을 넘으면 읽다가 끊고 실패 결과로 돌려준다', async () => {
    const server = await startServer();
    write(configFor(server));
    const { tools } = await connect({ maxResponseBytes: 50_000 });
    const outcome = await tools.call('mcp__b-studio__big', {});
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/상한\(50000바이트\)을 넘어/);
  });

  it('시간 상한을 넘으면 실패 결과를 돌려주고 던지지 않는다', async () => {
    const server = await startServer();
    write(configFor(server));
    const { tools } = await connect({ callTimeoutMs: 300 });
    const outcome = await tools.call('mcp__b-studio__slow', {});
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/호출에 실패/);
  });

  it('세션 중단 신호가 오면 기다리지 않고 실패 결과를 돌려준다', async () => {
    const server = await startServer();
    write(configFor(server));
    const { tools } = await connect();
    const abort = new AbortController();
    const pending = tools.call('mcp__b-studio__slow', {}, abort.signal);
    setTimeout(() => abort.abort(), 100);
    const started = Date.now();
    expect((await pending).isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('서버가 닫혀 있으면 사유를 알리고 도구 없이 시작한다(토큰은 사유에 없다)', async () => {
    const server = await startServer();
    const config = configFor(server);
    await server.close();
    servers.length = 0;
    write(config);
    const { tools, notices } = await connect();
    expect(tools.definitions).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/b-studio에 연결하지 못해 그 도구 없이 시작합니다/);
    expect(notices[0]).not.toContain(server.token);
  });

  it('응답하지 않는 서버는 연결 시간 상한에서 끊고 도구 없이 시작한다', async () => {
    const hang = http.createServer(() => {});
    rawServers.push(hang);
    await new Promise<void>((resolve) => hang.listen(0, '127.0.0.1', resolve));
    write({ mcpServers: { slow: { type: 'http', url: `http://127.0.0.1:${(hang.address() as AddressInfo).port}/mcp` } } });
    const { tools, notices } = await connect({ connectTimeoutMs: 300 });
    expect(tools.definitions).toEqual([]);
    expect(notices.join('\n')).toMatch(/slow에 연결하지 못해/);
  });

  it('서버가 보낸 오류 글에 토큰이 있어도 사유에는 가려서 낸다', async () => {
    const token = 'secret-token-123';
    const echo = http.createServer((_request, response) => response.writeHead(500, { 'content-type': 'text/plain' }).end(`bad auth Bearer ${token}`));
    rawServers.push(echo);
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    write({ mcpServers: { s: { type: 'http', url: `http://127.0.0.1:${(echo.address() as AddressInfo).port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } });
    const { notices } = await connect();
    expect(notices.join('\n')).toContain('연결하지 못해');
    expect(notices.join('\n')).not.toContain(token);
  });

  it('설정 파일을 읽지 못하면 알리고 계속한다', async () => {
    write({ mcpServers: {} }, 0o644);
    const { tools, notices } = await connect();
    expect(tools.definitions).toEqual([]);
    expect(notices[0]).toMatch(/MCP 설정을 쓰지 않습니다.*600/);
  });

  it('http가 아닌 서버는 화면에 한 줄로 알리고 건너뛴다', async () => {
    write({ mcpServers: { local: { command: 'node', args: ['x.js'] } } });
    const { tools, notices } = await connect();
    expect(tools.definitions).toEqual([]);
    expect(notices).toEqual(['MCP 서버를 건너뜁니다: local(종류 없음: http만 받습니다)']);
  });

  it('도구 수 상한을 넘으면 앞의 것만 쓰고 알린다', async () => {
    const server = await startServer();
    write(configFor(server));
    const { tools, notices } = await connect({ maxToolsPerServer: 2 });
    expect(tools.definitions).toHaveLength(2);
    expect(notices.join('\n')).toMatch(/2개를 넘어/);
  });

  it('모르는 도구 이름은 실패 결과다', async () => {
    write({ mcpServers: {} });
    const { tools } = await connect();
    expect(await tools.call('mcp__x__y', {})).toMatchObject({ isError: true });
  });
});

describe('결과 옮기기', () => {
  it('text는 이어 붙이고 이미지 등은 한 줄 요약으로 바꾼다', () => {
    const outcome = mapMcpResult({ content: [{ type: 'text', text: '가' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'resource', resource: { uri: 'file:///a', text: '리소스 글' } }, { type: 'resource_link', uri: 'x' }] }, 1000);
    expect(outcome.isError).toBe(false);
    expect(outcome.text).toBe('가\n[image image/png 4자(base64)는 모델에 보내지 않았습니다]\n리소스 글\n[resource_link 내용은 모델에 보내지 않았습니다]');
  });

  it('content가 없으면 형식 오류로 실패한다', () => {
    expect(mapMcpResult({ toolResult: 1 }, 100)).toMatchObject({ isError: true });
  });

  it('여러 조각이 합쳐 상한을 넘어도 상한까지만 남긴다', () => {
    const outcome = mapMcpResult({ content: [{ type: 'text', text: 'a'.repeat(60) }, { type: 'text', text: 'b'.repeat(60) }] }, 100);
    expect(outcome.text.startsWith('a'.repeat(60))).toBe(true);
    expect(outcome.text).toMatch(/21자를 버렸습니다. 앞 100자/);
  });
});
