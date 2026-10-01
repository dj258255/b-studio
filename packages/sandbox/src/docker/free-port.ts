import { createServer } from 'node:net';

/**
 * 런타임 공개 URL 주입(fix/frontend-backend-url)에서 쓴다. 다른 서비스가 참조할 서비스는 `docker compose up` 전에
 * 호스트 포트를 미리 정해야(pre-allocate) 그 주소를 환경 변수로 넣어 줄 수 있다(포트는 보통 `up` 뒤에야 안다).
 * OS에 포트 0으로 소켓을 열게 해 비어 있는 포트 하나를 받고 바로 닫는다 — 닫은 뒤 compose가 그 포트를 집기 전에
 * 다른 프로세스가 먼저 쓸 수도 있는 좁은 경합 구간이 있다(널리 쓰는 "find free port" 패턴과 같은 한계다).
 * 루프백(127.0.0.1)에서만 찾는다 — edge가 그 주소에만 포트를 공개하기 때문에 맞춰 둔다
 */
export function findFreeHostPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((closeError) => {
        if (closeError) reject(closeError);
        else if (!port) reject(new Error('빈 포트를 찾지 못했습니다'));
        else resolve(port);
      });
    });
  });
}
