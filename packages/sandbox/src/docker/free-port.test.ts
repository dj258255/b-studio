import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { findFreeHostPort } from './free-port';

describe('findFreeHostPort', () => {
  it('127.0.0.1에서 쓸 수 있는 포트 번호를 돌려준다', async () => {
    const port = await findFreeHostPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);

    // 돌려준 포트를 실제로 다시 바인드할 수 있어야 한다(진짜 비어 있었다는 뜻이다)
    await new Promise<void>((resolve, reject) => {
      const server = createServer();
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
    });
  });

  it('거듭 부르면 서로 다른 포트를 돌려준다', async () => {
    const [a, b] = await Promise.all([findFreeHostPort(), findFreeHostPort()]);
    expect(a).not.toBe(b);
  });
});
