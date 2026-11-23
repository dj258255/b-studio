import { randomBytes } from 'node:crypto';
import { decodeNative, encodeLoneSurrogates, native, type NativeToolLedger } from '@b-studio/sandbox';
import { decodeLoneSurrogates } from './lone-surrogates';
import { zodShape } from './tool-schema';
import type { buildTools, ToolOutcome } from './tools';

/** 모델이 b-studio 도구만 부르게 하려고 러너가 띄우는 로컬 MCP 서버. 끝나면 반드시 close()를 부른다 */
export interface ToolServer {
  url: string;
  port: number;
  /** 이 실행에서만 쓰는 bearer 토큰. 로그에 남기지 않는다 */
  token: string;
  close(): Promise<void>;
}

export interface ToolServerOptions {
  /**
   * buildTools가 만든 도구 목록. 스키마는 여기 한 곳에서만 정의한다.
   * 함수로 주면 요청마다 부른다 — 서버가 오래 살아 있는 동안 프로젝트 설정(서비스 이름)이 바뀌는 자리(세션 터미널)에서 쓴다
   */
  specs: ReturnType<typeof buildTools> | (() => ReturnType<typeof buildTools>);
  /** 도구 실행을 러너에 넘긴다. 순서 보장과 이벤트 알림은 부르는 쪽이 맡는다 */
  run: (name: string, args: unknown) => Promise<ToolOutcome>;
  name?: string;
  /** 스키마의 required에 없는 인자를 선택으로 연다(zodShape의 honorRequired). 선택 인자가 있는 도구(탐색형 QA)가 쓴다 */
  honorRequired?: boolean;
  /**
   * 루프백 말고도 받을 Host 이름. 컨테이너 안의 CLI는 호스트를 `host.docker.internal`로 부르므로 그 이름을 여기에 넣는다.
   * 넣지 않으면 루프백 이름만 받는다
   */
  allowedHosts?: readonly string[];
  /**
   * 도구 순서 장부(ADR-202, 트러블슈팅 206). 주면 `tools/call`이 `run`을 부르기 **전에** 이 장부를 지난다: 도착 순서대로 하나씩 실행하고,
   * 그 도구의 `tool_use`를 본 뒤에 실행하며(대기 상한을 넘기면 그대로), 닫혔거나 취소됐으면 `run`을 부르지 않고 isError 결과로 거절한다.
   * 주지 않으면(실험 러너) 지금처럼 요청이 오는 대로 `run`을 부른다 — 순서 보장은 부르는 쪽이 맡는다
   */
  ledger?: NativeToolLedger;
}

/**
 * b-studio 도구를 로컬 streamable HTTP MCP 서버로 노출한다.
 * Codex CLI는 `-c mcp_servers.<이름>.url=...`로 이 주소를 받고, 토큰은 환경 변수로만 넘긴다(파일에 쓰지 않는다).
 * 127.0.0.1의 임의 포트에만 열고, 실행마다 새 bearer 토큰을 만들어 그 토큰이 맞는 요청만 받는다.
 *
 * 전송과 프로토콜은 Rust가 한다(ADR-201, crates/bstudio-io/src/loopback_server.rs·mcp_server.rs): 포트 열기, Host·토큰 확인, streamable HTTP(stateless),
 * JSON-RPC 해석·분배, 도구 인자 검사(`zodShape` 규칙: 모르는 키를 지우고 정수는 JS 안전 정수만), SSE 쓰기, 닫기. 여기는 Rust가 부르는 두 가지만 맡는다:
 * 도구 목록 얻기(`specs`가 함수면 요청마다)와 도구 실행(`run`). 옛 `node:http` + `@modelcontextprotocol/sdk` 서버는 지웠다(#1347).
 * 글자는 `encodeLoneSurrogates`한 꼴로 오간다(짝 없는 서로게이트가 경계에서 합쳐지지 않게).
 */
export async function startToolServer({ specs, run, name = 'b-studio', allowedHosts = [], honorRequired = false, ledger }: ToolServerOptions): Promise<ToolServer> {
  const token = randomBytes(24).toString('hex');
  const { id, port } = await native.startMcpServer(token, allowedHosts.map(encodeLoneSurrogates), encodeLoneSurrogates(name), honorRequired, async (call) => {
    if (call.kind === 'list') {
      try {
        const list = typeof specs === 'function' ? specs() : specs;
        // 지원하지 않는 입력 형식은 여기서 던진다(Rust는 `zodShape`가 받는 꼴만 읽는다). 던지면 그 요청은 500이다
        for (const spec of list) zodShape(spec.input_schema as { properties?: unknown; required?: unknown }, { honorRequired });
        const encoded = encodeLoneSurrogates(JSON.stringify(list.map((spec) => ({ name: spec.name, description: spec.description, input_schema: spec.input_schema }))));
        return { specs: encoded, ok: true, content: '', images: [] };
      } catch (error) {
        return { error: describe(error), ok: false, content: '', images: [] };
      }
    }
    try {
      const args = decodeStrings(decodeNative<unknown>(call.args));
      const outcome = await run(decodeLoneSurrogates(call.name), args);
      const images = (outcome.images ?? []).map((image) => ({ data: encodeLoneSurrogates(image.data), mimeType: encodeLoneSurrogates(image.mimeType) }));
      return { ok: Boolean(outcome.ok), content: encodeLoneSurrogates(outcome.content), images };
    } catch (error) {
      // 처리가 던지면 그 메시지로 isError 결과다(옛 SDK 서버와 같다)
      return { ok: false, content: encodeLoneSurrogates(describe(error)), images: [] };
    }
  }, ledger ?? null);

  let closed = false;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    token,
    async close() {
      if (closed) return;
      closed = true;
      await native.closeLoopbackServer(id);
    },
  };
}

/** Rust가 `encodeLoneSurrogates`한 꼴로 보낸 값의 글자(값과 키)를 원래 글자로 되돌린다 */
function decodeStrings(value: unknown): unknown {
  if (typeof value === 'string') return decodeLoneSurrogates(value);
  if (Array.isArray(value)) return value.map(decodeStrings);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[decodeLoneSurrogates(key)] = decodeStrings(item);
    return out;
  }
  return value;
}

/** 호스트·토큰은 견주는 값이라(여는 쪽) 짝 없는 서로게이트가 경계에서 U+FFFD로 합쳐지지 않게 단사로 바꿔 보낸다. 없는 값은 그대로 없다 */
function encodeOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : encodeLoneSurrogates(value);
}

/** 통과하면 undefined, 막으면 응답할 상태와 이유. 판정은 Rust(crates/bstudio-guard/src/connection_judge.rs) */
export function authorize(host: string | undefined, authorization: string | undefined, token: string, allowedHosts: readonly string[]): { status: number; message: string } | undefined {
  const denied = native.connAuthorize(encodeOptional(host), encodeOptional(authorization), encodeLoneSurrogates(token), allowedHosts.map(encodeLoneSurrogates));
  return denied === null || denied === undefined ? undefined : decodeNative<{ status: number; message: string }>(denied);
}

/** Host 헤더가 루프백 이름이거나 따로 허용한 이름인가(여는 쪽). 이름은 대소문자를 가리지 않는다 */
export function hostAllowed(host: string | undefined, allowedHosts: readonly string[] = []): boolean {
  return native.connHostAllowed(encodeOptional(host), allowedHosts.map(encodeLoneSurrogates));
}

/**
 * bearer 토큰을 값의 위치와 길이에 따라 시간이 달라지지 않게 비교한다(Rust, 여는 쪽). 빈 토큰은 맞지 않는다.
 * 게시판 MCP 라우트(board-mcp-server.ts를 부르는 쪽)도 같은 비교가 필요해 밖으로 연다.
 */
export function tokenMatches(authorization: string | undefined, token: string): boolean {
  return native.connTokenMatches(encodeOptional(authorization), encodeLoneSurrogates(token));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
