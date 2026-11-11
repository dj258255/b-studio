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

  it('보통은 40000~59999 대역에서 돌려준다', async () => {
    // 대역의 포트 10개가 모두 막혀 있을 때만 OS 배정으로 돌아간다. 그 규칙(10번 시도, 돌아가기)은 Rust 단위 시험이 가짜 바인드로 본다
    const port = await findFreeHostPort();
    expect(port).toBeGreaterThanOrEqual(40_000);
    expect(port).toBeLessThanOrEqual(59_999);
  });
});
