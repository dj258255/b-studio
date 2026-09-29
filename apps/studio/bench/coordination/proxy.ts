/**
 * 계획 고정 + 상류 전달 프록시.
 *
 * 작업 분해 벤치마크에서 모델이 레인을 어떻게 나누는지가 섞이면 전략(S0/S1) 차이를 잴 수 없다.
 * 운영 코드를 건드리지 않고 계획을 고정하기 위해, 모델 레지스트리의 baseUrl을 이 프록시로 둔다.
 *  - 계획 요청(도구가 없고 system이 작업 분해 프롬프트로 시작)은 현재 실행의 고정 계획 JSON을 텍스트로 돌려준다
 *  - 그 밖의 요청은 상류 제공자로 그대로 넘기고, 프록시가 상류 키를 붙인다. 상태 코드와 본문을 그대로 돌려준다
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ProxyOptions {
  upstreamBaseUrl: string;
  upstreamApiKey: string;
}

export interface ProxyStats {
  /** 상류로 넘긴 chat/completions 호출 수 */
  forwardedCalls: number;
  /** /chat/completions로 받은 요청 본문 바이트 합 */
  requestBytes: number;
  /** /chat/completions에 보낸 응답 본문 바이트 합 */
  responseBytes: number;
  /** 프록시가 처리한 계획 요청 수 (상류로 가지 않음) */
  plannerCalls: number;
  /** 상류가 2xx가 아니거나 연결에 실패한 횟수 */
  upstreamErrors: number;
}

export interface ProxyHandle {
  baseUrl: string;
  setPlan(plan: unknown): void;
  takeStats(): ProxyStats;
  close(): Promise<void>;
}

/** 작업 분해 프롬프트(`buildPlannerSystem`)의 시작 문구. 계획 요청을 알아보는 표지다 */
const PLANNER_SYSTEM_PREFIX = 'You split a web development request';
const CHAT_PATH = '/v1/chat/completions';
const MODELS_PREFIX = '/v1/models/';

export function isPlannerRequest(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const tools = (body as { tools?: unknown }).tools;
  // 도구가 있는 요청은 작업 요청이다. OpenAI 호환 클라이언트는 도구가 없으면 tools 필드를 뺀다
  if (Array.isArray(tools) && tools.length > 0) return false;
  return systemText(body).startsWith(PLANNER_SYSTEM_PREFIX);
}

export async function startProxy(options: ProxyOptions): Promise<ProxyHandle> {
  let plan: unknown;
  const stats: ProxyStats = { forwardedCalls: 0, requestBytes: 0, responseBytes: 0, plannerCalls: 0, upstreamErrors: 0 };

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) json(response, 502, { error: { message: `프록시 오류: ${describe(error)}` } });
      else response.end();
    });
  });

  /** 계획 응답과 상류 응답 모두 Chat Completions 응답 모양을 따른다 */
  function chatCompletion(content: string): unknown {
    return {
      id: `bench-plan-${Date.now()}`,
      object: 'chat.completion',
      model: 'bench-plan',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // 모델 확인(preflight)은 상류로 넘기지 않고 로컬에서 답한다
    if (request.method === 'GET' && request.url?.startsWith(MODELS_PREFIX)) {
      const id = decodeURIComponent(request.url.slice(MODELS_PREFIX.length));
      json(response, 200, { id, object: 'model' });
      return;
    }
    if (request.method !== 'POST' || request.url !== CHAT_PATH) {
      json(response, 404, { error: { message: 'not found' } });
      return;
    }

    const raw = await readBody(request);
    stats.requestBytes += Buffer.byteLength(raw);
    const respond = (status: number, bodyText: string, contentType = 'application/json') => {
      stats.responseBytes += Buffer.byteLength(bodyText);
      response.writeHead(status, { 'content-type': contentType });
      response.end(bodyText);
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }

    if (isPlannerRequest(parsed)) {
      stats.plannerCalls += 1;
      respond(200, JSON.stringify(chatCompletion(JSON.stringify(plan))));
      return;
    }

    stats.forwardedCalls += 1;
    let upstream: Response;
    try {
      upstream = await fetch(`${options.upstreamBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${options.upstreamApiKey}` },
        body: raw,
      });
    } catch (error) {
      // 네트워크 오류는 키를 넣지 않고 알린다
      stats.upstreamErrors += 1;
      respond(502, JSON.stringify({ error: { message: `상류 연결 실패: ${describe(error)}` } }));
      return;
    }
    const text = await upstream.text();
    if (!upstream.ok) stats.upstreamErrors += 1;
    respond(upstream.status, text, upstream.headers.get('content-type') ?? 'application/json');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    setPlan(next) {
      plan = next;
    },
    takeStats() {
      const snapshot = { ...stats };
      stats.forwardedCalls = 0;
      stats.requestBytes = 0;
      stats.responseBytes = 0;
      stats.plannerCalls = 0;
      stats.upstreamErrors = 0;
      return snapshot;
    },
    close() {
      return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

function systemText(body: unknown): string {
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return '';
  const system = messages.find((message) => Boolean(message) && typeof message === 'object' && (message as { role?: unknown }).role === 'system');
  const content = system && typeof (system as { content?: unknown }).content === 'string' ? (system as { content: string }).content : '';
  return content;
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
