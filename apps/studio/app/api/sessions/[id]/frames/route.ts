import { authorizeSession, requireUser } from '@/lib/server/access';
import { errorResponse } from '@/lib/server/errors';
import { subscribe } from '@/lib/server/live-frames';
import { recoverSessions } from '@/lib/server/sessions';

/**
 * 화면 확인과 원격 브라우저의 실시간 프레임을 Server-Sent Events로 흘려보낸다.
 * 프레임은 세션 기록에 남기지 않는다. 연결하면 마지막 한 장을 곧바로 받고, 연결이 끊기면 구독을 푼다
 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/frames'>) {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  try {
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    await authorizeSession(id, user);
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
        const unsubscribe = subscribe(id, (message) => write(`data: ${JSON.stringify(message)}\n\n`));
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
