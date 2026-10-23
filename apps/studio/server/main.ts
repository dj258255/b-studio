/**
 * 스튜디오 서버의 시작점(Next 없이 node:http로 돈다). `pnpm studio`(launch)가 tsx로 띄운다:
 *   tsx --tsconfig apps/studio/tsconfig.json apps/studio/server/main.ts --port 3000 --hostname 127.0.0.1
 * 포트·주소는 인자 → PORT·HOSTNAME 환경 변수 → 3000·127.0.0.1 차례다. 준비되면 주소 한 줄을 찍는다(launch는 /api/health로 따로 본다)
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createStudioHandler } from './app';
import { routes } from './routes.gen';

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function serverAddress(args: readonly string[], env: Record<string, string | undefined>): { port: number; hostname: string } {
  const rawPort = argValue(args, '--port') ?? argValue(args, '-p') ?? env.PORT ?? '3000';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`포트 값이 올바르지 않습니다: ${rawPort}`);
  const hostname = argValue(args, '--hostname') ?? argValue(args, '-H') ?? env.HOSTNAME ?? '127.0.0.1';
  return { port, hostname };
}

async function main(): Promise<void> {
  // 서버 코드는 Next와 같이 apps/studio를 작업 폴더로 여긴다(예제 폴더·저장소 루트를 여기서 찾는다)
  process.chdir(path.resolve(import.meta.dirname, '..'));
  const { port, hostname } = serverAddress(process.argv.slice(2), process.env);

  // Next의 instrumentation.ts가 하던 일: 시작할 때 로컬 토큰을 만들어 둔다(첫 요청을 기다리지 않는다)
  try {
    const { localToken } = await import('@/lib/server/local-token');
    localToken();
  } catch (error) {
    console.error('[b-studio] 로컬 토큰을 만들지 못했습니다:', error instanceof Error ? error.message : String(error));
  }

  const server = createServer(createStudioHandler({ routes }));
  // SSE 통로는 오래 열려 있다. 요청 시간 한도로 끊지 않는다
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, resolve);
  });
  const address = server.address() as AddressInfo;
  console.log(`b-studio 서버가 떴습니다: http://${hostname}:${address.port}`);

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    console.log(`[b-studio] ${signal} 신호를 받아 서버를 닫습니다`);
    server.close(() => process.exit(0));
    // 열린 SSE 연결이 닫기를 붙잡지 않게 남은 연결을 끊는다
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error: unknown) => {
    console.error('[b-studio] 서버를 띄우지 못했습니다:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
