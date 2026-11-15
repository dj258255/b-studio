import { native } from '@b-studio/sandbox';
import { afterEach, describe, expect, it } from 'vitest';
import { startToolServer, type ToolServer } from './mcp-http-server';
import type { ToolOutcome } from './tools';

/**
 * 도구 순서 장부(ADR-202, 4f A8b, 트러블슈팅 206)를 도구 서버(`startToolServer`의 선택 인자 `ledger`)까지 이어서 본다.
 * 장부는 Rust 객체(crates/bstudio-io/src/tool_ledger.rs)이고, MCP 서버의 `tools/call`이 TS의 도구 실행 콜백을 부르기 전에 이 객체를 지난다.
 * 옛 TS 구현(`serialQueue`·`noteToolUses`·`awaitToolUse`·`closeTools`)의 뜻을 그대로 지킨다: 도착 순서대로 하나씩, 그 도구의 `tool_use`를 본 뒤에, 닫혔거나 취소됐으면 실행하지 않는다.
 * 장부를 주지 않으면(실험 러너) 지금처럼 요청이 오는 대로 실행한다.
 */

const SPECS = [
  { name: 'read', description: 'R', input_schema: { type: 'object', properties: { n: { type: 'integer' } }, required: [] } },
  { name: 'other', description: 'O', input_schema: { type: 'object', properties: {}, required: [] } },
];
const PREFIX = 'mcp__t__';
const toolUse = (id: string, name: string) => ({ type: 'tool_use', id, name: `${PREFIX}${name}` });

let servers: ToolServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((server) => server.close()));
  servers = [];
});

async function start(run: (name: string, args: unknown) => Promise<ToolOutcome>, ledger?: InstanceType<typeof native.ToolLedger>): Promise<ToolServer> {
  const server = await startToolServer({ specs: SPECS as never, run, name: 't', honorRequired: true, ...(ledger ? { ledger } : {}) });
  servers.push(server);
  return server;
}

/** tools/call 한 번. 응답 본문의 결과 글과 isError를 돌려준다 */
async function call(server: ToolServer, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean | undefined }> {
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await response.text();
  const data = body.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).at(-1) ?? body;
  const parsed = JSON.parse(data) as { result?: { content?: Array<{ text?: string }>; isError?: boolean } };
  return { text: parsed.result?.content?.[0]?.text ?? '', isError: parsed.result?.isError };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ok = (content: string): ToolOutcome => ({ ok: true, content });

describe('도구 순서 장부 + 도구 서버', () => {
  it('장부가 없으면 요청이 오는 대로 실행한다(실험 러너는 지금과 같다)', async () => {
    const running: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const server = await start(async (name) => {
      running.push(1);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(120);
      concurrent -= 1;
      return ok(name);
    });
    const results = await Promise.all([call(server, 'read'), call(server, 'read'), call(server, 'other')]);
    expect(results.map((r) => r.text)).toEqual(['read', 'read', 'other']);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('그 도구의 tool_use를 본 뒤에 실행한다(요청이 메시지보다 먼저 와도 기다린다)', async () => {
    const ledger = new native.ToolLedger(PREFIX, 5_000);
    const ran: string[] = [];
    const server = await start(async (name) => (ran.push(name), ok(name)), ledger);
    const pending = call(server, 'read');
    await sleep(150);
    expect(ran).toEqual([]);
    ledger.noteToolUses(JSON.stringify([toolUse('a', 'read')]));
    expect(await pending).toMatchObject({ text: 'read' });
    expect(ran).toEqual(['read']);
  });

  it('메시지가 끝내 오지 않으면 대기 상한 뒤 그대로 실행한다', async () => {
    const ledger = new native.ToolLedger(PREFIX, 200);
    const server = await start(async (name) => ok(name), ledger);
    const started = Date.now();
    expect(await call(server, 'read')).toMatchObject({ text: 'read' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });

  it('tool_use가 아닌 블록은 같은 이름이어도 세지 않는다', async () => {
    const ledger = new native.ToolLedger(PREFIX, 300);
    const server = await start(async (name) => ok(name), ledger);
    ledger.noteToolUses(JSON.stringify([{ type: 'server_tool_use', id: 's', name: `${PREFIX}read` }, { type: 'text', name: `${PREFIX}read` }, null, 'x']));
    const started = Date.now();
    await call(server, 'read');
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  });

  it('도착 순서대로 하나씩 실행한다(앞의 것이 느려도 뒤의 것이 앞서지 않는다)', async () => {
    const ledger = new native.ToolLedger(PREFIX, 300);
    ledger.noteToolUses(JSON.stringify([toolUse('1', 'read'), toolUse('2', 'read'), toolUse('3', 'read')]));
    const order: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const server = await start(async (_name, args) => {
      const n = (args as { n: number }).n;
      order.push(n);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(150 - n * 40);
      concurrent -= 1;
      return ok(String(n));
    }, ledger);
    const pending: Array<Promise<unknown>> = [];
    for (const n of [1, 2, 3]) {
      pending.push(call(server, 'read', { n }));
      await sleep(40);
    }
    await Promise.all(pending);
    expect(order).toEqual([1, 2, 3]);
    expect(maxConcurrent).toBe(1);
  });

  it('닫으면 기다리던 요청을 깨워 실행하지 않고 거절한다(대기 상한까지 붙잡지 않는다)', async () => {
    const ledger = new native.ToolLedger(PREFIX, 5_000);
    const ran: string[] = [];
    const server = await start(async (name) => (ran.push(name), ok(name)), ledger);
    const pending = call(server, 'read');
    await sleep(100);
    const closedAt = Date.now();
    ledger.close();
    expect(await pending).toEqual({ text: '이 실행은 이미 끝나 도구를 쓸 수 없습니다', isError: true });
    expect(Date.now() - closedAt).toBeLessThan(1_000);
    // 닫힌 뒤 도착한 요청도 거절한다
    expect(await call(server, 'other')).toEqual({ text: '이 실행은 이미 끝나 도구를 쓸 수 없습니다', isError: true });
    expect(ran).toEqual([]);
    expect(ledger.isClosed()).toBe(true);
  });

  it('취소하면 취소 이유로 거절한다(닫힘보다 먼저 본다)', async () => {
    const ledger = new native.ToolLedger(PREFIX, 5_000);
    const ran: string[] = [];
    const server = await start(async (name) => (ran.push(name), ok(name)), ledger);
    const pending = call(server, 'read');
    await sleep(100);
    ledger.abort('요청을 취소했습니다');
    ledger.close();
    expect(await pending).toEqual({ text: '요청을 취소했습니다', isError: true });
    expect(ran).toEqual([]);
  });

  it('idle()은 실행 중인 도구가 끝난 뒤에 돌아온다', async () => {
    const ledger = new native.ToolLedger(PREFIX, 300);
    ledger.noteToolUses(JSON.stringify([toolUse('1', 'read')]));
    let finished = false;
    const server = await start(async (name) => {
      await sleep(250);
      finished = true;
      return ok(name);
    }, ledger);
    const pending = call(server, 'read');
    await sleep(60);
    await ledger.idle();
    expect(finished).toBe(true);
    await pending;
  });

  it('같은 tool_use id를 다시 받아도 한 번만 센다', async () => {
    const ledger = new native.ToolLedger(PREFIX, 300);
    const server = await start(async (name) => ok(name), ledger);
    ledger.noteToolUses(JSON.stringify([toolUse('same', 'read')]));
    ledger.noteToolUses(JSON.stringify([toolUse('same', 'read')]));
    const first = Date.now();
    await call(server, 'read');
    expect(Date.now() - first).toBeLessThan(250);
    const second = Date.now();
    await call(server, 'read');
    // 센 것은 하나뿐이라 둘째 요청은 대기 상한까지 기다린다
    expect(Date.now() - second).toBeGreaterThanOrEqual(280);
  });
});
