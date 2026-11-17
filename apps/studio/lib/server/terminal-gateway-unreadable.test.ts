import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startTerminalGateway, UNREADABLE_PRE_TOOL_DENY, UNREADABLE_PROMPT_BLOCK, type TerminalGateway, type TerminalGatewayHandlers } from './terminal-gateway';

/**
 * 훅 요청 본문을 읽지 못했을 때(N18, ADR-219)를 실제 훅 서버(루프백의 임의 포트)로 본다. 옛 코드는 읽지 못한 본문을 `{}`로 두고 처리를 불렀다:
 * 쓰기 직전 훅은 도구 이름 없이 판정해 허용했다. 막는 판정이 쓰는 훅(쓰기 직전, 요청 시작)은 읽지 못하면 막고, 턴의 끝·종료·API 오류 훅은 지금처럼 닫는 쪽으로 돈다.
 */
const opened: TerminalGateway[] = [];
afterEach(async () => {
  for (const gateway of opened.splice(0)) await gateway.close();
});

interface Calls {
  prompt: unknown[];
  preTool: unknown[];
  stop: unknown[];
  stopFailure: unknown[];
  sessionEnd: unknown[];
  telemetry: unknown[];
}

function handlers(calls: Calls): TerminalGatewayHandlers {
  return {
    note: async () => undefined,
    prompt: async (input) => {
      calls.prompt.push(input);
      return {};
    },
    preTool: async (input) => {
      calls.preTool.push(input);
      return {};
    },
    stop: async (input) => {
      calls.stop.push(input);
      return { message: '닫았습니다' };
    },
    sessionEnd: async (input) => void calls.sessionEnd.push(input),
    stopFailure: async (input) => void calls.stopFailure.push(input),
    notification: async () => {},
    telemetry: async (body) => void calls.telemetry.push(body),
    toolSpecs: () => [] as never,
    runTool: async () => ({ ok: true, content: '' }),
  };
}

const newCalls = (): Calls => ({ prompt: [], preTool: [], stop: [], stopFailure: [], sessionEnd: [], telemetry: [] });

/** 본문 바이트를 그대로 보낸다 */
function postRaw(url: string, token: string, route: string, body: Buffer): Promise<{ status: number; body: unknown }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port: target.port, path: route, method: 'POST', headers: { host: target.host, 'content-type': 'application/json', authorization: `Bearer ${token}`, 'content-length': body.length } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

async function serve(calls: Calls): Promise<{ call: (route: string, body: Buffer | string) => Promise<{ status: number; body: unknown }> }> {
  const gateway = await startTerminalGateway(handlers(calls), '127.0.0.1');
  opened.push(gateway);
  return { call: (route, body) => postRaw(gateway.address.hookUrl, gateway.address.hookToken, route, Buffer.from(body)) };
}

const UNREADABLE: Array<[string, Buffer | string]> = [
  ['JSON이 아닌 글', 'not json'],
  ['잘린 JSON', '{"tool_name":"Write"'],
  ['배열', '[{"tool_name":"Write"}]'],
  ['글', '"Write"'],
  ['null', 'null'],
  ['BOM이 앞선 JSON', Buffer.from('﻿{"tool_name":"Write"}')],
  ['문법 밖 바이트', Buffer.from([0x7b, 0xff, 0x7d])],
  ['본문 없음', ''],
];

describe('읽지 못한 훅 본문(N18, ADR-219)', () => {
  it.each(UNREADABLE)('쓰기 직전 훅은 %s이면 처리를 부르지 않고 거절한다', async (_name, body) => {
    const calls = newCalls();
    const { call } = await serve(calls);
    const answer = await call('/pre-tool', body);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: UNREADABLE_PRE_TOOL_DENY } });
    expect(calls.preTool).toEqual([]);
  });

  it.each(UNREADABLE)('요청 시작 훅은 %s이면 처리를 부르지 않고 요청을 막는다', async (_name, body) => {
    const calls = newCalls();
    const { call } = await serve(calls);
    const answer = await call('/prompt', body);
    expect(answer.body).toEqual({ decision: 'block', reason: UNREADABLE_PROMPT_BLOCK });
    expect(calls.prompt).toEqual([]);
  });

  it('텔레메트리 본문을 읽지 못하면 빈 내보내기로 세지 않고 5xx로 답한다', async () => {
    const calls = newCalls();
    const { call } = await serve(calls);
    expect((await call('/v1/logs', 'not json')).status).toBe(500);
    expect(calls.telemetry).toEqual([]);
    expect((await call('/v1/logs', '{"resourceLogs":[]}')).status).toBe(200);
    expect(calls.telemetry).toHaveLength(1);
  });

  it('읽은 본문은 지금처럼 처리로 간다(회귀 방지)', async () => {
    const calls = newCalls();
    const { call } = await serve(calls);
    expect((await call('/pre-tool', '{"tool_name":"Write","tool_input":{"file_path":"a"}}')).body).toEqual({});
    expect(calls.preTool).toEqual([{ tool_name: 'Write', tool_input: { file_path: 'a' } }]);
    expect((await call('/prompt', '{"prompt":"안녕"}')).body).toEqual({});
    expect(calls.prompt).toEqual([{ prompt: '안녕' }]);
  });

  it('턴의 끝·CLI 종료·API 오류 훅은 읽지 못해도 처리를 부른다(닫는 쪽으로 돈다: 입력은 쓰는 글만 담는다)', async () => {
    const calls = newCalls();
    const { call } = await serve(calls);
    expect((await call('/stop', 'not json')).body).toEqual({ systemMessage: '닫았습니다' });
    await call('/session-end', '[1]');
    await call('/stop-failure', '');
    expect(calls.stop).toEqual([{}]);
    expect(calls.sessionEnd).toEqual([{}]);
    expect(calls.stopFailure).toEqual([{}]);
  });
});
