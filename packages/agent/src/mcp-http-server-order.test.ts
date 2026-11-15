import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import { startToolServer } from './mcp-http-server';
import type { buildTools } from './tools';

/**
 * CLI는 도구를 부르기 전에 그 호출이 든 assistant 메시지를 stdout에 먼저 쓴다(stream-json). 러너는 stdout에서 턴을 세고(`turn` 이벤트),
 * MCP 요청에서 도구 호출을 알린다(`tool_call`). 옛 node:http 서버에서는 HTTP 요청이 같은 이벤트 루프에서 연결·머리 읽기를 거쳐야 해서
 * 먼저 와 있던 stdout이 늘 먼저 처리됐다. Rust 서버는 다른 스레드에서 요청을 다 읽고 콜백을 넣으므로, 콜백이 stdout을 앞지르지 않게
 * 한 번 양보한다. 이 시험은 그 순서(stdout 줄 → 도구 실행)를 여러 번 되풀이해 본다(CI Linux에서 F0 기준 사진의 이벤트 순서가 뒤집혔다).
 */
const specs = [{ name: 'ping_tool', description: 'p', input_schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false } }] as unknown as ReturnType<typeof buildTools>;

const CHILD = `
const [url, token, rounds] = process.argv.slice(1);
const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
(async () => {
  for (let i = 0; i < Number(rounds); i++) {
    process.stdout.write(JSON.stringify({ line: i }) + '\\n');
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'ping_tool', arguments: { n: i } } }) });
    await response.text();
  }
})();
`;

describe('MCP 도구 호출은 CLI가 먼저 쓴 stdout 줄을 앞지르지 않는다', () => {
  it('stdout에 쓴 직후 부른 도구는 그 줄이 처리된 뒤에 실행된다(200번)', async () => {
    const seen: number[] = [];
    const inversions: number[] = [];
    const server = await startToolServer({
      specs,
      run: async (_name, args) => {
        const n = (args as { n: number }).n;
        if (!seen.includes(n)) inversions.push(n);
        return { ok: true, content: 'ok' };
      },
    });
    try {
      const rounds = 200;
      const child = spawn(process.execPath, ['-e', CHILD, server.url, server.token, String(rounds)], { stdio: ['ignore', 'pipe', 'inherit'] });
      createInterface({ input: child.stdout }).on('line', (line) => seen.push((JSON.parse(line) as { line: number }).line));
      await new Promise<void>((resolve) => child.on('exit', () => resolve()));
      expect(seen).toHaveLength(rounds);
      expect(inversions).toEqual([]);
    } finally {
      await server.close();
    }
  }, 60_000);
});
