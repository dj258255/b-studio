//! `packages/spec/src/load.ts`의 파일 읽기. 판정(교차 검증)은 `bstudio_guard::spec_load`가 하고,
//! 여기는 경로 확인·realpath·O_NOFOLLOW 열기·크기 제한·읽기만 한다. 오류 글은 옛 TS와 같다.

use bstudio_guard::js_json::{JsObject, JsValue};
use bstudio_guard::node_path;
use bstudio_guard::spec_load::{self, SpecFailure, SPEC_FILE};
use std::io::ErrorKind;
use tokio::io::AsyncReadExt;

const MAX_YAML_BYTES: usize = 4 * 1024 * 1024;

fn is_inside(cwd: &str, parent: &str, target: &str) -> bool {
    let relative = node_path::relative(cwd, parent, target);
    relative.is_empty() || (relative != ".." && !relative.starts_with("../") && !node_path::is_absolute(&relative))
}

fn eof_error(error: &std::io::Error) -> bool {
    error.kind() == ErrorKind::NotFound
}

fn missing(file: &str) -> SpecFailure {
    SpecFailure::message(format!("파일이 없습니다: {file}"))
}

fn open_flags() -> i32 {
    #[cfg(unix)]
    {
        libc::O_NOFOLLOW | libc::O_NONBLOCK
    }
    #[cfg(not(unix))]
    {
        0
    }
}

async fn read_project_text(cwd: &str, root: &str, relative: &str) -> Result<String, SpecFailure> {
    let file = node_path::resolve(cwd, &[root, relative]);
    if node_path::is_absolute(relative) || !is_inside(cwd, root, &file) {
        return Err(SpecFailure::message(format!("{relative}: 프로젝트 폴더 안의 경로만 쓸 수 있습니다")));
    }
    let outside = || SpecFailure::message(format!("{relative}: 프로젝트 폴더 밖을 가리키는 링크는 읽지 않습니다"));
    let open_failed = || SpecFailure::message(format!("{relative}: 파일을 열 수 없습니다"));
    let read_failed = || SpecFailure::message(format!("{relative}: 파일을 읽을 수 없습니다"));

    let (real_root, real_file) = match tokio::join!(tokio::fs::canonicalize(root), tokio::fs::canonicalize(&file)) {
        (Ok(root), Ok(file)) => (root.to_string_lossy().into_owned(), file.to_string_lossy().into_owned()),
        (Err(error), _) | (_, Err(error)) if eof_error(&error) => return Err(missing(&file)),
        _ => return Err(open_failed()),
    };
    if !is_inside(cwd, &real_root, &real_file) {
        return Err(outside());
    }

    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        options.custom_flags(open_flags());
    }
    let mut handle = match options.open(&real_file).await {
        Ok(handle) => handle,
        Err(error) => {
            if eof_error(&error) {
                return Err(missing(&file));
            }
            if error.raw_os_error() == Some(libc::ELOOP) {
                return Err(outside());
            }
            return Err(open_failed());
        }
    };

    let opened = match handle.metadata().await {
        Ok(metadata) => metadata,
        Err(error) => {
            if eof_error(&error) {
                return Err(missing(&file));
            }
            return Err(read_failed());
        }
    };
    if !opened.is_file() {
        return Err(SpecFailure::message(format!("{relative}: 일반 파일이 아닙니다")));
    }
    if opened.len() > MAX_YAML_BYTES as u64 {
        return Err(SpecFailure::message(format!("{relative}: 파일이 너무 큽니다({MAX_YAML_BYTES}바이트까지)")));
    }

    // 확인과 여는 것 사이에 경로가 링크로 바뀌었을 수 있다: 연 파일이 지금 그 경로의 프로젝트 안 파일과 같은지 다시 본다
    let (root_now, file_now) = match tokio::join!(tokio::fs::canonicalize(root), tokio::fs::canonicalize(&file)) {
        (Ok(root), Ok(file)) => (root.to_string_lossy().into_owned(), file.to_string_lossy().into_owned()),
        (Err(error), _) | (_, Err(error)) if eof_error(&error) => return Err(missing(&file)),
        _ => return Err(read_failed()),
    };
    let now = match tokio::fs::symlink_metadata(&file_now).await {
        Ok(metadata) => metadata,
        Err(error) => {
            if eof_error(&error) {
                return Err(missing(&file));
            }
            return Err(read_failed());
        }
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !is_inside(cwd, &root_now, &file_now) || now.dev() != opened.dev() || now.ino() != opened.ino() {
            return Err(outside());
        }
    }

    let mut buffer = Vec::new();
    let mut limited = (&mut handle).take((MAX_YAML_BYTES + 1) as u64);
    if let Err(error) = limited.read_to_end(&mut buffer).await {
        if eof_error(&error) {
            return Err(missing(&file));
        }
        return Err(read_failed());
    }
    if buffer.len() > MAX_YAML_BYTES {
        return Err(SpecFailure::message(format!("{relative}: 파일이 너무 큽니다({MAX_YAML_BYTES}바이트까지)")));
    }
    Ok(String::from_utf8_lossy(&buffer).into_owned())
}

fn yaml_where(line: usize, col: usize) -> String {
    if line == 0 {
        return String::new();
    }
    if col > 0 {
        format!("({line}번째 줄 {col}번째 칸)")
    } else {
        format!("({line}번째 줄)")
    }
}

fn parse_yaml(text: &str, label: &str, merge: bool) -> Result<JsValue, SpecFailure> {
    match bstudio_guard::yaml::parse(text, merge) {
        bstudio_guard::yaml::Outcome::Value(json) => {
            bstudio_guard::js_json::parse_native(&json).map_err(|error| SpecFailure::message(format!("{label}: {error}")))
        }
        bstudio_guard::yaml::Outcome::Unsupported { reason, line, col } => Err(SpecFailure::message(format!(
            "{label}: 이 YAML 꼴은 지원하지 않습니다: {reason}{}",
            yaml_where(line, col)
        ))),
        bstudio_guard::yaml::Outcome::Syntax { message, line, col } => Err(SpecFailure::message(format!(
            "{label}의 YAML 문법이 올바르지 않습니다{}: {message}",
            yaml_where(line, col)
        ))),
    }
}

fn path_text(issue: &bstudio_guard::spec_schema::Issue) -> String {
    if issue.path.is_empty() {
        return "(root)".to_owned();
    }
    issue
        .path
        .iter()
        .map(|seg| match seg {
            bstudio_guard::spec_schema::Seg::Key(key) => key.clone(),
            bstudio_guard::spec_schema::Seg::Index(index) => index.to_string(),
        })
        .collect::<Vec<_>>()
        .join(".")
}

pub async fn load_project(dir: &str) -> Result<JsValue, SpecFailure> {
    let cwd = std::env::current_dir().map_err(|_| SpecFailure::message("현재 폴더를 알 수 없습니다"))?;
    let cwd = cwd.to_string_lossy().into_owned();
    let root = node_path::resolve(&cwd, &[dir]);

    let spec_text = read_project_text(&cwd, &root, SPEC_FILE).await?;
    let spec_value = parse_yaml(&spec_text, SPEC_FILE, false)?;
    let spec = bstudio_guard::spec_schema::validate("StudioSpecSchema", Some(&spec_value));
    if !spec.issues.is_empty() {
        let issues = spec.issues.iter().map(|issue| format!("{}: {}", path_text(issue), issue.message)).collect();
        return Err(SpecFailure::issues(format!("{SPEC_FILE} 형식이 올바르지 않습니다"), issues));
    }
    let spec_value = spec.value.ok_or_else(|| SpecFailure::message(format!("{SPEC_FILE} 형식이 올바르지 않습니다")))?;
    let compose_name = spec_value.prop("compose").and_then(JsValue::as_str).unwrap_or("compose.yaml").to_owned();
    let compose_path = node_path::resolve(&cwd, &[&root, &compose_name]);

    let compose_text = read_project_text(&cwd, &root, &compose_name).await?;
    let compose_value = parse_yaml(&compose_text, &compose_name, true)?;
    let compose = bstudio_guard::spec_schema::validate_compose(&compose_value);
    if !compose.issues.is_empty() {
        return Err(SpecFailure::message(format!("{compose_name}에 services 항목이 없습니다")));
    }
    let compose_value = compose.value.ok_or_else(|| SpecFailure::message(format!("{compose_name}에 services 항목이 없습니다")))?;
    spec_load::build_project(&root, &spec_value, &compose_value, &compose_path)
}

/// napi가 돌려줄 JSON. `{ ok: true, project }` 또는 `{ ok: false, message, issues }`
pub fn result_json(result: Result<JsValue, SpecFailure>) -> String {
    let mut out = JsObject::new();
    match result {
        Ok(project) => {
            out.set("ok", JsValue::Bool(true));
            out.set("project", project);
        }
        Err(failure) => {
            out.set("ok", JsValue::Bool(false));
            out.set("message", JsValue::Str(failure.message));
            out.set("issues", JsValue::Arr(failure.issues.into_iter().map(JsValue::Str).collect()));
        }
    }
    bstudio_guard::js_json::to_native(&JsValue::Obj(out))
}
