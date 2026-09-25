/**
 * `--dry`용 가짜 상류(OpenAI 호환). 실제 모델을 부르지 않고 과금 없이 실행 경로를 확인한다.
 *
 * 과제 `orders-list`만 안다. api 작업은 OrderController.java를, web 작업은 /orders 페이지를 만든다.
 * S1(대화에 api 작업의 도구 호출이 없음)에서는 web이 일부러 잘못된 경로(/api/order-list)를 부른다 —
 * 수용 확인 실패와 분류 경로를 과금 없이 확인하기 위해서다.
 * 이 파일은 단위 테스트 대상이 아니다(실제 Docker 실행으로 확인).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface DryProviderHandle {
  baseUrl: string;
  close(): Promise<void>;
}

const API_FILE = 'api/src/main/java/com/example/api/OrderController.java';
const WEB_FILE = 'web/app/orders/page.tsx';

const API_SOURCE = `package com.example.api;

import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
class OrderController {

    @GetMapping("/api/orders")
    List<Map<String, Object>> orders() {
        return List.of(
            Map.of("id", 1, "customerName", "김민수", "amount", 15000, "status", "PAID"),
            Map.of("id", 2, "customerName", "이영희", "amount", 20000, "status", "PAID"),
            Map.of("id", 3, "customerName", "박철수", "amount", 10000, "status", "SHIPPED")
        );
    }
}
`;

/** web 페이지. apiPath를 바꿔 S1에서 잘못된 경로를 부르게 한다. examples/orders/web lint(any 금지)를 통과해야 한다 */
function webSource(apiPath: string): string {
  return [
    'export const dynamic = "force-dynamic";',
    '',
    'interface Order {',
    '  id: number;',
    '  customerName: string;',
    '  amount: number;',
    '  status: string;',
    '}',
    '',
    'export default async function OrdersPage() {',
    '  const response = await fetch(`${process.env.API_BASE_URL}' + apiPath + '`, { cache: "no-store" });',
    '  if (!response.ok) {',
    '    return <p>주문을 불러오지 못했습니다 (HTTP {response.status})</p>;',
    '  }',
    '  const orders = (await response.json()) as Order[];',
    '  return (',
    '    <main className="p-8">',
    '      <h1 className="text-2xl font-semibold">주문 목록</h1>',
    '      <table className="mt-4 w-full border-collapse text-left">',
    '        <thead>',
    '          <tr>',
    '            <th className="border-b p-2">ID</th>',
    '            <th className="border-b p-2">고객</th>',
    '            <th className="border-b p-2">금액</th>',
    '            <th className="border-b p-2">상태</th>',
    '          </tr>',
    '        </thead>',
    '        <tbody>',
    '          {orders.map((order) => (',
    '            <tr key={order.id}>',
    '              <td className="border-b p-2">{order.id}</td>',
    '              <td className="border-b p-2">{order.customerName}</td>',
    '              <td className="border-b p-2">{order.amount}</td>',
    '              <td className="border-b p-2">{order.status}</td>',
    '            </tr>',
    '          ))}',
    '        </tbody>',
    '      </table>',
    '    </main>',
    '  );',
    '}',
    '',
  ].join('\n');
}

export async function startDryProvider(): Promise<DryProviderHandle> {
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) json(response, 500, { error: { message: `dry 제공자 오류: ${describe(error)}` } });
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models/')) {
      json(response, 200, { id: decodeURIComponent(request.url.slice('/v1/models/'.length)), object: 'model' });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      json(response, 404, { error: { message: 'not found' } });
      return;
    }

    const body = JSON.parse(await readBody(request)) as { messages?: unknown[] };
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const markerAt = messages.findLastIndex((message) => isUserTaskMessage(message));
    const taskId = markerAt === -1 ? '' : (/\[task:([a-z0-9-]+)\]/.exec(taskText(messages[markerAt]))?.[1] ?? '');
    const step = messages.slice(markerAt + 1).filter((message) => role(message) === 'tool').length;

    if (taskId.endsWith('-api')) {
      if (step === 0) return write(response, API_FILE, API_SOURCE);
      return text(response, `${taskId} 완료: 주문 목록 API를 추가했습니다.`);
    }
    if (taskId.endsWith('-web')) {
      if (step === 0) {
        // S0(같은 세션에서 api 작업의 쓰기를 봤다)이면 맞는 경로, S1이면 일부러 틀린 경로를 부른다
        const sawApi = messages.some((message) => wroteApiController(message));
        return write(response, WEB_FILE, webSource(sawApi ? '/api/orders' : '/api/order-list'));
      }
      return text(response, `${taskId} 완료: 주문 목록 화면을 추가했습니다.`);
    }
    return text(response, '알 수 없는 작업입니다.');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

let callId = 0;

function write(response: ServerResponse, path: string, content: string): void {
  callId += 1;
  json(response, 200, {
    id: `dry-${callId}`,
    model: 'dry',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: { content: null, tool_calls: [{ id: `call-${callId}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path, content }) } }] },
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  });
}

function text(response: ServerResponse, content: string): void {
  callId += 1;
  json(response, 200, {
    id: `dry-${callId}`,
    model: 'dry',
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  });
}

function role(message: unknown): string | undefined {
  return message && typeof message === 'object' ? ((message as { role?: string }).role ?? undefined) : undefined;
}

function taskText(message: unknown): string {
  const content = message && typeof message === 'object' ? (message as { content?: unknown }).content : undefined;
  return typeof content === 'string' ? content : '';
}

function isUserTaskMessage(message: unknown): boolean {
  return role(message) === 'user' && /\[task:[a-z0-9-]+\]/.test(taskText(message));
}

/** 이 assistant 메시지가 api 컨트롤러 파일을 쓴 기록을 담고 있는가 (S0 판별) */
function wroteApiController(message: unknown): boolean {
  if (role(message) !== 'assistant') return false;
  const calls = (message as { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }).tool_calls;
  if (!Array.isArray(calls)) return false;
  return calls.some((call) => call.function?.name === 'write_file' && String(call.function.arguments ?? '').includes('OrderController.java'));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
