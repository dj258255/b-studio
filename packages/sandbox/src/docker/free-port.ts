import { native } from '../native';

/**
 * 런타임 공개 URL 주입(fix/frontend-backend-url)에서 쓴다. 다른 서비스가 참조할 서비스는 `docker compose up` 전에
 * 호스트 포트를 미리 정해야(pre-allocate) 그 주소를 환경 변수로 넣어 줄 수 있다(포트는 보통 `up` 뒤에야 안다).
 *
 * 40000~59999 대역에서 무작위 포트를 몇 번 직접 바인드해 보고, 다 막혀 있으면 OS에 포트 0으로 받는다(colima VM의 동적 포트 대역과 떨어뜨려
 * 호스트에서는 비어 보이는데 VM 안에서는 쓰는 충돌을 줄이려는 것). 찾는 규칙과 한계는 Rust(crates/bstudio-io/src/host_port.rs)에 적었다.
 * 충돌로 `compose up`이 실패하면 compose-provider.ts의 재시도가 다룬다. 루프백(127.0.0.1)에서만 찾는다 — edge가 그 주소에만 포트를 공개한다.
 *
 * 옛 구현은 바인드 확인 함수를 주입받았다(시험용). 호출하는 곳이 없어 없앴고, 대역·재시도 규칙은 Rust 단위 시험이 가짜 확인 함수로 본다
 */
export async function findFreeHostPort(): Promise<number> {
  return native.findFreeHostPort();
}
