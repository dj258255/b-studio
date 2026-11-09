//! b-studio의 막는 검사 판정(ADR-191 1단계). Node를 모르는 순수 Rust다.
//!
//! 옮기기 전 TS 구현과 같은 입력에 같은 결과를 낸다. 다른 곳은 모두 "의도한 차이"로 테스트 이름에 적었고,
//! 거부 목록에서 더 넓게 막는 쪽으로만 다르다.

pub mod check_evidence;
pub mod cli_router;
pub mod commit_message;
pub mod compose_override;
pub mod container_policy;
pub mod context_clearing;
pub mod contract_diff;
pub mod coordination;
pub mod declared_checks;
pub mod deploy_plan;
pub mod docker_format;
pub mod edge_config;
pub mod escalation;
pub mod git_mask;
pub mod host_containers;
pub mod host_processes;
pub mod import_graph;
pub mod js;
pub mod js_json;
pub mod js_locale;
pub mod load_check;
pub mod model_router;
pub mod node_path;
pub mod pr_review;
pub mod public_url;
pub mod readiness;
pub mod readonly_docker;
pub mod relay;
pub mod requirement_issues;
pub mod review_input;
pub mod secrets;
pub mod snapshots;
pub mod stray_processes;
pub mod test_discovery;
pub mod test_results;
pub mod test_run;
pub mod tool_output;
pub mod usage;
