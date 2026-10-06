import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { spawnReadonlyDocker } from '@b-studio/sandbox';
import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { requireSameOrigin, resolveLogTarget } from '@/lib/server/my-env';

/**
 * 사용자가 직접 띄운 컨테이너 한 개의 로그를 Server-Sent Events로 흘려보낸다(tail 200 + follow).
 * resolveLogTarget이 요청한 컨테이너가 정말 이 프로젝트 폴더에서 뜬 것인지 먼저 확인하므로,
 * 다른 프로젝트의 컨테이너 id를 넣어도 읽을 수 없다. docker 호출은 읽기 전용 화이트리스트(spawnReadonlyDocker)만 쓴다
 */
export async function GET(request: Request, context: RouteContext<'/api/sessions/[id]/my-env/logs'>) {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  try {
    requireSameOrigin(request.headers);
    requireUser(request.headers);
    const { id } = await context.params;
    const container = new URL(request.url).searchParams.get('container');
    if (!container) throw new StudioError(400, 'container 쿼리 파라미터가 필요합니다');
    const { dockerBin, containerId } = await resolveLogTarget(id, container);

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

        const child = spawnReadonlyDocker(dockerBin, ['logs', '--follow', '--timestamps', '--tail', '200', containerId]);
        child.on('error', () => {});
        const lineReaders = [child.stdout, child.stderr]
          .filter((stream): stream is Readable => Boolean(stream))
          .map((output) =>
            createInterface({ input: output, crlfDelay: Infinity }).on('line', (line) => {
              if (line.trim()) write(`data: ${JSON.stringify({ text: line })}\n\n`);
            }),
          );
        const heartbeat = setInterval(() => write(': ping\n\n'), 15_000);

        cleanup = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          for (const reader of lineReaders) reader.close();
          child.kill();
          try {
            controller.close();
          } catch {
            // 이미 닫혔으면 둔다
          }
        };
        child.on('close', cleanup);
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
