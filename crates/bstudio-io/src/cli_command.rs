//! CLI 실행 파일 고르기의 파일 상태 읽기(ADR-191 3단계 3ac). 무엇을 고를지의 판정(PATH 나누기·절대 항목·후보 경로·폴더 안인지의 글자 비교)은
//! `bstudio_guard::cli_command`가 하고, 여기는 실제 경로·파일 종류·실행 권한을 읽는다.
//!
//! 왜 파일 상태 읽기까지 Rust에 두는가: TS가 `statSync`·`accessSync`·`realpathSync`로 확인하고 Rust가 후보 목록만 판정하면 "무엇을 확인한 경로"와
//! "무엇을 띄울 경로"가 두 언어에서 따로 만들어진다. 여기서는 후보 경로 문자열 하나를 만들어 그 문자열로 실제 경로·종류·권한을 읽고, 같은 문자열을
//! TS가 `spawn`에 그대로 쓴다(`join`으로 정규화한 글자 그대로). 확인과 실행 사이에 파일 자체가 바뀌는 틈(TOCTOU)은 어느 쪽에 두어도 남는다.
//!
//! 막는 쪽이다. 폴더 안인지는 세 가지로 본다. 하나라도 맞으면 안이고, 읽지 못하면 안이다.
//! 1. 글자 그대로의 경로(정규화)의 조상 중 프로젝트 루트와 같은 폴더(장치·inode)가 있는가 — 대소문자를 구분하지 않는 볼륨에서 `/PROJ`와 `/proj`, 프로젝트 안의 링크가 바깥을 가리켜도 안이다
//! 2. 실제 경로의 조상 중 프로젝트 루트와 같은 폴더가 있는가 — 링크를 따라간 뒤의 경로
//! 3. 실제 경로와 루트의 실제 경로를 구성 요소 단위로 견준 결과
//!
//! 짝 없는 서로게이트가 든 글자는 napi 경계에서 U+FFFD가 된다. Node가 `spawn`·`fs`에 그 글자를 줄 때도 같은 UTF-8 바이트(U+FFFD)로 바뀌므로,
//! 확인한 경로와 띄우는 경로의 바이트는 같다.

use bstudio_guard::cli_command as judge;

#[cfg(unix)]
fn identity(path: &str) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|meta| (meta.dev(), meta.ino()))
}

/// 보통 파일이고(링크를 따라간다) 현재 사용자가 실행할 수 있는가(`access(X_OK)`)
#[cfg(unix)]
pub fn is_executable_file(path: &str) -> bool {
    use std::ffi::CString;
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => {}
        _ => return false,
    }
    let Ok(c_path) = CString::new(path) else { return false };
    // SAFETY: c_path는 끝이 NUL인 유효한 C 문자열이다. access는 읽기만 한다.
    unsafe { libc::access(c_path.as_ptr(), libc::X_OK) == 0 }
}

#[cfg(not(unix))]
pub fn is_executable_file(_path: &str) -> bool {
    false
}

/// `file`이 프로젝트 루트와 같거나 그 안인가(막는 쪽). 읽지 못하면 안으로 본다
#[cfg(unix)]
pub fn inside_root(file: &str, root: &str) -> bool {
    let Some(root_id) = identity(root) else { return true };
    let Ok(real_root) = std::fs::canonicalize(root) else { return true };
    let Ok(real_root) = real_root.into_os_string().into_string() else { return true };
    let Ok(cwd) = std::env::current_dir() else { return true };
    let Ok(cwd) = cwd.into_os_string().into_string() else { return true };
    // 1. 글자 그대로의 경로
    let absolute = bstudio_guard::node_path::resolve(&cwd, &[file]);
    if has_root_ancestor(&absolute, root_id) {
        return true;
    }
    // 2·3. 링크를 따라간 실제 경로
    let Ok(real) = std::fs::canonicalize(file) else { return true };
    let Ok(real) = real.into_os_string().into_string() else { return true };
    has_root_ancestor(&real, root_id) || judge::is_under(&real, &real_root)
}

#[cfg(not(unix))]
pub fn inside_root(_file: &str, _root: &str) -> bool {
    true
}

#[cfg(unix)]
fn has_root_ancestor(absolute: &str, root_id: (u64, u64)) -> bool {
    let prefixes = judge::prefixes(absolute);
    if prefixes.is_empty() {
        return true;
    }
    prefixes.iter().any(|prefix| match identity(prefix) {
        Some(id) => id == root_id,
        None => true,
    })
}

/// CLI 실행 파일을 절대 경로로 찾는다. 돌려주는 글자를 그대로 `spawn`에 쓴다. 못 찾으면 이유(TS가 ENOENT로 던진다)
pub fn resolve_cli_command(command: &str, path_value: Option<&str>, forbidden_root: Option<&str>) -> Result<String, &'static str> {
    if cfg!(not(unix)) {
        return Err(judge::REASON_UNSUPPORTED);
    }
    if judge::has_separator(command) {
        if !bstudio_guard::node_path::is_absolute(command) {
            return Err(judge::REASON_RELATIVE_COMMAND);
        }
        if forbidden_root.is_some_and(|root| inside_root(command, root)) {
            return Err(judge::REASON_INSIDE_PROJECT);
        }
        return Ok(command.to_owned());
    }
    for dir in judge::path_entries(path_value.unwrap_or("")) {
        let candidate = judge::candidate(dir, command);
        if !is_executable_file(&candidate) {
            continue;
        }
        if forbidden_root.is_some_and(|root| inside_root(&candidate, root)) {
            continue;
        }
        return Ok(candidate);
    }
    Err(judge::REASON_NOT_FOUND)
}

/// 자식에게 넘길 PATH 값. 빈·상대 항목과 프로젝트 안(읽지 못한 항목 포함)을 뺀다
pub fn child_path(value: &str, forbidden_root: Option<&str>) -> String {
    if cfg!(not(unix)) {
        return String::new();
    }
    judge::child_path(value, &|dir| forbidden_root.is_some_and(|root| inside_root(dir, root)))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::path::{Path, PathBuf};

    fn temp(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("bstudio-cli-command-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        fs::canonicalize(&base).unwrap()
    }

    fn exe(path: &Path) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "#!/bin/sh\n").unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn s(path: &Path) -> &str {
        path.to_str().unwrap()
    }

    #[test]
    fn 프로젝트_밖의_실행_파일을_고르고_안은_건너뛴다() {
        let base = temp("pick");
        let project = base.join("project");
        exe(&project.join("bin/claude"));
        exe(&base.join("outside/claude"));
        let path = format!("{}:{}", project.join("bin").display(), base.join("outside").display());
        assert_eq!(resolve_cli_command("claude", Some(&path), Some(s(&project))).unwrap(), s(&base.join("outside/claude")));
        assert!(resolve_cli_command("claude", Some(&format!("{}", project.join("bin").display())), Some(s(&project))).is_err());
    }

    #[test]
    fn 이름이_점점으로_시작하는_폴더도_안이다() {
        let base = temp("dotdot");
        let project = base.join("project");
        exe(&project.join("..bin/claude"));
        let path = project.join("..bin").display().to_string();
        assert_eq!(resolve_cli_command("claude", Some(&path), Some(s(&project))), Err(judge::REASON_NOT_FOUND));
        assert_eq!(child_path(&path, Some(s(&project))), "");
    }

    #[test]
    fn 프로젝트_안을_가리키는_링크는_안이다() {
        let base = temp("link");
        let project = base.join("project");
        exe(&project.join("real/claude"));
        fs::create_dir_all(base.join("bin")).unwrap();
        symlink(project.join("real/claude"), base.join("bin/claude")).unwrap();
        let path = base.join("bin").display().to_string();
        assert_eq!(resolve_cli_command("claude", Some(&path), Some(s(&project))), Err(judge::REASON_NOT_FOUND));
    }

    #[test]
    fn 프로젝트_안의_링크가_바깥을_가리켜도_안이다() {
        let base = temp("outlink");
        let project = base.join("project");
        exe(&base.join("outside/claude"));
        fs::create_dir_all(&project).unwrap();
        symlink(base.join("outside"), project.join("tools")).unwrap();
        let path = project.join("tools").display().to_string();
        assert_eq!(resolve_cli_command("claude", Some(&path), Some(s(&project))), Err(judge::REASON_NOT_FOUND));
    }

    #[test]
    fn 루트가_링크여도_실제_폴더로_견준다() {
        let base = temp("rootlink");
        let project = base.join("project");
        exe(&project.join("bin/claude"));
        symlink(&project, base.join("alias")).unwrap();
        let path = project.join("bin").display().to_string();
        assert_eq!(resolve_cli_command("claude", Some(&path), Some(s(&base.join("alias")))), Err(judge::REASON_NOT_FOUND));
    }

    #[test]
    fn 상대_항목과_빈_항목은_보지_않는다() {
        let base = temp("rel");
        let project = base.join("project");
        exe(&project.join("claude"));
        assert!(resolve_cli_command("claude", Some(":.:bin"), Some(s(&project))).is_err());
        assert!(resolve_cli_command("./claude", None, None).is_err());
        assert!(resolve_cli_command("bin/claude", None, None).is_err());
    }

    #[test]
    fn 실행_권한이_없거나_폴더면_건너뛴다() {
        let base = temp("noexec");
        fs::create_dir_all(base.join("a")).unwrap();
        fs::write(base.join("a/claude"), "x").unwrap();
        fs::set_permissions(base.join("a/claude"), fs::Permissions::from_mode(0o644)).unwrap();
        fs::create_dir_all(base.join("b/claude")).unwrap();
        exe(&base.join("c/claude"));
        let path = format!("{}:{}:{}", base.join("a").display(), base.join("b").display(), base.join("c").display());
        assert_eq!(resolve_cli_command("claude", Some(&path), None).unwrap(), s(&base.join("c/claude")));
    }

    #[test]
    fn 읽지_못하는_루트는_안으로_본다() {
        let base = temp("noroot");
        exe(&base.join("bin/claude"));
        let path = base.join("bin").display().to_string();
        assert!(resolve_cli_command("claude", Some(&path), Some(s(&base.join("missing")))).is_err());
        assert_eq!(child_path(&path, Some(s(&base.join("missing")))), "");
        assert!(resolve_cli_command("claude", Some(&path), None).is_ok());
    }

    #[test]
    fn 절대_경로_명령은_루트_안이면_거절한다() {
        let base = temp("abs");
        let project = base.join("project");
        exe(&project.join("claude"));
        exe(&base.join("out/claude"));
        assert_eq!(resolve_cli_command(s(&project.join("claude")), None, Some(s(&project))), Err(judge::REASON_INSIDE_PROJECT));
        assert_eq!(resolve_cli_command(s(&base.join("out/claude")), None, Some(s(&project))).unwrap(), s(&base.join("out/claude")));
    }

    #[test]
    fn 대소문자만_다른_경로도_같은_폴더면_안이다() {
        let base = temp("case");
        let project = base.join("Project");
        exe(&project.join("bin/claude"));
        // 대소문자를 구분하지 않는 볼륨에서만 이 경로가 같은 폴더를 가리킨다. 구분하는 볼륨에서는 없는 경로라 읽지 못해 안으로 본다(둘 다 안)
        let swapped = base.join("project/bin");
        let path = swapped.display().to_string();
        assert!(resolve_cli_command("claude", Some(&path), Some(s(&project))).is_err());
        assert_eq!(child_path(&path, Some(s(&project))), "");
    }
}
