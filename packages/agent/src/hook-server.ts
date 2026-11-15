import { randomBytes } from 'node:crypto';
import { encodeLoneSurrogates, native } from '@b-studio/sandbox';

/**
 * 에이전트 CLI의 훅 명령이 부르는 서버(이슈 #670·#673).
 * 요청 본문은 CLI가 훅에 준 JSON이고, 응답은 CLI가 훅의 출력으로 읽을 JSON이다. 127.0.0.1의 임의 포트에만 열고,
 * 서버마다 새로 만든 bearer 토큰이 맞는 요청만 받는다.
 *
 * 전송은 Rust가 한다(ADR-201, crates/bstudio-io/src/loopback_server.rs): 포트 열기, Host·토큰 확인, 메서드와 요청 대상 원문의 라우트 비교,
 * 본문 4MiB 상한, 닫기. 여기는 Rust가 넘긴 원래 바이트를 옛 서버와 똑같이 읽고(`JSON.parse`) 처리를 부른다. 본문 해석을 Rust로 옮기지 않은 이유는
 * `JSON.parse`와 받는 입력이 다르면(짝 없는 서로게이트 이스케이프, 중복 키, 큰 수) 입력을 `{}`로 두던 자리가 달라지기 때문이다.
 * 옛 `node:http` 서버는 `hook-server-legacy.ts`에 있다(차등 시험의 기준값).
 */

/** CLI가 훅에 준 입력. 필드는 훅 종류마다 달라 쓰는 쪽이 꺼내 확인한다(바깥에서 온 값이다) */
export type HookInput = Readonly<Record<string, unknown>>;
export type HookHandler = (input: HookInput) => Promise<Record<string, unknown>>;

export interface HookServer {
  /** 뒤에 경로(/stop 등)를 붙여 부른다 */
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

export interface HookServerOptions {
  /**
   * 루프백 말고도 받을 Host 이름. 컨테이너 안의 CLI는 호스트를 `host.docker.internal`로 부르므로 그 이름을 여기에 넣는다.
   * 넣지 않으면 루프백 이름만 받는다(브라우저가 다른 이름으로 이 포트를 부르게 만드는 DNS 재바인딩을 막는다)
   */
  allowedHosts?: readonly string[];
}

export async function startHookServer(routes: Readonly<Record<string, HookHandler>>, { allowedHosts = [] }: HookServerOptions = {}): Promise<HookServer> {
  const token = randomBytes(24).toString('hex');
  // 옛 서버는 `Object.hasOwn(routes, url)`로 요청마다 찾았다. 이름은 시작할 때의 것으로 고정하고(Rust가 요청 대상 원문과 견준다), 처리는 부를 때 찾는다
  const names = Object.getOwnPropertyNames(routes);
  const { id, port } = await native.startLoopbackServer(token, allowedHosts.map(encodeLoneSurrogates), names.map(encodeLoneSurrogates), async ({ route, body }) => {
    const handler = Object.hasOwn(routes, names[route] ?? '') ? routes[names[route] as string] : undefined;
    if (!handler) return reply(404, { error: 'not found' });
    let input: HookInput = {};
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8') || '{}');
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) input = parsed as HookInput;
    } catch {
      // 훅 입력을 읽지 못해도 검증은 돈다. 입력은 요약에만 쓴다
    }
    try {
      return reply(200, await handler(input));
    } catch (error) {
      // 5xx로 답한다. 훅 명령이 이것을 어떻게 다룰지는 쓰는 쪽이 정한다(관문 러너의 PreToolUse는 거절로 바꾼다)
      return reply(500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  let closed = false;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    token,
    async close() {
      if (closed) return;
      closed = true;
      await native.closeLoopbackServer(id);
    },
  };
}

function reply(status: number, body: unknown): { status: number; body: Buffer } {
  return { status, body: Buffer.from(JSON.stringify(body) ?? '', 'utf8') };
}
