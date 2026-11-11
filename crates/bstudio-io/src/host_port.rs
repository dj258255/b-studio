//! 호스트에서 미리 정해 둘 빈 포트(옛 TS: `packages/sandbox/src/docker/free-port.ts`, ADR-195 4f A4a).
//!
//! `deploy_io::free_port`(포트 0으로 OS에 받기)와 뜻이 다르다. 이쪽은 먼저 40000~59999 대역에서 무작위 포트를 몇 번 직접 바인드해 본다.
//! colima/Docker가 컨테이너 포트를 동적으로 퍼뜨리는 32768대와 떨어뜨려, 호스트에서는 비어 보이는데 VM 안에서는 이미 다른 컨테이너가 쓰고
//! 있을 확률을 낮추려는 것이다. 대역이 모두 막혀 있을 때만 `free_port`로 돌아간다.
//!
//! 한계(옛 TS와 같다): 닫은 뒤 compose가 그 포트를 집기 전에 다른 프로세스가 먼저 쓸 수 있고, 확인은 호스트에서 하는데 실제 바인드는
//! VM 안의 컨테이너가 한다. 그 실패는 compose-provider의 재시도가 다룬다. 루프백(127.0.0.1)에서만 찾는다 — edge가 그 주소에만 포트를 공개한다.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::net::TcpListener;

/// 무작위로 먼저 시도할 대역
pub const HIGH_BAND_START: u16 = 40_000;
pub const HIGH_BAND_END: u16 = 59_999;
/// 이 대역에서 바인드를 시도할 횟수. 다 막혀 있으면 포트 0(OS 자동 배정)으로 돌아간다
pub const HIGH_BAND_TRIES: usize = 10;

fn random_high_band_port() -> u16 {
    // 프로세스마다 무작위로 정해지는 키를 쓰는 해시. 부를 때마다 다른 키라 값이 다르다
    let seed = RandomState::new().build_hasher().finish();
    HIGH_BAND_START + (seed % u64::from(HIGH_BAND_END - HIGH_BAND_START + 1)) as u16
}

/// 실제로 포트를 127.0.0.1에 바인드해 보고 바로 닫는다. 바인드되면 비어 있던 것이다
fn real_bind_test(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// 후보를 고르는 쪽과 바인드를 확인하는 쪽을 받는 판. 시험이 가짜를 넣는다
pub fn find_free_host_port_with(mut candidate: impl FnMut() -> u16, mut bind_test: impl FnMut(u16) -> bool, fallback: impl FnOnce() -> io::Result<u16>) -> io::Result<u16> {
    for _ in 0..HIGH_BAND_TRIES {
        let port = candidate();
        if bind_test(port) {
            return Ok(port);
        }
    }
    fallback()
}

/// 127.0.0.1에서 비어 있는 호스트 포트 하나
pub fn find_free_host_port() -> io::Result<u16> {
    find_free_host_port_with(random_high_band_port, real_bind_test, crate::deploy_io::free_port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 대역에서_첫_후보가_비면_그것을_돌려준다() {
        let mut tried = Vec::new();
        let port = find_free_host_port_with(
            || 41_000,
            |p| {
                tried.push(p);
                true
            },
            || panic!("fallback을 부르면 안 된다"),
        )
        .unwrap();
        assert_eq!((port, tried), (41_000, vec![41_000]));
    }

    #[test]
    fn 몇_번_막혀도_빌_때까지_시도한다() {
        let mut calls = 0;
        let port = find_free_host_port_with(|| 45_000, |_| { calls += 1; calls >= 3 }, || panic!("fallback")).unwrap();
        assert_eq!((port, calls), (45_000, 3));
    }

    #[test]
    fn 대역이_모두_막히면_열_번_시도한_뒤_os_배정으로_돌아간다() {
        let mut calls = 0;
        let port = find_free_host_port_with(|| 50_000, |_| { calls += 1; false }, || Ok(1234)).unwrap();
        assert_eq!((port, calls), (1234, HIGH_BAND_TRIES));
        let error = find_free_host_port_with(|| 50_000, |_| false, || Err(io::Error::other("x"))).unwrap_err();
        assert_eq!(error.to_string(), "x");
    }

    #[test]
    fn 후보는_대역_안이고_부를_때마다_다르다() {
        let ports: Vec<u16> = (0..200).map(|_| random_high_band_port()).collect();
        assert!(ports.iter().all(|p| (HIGH_BAND_START..=HIGH_BAND_END).contains(p)));
        assert!(ports.iter().collect::<std::collections::HashSet<_>>().len() > 100);
    }

    #[test]
    fn 실제로_돌려준_포트는_다시_묶을_수_있다() {
        let port = find_free_host_port().unwrap();
        assert!(port > 0);
        TcpListener::bind(("127.0.0.1", port)).unwrap();
    }
}
