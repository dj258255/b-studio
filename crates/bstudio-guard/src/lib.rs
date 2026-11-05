//! b-studio의 막는 검사 판정(ADR-191 1단계). Node를 모르는 순수 Rust다.
//!
//! 옮기기 전 TS 구현과 같은 입력에 같은 결과를 낸다. 다른 곳은 모두 "의도한 차이"로 테스트 이름에 적었고,
//! 거부 목록에서 더 넓게 막는 쪽으로만 다르다.

pub mod container_policy;
pub mod js;
pub mod readonly_docker;
pub mod secrets;
