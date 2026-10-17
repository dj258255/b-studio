import { z } from 'zod';
import { authorizeSession, requireUser } from '@/lib/server/access';
import { authConfig, isLoopbackHost } from '@/lib/server/auth';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { hasLocalToken, LOCAL_TOKEN_COOKIE } from '@/lib/server/local-token';
import { closeSessionTerminal, MAX_TERMINAL_INPUT, openSessionTerminal, resizeSessionTerminal, subscribeSessionTerminal, writeSessionTerminal } from '@/lib/server/session-terminal';
import { recoverSessions, sessionTerminalTarget } from '@/lib/server/sessions';

/**
 * 터미널은 컨테이너 안의 셸에 닿는 통로다. 이 컴퓨터의 주소로 들어온 요청만 받는다.
 * 개인 PC 모드에는 인증이 없어서, 다른 사이트가 자기 도메인을 127.0.0.1로 풀리게 하면(DNS 리바인딩) 같은 출처로 보인다
 */
function assertLocalRequest(headers: Headers): void {
  if (!isLoopbackHost(headers)) throw new StudioError(403, '세션 터미널은 이 컴퓨터의 주소(127.0.0.1 · localhost)로 연 화면에서만 씁니다');
}

/**
 * 개인 PC 모드의 터미널 통로는 `studio launch`가 심은 로컬 토큰 쿠키가 있어야 쓴다(ADR-173 덧붙임).
 * 같은 컴퓨터의 다른 프로세스가 스튜디오 포트로 보내는 요청을 가릴 수단이 인증에는 없기 때문이다. 인증을 켠 서버(token·proxy)는 로그인으로 충분하다
 */
function assertLocalToken(headers: Headers): void {
  if (authConfig().mode !== 'none') return;
  if (!hasLocalToken(cookieValue(headers, LOCAL_TOKEN_COOKIE))) {
    throw new StudioError(403, '터미널은 `pnpm studio launch`가 연 창에서 씁니다. 다른 창이면 launch가 찍은 주소로 여세요');
  }
}

/** Cookie 헤더에서 이름 하나의 값을 꺼낸다 */
function cookieValue(headers: Headers, name: string): string | undefined {
  const header = headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

const size = { cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) };
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('open'), ...size }),
  z.object({ action: z.literal('input'), data: z.string().min(1).max(MAX_TERMINAL_INPUT) }),
  z.object({ action: z.literal('resize'), ...size }),
  z.object({ action: z.literal('close') }),
]);

/**
 * 세션 터미널의 출력을 Server-Sent Events로 흘려보낸다(이슈 #673). 연결하면 최근 출력과 지금 상태를 곧바로 받는다.
 * 출력은 화면 제어 문자가 섞인 바이트라 base64로 싣고, 세션 기록에는 남기지 않는다
 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/terminal'>) {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  try {
    assertLocalRequest(request.headers);
    assertLocalToken(request.headers);
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
    await authorizeSession(id, user);
    // 쓸 수 없는 서버에서는 통로 자체를 열지 않는다
    sessionTerminalTarget(id);
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
        const unsubscribe = subscribeSessionTerminal(id, (message) => write(`data: ${JSON.stringify(message)}\n\n`));
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
    assertLocalRequest(request.headers);
    assertLocalToken(request.headers);
    const user = requireUser(request.headers);
    const { id } = await context.params;
    await recoverSessions();
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
