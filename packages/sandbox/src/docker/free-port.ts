import { createServer } from 'node:net';

/** 포트 하나가 127.0.0.1에서 비어 있는지 확인하는 함수 모양. 테스트가 실제 바인드 대신 가짜로 주입한다 */
export type BindTester = (port: number) => Promise<boolean>;

/** 무작위로 먼저 시도할 대역. colima/Docker가 컨테이너 포트를 동적으로 퍼뜨리는 32768~32799대와 떨어뜨려
 *  호스트에서는 비어 보이는데 VM 안에서는 이미 다른 컨테이너가 쓰고 있을 확률을 낮춘다(아래 설명 참고) */
const HIGH_BAND_START = 40_000;
const HIGH_BAND_END = 59_999;
/** 이 대역에서 바인드를 시도할 횟수. 다 막혀 있으면 포트 0(OS 자동 배정)으로 돌아간다 */
const HIGH_BAND_TRIES = 10;

function randomHighBandPort(): number {
  return HIGH_BAND_START + Math.floor(Math.random() * (HIGH_BAND_END - HIGH_BAND_START + 1));
}

/** 실제로 포트를 127.0.0.1에 바인드해 보고 바로 닫는다. 바인드되면 비어 있던 것이다 */
const realBindTester: BindTester = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });

/** OS에 포트 0으로 소켓을 열게 해 비어 있는 포트 하나를 받고 바로 닫는다(예전 구현, 대역 시도가 모두 막혔을 때의 fallback) */
function listenForFreePort(): Promise<number> {
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

/**
 * 런타임 공개 URL 주입(fix/frontend-backend-url)에서 쓴다. 다른 서비스가 참조할 서비스는 `docker compose up` 전에
 * 호스트 포트를 미리 정해야(pre-allocate) 그 주소를 환경 변수로 넣어 줄 수 있다(포트는 보통 `up` 뒤에야 안다).
 *
 * 먼저 40000~59999 대역에서 무작위 포트를 몇 번 직접 바인드해 본다. 그래도 다 막혀 있으면 OS에 포트 0으로
 * 소켓을 열게 해 비어 있는 포트를 받는 예전 방식으로 돌아간다 — 두 방식 모두 닫은 뒤 compose가 그 포트를
 * 집기 전에 다른 프로세스가 먼저 쓸 수도 있는 좁은 경합 구간이 있다(널리 쓰는 "find free port" 패턴과 같은
 * 한계다). 더 근본적인 한계: 이 확인은 macOS 호스트에서 하는데 실제 바인드는 colima VM 안에서 일어나는
 * 컨테이너가 한다. 호스트에서는 비어 보여도 VM 안에서 다른 컨테이너가 이미 그 포트를 쓰고 있으면 `compose up`이
 * 실패한다(troubleshooting.md 참고) — 그 실패는 compose-provider.ts의 재시도 로직이 다룬다, 이 함수는 애초에
 * 충돌 확률을 낮추는 역할만 한다.
 * 루프백(127.0.0.1)에서만 찾는다 — edge가 그 주소에만 포트를 공개하기 때문에 맞춰 둔다
 */
export async function findFreeHostPort(bindTest: BindTester = realBindTester): Promise<number> {
  for (let attempt = 0; attempt < HIGH_BAND_TRIES; attempt++) {
    const port = randomHighBandPort();
    if (await bindTest(port)) return port;
  }
  return listenForFreePort();
}
