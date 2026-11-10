use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct RuntimeError(pub String);

impl fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// 유닉스 소켓 경로 상한(끝 NUL 포함 바이트)
#[cfg(target_os = "macos")]
pub const SOCKET_PATH_LIMIT: usize = 104;
#[cfg(not(target_os = "macos"))]
pub const SOCKET_PATH_LIMIT: usize = 108;

/// 폴더 안의 소켓 경로. 경로의 바이트 길이(끝 NUL 포함)가 OS 상한을 넘으면 거절한다.
/// 넘는 경로로 bind하면 OS가 잘라 엉뚱한 곳에 소켓을 만들거나 실패하므로 띄우지 않는다
pub fn socket_path_in(dir: &Path, file_name: &str) -> Result<PathBuf, RuntimeError> {
    use std::os::unix::ffi::OsStrExt;
    let path = dir.join(file_name);
    let bytes = path.as_os_str().as_bytes().len();
    if bytes + 1 > SOCKET_PATH_LIMIT {
        return Err(RuntimeError(format!(
            "소켓 경로가 너무 깁니다: {bytes}바이트(끝 NUL 포함 {}바이트, 이 OS의 상한은 {SOCKET_PATH_LIMIT}바이트): {}. 더 짧은 폴더를 --run-dir로 정하세요",
            bytes + 1,
            path.display()
        )));
    }
    Ok(path)
}

/// 소켓 폴더가 안전한지 본다: 링크가 아닌 폴더, 내 소유, 권한 정확히 0700.
/// 다른 사용자가 소켓에 닿을 수 있는 폴더면 앞단을 거치지 않고 Node에 닿는다(ADR-195 결정 1)
pub fn check_run_dir_meta(is_dir: bool, is_symlink: bool, uid: u32, mode: u32, my_uid: u32) -> Result<(), RuntimeError> {
    if is_symlink {
        return Err(RuntimeError("소켓 폴더가 링크입니다. 링크를 따라가지 않습니다".into()));
    }
    if !is_dir {
        return Err(RuntimeError("소켓 폴더 자리에 폴더가 아닌 것이 있습니다".into()));
    }
    if uid != my_uid {
        return Err(RuntimeError(format!("소켓 폴더의 소유자(uid {uid})가 내(uid {my_uid})가 아닙니다")));
    }
    if mode & 0o7777 != 0o700 {
        return Err(RuntimeError(format!("소켓 폴더의 권한이 0700이 아닙니다(지금 {:o}). 고치지 않고 멈춥니다", mode & 0o7777)));
    }
    Ok(())
}

/// 소켓 폴더를 준비한다. 없으면 0700으로 만들고, 있으면 위 검사를 통과해야 한다. 여러 번 불려도 같은 결과다
pub fn prepare_run_dir(dir: &Path) -> Result<(), RuntimeError> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let my_uid = unsafe { libc::geteuid() };
    match std::fs::symlink_metadata(dir) {
        Ok(meta) => return check_run_dir_meta(meta.is_dir(), meta.file_type().is_symlink(), meta.uid(), meta.mode(), my_uid).map_err(|e| RuntimeError(format!("{}: {e}", dir.display()))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(RuntimeError(format!("소켓 폴더를 확인하지 못했습니다({}): {error}", dir.display()))),
    }
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| RuntimeError(format!("상위 폴더를 만들지 못했습니다({}): {e}", parent.display())))?;
    }
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        // 동시에 다른 준비가 먼저 만들었으면 그것을 검사한다
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(RuntimeError(format!("소켓 폴더를 만들지 못했습니다({}): {error}", dir.display()))),
    }
    // umask가 0700을 더 좁혔을 수 있고, 만든 직후 다시 확인한다
    let meta = std::fs::symlink_metadata(dir).map_err(|e| RuntimeError(format!("소켓 폴더를 확인하지 못했습니다({}): {e}", dir.display())))?;
    check_run_dir_meta(meta.is_dir(), meta.file_type().is_symlink(), meta.uid(), meta.mode(), my_uid).map_err(|e| RuntimeError(format!("{}: {e}", dir.display())))
}

/// 남은 옛 소켓 파일을 지운다. 그 이름이 소켓일 때만 지우고, 링크·일반 파일·폴더면 건드리지 않고 멈춘다(lstat)
pub fn clear_stale_socket(path: &Path) -> Result<(), RuntimeError> {
    use std::os::unix::fs::FileTypeExt;
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_socket() => std::fs::remove_file(path).map_err(|e| RuntimeError(format!("옛 소켓을 지우지 못했습니다({}): {e}", path.display()))),
        Ok(_) => Err(RuntimeError(format!("소켓 자리에 소켓이 아닌 것이 있어 지우지 않고 멈춥니다: {}", path.display()))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(RuntimeError(format!("소켓 자리를 확인하지 못했습니다({}): {error}", path.display()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn tmp() -> tempfile::TempDir {
        tempfile::Builder::new().prefix("bs").tempdir_in("/tmp").unwrap()
    }

    #[test]
    fn 소켓_경로는_끝_nul_포함_상한_안이어야_한다() {
        let dir = Path::new("/r");
        // "/r/" + 이름 + NUL이 상한과 같으면 통과, 하나 넘으면 거절
        let ok_name = "a".repeat(SOCKET_PATH_LIMIT - 1 - "/r/".len());
        assert!(socket_path_in(dir, &ok_name).is_ok());
        let too_long = "a".repeat(SOCKET_PATH_LIMIT - "/r/".len());
        let err = socket_path_in(dir, &too_long).unwrap_err();
        assert!(err.to_string().contains("너무 깁니다"), "{err}");
    }

    #[test]
    fn 바이트_길이로_센다_한글_경로() {
        // 글자 수는 적어도 UTF-8 바이트로는 넘는 경우
        let name = "가".repeat(40); // 120바이트
        assert!(socket_path_in(Path::new("/r"), &name).is_err());
    }

    #[test]
    fn 폴더의_소유자와_권한을_본다() {
        assert!(check_run_dir_meta(true, false, 501, 0o700, 501).is_ok());
        assert!(check_run_dir_meta(true, false, 501, 0o40700, 501).is_ok(), "파일 종류 비트는 무시한다");
        assert!(check_run_dir_meta(true, false, 501, 0o755, 501).is_err());
        assert!(check_run_dir_meta(true, false, 501, 0o750, 501).is_err());
        assert!(check_run_dir_meta(true, false, 501, 0o500, 501).is_err(), "정확히 0700이어야 한다");
        assert!(check_run_dir_meta(true, false, 0, 0o700, 501).is_err(), "소유자가 다르면 멈춘다");
        assert!(check_run_dir_meta(false, false, 501, 0o700, 501).is_err(), "폴더가 아니면 멈춘다");
        assert!(check_run_dir_meta(true, true, 501, 0o700, 501).is_err(), "링크면 멈춘다");
    }

    #[test]
    fn 없는_폴더는_0700으로_만든다() {
        let t = tmp();
        let dir = t.path().join("a/b/run");
        prepare_run_dir(&dir).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        // 같은 폴더를 다시 준비해도 같은 결과(여러 번 불려도 된다)
        prepare_run_dir(&dir).unwrap();
    }

    #[test]
    fn 이미_있는_폴더가_0700이_아니면_고치지_않고_멈춘다() {
        let t = tmp();
        let dir = t.path().join("run");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(prepare_run_dir(&dir).is_err());
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o755);
    }

    #[test]
    fn 링크나_파일인_폴더_자리는_받지_않는다() {
        let t = tmp();
        let real = t.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o700)).unwrap();
        let link = t.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(prepare_run_dir(&link).is_err(), "링크를 따라가지 않는다");
        let file = t.path().join("file");
        std::fs::write(&file, "x").unwrap();
        assert!(prepare_run_dir(&file).is_err());
    }

    #[test]
    fn 옛_소켓_파일은_소켓일_때만_지운다() {
        let t = tmp();
        // 없으면 할 일이 없다
        clear_stale_socket(&t.path().join("none.sock")).unwrap();
        // 소켓이면 지운다
        let sock = t.path().join("s.sock");
        drop(std::os::unix::net::UnixListener::bind(&sock).unwrap());
        assert!(sock.exists());
        clear_stale_socket(&sock).unwrap();
        assert!(!sock.exists());
        // 일반 파일은 지우지 않고 멈춘다
        let file = t.path().join("f.sock");
        std::fs::write(&file, "내 파일").unwrap();
        assert!(clear_stale_socket(&file).is_err());
        assert!(file.exists());
        // 폴더도
        let sub = t.path().join("d.sock");
        std::fs::create_dir(&sub).unwrap();
        assert!(clear_stale_socket(&sub).is_err());
        assert!(sub.exists());
    }

    #[test]
    fn 소켓을_가리키는_링크는_따라가지_않고_지우지도_않는다() {
        let t = tmp();
        let target = t.path().join("t.sock");
        drop(std::os::unix::net::UnixListener::bind(&target).unwrap());
        let link = t.path().join("l.sock");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(clear_stale_socket(&link).is_err());
        assert!(target.exists(), "링크 너머의 소켓이 지워졌다");
        assert!(std::fs::symlink_metadata(&link).is_ok(), "링크도 그대로 둔다(내 것이 아니다)");
    }
}
