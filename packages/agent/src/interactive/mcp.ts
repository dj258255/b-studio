import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolOutcome } from './tools';

type BetaTool = Anthropic.Beta.BetaTool;

/** 도구 결과 글자 상한(Bash와 같은 값), 도구 호출 하나의 시간 상한, 연결·목록의 시간 상한, 응답 본문 바이트 상한, 서버 하나의 도구 수 상한 */
export const MCP_MAX_OUTPUT_CHARS = 30_000;
export const MCP_CALL_TIMEOUT_MS = 600_000;
export const MCP_CONNECT_TIMEOUT_MS = 10_000;
export const MCP_MAX_RESPONSE_BYTES = 8_000_000;
export const MCP_MAX_TOOLS_PER_SERVER = 256;
/** 모델 API가 받는 도구 이름: 영문·숫자·`_`·`-`, 64자까지 */
const MAX_TOOL_NAME = 64;

export class McpConfigError extends Error {}

export interface McpHttpServer {
  name: string;
  url: string;
  /** 요청 머리글(Authorization 등). 토큰이 들어 있으니 화면·환경·자식 프로세스에 내지 않는다 */
  headers: Record<string, string>;
}
export interface McpConfig {
  servers: McpHttpServer[];
  /** 쓰지 않고 건너뛴 서버와 그 까닭(화면에 한 줄로 알린다) */
  skipped: string[];
}

/**
 * `--mcp-config` 파일 하나를 읽는다(fail closed): 없음·읽을 수 없음·일반 파일이 아님(링크·FIFO)·다른 사용자 소유·그룹/다른 사용자 권한·JSON이 아님은 McpConfigError다.
 * 토큰이 든 파일이라 600이 아니면 읽지 않는다. 한 번 연 핸들로 확인하고 읽는다(경로로 확인한 뒤 다시 경로로 읽으면 그 사이에 바꿔친 파일을 읽을 수 있다).
 * `type: "http"`가 아닌 서버(stdio·sse·종류 없음)는 건너뛰고 까닭을 skipped에 적는다: 명령을 띄우는 서버는 이 CLI가 받지 않는다
 */
export function readMcpConfig(file: string): McpConfig {
  if (file.trimStart().startsWith('{')) throw new McpConfigError('MCP 설정은 파일 경로만 받습니다(JSON 글을 직접 받지 않습니다)');
  let fd: number;
  try {
    // O_NOFOLLOW: 마지막 조각이 링크면 열지 않는다. O_NONBLOCK: FIFO에서 열기가 멈추지 않게 한다(종류는 아래 fstat에서 거절한다)
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new McpConfigError(`MCP 설정이 일반 파일이 아닙니다(링크는 허용하지 않습니다): ${file}`);
    throw new McpConfigError(`MCP 설정이 없거나 읽을 수 없습니다: ${file}`);
  }
  let raw: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new McpConfigError(`MCP 설정이 일반 파일이 아닙니다(링크는 허용하지 않습니다): ${file}`);
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) throw new McpConfigError(`MCP 설정의 주인이 이 사용자가 아닙니다: ${file}`);
    if ((stat.mode & 0o077) !== 0) throw new McpConfigError(`MCP 설정의 권한이 600이 아닙니다(그룹·다른 사용자 권한이 있습니다): ${file}`);
    try {
      raw = JSON.parse(readFileSync(fd, 'utf8'));
    } catch {
      throw new McpConfigError(`MCP 설정이 올바른 JSON이 아닙니다: ${file}`);
    }
  } finally {
    closeSync(fd);
  }
  const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!record(raw) || !record(raw.mcpServers)) throw new McpConfigError('MCP 설정은 {"mcpServers": {…}} 꼴의 객체여야 합니다');
  const servers: McpHttpServer[] = [];
  const skipped: string[] = [];
  for (const [name, entry] of Object.entries(raw.mcpServers)) {
    if (!record(entry) || entry.type !== 'http') {
      skipped.push(`${name}(종류 ${record(entry) && typeof entry.type === 'string' ? entry.type : '없음'}: http만 받습니다)`);
      continue;
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(String(entry.url));
    } catch {
      skipped.push(`${name}(주소가 올바르지 않습니다)`);
      continue;
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      skipped.push(`${name}(http·https 주소만 받습니다)`);
      continue;
    }
    const headers: Record<string, string> = {};
    if (entry.headers !== undefined) {
      if (!record(entry.headers) || Object.values(entry.headers).some((value) => typeof value !== 'string')) {
        skipped.push(`${name}(headers가 문자열 값의 객체가 아닙니다)`);
        continue;
      }
      Object.assign(headers, entry.headers);
    }
    servers.push({ name, url: parsedUrl.href, headers });
  }
  return { servers, skipped };
}

/** 모델 API의 도구 이름 규칙에 맞게 서버·도구 이름의 다른 글자를 `_`로 바꾼다(claude가 하는 것과 같다) */
const normalizeName = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_');
export const mcpToolName = (server: string, tool: string): string => `mcp__${normalizeName(server)}__${normalizeName(tool)}`;

export interface McpTools {
  definitions: BetaTool[];
  has(name: string): boolean;
  /** 던지지 않는다: 네트워크 오류·시간 초과·중단은 실패한 도구 결과다 */
  call(name: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<ToolOutcome>;
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** 화면에 한 줄을 알린다 */
  notice: (line: string) => void;
  signal?: AbortSignal;
  /** 시험이 줄이는 값 */
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  maxOutputChars?: number;
  maxResponseBytes?: number;
  maxToolsPerServer?: number;
}

/** 응답 본문이 상한을 넘으면 읽다가 끊는다(읽은 뒤에 크기를 보지 않는다). POST 응답에만 건다: GET은 오래 열어 두는 알림 통로다 */
function cappedFetch(limit: number): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, { ...init, redirect: 'error' });
    if (init?.method !== 'POST' || !response.body) return response;
    let seen = 0;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > limit) controller.error(new Error(`응답이 상한(${limit}바이트)을 넘어 끊었습니다`));
          else controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** 결과 content를 글로: text는 그대로, 나머지는 한 줄 요약. 상한까지만 모으고 나머지는 센다(큰 글자열을 다 만들지 않는다) */
export function mapMcpResult(result: unknown, maxChars: number): ToolOutcome {
  const record = typeof result === 'object' && result !== null ? (result as { content?: unknown; isError?: unknown }) : {};
  if (!Array.isArray(record.content)) return { text: 'MCP 서버의 결과 형식을 읽지 못했습니다', isError: true };
  let collected = '';
  let dropped = 0;
  const add = (piece: string) => {
    const separator = collected === '' ? '' : '\n';
    const room = maxChars - collected.length - separator.length;
    if (room <= 0) {
      dropped += piece.length;
      return;
    }
    collected += separator + piece.slice(0, room);
    if (piece.length > room) dropped += piece.length - room;
  };
  for (const part of record.content as Array<Record<string, unknown>>) {
    const type = typeof part?.type === 'string' ? part.type : '알 수 없음';
    if (type === 'text' && typeof part.text === 'string') add(part.text);
    else if (type === 'image' || type === 'audio') add(`[${type} ${typeof part.mimeType === 'string' ? part.mimeType : ''} ${typeof part.data === 'string' ? part.data.length : 0}자(base64)는 모델에 보내지 않았습니다]`);
    else if (type === 'resource' && typeof part.resource === 'object' && part.resource !== null) {
      const resource = part.resource as { uri?: unknown; text?: unknown };
      add(typeof resource.text === 'string' ? resource.text : `[리소스 ${typeof resource.uri === 'string' ? resource.uri : ''}]`);
    } else add(`[${type} 내용은 모델에 보내지 않았습니다]`);
  }
  const note = dropped > 0 ? `\n(결과가 길어 ${dropped}자를 버렸습니다. 앞 ${collected.length}자만 남겼습니다)` : '';
  return { text: `${collected === '' ? '(결과 없음)' : collected}${note}`, isError: record.isError === true };
}

interface Connected {
  client: Client;
  /** 지금 이 서버에서 기다리는 호출들. 전송에서 오류가 나면 SDK는 기다리는 요청을 풀어 주지 않으므로(스트림이 끊겨도 시간 상한까지 기다린다) 우리가 끊는다 */
  active: Set<AbortController>;
  tool: string;
  timeoutMs: number;
}

/**
 * 설정 파일들의 http 서버에 붙어 도구를 모아 온다. 어느 한 곳도 세션을 막지 않는다: 설정 파일을 읽지 못하거나 서버에 붙지 못하면
 * 그 사유를 알리고 그 도구 없이 계속한다(도구가 없는 쪽이 안전한 쪽이다)
 */
export async function connectMcpServers(files: readonly string[], options: ConnectOptions): Promise<McpTools> {
  const definitions: BetaTool[] = [];
  const registry = new Map<string, Connected>();
  const clients: Client[] = [];
  const secrets = new Set<string>();
  const redact = (text: string): string => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('[가림]');
    return out;
  };
  const connectTimeoutMs = options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS;
  const callTimeoutMs = options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS;
  const maxChars = options.maxOutputChars ?? MCP_MAX_OUTPUT_CHARS;
  const maxTools = options.maxToolsPerServer ?? MCP_MAX_TOOLS_PER_SERVER;

  for (const file of files) {
    let config: McpConfig;
    try {
      config = readMcpConfig(file);
    } catch (error) {
      options.notice(`MCP 설정을 쓰지 않습니다: ${error instanceof McpConfigError ? error.message : '읽지 못했습니다'}`);
      continue;
    }
    for (const skipped of config.skipped) options.notice(`MCP 서버를 건너뜁니다: ${skipped}`);
    for (const server of config.servers) {
      for (const value of Object.values(server.headers)) {
        secrets.add(value);
        const bearer = /^Bearer\s+(.+)$/i.exec(value)?.[1];
        if (bearer) secrets.add(bearer);
      }
      const client = new Client({ name: 'b-studio-agent', version: '0.0.0' });
      const active = new Set<AbortController>();
      client.onerror = (error) => {
        for (const controller of active) controller.abort(error);
      };
      try {
        const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers }, fetch: cappedFetch(options.maxResponseBytes ?? MCP_MAX_RESPONSE_BYTES) });
        const connectSignal = AbortSignal.any([AbortSignal.timeout(connectTimeoutMs), ...(options.signal ? [options.signal] : [])]);
        await client.connect(transport, { signal: connectSignal });
        const tools: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
        let cursor: string | undefined;
        for (let page = 0; page < 20; page++) {
          const listed = await client.listTools(cursor ? { cursor } : {}, { signal: connectSignal });
          tools.push(...listed.tools);
          cursor = listed.nextCursor;
          if (!cursor || tools.length > maxTools) break;
        }
        clients.push(client);
        for (const tool of tools.slice(0, maxTools)) {
          const name = mcpToolName(server.name, tool.name);
          if (name.length > MAX_TOOL_NAME || registry.has(name)) {
            options.notice(`MCP 도구를 건너뜁니다: ${name.length > MAX_TOOL_NAME ? '이름이 너무 깁니다' : '이름이 겹칩니다'}(${server.name}의 ${tool.name})`);
            continue;
          }
          registry.set(name, { client, active, tool: tool.name, timeoutMs: callTimeoutMs });
          definitions.push({ name, description: tool.description ?? '', input_schema: tool.inputSchema as BetaTool['input_schema'] });
        }
        if (tools.length > maxTools) options.notice(`MCP 서버 ${server.name}의 도구가 ${maxTools}개를 넘어 앞의 ${maxTools}개만 씁니다`);
      } catch (error) {
        await client.close().catch(() => undefined);
        const reason = redact(error instanceof Error ? error.message : String(error));
        options.notice(`MCP 서버 ${server.name}에 연결하지 못해 그 도구 없이 시작합니다: ${reason.slice(0, 200)}`);
      }
    }
  }

  return {
    definitions,
    has: (name) => registry.has(name),
    async call(name, input, signal) {
      const target = registry.get(name);
      if (!target) return { text: `${name}: 알 수 없는 MCP 도구입니다`, isError: true };
      if (signal?.aborted) return { text: '중단되어 호출하지 않았습니다', isError: true };
      const own = new AbortController();
      target.active.add(own);
      try {
        const result = await target.client.callTool({ name: target.tool, arguments: input }, undefined, { signal: signal ? AbortSignal.any([signal, own.signal]) : own.signal, timeout: target.timeoutMs, maxTotalTimeout: target.timeoutMs });
        return mapMcpResult(result, maxChars);
      } catch (error) {
        const reason = own.signal.aborted && own.signal.reason instanceof Error ? own.signal.reason : error;
        return { text: `MCP 도구 호출에 실패했습니다: ${redact(reason instanceof Error ? reason.message : String(reason)).slice(0, 500)}`, isError: true };
      } finally {
        target.active.delete(own);
      }
    },
    async close() {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}
