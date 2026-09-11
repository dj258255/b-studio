import { requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { recoverSessions, subscribe } from '@/lib/server/sessions';
import type { StudioEvent } from '@/lib/studio-events';

/** 세션 이벤트를 Server-Sent Events로 흘려보낸다. 연결하면 지금 상태와 지금까지의 기록부터 보낸다 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/events'>) {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  try {
    requireUser(request.headers);
    const { id } = await context.params;
    // 스튜디오 서버가 다시 시작된 뒤 열려 있던 화면이 다시 연결하면 이전 세션 기록을 보낸다
    await recoverSessions();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const write = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        };

        const unsubscribe = subscribe(id, (event: StudioEvent) => write(`data: ${JSON.stringify(event)}\n\n`));
        // 프록시가 유휴 연결을 끊지 않도록 주기적으로 주석 줄을 보낸다
        const heartbeat = setInterval(() => write(': ping\n\n'), 15_000);

        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // 이미 닫힌 스트림
          }
        };
        request.signal.addEventListener('abort', cleanup, { once: true });
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
    return errorResponse(error);
  }
}
