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

  it('바인드 확인 함수를 주입하면 40000~59999 대역에서 먼저 시도한다', async () => {
    const tried: number[] = [];
    const port = await findFreeHostPort(async (candidate) => {
      tried.push(candidate);
      return true;
    });

    expect(tried).toHaveLength(1);
    expect(port).toBe(tried[0]);
    expect(port).toBeGreaterThanOrEqual(40_000);
    expect(port).toBeLessThanOrEqual(59_999);
  });

  it('대역에서 몇 번 막혀도 비는 포트를 찾을 때까지 계속 시도한다', async () => {
    let calls = 0;
    const port = await findFreeHostPort(async () => {
      calls += 1;
      return calls >= 3;
    });

    expect(calls).toBe(3);
    expect(port).toBeGreaterThanOrEqual(40_000);
    expect(port).toBeLessThanOrEqual(59_999);
  });

  it('대역이 전부 막혀 있으면 OS 자동 배정(포트 0)으로 돌아간다', async () => {
    const port = await findFreeHostPort(async () => false);

    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);
  });
});
