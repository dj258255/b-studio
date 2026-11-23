//! 이 컴퓨터 방식 터미널의 관문 폴더 입출력(ADR-173, 4f C1 5단계). 옛 구현은 `packages/sandbox/src/host-terminal.ts`의
//! `writeHostGatewayConfig`·`checkHostGatewayConfig`·`removeHostGatewayConfig`다(옛 구현 `host-terminal-legacy.ts`는 #1347에서 지웠다).
//! 글은 `bstudio_session::terminal::gateway`가 만든다. 여기는 그 글을 쓰고, 견주고, 지우기만 한다.
//!
//! **지우는 코드다.** 지우기 전에 경로가 링크인지, 파일인지, 진짜 폴더인지 먼저 본다(AGENTS.md "지우는 코드").
//! - 관문 폴더 자체가 링크면 그 너머를 건드리지 않고 링크 자리만 지운다
//! - 하위 폴더 자리가 링크면 그 안으로 들어가지 않고 링크 자리만 지운다
//! - 파일은 그 부모 폴더가 진짜 폴더일 때만 지운다(부모가 링크면 그 너머의 파일을 지우지 않는다)
//! - `shell/zsh`의 `.zcompdump*`(#1296)도 같은 규칙이다. 진짜 폴더 바로 아래의 파일·링크만 지운다
//! - 빈 폴더만 지운다(`remove_dir`). 다른 파일이 남아 있으면 폴더는 남는다
//!
//! 쓰기는 링크를 따라쓰지 않는다: 자리가 보통 파일이 아니면 호출마다 다른 임시 이름에 `wx`(create_new)로 쓰고 `rename`한다.
//! `rename`은 자리의 링크가 아니라 자리 자체를 바꾼다. 내용이 같아도 권한이 넓혀져 있으면 다시 조인다.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// 관문 폴더 안의 폴더 이름(폴더 기준). 지울 때는 역순이다
pub const GATEWAY_DIRS: [&str; 3] = ["bin", "shell", "shell/zsh"];
/// 관문 폴더 안에 쓰는 파일 이름(폴더 기준)
pub const GATEWAY_FILE_NAMES: [&str; 13] = [
    "settings.json",
    "mcp.json",
    "b-studio-hook.mjs",
    "b-studio-gateway.json",
    "statusline.json",
    "codex.env",
    "bin/claude",
    "bin/codex",
    "shell/zsh/.zshenv",
    "shell/zsh/.zprofile",
    "shell/zsh/.zshrc",
    "shell/zsh/.zlogin",
    "shell/bashrc",
];
/// 권한을 700으로 유지해야 하는 폴더(폴더 기준 이름). 빈 이름은 관문 폴더 그 자체다
pub const GATEWAY_FOLDER_NAMES: [&str; 4] = ["", "bin", "shell", "shell/zsh"];
pub const STATUSLINE_FILE: &str = "statusline.json";

/// 관문 폴더에 쓸 파일 하나
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayFile {
    /// 관문 폴더 기준 이름(`bin/claude`처럼 구분자를 포함할 수 있다)
    pub name: String,
    pub content: String,
    pub mode: u32,
}

/// 부르는 쪽(TS)이 `SandboxError`로 다시 만드는 실패
#[derive(Debug)]
pub enum GatewayIoError {
    /// 관문 폴더 자체가 심볼릭 링크다
    Link(PathBuf),
    /// 폴더 자리를 만들지 못했다
    MakeDir(PathBuf),
    /// 샌드박스 id로 폴더 이름을 정할 수 없다
    InvalidId(String),
    Io(io::Error),
}

impl GatewayIoError {
    /// 첫 줄은 `SandboxError`의 제목, 둘째 줄은 상세다(옛 글과 같다)
    pub fn message(&self) -> String {
        match self {
            Self::Link(path) => format!("관문 폴더가 심볼릭 링크입니다\n{}", path.display()),
            Self::MakeDir(path) => format!("관문 폴더를 만들지 못했습니다\n{}", path.display()),
            Self::InvalidId(id) => format!("샌드박스 id로 관문 설정 폴더를 정할 수 없습니다\n{id}"),
            Self::Io(error) => error.to_string(),
        }
    }
}

impl From<io::Error> for GatewayIoError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

static STAGED: AtomicU64 = AtomicU64::new(0);

#[cfg(unix)]
fn create_dir(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true).mode(mode);
    builder.create(path)
}

#[cfg(not(unix))]
fn create_dir(path: &Path, _mode: u32) -> io::Result<()> {
    fs::create_dir_all(path)
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn mode_of(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    metadata.mode() & 0o777
}

#[cfg(not(unix))]
fn mode_of(_metadata: &fs::Metadata) -> u32 {
    0o700
}

fn set_mode_if_real_dir(target: &Path, mode: u32) -> io::Result<()> {
    if let Ok(info) = fs::symlink_metadata(target) {
        if info.is_dir() && !info.file_type().is_symlink() {
            set_mode(target, mode)?;
        }
    }
    Ok(())
}

fn write_new_file(target: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    let mut file = options.open(target)?;
    file.write_all(bytes)?;
    file.flush()
}

/** 호출마다 다른 임시 이름(`<자리>.<pid><차례><시각>.tmp`). 부모 폴더 안에 만들어진다 */
fn staged_path(target: &Path) -> PathBuf {
    let step = STAGED.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut name = target.as_os_str().to_owned();
    name.push(format!(".{:x}{step:x}{nanos:x}.tmp", std::process::id()));
    PathBuf::from(name)
}

/**
 * 샌드박스 id로 관문 폴더 이름을 만든다. 옛 `gatewayDirFor`와 같다: 정해진 글자만 남기고 나머지는 `-`로 바꾼다.
 * JS의 정규식은 UTF-16 코드 단위로 맞추므로 서로게이트 쌍 하나는 `-` 두 개가 된다(같은 이름이 되지 않게 그대로 따른다)
 */
pub fn gateway_dir_for(root: &Path, sandbox_id: &str) -> Result<PathBuf, GatewayIoError> {
    let mut safe = String::new();
    for unit in sandbox_id.encode_utf16() {
        let ch = char::from_u32(u32::from(unit)).unwrap_or('\u{fffd}');
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            safe.push(ch);
        } else {
            safe.push('-');
        }
    }
    if safe.is_empty() || safe == "." || safe == ".." {
        return Err(GatewayIoError::InvalidId(sandbox_id.to_owned()));
    }
    Ok(root.join(safe))
}

/** 부모가 진짜 폴더일 때만 자식을 본다. 부모가 링크면 그 너머로 들어가지 않는다 */
fn lstat_child(parent: &Path, child: &Path) -> Option<fs::Metadata> {
    let info = fs::symlink_metadata(parent).ok()?;
    if !info.is_dir() || info.file_type().is_symlink() {
        return None;
    }
    fs::symlink_metadata(child).ok()
}

/**
 * 폴더 자리를 확보한다. 자리가 링크거나 폴더가 아니면 자리 자체를 지우고 새로 만든다 —
 * 링크의 대상은 건드리지 않는다. `mkdir`은 자리 자체만 만들고 링크를 따라가지 않는다
 */
fn ensure_gateway_dir(target: &Path) -> Result<(), GatewayIoError> {
    if let Ok(info) = fs::symlink_metadata(target) {
        if !info.is_dir() || info.file_type().is_symlink() {
            match fs::remove_file(target) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(GatewayIoError::Io(error)),
            }
        }
    }
    create_dir(target, 0o700)?;
    let after = fs::symlink_metadata(target)?;
    if !after.is_dir() || after.file_type().is_symlink() {
        return Err(GatewayIoError::MakeDir(target.to_path_buf()));
    }
    set_mode_if_real_dir(target, 0o700)?;
    Ok(())
}

/**
 * 세션의 관문 폴더 자리를 준비하고 링크를 푼 진짜 경로를 돌려준다. 옛 `writeHostGatewayConfig`의 앞부분이다.
 * 관문 폴더 안의 링크를 따라가지 않는다: 하위 폴더 자리가 링크면 그 자리만 지우고 새로 만든다
 */
pub fn prepare_gateway_dir(root: &Path, sandbox_id: &str) -> Result<PathBuf, GatewayIoError> {
    create_dir(root, 0o700)?;
    let made = gateway_dir_for(root, sandbox_id)?;
    // 관문 폴더 자체가 링크면 그 너머를 건드리지 않고 멈춘다(루트 아래의 세션 폴더를 링크로 바꾼 경우다)
    if let Ok(info) = fs::symlink_metadata(&made) {
        if info.file_type().is_symlink() {
            return Err(GatewayIoError::Link(made));
        }
    }
    create_dir(&made, 0o700)?;
    // 훅 명령과 감싸개에 이 폴더의 경로가 들어간다. 링크를 푼 진짜 경로로 적는다(위에서 링크가 아님을 확인했다)
    let dir = fs::canonicalize(&made)?;
    for name in GATEWAY_DIRS {
        ensure_gateway_dir(&dir.join(name))?;
    }
    // 이미 있던 폴더에는 mkdir의 mode가 적용되지 않는다. 부를 때마다 다시 조인다
    set_mode_if_real_dir(&dir, 0o700)?;
    for name in GATEWAY_DIRS {
        set_mode_if_real_dir(&dir.join(name), 0o700)?;
    }
    Ok(dir)
}

/**
 * 관문 폴더에 기대하는 파일을 쓴다. 내용이 같은 보통 파일이면 그대로 두고, 아니면 임시 이름에 새로 써서 옮긴다.
 * 기대하는 자리가 보통 파일이 아니면(없거나, 링크거나, 폴더면) 다시 쓴다. 내용이 같아 쓰지 않았어도 권한을 다시 조인다
 */
pub fn write_gateway_files(
    dir: &Path,
    files: &[GatewayFile],
    statusline_name: &str,
) -> Result<(), GatewayIoError> {
    // 사용자가 상태 줄을 지웠으면 지난번에 적어 둔 원래 명령도 지운다(#920). 링크면 자리만 지운다
    if !files.iter().any(|file| file.name == statusline_name) {
        let _ = fs::remove_file(dir.join(statusline_name));
    }
    for spec in files {
        let target = dir.join(&spec.name);
        let same = match fs::symlink_metadata(&target) {
            Ok(info) => {
                info.file_type().is_file()
                    && !info.file_type().is_symlink()
                    && fs::read(&target)
                        .map(|bytes| bytes == spec.content.as_bytes())
                        .unwrap_or(false)
            }
            Err(_) => false,
        };
        if !same {
            // 추측할 수 없는 이름을 새로 만들 때만 쓰고(wx) 옮긴다. 미리 심어 둔 링크를 따라 쓰지 않는다.
            // rename은 자리의 링크를 그 대상이 아니라 자리 자체로 바꾼다
            let staged = staged_path(&target);
            write_new_file(&staged, spec.content.as_bytes(), spec.mode)?;
            fs::rename(&staged, &target)?;
        }
        // 내용이 같아 쓰지 않았어도 권한이 넓혀져 있을 수 있다(주소 파일에는 토큰이 있다). 보통 파일일 때만 다시 조인다
        if let Ok(info) = fs::symlink_metadata(&target) {
            if info.file_type().is_file() && !info.file_type().is_symlink() {
                set_mode(&target, spec.mode)?;
            }
        }
    }
    Ok(())
}

/**
 * 관문 폴더가 쓴 그대로인가. 다르거나 없거나 권한이 다른 파일의 이름(폴더 기준)을 돌려준다.
 * 기대하는 파일 자리가 심볼릭 링크면 다른 것을 가리킨 것이므로 위반으로 본다.
 * 폴더 권한이 다르면 그 폴더 이름도 넣는다(관문 폴더 자체는 '.'). 기대하지 않은 파일이 생긴 것은 위반으로 보지 않는다
 */
pub fn check_gateway_config(dir: &Path, expected: &[GatewayFile]) -> Vec<String> {
    let mut bad = Vec::new();
    for spec in expected {
        let target = dir.join(&spec.name);
        let ok = match fs::symlink_metadata(&target) {
            Ok(info) => {
                info.file_type().is_file()
                    && !info.file_type().is_symlink()
                    && mode_of(&info) == spec.mode
                    && fs::read(&target)
                        .map(|bytes| bytes == spec.content.as_bytes())
                        .unwrap_or(false)
            }
            Err(_) => false,
        };
        if !ok {
            bad.push(spec.name.clone());
        }
    }
    for name in GATEWAY_FOLDER_NAMES {
        let target = if name.is_empty() {
            dir.to_path_buf()
        } else {
            dir.join(name)
        };
        let ok = match fs::symlink_metadata(&target) {
            Ok(info) => info.is_dir() && !info.file_type().is_symlink() && mode_of(&info) == 0o700,
            Err(_) => false,
        };
        if !ok {
            bad.push(if name.is_empty() {
                ".".to_owned()
            } else {
                name.to_owned()
            });
        }
    }
    bad
}

/**
 * 세션이 멈출 때 그 세션의 관문 설정을 지운다. 이 코드가 쓴 파일만 지우고, 폴더는 비었을 때만 지운다.
 * 링크를 따라가지 않는다: 관문 폴더 자체나 하위 폴더가 링크면 그 너머의 파일은 건드리지 않고 링크 자리만 지운다
 */
pub fn remove_gateway_config(root: &Path, sandbox_id: &str) -> Result<(), GatewayIoError> {
    let dir = gateway_dir_for(root, sandbox_id)?;
    let Ok(dir_info) = fs::symlink_metadata(&dir) else {
        return Ok(());
    };
    // 관문 폴더 자체가 링크면 그 너머를 건드리지 않고 링크만 지운다
    if dir_info.file_type().is_symlink() {
        let _ = fs::remove_file(&dir);
        return Ok(());
    }
    // 하위 폴더가 링크면 그 안으로 들어가지 않고 링크 자체만 지운다
    for name in GATEWAY_DIRS {
        let folder = dir.join(name);
        if let Some(info) = lstat_child(folder.parent().unwrap_or(&dir), &folder) {
            if info.file_type().is_symlink() {
                let _ = fs::remove_file(&folder);
            }
        }
    }
    // 파일은 그 부모 폴더가 진짜일 때만 지운다(부모가 링크면 그 너머의 파일을 지우지 않는다)
    for name in GATEWAY_FILE_NAMES {
        let target = dir.join(name);
        if lstat_child(target.parent().unwrap_or(&dir), &target).is_some() {
            let _ = fs::remove_file(&target);
        }
    }
    // CLI가 끝나 터미널이 zsh로 돌아가면 compinit이 ZDOTDIR(관문의 shell/zsh)에 `.zcompdump*`를 쓴다(#1296). 다시 만들어지는 캐시라 지운다.
    // 진짜 shell/zsh 바로 아래의 이름만 본다. 링크면 링크 자리만 지우고(remove_file은 링크를 따라가지 않는다) 폴더는 건드리지 않는다
    let zsh = dir.join("shell/zsh");
    if let Some(info) = lstat_child(zsh.parent().unwrap_or(&dir), &zsh) {
        if info.is_dir() && !info.file_type().is_symlink() {
            if let Ok(entries) = fs::read_dir(&zsh) {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    if !name.to_string_lossy().starts_with(".zcompdump") {
                        continue;
                    }
                    let target = zsh.join(&name);
                    if let Ok(info) = fs::symlink_metadata(&target) {
                        if info.file_type().is_file() || info.file_type().is_symlink() {
                            let _ = fs::remove_file(&target);
                        }
                    }
                }
            }
        }
    }
    // 진짜 폴더만 비었을 때 지운다(역순)
    for name in GATEWAY_DIRS.iter().rev() {
        let folder = dir.join(name);
        if let Some(info) = lstat_child(folder.parent().unwrap_or(&dir), &folder) {
            if info.is_dir() && !info.file_type().is_symlink() {
                let _ = fs::remove_dir(&folder);
            }
        }
    }
    let _ = fs::remove_dir(&dir);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_dir_for_keeps_safe_characters() {
        let root = Path::new("/tmp/root");
        assert_eq!(
            gateway_dir_for(root, "studio-orders-abc").unwrap(),
            root.join("studio-orders-abc")
        );
        assert_eq!(gateway_dir_for(root, "a/b c").unwrap(), root.join("a-b-c"));
        assert!(gateway_dir_for(root, ".").is_err());
        assert!(gateway_dir_for(root, "").is_err());
    }
}
