import { requireUser } from '@/lib/server/access';
import { onAgentsChanged } from '@/lib/server/agents-pulse';
import { listAgentOverview } from '@/lib/server/agents-overview';
import { createAgentsFeed } from '@/lib/server/agents-stream';
import { errorResponse, StudioError } from '@/lib/server/errors';

/** 한 서버가 동시에 여는 목록 통로 수. desk 몇 개면 충분하다 — 끊기지 않은 통로가 쌓여 계산이 불어나지 않게 막는다 */
export const MAX_AGENT_STREAMS = 8;
/** 프록시가 유휴 연결을 끊지 않도록 주석 줄을 보내는 간격 */
const HEARTBEAT_MS = 15_000;

let open = 0;

/**
 * 에이전트 목록 통로(#923). desk가 1.5초마다 /api/agents를 묻던 것을 서버가 바뀔 때 밀어준다.
 * 처음에 전체를 보내고, 세션 이벤트·훅이 들어오면 다시 계산해 바뀐 항목만 보낸다(`agents-stream`).
 * 목록은 /api/agents와 같은 함수(listAgentOverview)로 만든다
 */
export async function GET(request: Request) {
  try {
    const user = requireUser(request.headers);
    if (open >= MAX_AGENT_STREAMS) throw new StudioError(429, '열린 목록 통로가 너무 많습니다. 쓰지 않는 desk를 닫아 주세요');
    open += 1;
    const encoder = new TextEncoder();
    let cleanup = () => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const write = (chunk: string): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            cleanup();
          }
        };
        const feed = createAgentsFeed({
          compute: () => listAgentOverview(user),
          onChange: onAgentsChanged,
          send: (message) => write(`data: ${JSON.stringify(message)}\n\n`),
        });
        const heartbeat = setInterval(() => write(': ping\n\n'), HEARTBEAT_MS);
        cleanup = () => {
          if (closed) return;
          closed = true;
          open -= 1;
          clearInterval(heartbeat);
          feed.stop();
          try {
            controller.close();
          } catch {
            // 이미 닫힌 스트림
          }
        };
        request.signal.addEventListener('abort', cleanup, { once: true });
        void feed.start();
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
