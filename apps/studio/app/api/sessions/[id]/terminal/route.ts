import { z } from 'zod';
import { authorizeSession } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { closeSessionTerminal, MAX_TERMINAL_INPUT, openSessionTerminal, resizeSessionTerminal, subscribeSessionTerminal, writeSessionTerminal, type TerminalMessage } from '@/lib/server/session-terminal';
import { sessionTerminalTarget } from '@/lib/server/sessions';
import { assertTerminalAccess } from '@/lib/server/terminal-access';

const size = { cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) };
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), ...size }),
  z.object({ action: z.literal('input'), data: z.string().min(1).max(MAX_TERMINAL_INPUT) }),
  z.object({ action: z.literal('resize'), ...size }),
  z.object({ action: z.literal('close') }),
]);

/**
 * 단일 터미널 통로의 쓰기와 정리(B4 2차). 묶음 통로(terminals/stream/route.ts)의 같은 함수와 같은 꼴이다 —
 * 쓰기(controller.enqueue)가 실패하면(소비자가 끊김) 그 자리에서 정리한다. "닫힘 표시(closed)"와 "정리 끝남(cleaned)"을
 * 따로 두어, 어느 길로 닫히든(쓰기 실패·abort·cancel) 정리가 한 번은 돈다. 단일 통로는 id 없이 메시지를 그대로 싣는다
 */
export function createTerminalSse(controller: ReadableStreamDefaultController<Uint8Array>) {
  const encoder = new TextEncoder();
  let closed = false;
  let cleaned = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;

  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    closed = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    unsubscribe?.();
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
      // 쓰기가 실패하면 곧바로 정리한다
      cleanup();
    }
  };

  return {
    cleanup,
    closed: () => closed,
    /** 메시지 한 조각을 SSE로 보낸다 */
    message: (message: TerminalMessage) => write(`data: ${JSON.stringify(message)}\n\n`),
    /** 연결이 끊기면 풀 구독을 등록한다 */
    track: (stop: () => void) => {
      unsubscribe = stop;
    },
    /** 프록시가 유휴 연결을 끊지 않도록 주기적으로 주석 줄을 보낸다 */
    startHeartbeat: () => {
      heartbeat = setInterval(() => write(': ping\n\n'), 15_000);
    },
  };
}

/**
 * 세션 터미널의 출력을 Server-Sent Events로 흘려보낸다(이슈 #673). 연결하면 최근 출력과 지금 상태를 곧바로 받는다.
 * 출력은 화면 제어 문자가 섞인 바이트라 base64로 싣고, 세션 기록에는 남기지 않는다
 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/terminal'>) {
  let cleanup = () => {};

  try {
    const user = await assertTerminalAccess(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    // 쓸 수 없는 서버에서는 통로 자체를 열지 않는다
    sessionTerminalTarget(id);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const out = createTerminalSse(controller);
        cleanup = out.cleanup;
        out.track(subscribeSessionTerminal(id, (message) => out.message(message)));
        out.startHeartbeat();
        request.signal.addEventListener('abort', out.cleanup, { once: true });
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

/**
 * 터미널을 열고, 입력을 보내고, 크기를 바꾸고, 닫는다. 컨테이너 안의 셸에 닿는 일이라 세션을 바꿀 수 있는 사람만 쓴다.
 * 다른 출처에서 온 쓰기 요청은 앞단(proxy)이 거절한다
 */
export async function POST(request: Request, context: RouteContext<'/api/sessions/[id]/terminal'>) {
  try {
    const user = await assertTerminalAccess(request.headers);
    const { id } = await context.params;
    await authorizeSession(id, user);
    const target = sessionTerminalTarget(id);
    const parsed = requestSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) throw new StudioError(400, `터미널 요청이 올바르지 않습니다: ${parsed.error.issues[0]?.message ?? '형식 오류'}`);
    const body = parsed.data;

    switch (body.action) {
      case 'open':
        await openSessionTerminal(id, target, body);
        return Response.json({ ok: true });
      case 'input':
        writeSessionTerminal(id, body.data);
        return Response.json({ ok: true });
      case 'resize':
        await resizeSessionTerminal(id, body);
        return Response.json({ ok: true });
      case 'close':
        closeSessionTerminal(id);
        return Response.json({ ok: true });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
