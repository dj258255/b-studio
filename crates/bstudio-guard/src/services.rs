//! 바뀐 파일이 어느 managed 서비스에 속하는지의 판정(옛 TS: `packages/agent/src/services.ts`, ADR-191 3단계 3l).
//!
//! 게이트는 이 판정으로 다시 띄우고 확인할 서비스를 고르고, `uncoveredChangeWarnings`도 같은 판정을 쓴다. 그래서 **바뀐 파일이 어느
//! 서비스에도 속하지 않는 쪽으로 바뀌는 차이**가 없어야 한다(재시작·확인 대상에서 빠진다). 옛 코드의 비교 규칙을 "더 옳게" 고치지 않고 그대로 옮겼다:
//!
//! - `normalize`(`^\.\/?` 제거, 끝 `/+` 제거)는 서비스 경로·includes·projectWide 경로·`isComposeFile`의 file에만 쓰고,
//!   `ownsFile`의 file 쪽에는 쓰지 않는다(비대칭). `^\.\/?`는 `.`만 있는 경로나 `.hidden`의 첫 점도 지운다.
//! - 비교는 글자 그대로다: 대소문자·유니코드 정규화(NFC·NFD)·`..`·겹친 `/`를 접지 않는다.
//! - 겹치는 소유자는 전부 고른다(첫 번째만 고르지 않는다). 결과 서비스는 `managed` 순서이고, 같은 이름이 여러 번 있으면 그만큼 나온다.
//! - 루트가 `''`로 접히는 서비스(`path: '.'` 등)는 모든 파일을 소유한다.
//! - `path.relative`는 Node의 posix 알고리즘(`node_path`)이다. 현재 폴더는 TS가 `process.cwd()`로 넘긴다.
//!   Windows의 `path`(win32)는 따르지 않는다(이 저장소의 지원 범위는 macOS·Linux).
//!
//! 서비스와 파일은 **입력 배열의 위치**로 돌려준다. 껍데기가 그 위치로 원래 문자열을 꺼내므로 짝 없는 서로게이트가 있는 파일 이름도 그대로 남는다.

use std::collections::HashSet;

use crate::js_json::{self, JsValue};
use crate::node_path;

pub const SPEC_FILE: &str = "studio.yaml";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedService {
    pub name: String,
    pub path: String,
    pub includes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Mapping {
    /// `managed`의 위치(studio.yaml 순서)
    pub services: Vec<usize>,
    /// `files`의 위치
    pub unmatched: Vec<usize>,
}

/// `servicePath.replace(/^\.\/?/, '').replace(/\/+$/, '')`
pub fn normalize(path: &str) -> &str {
    let rest = match path.strip_prefix('.') {
        Some(after) => after.strip_prefix('/').unwrap_or(after),
        None => path,
    };
    rest.trim_end_matches('/')
}

fn is_under_root(file: &str, root: &str) -> bool {
    let normalized = normalize(root);
    normalized.is_empty() || file == normalized || (file.starts_with(normalized) && file[normalized.len()..].starts_with('/'))
}

/// `ownsFile`: `[path, ...includes]` 중 하나라도 그 아래이면 소유한다
pub fn owns_file(path: &str, includes: &[String], file: &str) -> bool {
    std::iter::once(path).chain(includes.iter().map(String::as_str)).any(|root| is_under_root(file, root))
}

/// `normalize(path.relative(root, composePath))`. root·composePath가 비면 None(옛 코드는 compose 쪽을 건너뛴다)
fn compose_relative(root: &str, compose_path: &str, cwd: &str) -> Option<String> {
    if root.is_empty() || compose_path.is_empty() {
        return None;
    }
    Some(normalize(&node_path::relative(cwd, root, compose_path)).to_owned())
}

pub fn is_compose_file(root: &str, compose_path: &str, cwd: &str, file: &str) -> bool {
    match compose_relative(root, compose_path, cwd) {
        Some(relative) => normalize(file) == relative,
        None => false,
    }
}

pub fn services_for_files(managed: &[ManagedService], root: &str, compose_path: &str, cwd: &str, files: &[String]) -> Mapping {
    let mut project_wide = vec![SPEC_FILE.to_owned()];
    if let Some(relative) = compose_relative(root, compose_path, cwd) {
        project_wide.push(relative);
    }
    let mut hit: HashSet<&str> = HashSet::new();
    let mut unmatched = Vec::new();
    for (index, file) in files.iter().enumerate() {
        if project_wide.iter().any(|wide| wide == normalize(file)) {
            for service in managed {
                hit.insert(&service.name);
            }
            if managed.is_empty() {
                unmatched.push(index);
            }
            continue;
        }
        let owners: Vec<&ManagedService> = managed.iter().filter(|service| owns_file(&service.path, &service.includes, file)).collect();
        if owners.is_empty() {
            unmatched.push(index);
        } else {
            for owner in owners {
                hit.insert(&owner.name);
            }
        }
    }
    let services = managed.iter().enumerate().filter(|(_, service)| hit.contains(service.name.as_str())).map(|(i, _)| i).collect();
    Mapping { services, unmatched }
}

fn string_field(value: &JsValue, key: &str, what: &str) -> Result<String, String> {
    match value.prop(key) {
        Some(JsValue::Str(text)) => Ok(text.clone()),
        _ => Err(format!("{what}.{key}는 문자열이어야 합니다")),
    }
}

fn string_list(value: Option<&JsValue>, what: &str) -> Result<Vec<String>, String> {
    match value {
        None | Some(JsValue::Null) => Ok(Vec::new()),
        Some(JsValue::Arr(items)) => items
            .iter()
            .map(|item| match item {
                JsValue::Str(text) => Ok(text.clone()),
                _ => Err(format!("{what}의 항목은 문자열이어야 합니다")),
            })
            .collect(),
        Some(_) => Err(format!("{what}는 배열이어야 합니다")),
    }
}

/// 입력: `{"managed":[{"name","path","includes"?}],"root","composePath","cwd","files":[..]}`. 출력: `{"services":[위치..],"unmatched":[위치..]}`
pub fn services_for_files_json(input_json: &str) -> Result<String, String> {
    let input = js_json::parse(input_json)?;
    let managed = match input.prop("managed") {
        Some(JsValue::Arr(items)) => items
            .iter()
            .map(|item| {
                Ok(ManagedService {
                    name: string_field(item, "name", "managed")?,
                    path: string_field(item, "path", "managed")?,
                    includes: string_list(item.prop("includes"), "managed.includes")?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?,
        _ => return Err("managed는 배열이어야 합니다".to_owned()),
    };
    let files = string_list(input.prop("files"), "files")?;
    let mapping = services_for_files(
        &managed,
        &string_field(&input, "root", "input")?,
        &string_field(&input, "composePath", "input")?,
        &string_field(&input, "cwd", "input")?,
        &files,
    );
    let list = |items: &[usize]| items.iter().map(usize::to_string).collect::<Vec<_>>().join(",");
    Ok(format!("{{\"services\":[{}],\"unmatched\":[{}]}}", list(&mapping.services), list(&mapping.unmatched)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn svc(name: &str, path: &str, includes: &[&str]) -> ManagedService {
        ManagedService { name: name.into(), path: path.into(), includes: includes.iter().map(|s| (*s).into()).collect() }
    }

    fn files(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).into()).collect()
    }

    #[test]
    fn normalize는_옛_정규식과_같다() {
        for (input, expected) in [
            ("", ""),
            (".", ""),
            ("./", ""),
            ("/", ""),
            ("//", ""),
            ("./a", "a"),
            (".//a", "/a"),
            ("a//", "a"),
            (".hidden", "hidden"),
            ("..", "."),
            ("../a", "./a"),
            ("a/./", "a/."),
        ] {
            assert_eq!(normalize(input), expected, "{input:?}");
        }
    }

    #[test]
    fn 폴더_경계는_슬래시로_본다() {
        assert!(owns_file("a", &[], "a/x"));
        assert!(owns_file("a", &[], "a"));
        assert!(!owns_file("a", &[], "ab/x"));
        assert!(!owns_file("a", &[], "A/x"));
        assert!(!owns_file("a", &[], "./a/x"));
        assert!(owns_file("./a/", &[], "a/x"));
        assert!(owns_file(".", &[], "anything"));
    }

    #[test]
    fn compose는_상대_경로로_견준다() {
        assert!(is_compose_file("/r", "/r/compose.yaml", "/w", "compose.yaml"));
        assert!(is_compose_file("/r/", "/r/compose.yaml", "/w", "./compose.yaml"));
        assert!(!is_compose_file("", "/r/compose.yaml", "/w", "compose.yaml"));
        assert!(!is_compose_file("/r", "", "/w", ""));
        assert!(is_compose_file("/r", "/r/a", "/w", "a/"));
    }

    #[test]
    fn 상대_root는_현재_폴더_기준으로_읽는다() {
        assert!(is_compose_file("p", "/w/p/compose.yaml", "/w", "compose.yaml"));
        assert!(!is_compose_file("p", "/w/p/compose.yaml", "/x", "compose.yaml"));
    }

    #[test]
    fn 겹치는_소유자는_전부_고른다() {
        let managed = vec![svc("c", "c", &["shared"]), svc("w", "w", &["shared"])];
        let m = services_for_files(&managed, "", "", "/w", &files(&["shared/t.ts", "z"]));
        assert_eq!(m, Mapping { services: vec![0, 1], unmatched: vec![1] });
    }

    #[test]
    fn project_wide는_전부_고르고_비면_unmatched다() {
        let managed = vec![svc("c", "c", &[]), svc("w", "w", &[])];
        let m = services_for_files(&managed, "/r", "/r/compose.yaml", "/w", &files(&["compose.yaml", "studio.yaml"]));
        assert_eq!(m, Mapping { services: vec![0, 1], unmatched: vec![] });
        let m = services_for_files(&[], "/r", "/r/compose.yaml", "/w", &files(&["compose.yaml", "studio.yaml"]));
        assert_eq!(m, Mapping { services: vec![], unmatched: vec![0, 1] });
    }

    #[test]
    fn json_입력은_모양이_어긋나면_던진다() {
        assert!(services_for_files_json("{\"managed\":[{\"name\":1,\"path\":\"a\"}],\"root\":\"\",\"composePath\":\"\",\"cwd\":\"/\",\"files\":[]}").is_err());
        assert_eq!(
            services_for_files_json("{\"managed\":[{\"name\":\"a\",\"path\":\"a\"}],\"root\":\"\",\"composePath\":\"\",\"cwd\":\"/\",\"files\":[\"a/x\",\"b\"]}").unwrap(),
            "{\"services\":[0],\"unmatched\":[1]}"
        );
    }
}
