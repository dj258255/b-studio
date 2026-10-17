import { authorizeSession } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { subscribeSessionTerminal, type TerminalMessage } from '@/lib/server/session-terminal';
import { sessionTerminalTarget } from '@/lib/server/sessions';
import { assertTerminalAccess } from '@/lib/server/terminal-access';
import { parseSplitIds } from '@/lib/split';

/** 묶음 통로가 흘리는 한 조각. 어느 세션의 출력인지 함께 싣는다 */
interface BundledTerminalMessage {
  id: string;
  message: TerminalMessage;
}

/**
 * SSE 통로의 쓰기와 정리(B4). 쓰기(controller.enqueue)가 실패하면(소비자가 끊겨 스트림이 닫힌 뒤 등)
 * 그 자리에서 정리한다. "닫힘 표시(closed)"와 "정리 끝남(cleaned)"을 따로 두어, 어느 길로 닫히든
 * (쓰기 실패·abort·cancel) 정리가 한 번은 돈다. 테스트가 가짜 컨트롤러를 끼울 수 있게 export한다
 */
export function createTerminalStream(controller: ReadableStreamDefaultController<Uint8Array>) {
  const encoder = new TextEncoder();
  let closed = false;
  let cleaned = false;
  const unsubscribes: Array<() => void> = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    closed = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    for (const unsubscribe of unsubscribes) unsubscribe();
    try {
      controller.close();
    } catch {
      // 이미 닫힌 스트림
    }
  };

  const write = (chunk: string): void => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      // 쓰기가 실패하면(소비자가 끊김) 곧바로 정리한다
      cleanup();
    }
  };

  return {
    cleanup,
    closed: () => closed,
    /** 메시지 한 조각을 SSE로 보낸다 */
    message: (id: string, message: TerminalMessage) => write(`data: ${JSON.stringify({ id, message } satisfies BundledTerminalMessage)}\n\n`),
    /** 연결이 끊기면 풀 구독을 등록한다 */
    track: (unsubscribe: () => void) => {
      unsubscribes.push(unsubscribe);
    },
    /** 프록시가 유휴 연결을 끊지 않도록 주기적으로 주석 줄을 보낸다 */
    startHeartbeat: () => {
      heartbeat = setInterval(() => write(': ping\n\n'), 15_000);
    },
  };
}

/**
 * 나란히 보기에서 터미널 출력을 한 연결로 묶는다(B4). 칸이 몇 개든 출력용 연결은 하나다 —
 * 브라우저는 HTTP/1.1에서 한 주소에 6개까지만 연결을 열어서, 칸마다 터미널 통로를 열면 4칸에서 연결이 모자란다.
 *
 * 검사는 한 세션용 터미널 통로와 같다(같은 공통 함수 `assertTerminalAccess`를 쓴다). 다만 id 하나가 실패해도
 * 통로 전체를 닫지 않는다: 그 id만 닫힘으로 한 번 알리고 그 id를 빼고 나머지를 계속 흘린다
 */
export async function GET(request: Request) {
  let cleanup = () => {};

  try {
    const user = await assertTerminalAccess(request.headers);
    const ids = parseSplitIds(new URL(request.url).searchParams.get('ids') ?? undefined);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const out = createTerminalStream(controller);
        cleanup = out.cleanup;
        out.startHeartbeat();
        request.signal.addEventListener('abort', out.cleanup, { once: true });

        // id마다 검사하고 구독한다. 권한이 없거나 쓸 수 없는 id는 그 id만 닫힘으로 알린다(통로 전체를 막지 않는다).
        // 검사(await)를 기다리는 동안 연결이 끊겼으면(closed) 구독을 붙이지 않는다
        void (async () => {
          for (const id of ids) {
            if (out.closed()) return;
            try {
              await authorizeSession(id, user);
              // 검사를 기다리는 사이 끊겼으면 붙이지 않는다
              if (out.closed()) return;
              // 쓸 수 없는 서버(실험 기능이 꺼졌거나 개인 PC 모드가 아님)나 멈춘 세션이면 여기서 던진다
              sessionTerminalTarget(id);
              if (out.closed()) return;
              const unsubscribe = subscribeSessionTerminal(id, (message) => out.message(id, message));
              out.track(unsubscribe);
              // 붙이는 사이 끊겼으면 즉시 푼다
              if (out.closed()) unsubscribe();
            } catch (error) {
              out.message(id, { kind: 'status', state: 'closed', message: error instanceof Error ? error.message : String(error) });
            }
          }
        })();
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    cleanup();
    return errorResponse(error);
  }
}
