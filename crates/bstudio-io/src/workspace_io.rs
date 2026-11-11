//! 작업 공간(`packages/agent/src/workspace.ts`·`change-tracker.ts`)의 파일 시스템 I/O(ADR-195 4f A3). 옛 TS의 `node:fs` 호출을 옮긴 것이다.
//! 무엇이 막히는지는 [`bstudio_guard::workspace_guard`]가 정하고, 여기는 그 판정을 지키면서 실제로 열고 읽고 쓰고 지운다.
//!
//! **확인과 실행이 같은 대상을 쓴다.** 옛 구현은 `#resolve`가 경로를 문자열로 확인한 뒤 `open(경로)`로 다시 열었고, 확인과 여는 사이에
//! 상위 폴더가 링크로 바뀌는 틈을 열기 뒤의 `realpath`·`dev/ino` 비교로 좁혔다. 여기서는 루트의 실제 위치를 폴더 서술자로 열고 그 아래를 조각마다
//! `openat(O_NOFOLLOW)`로 내려간다. **경로의 어느 조각이든 링크면 열지 않는다.** 그래서 연 파일은 구성상 루트 안의 것이고, 쓰기가 만드는 폴더와 파일도
//! 걸어 내려온 폴더 서술자 아래에만 생긴다(옛 한계였던 "O_CREAT가 바깥에 빈 파일을 만든다"가 없다). 읽기·쓰기·지우기는 연 서술자(또는 부모 서술자 + 이름)로 한다.
//!
//! **막는 쪽과 여는 쪽(자리마다 다르다).** 숨긴 이름(`is_denied`)은 거부 목록이다: 아는 만큼 넓게 맞추고, 모르는 입력(NUL, `..`, 읽을 수 없는 조각)은 걸린 것으로 본다.
//! 프로젝트 안쪽·링크 없음은 허용 목록이다: 통과가 곧 안쪽이라서 모르는 입력은 거절한다(`..` 조각, 확인하지 못한 조각의 오류, 실제 위치를 풀 수 없는 루트).
//! `*_tool` 계열(`resolve`·`read_dir`·`lstat`·`read_file`·`write_file`·`remove_file`)은 숨긴 이름을 조각마다 다시 본다 — TS가 이미 걸렀어도 여기서 한 번 더 건다(확인하는 쪽과 실행하는 쪽이 같다).
//! 반대로 `read_project_file`·`read_regular_file`·`fingerprint`·보호 경로 고정은 숨긴 이름을 걸지 않는다(게이트가 `.env`의 지문을 떠야 하고, 요구사항 문서처럼 정해진 경로만 읽는다).
//!
//! 짝이 되는 자리: 보호 경로 고정(`PinStore::pin`)과 비교(`PinStore::restored`)는 같은 `read_project_file`을 쓴다(ADR-196 결정 5).
//! 동기 함수가 본체이고 napi 층(`bstudio-node`)이 `spawn_blocking`으로 감싼다. Windows에서는 지원하지 않고 모두 닫힌 쪽(실패)으로 돌려준다.

use std::collections::HashMap;
use std::path::Path;

/// 보호 경로 파일의 고정·비교에서 읽는 상한(1MiB). 크기는 읽기 전에 본다
pub const MAX_PIN_BYTES: f64 = 1024.0 * 1024.0;

/// 파일을 읽은 결과: 없음, 읽은 바이트(`complete`가 거짓이면 확인한 크기만큼 다 읽지 못했거나 읽는 동안 바뀜), 읽지 않은 이유
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileRead {
    Missing,
    Bytes { content: Vec<u8>, complete: bool },
    Irregular(String),
}

/// 열지 못한 이유. `code()`가 napi를 건너 TS로 가는 글이다
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// 경로의 어느 조각이 링크다(깨진 링크 포함)
    Link,
    /// 루트 밖이다(`..` 조각, 실제 위치가 루트 밖)
    Outside,
    /// 숨긴 이름이다
    Denied,
    /// 파일이 없다(`must_exist`)
    Missing,
    /// 일반 파일이 아니다
    NotRegular,
    /// 상한보다 크다(크기)
    TooLarge(u64),
    /// 운영체제 오류(이름)
    Os(&'static str),
    /// 그 밖(지원하지 않는 플랫폼, 이름에 NUL 등)
    Other(String),
}

impl Failure {
    pub fn code(&self) -> String {
        match self {
            Failure::Link => "LINK".to_owned(),
            Failure::Outside => "OUTSIDE".to_owned(),
            Failure::Denied => "DENIED".to_owned(),
            Failure::Missing => "MISSING".to_owned(),
            Failure::NotRegular => "NOT_REGULAR".to_owned(),
            Failure::TooLarge(size) => format!("TOO_LARGE:{size}"),
            Failure::Os(name) => format!("OS:{name}"),
            Failure::Other(message) => format!("OTHER:{message}"),
        }
    }

    /// 없는 것으로 읽는 오류인가(`ENOENT`·`ENOTDIR`)
    pub fn is_missing(&self) -> bool {
        matches!(self, Failure::Missing | Failure::Os("ENOENT" | "ENOTDIR"))
    }
}

/// 항목의 종류(링크를 따라가지 않은 것)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Link,
    Other,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::File => "file",
            Kind::Dir => "dir",
            Kind::Link => "link",
            Kind::Other => "other",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub kind: Kind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stat {
    pub kind: Kind,
    pub size: u64,
}

/// 읽는 동안 파일이 줄거나 늘었는지 보려고 `fstat` 두 번과 `pread`를 추상화한 것. 시험이 짧게 읽힘·덧붙음을 흉내 내는 자리다
pub struct Meta {
    pub is_file: bool,
    pub size: u64,
    pub mtime: (i64, i64),
}

pub trait Source {
    fn meta(&self) -> std::io::Result<Meta>;
    fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize>;
}

fn max_label(max: f64) -> String {
    if max.is_finite() && max.fract() == 0.0 {
        format!("{}", max as u64)
    } else {
        format!("{max}")
    }
}

/// 연 파일 자체(`fstat`)로 종류와 크기를 읽기 전에 보고(상한 초과면 내용을 읽지 않는다), 확인한 크기만큼 읽은 뒤 한 번 더 `fstat`해 크기·수정 시각이 그대로일 때만 완전한 읽기로 본다
pub fn read_source(source: &impl Source, max: f64) -> FileRead {
    let Ok(first) = source.meta() else {
        return FileRead::Irregular("읽을 수 없습니다".to_owned());
    };
    if !first.is_file {
        return FileRead::Irregular("일반 파일이 아닙니다".to_owned());
    }
    if first.size as f64 > max {
        return FileRead::Irregular(format!("너무 큽니다({}바이트, 상한 {}바이트)", first.size, max_label(max)));
    }
    let size = first.size as usize;
    let mut buffer = vec![0u8; size];
    let mut offset = 0usize;
    while offset < size {
        match source.read_at(&mut buffer[offset..], offset as u64) {
            Ok(0) => break,
            Ok(read) => offset += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return FileRead::Irregular("읽을 수 없습니다".to_owned()),
        }
    }
    let Ok(after) = source.meta() else {
        return FileRead::Irregular("읽을 수 없습니다".to_owned());
    };
    let complete = offset == size && after.size == first.size && after.mtime == first.mtime;
    buffer.truncate(offset);
    FileRead::Bytes { content: buffer, complete }
}

/// 보호 경로 파일의 쓰기 직전 고정값과 비교(ADR-196). **같은 구현**이 읽는다: 고정할 때와 견줄 때 파일을 읽는 방법이 갈리면(링크, 상한, 읽기 실패) 같은 내용을 다르게 본다.
/// 고정하지 못한 파일은 `Irregular`로 적어, 나중의 쓰기가 이미 바뀐 내용을 고정값으로 삼지 못하게 한다
#[derive(Default)]
pub struct PinStore {
    pins: HashMap<String, FileRead>,
}

impl PinStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn contains(&self, relative: &str) -> bool {
        self.pins.contains_key(relative)
    }

    /// 처음 한 번만 고정한다(이미 있으면 그대로 둔다). 링크이거나 일반 파일이 아니거나 상한을 넘거나 읽지 못했으면 그 이유가 고정값이 된다
    pub fn pin(&mut self, root: &Path, relative: &str) {
        if self.pins.contains_key(relative) {
            return;
        }
        self.pins.insert(relative.to_owned(), read_project_file(root, relative, MAX_PIN_BYTES));
    }

    /// 고정하지 않기로 한 파일을 표시한다(이미 바뀐 목록에 있다, 도구 밖 변경을 옮기지 못했다)
    pub fn pin_unpinned(&mut self, relative: &str, reason: &str) {
        if !self.pins.contains_key(relative) {
            self.pins.insert(relative.to_owned(), FileRead::Irregular(reason.to_owned()));
        }
    }

    /// `files` 중 고정값이 있고 지금 내용이 그 고정값과 바이트까지 같은 파일(열린 쪽 판정이라 모르면 같다고 하지 않는다). 없던 파일(고정값이 "없음")은 지금도 없을 때만 같다
    pub fn restored(&self, root: &Path, files: &[String]) -> Vec<String> {
        let mut restored = Vec::new();
        for file in files {
            let Some(pin) = self.pins.get(file) else { continue };
            let now = read_project_file(root, file, MAX_PIN_BYTES);
            let same = match (pin, &now) {
                (FileRead::Missing, FileRead::Missing) => true,
                (FileRead::Bytes { content: before, complete: true }, FileRead::Bytes { content: after, complete: true }) => before == after,
                _ => false,
            };
            if same {
                restored.push(file.clone());
            }
        }
        restored
    }
}

/// 짝 없는 서로게이트 때문에 U+FFFD로 바뀐 이름이 아니라, 파일 시스템의 실제 저장 이름에서 루트 기준 조각을 뽑는다. `canonical`이 오류면 받은 조각을 그대로 쓴다(옛 TS와 같다).
/// 루트 밖이면 `Outside`(허용 목록: 모르면 밖), 숨긴 이름이 있으면 `Denied`(거부 목록)
pub fn stored_segments(real_root: &Path, canonical: std::io::Result<std::path::PathBuf>, given: &[&str]) -> Result<Vec<String>, Failure> {
    let segments: Vec<String> = match canonical {
        Ok(path) => {
            let Ok(rest) = path.strip_prefix(real_root) else {
                return Err(Failure::Outside);
            };
            rest.components()
                .map(|component| match component {
                    std::path::Component::Normal(name) => Ok(name.to_string_lossy().into_owned()),
                    _ => Err(Failure::Outside),
                })
                .collect::<Result<_, _>>()?
        }
        Err(_) => given.iter().map(|part| (*part).to_owned()).collect(),
    };
    if segments.iter().any(|segment| bstudio_guard::workspace_guard::is_denied(segment)) {
        return Err(Failure::Denied);
    }
    Ok(segments)
}

/// 경로의 조각들. 빈 조각과 `.`은 건너뛰고 `..`는 거절한다(허용 목록: 정리하지 못한 모양은 밖). 이름의 NUL도 거절한다
fn components(relative: &str) -> Result<Vec<&str>, Failure> {
    // 절대 경로는 루트 기준 상대 경로가 아니다. 앞의 `/`를 빈 조각으로 건너뛰면 `/etc/hosts`가 `etc/hosts`가 된다
    if relative.starts_with('/') {
        return Err(Failure::Outside);
    }
    let mut parts = Vec::new();
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(Failure::Outside),
            other => {
                if other.contains('\0') {
                    return Err(Failure::Other("이름에 NUL이 있습니다".to_owned()));
                }
                parts.push(other);
            }
        }
    }
    Ok(parts)
}

/// 숨긴 이름이 있으면 거절한다(거부 목록)
fn deny_check(parts: &[&str]) -> Result<(), Failure> {
    if parts.iter().any(|part| bstudio_guard::workspace_guard::is_denied(part)) {
        return Err(Failure::Denied);
    }
    Ok(())
}

#[cfg(unix)]
mod imp {
    use super::*;
    use std::ffi::{CStr, CString};
    use std::fs::File;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::{FileExt, MetadataExt};
    use std::path::PathBuf;

    fn errno() -> i32 {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
    }

    pub(super) fn errno_name(code: i32) -> &'static str {
        match code {
            libc::ENOENT => "ENOENT",
            libc::ENOTDIR => "ENOTDIR",
            libc::ELOOP => "ELOOP",
            libc::EMLINK => "EMLINK",
            libc::EACCES => "EACCES",
            libc::EPERM => "EPERM",
            libc::EISDIR => "EISDIR",
            libc::EEXIST => "EEXIST",
            libc::ENXIO => "ENXIO",
            libc::EMFILE => "EMFILE",
            libc::ENFILE => "ENFILE",
            libc::ENOSPC => "ENOSPC",
            libc::EROFS => "EROFS",
            libc::EIO => "EIO",
            libc::ENAMETOOLONG => "ENAMETOOLONG",
            libc::EBUSY => "EBUSY",
            libc::ENOTEMPTY => "ENOTEMPTY",
            libc::EINVAL => "EINVAL",
            libc::EFBIG => "EFBIG",
            libc::EXDEV => "EXDEV",
            _ => "UNKNOWN",
        }
    }

    fn cstring(name: &str) -> Result<CString, Failure> {
        CString::new(name).map_err(|_| Failure::Other("이름에 NUL이 있습니다".to_owned()))
    }

    fn openat(dir: RawFd, name: &CStr, flags: libc::c_int, mode: libc::c_uint) -> Result<OwnedFd, i32> {
        loop {
            // SAFETY: name은 NUL로 끝나는 C 문자열이고 dir은 열려 있는 서술자다
            let fd = unsafe { libc::openat(dir, name.as_ptr(), flags | libc::O_CLOEXEC, mode) };
            if fd >= 0 {
                // SAFETY: openat이 새로 돌려준 서술자의 소유권을 넘겨받는다
                return Ok(unsafe { OwnedFd::from_raw_fd(fd) });
            }
            let code = errno();
            if code != libc::EINTR {
                return Err(code);
            }
        }
    }

    fn fstatat_nofollow(dir: RawFd, name: &CStr) -> Result<libc::stat, i32> {
        // SAFETY: stat은 0으로 채운 값이 유효하고, 아래 호출이 채운다
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: name은 NUL로 끝나고 st는 쓸 수 있는 자리다
        if unsafe { libc::fstatat(dir, name.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } == 0 {
            Ok(st)
        } else {
            Err(errno())
        }
    }

    fn kind_of(mode: libc::mode_t) -> Kind {
        match mode & libc::S_IFMT {
            libc::S_IFREG => Kind::File,
            libc::S_IFDIR => Kind::Dir,
            libc::S_IFLNK => Kind::Link,
            _ => Kind::Other,
        }
    }

    impl Source for File {
        fn meta(&self) -> std::io::Result<Meta> {
            let meta = self.metadata()?;
            Ok(Meta { is_file: meta.is_file(), size: meta.len(), mtime: (meta.mtime(), meta.mtime_nsec()) })
        }

        fn read_at(&self, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
            FileExt::read_at(self, buf, offset)
        }
    }

    /// 루트의 실제 위치(링크를 푼 것)와 그것을 연 폴더 서술자. 루트 자체가 링크를 거쳐 있어도 된다(루트는 믿는 값이다)
    fn open_root(root: &Path) -> Result<(PathBuf, OwnedFd), Failure> {
        let real = std::fs::canonicalize(root).map_err(|error| Failure::Os(errno_name(error.raw_os_error().unwrap_or(0))))?;
        let c = CString::new(real.as_os_str().as_bytes()).map_err(|_| Failure::Other("루트에 NUL이 있습니다".to_owned()))?;
        // SAFETY: c는 NUL로 끝나는 C 문자열이다
        let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(Failure::Os(errno_name(errno())));
        }
        // SAFETY: open이 새로 돌려준 서술자의 소유권을 넘겨받는다
        Ok((real, unsafe { OwnedFd::from_raw_fd(fd) }))
    }

    fn dup(fd: &OwnedFd) -> Result<OwnedFd, Failure> {
        fd.try_clone().map_err(|error| Failure::Os(errno_name(error.raw_os_error().unwrap_or(0))))
    }

    /// `dir` 아래의 폴더 `name`을 링크를 따라가지 않고 연다. 링크면 `Link`, 폴더가 아니면 `Os("ENOTDIR")`, 없으면 `Os("ENOENT")`.
    /// `O_DIRECTORY|O_NOFOLLOW`가 링크에서 내는 오류가 플랫폼마다 다르다(리눅스 ENOTDIR, macOS ELOOP) — 오류가 나면 링크인지 `fstatat`으로 따로 본다
    fn open_dir_nofollow(dir: RawFd, name: &str) -> Result<OwnedFd, Failure> {
        let c = cstring(name)?;
        match openat(dir, &c, libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW, 0) {
            Ok(fd) => Ok(fd),
            Err(libc::ELOOP | libc::ENOTDIR | libc::EMLINK) => match fstatat_nofollow(dir, &c) {
                Ok(st) if kind_of(st.st_mode) == Kind::Link => Err(Failure::Link),
                Ok(_) => Err(Failure::Os("ENOTDIR")),
                Err(inner) => Err(Failure::Os(errno_name(inner))),
            },
            Err(code) => Err(Failure::Os(errno_name(code))),
        }
    }

    fn mkdirat(dir: RawFd, name: &str) -> Result<(), Failure> {
        let c = cstring(name)?;
        // SAFETY: c는 NUL로 끝나는 C 문자열이고 dir은 열려 있는 서술자다
        if unsafe { libc::mkdirat(dir, c.as_ptr(), 0o777) } == 0 {
            return Ok(());
        }
        match errno() {
            libc::EEXIST => Ok(()),
            code => Err(Failure::Os(errno_name(code))),
        }
    }

    /// 루트 서술자에서 `parts`의 폴더들을 조각마다 링크 없이 내려가 마지막 폴더의 서술자를 돌려준다. `make`면 없는 폴더를 만들고 다시 같은 방식으로 연다
    fn descend(root: &OwnedFd, parts: &[&str], make: bool) -> Result<OwnedFd, Failure> {
        let mut current = dup(root)?;
        for part in parts {
            let next = match open_dir_nofollow(current.as_raw_fd(), part) {
                Err(Failure::Os("ENOENT")) if make => {
                    mkdirat(current.as_raw_fd(), part)?;
                    open_dir_nofollow(current.as_raw_fd(), part)?
                }
                other => other?,
            };
            current = next;
        }
        Ok(current)
    }

    /// 마지막 조각을 뺀 부모 폴더의 서술자와 마지막 이름. 경로가 루트 자신이면 이름이 없다
    struct Opened {
        parent: OwnedFd,
        leaf: Option<String>,
    }

    fn open_parent(root: &Path, relative: &str, deny: bool, make: bool) -> Result<Opened, Failure> {
        let parts = components(relative)?;
        if deny {
            deny_check(&parts)?;
        }
        let (_, root_fd) = open_root(root)?;
        match parts.split_last() {
            None => Ok(Opened { parent: root_fd, leaf: None }),
            Some((leaf, parents)) => {
                let parent = descend(&root_fd, parents, make)?;
                Ok(Opened { parent, leaf: Some((*leaf).to_owned()) })
            }
        }
    }

    fn open_error_to_read(code: i32) -> FileRead {
        match code {
            libc::ENOENT | libc::ENOTDIR => FileRead::Missing,
            libc::ELOOP | libc::EMLINK => FileRead::Irregular("심볼릭 링크입니다".to_owned()),
            other => FileRead::Irregular(format!("열 수 없습니다({})", errno_name(other))),
        }
    }

    const READ_FLAGS: libc::c_int = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK;

    /// 경로로 열되 마지막 조각이 링크면 따라가지 않는다. FIFO·장치가 여는 데서 멈추지 않게 `O_NONBLOCK`으로 열고, 연 뒤 일반 파일인지 `fstat`으로 본다
    pub fn read_regular_file(absolute: &Path, max: f64) -> FileRead {
        let Ok(c) = CString::new(absolute.as_os_str().as_bytes()) else {
            return FileRead::Irregular("열 수 없습니다(UNKNOWN)".to_owned());
        };
        loop {
            // SAFETY: c는 NUL로 끝나는 C 문자열이다
            let fd = unsafe { libc::open(c.as_ptr(), READ_FLAGS | libc::O_CLOEXEC) };
            if fd >= 0 {
                // SAFETY: open이 새로 돌려준 서술자의 소유권을 넘겨받는다
                let file = File::from(unsafe { OwnedFd::from_raw_fd(fd) });
                return read_source(&file, max);
            }
            let code = errno();
            if code != libc::EINTR {
                return open_error_to_read(code);
            }
        }
    }

    /// 프로젝트 루트 기준 경로의 파일을 읽는다. **경로의 어느 조각도 링크를 따라가지 않는다**(옛 구현은 상위 폴더의 `realpath`를 견줬다). 숨긴 이름은 걸지 않는다
    pub fn read_project_file(root: &Path, relative: &str, max: f64) -> FileRead {
        let parts = match components(relative) {
            Ok(parts) => parts,
            Err(Failure::Outside) => return FileRead::Irregular("프로젝트 밖 경로입니다".to_owned()),
            Err(_) => return FileRead::Irregular("열 수 없습니다(UNKNOWN)".to_owned()),
        };
        if !bstudio_guard::workspace_guard::is_inside_relative(relative, false) {
            return FileRead::Irregular("프로젝트 밖 경로입니다".to_owned());
        }
        let Ok((_, root_fd)) = open_root(root) else {
            return FileRead::Irregular("프로젝트 폴더를 열 수 없습니다".to_owned());
        };
        let Some((leaf, parents)) = parts.split_last() else {
            return FileRead::Irregular("일반 파일이 아닙니다".to_owned());
        };
        let parent = match descend(&root_fd, parents, false) {
            Ok(fd) => fd,
            Err(Failure::Link) => return FileRead::Irregular("상위 폴더가 심볼릭 링크입니다".to_owned()),
            Err(failure) if failure.is_missing() => return FileRead::Missing,
            Err(Failure::Os(name)) => return FileRead::Irregular(format!("상위 폴더를 열 수 없습니다({name})")),
            Err(_) => return FileRead::Irregular("상위 폴더를 열 수 없습니다(알 수 없는 오류)".to_owned()),
        };
        let Ok(c) = cstring(leaf) else {
            return FileRead::Irregular("열 수 없습니다(UNKNOWN)".to_owned());
        };
        match openat(parent.as_raw_fd(), &c, READ_FLAGS, 0) {
            Ok(fd) => read_source(&File::from(fd), max),
            Err(code) => open_error_to_read(code),
        }
    }

    fn open_leaf_read(parent: &OwnedFd, leaf: &str) -> Result<File, Failure> {
        let c = cstring(leaf)?;
        match openat(parent.as_raw_fd(), &c, READ_FLAGS, 0) {
            Ok(fd) => Ok(File::from(fd)),
            Err(libc::ELOOP | libc::EMLINK) => Err(Failure::Link),
            Err(code) => Err(Failure::Os(errno_name(code))),
        }
    }

    /// 경로가 다룰 수 있는 곳인지 보고 저장된 이름을 돌려준다(`Workspace.#resolve`의 파일 시스템 쪽). 읽지도 쓰지도 않는다.
    /// 조각마다 링크를 따라가지 않고 내려가며 첫 링크에서 `Link`로 멈춘다(깨진 링크 포함). 없는 조각부터는 아직 없는 경로다(쓰기가 새로 만든다).
    /// 없는 조각을 만나기 전까지의 앞부분은 운영체제가 알려 주는 실제 저장 이름으로 돌려준다(대소문자·정규화 꼴). 확인하지 못한 조각의 오류는 통과가 아니라 거절이다
    pub fn resolve(root: &Path, relative: &str, must_exist: bool) -> Result<String, Failure> {
        let parts = components(relative)?;
        deny_check(&parts)?;
        let (real_root, root_fd) = open_root(root)?;
        let mut dir = dup(&root_fd)?;
        let mut existing = 0usize;
        for (index, part) in parts.iter().enumerate() {
            let c = cstring(part)?;
            let st = match fstatat_nofollow(dir.as_raw_fd(), &c) {
                Ok(st) => st,
                Err(libc::ENOENT | libc::ENOTDIR) => break,
                Err(code) => return Err(Failure::Os(errno_name(code))),
            };
            match kind_of(st.st_mode) {
                Kind::Link => return Err(Failure::Link),
                Kind::Dir if index + 1 < parts.len() => {
                    existing = index + 1;
                    dir = open_dir_nofollow(dir.as_raw_fd(), part)?;
                }
                // 파일이 폴더 자리에 있으면 그 아래는 없는 경로다(옛 `lstat` 실패와 같다)
                _ => {
                    existing = index + 1;
                    break;
                }
            }
        }
        if must_exist && existing != parts.len() {
            return Err(Failure::Missing);
        }
        let prefix = &parts[..existing];
        let canonical = std::fs::canonicalize(prefix.iter().fold(real_root.clone(), |path, part| path.join(part)));
        let mut stored = stored_segments(&real_root, canonical, prefix)?;
        stored.extend(parts[existing..].iter().map(|part| (*part).to_owned()));
        Ok(stored.join("/"))
    }

    /// 폴더의 항목(이름과 종류). 숨긴 이름은 돌려주지 않고 링크를 따라가지 않는다. 순서는 정하지 않는다
    pub fn read_dir(root: &Path, relative: &str) -> Result<Vec<DirEntry>, Failure> {
        let parts = components(relative)?;
        deny_check(&parts)?;
        let (_, root_fd) = open_root(root)?;
        let dir = descend(&root_fd, &parts, false)?;
        let duplicate = dup(&dir)?;
        // SAFETY: fdopendir가 서술자의 소유권을 가져간다. 성공하면 closedir이 닫고, 실패하면 우리가 닫는다
        let stream = unsafe { libc::fdopendir(std::os::fd::IntoRawFd::into_raw_fd(duplicate)) };
        if stream.is_null() {
            return Err(Failure::Os(errno_name(errno())));
        }
        let mut entries = Vec::new();
        loop {
            // SAFETY: stream은 열린 DIR이다
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                break;
            }
            // SAFETY: readdir이 돌려준 항목은 다음 readdir·closedir 전까지 유효하다
            let (name, d_type) = unsafe { (CStr::from_ptr((*entry).d_name.as_ptr()).to_string_lossy().into_owned(), (*entry).d_type) };
            if name == "." || name == ".." || bstudio_guard::workspace_guard::is_denied(&name) {
                continue;
            }
            let kind = match d_type {
                libc::DT_REG => Kind::File,
                libc::DT_DIR => Kind::Dir,
                libc::DT_LNK => Kind::Link,
                libc::DT_UNKNOWN => match cstring(&name).ok().and_then(|c| fstatat_nofollow(dir.as_raw_fd(), &c).ok()) {
                    Some(st) => kind_of(st.st_mode),
                    None => Kind::Other,
                },
                _ => Kind::Other,
            };
            entries.push(DirEntry { name, kind });
        }
        // SAFETY: stream은 열린 DIR이고 한 번만 닫는다
        unsafe { libc::closedir(stream) };
        Ok(entries)
    }

    /// 링크를 따라가지 않는 종류·크기. 경로가 루트 자신이면 루트 폴더의 것이다
    pub fn lstat(root: &Path, relative: &str) -> Result<Stat, Failure> {
        let opened = open_parent(root, relative, true, false)?;
        let st = match &opened.leaf {
            Some(leaf) => fstatat_nofollow(opened.parent.as_raw_fd(), &cstring(leaf)?),
            None => fstatat_nofollow(opened.parent.as_raw_fd(), c"."),
        }
        .map_err(|code| Failure::Os(errno_name(code)))?;
        Ok(Stat { kind: kind_of(st.st_mode), size: st.st_size.max(0) as u64 })
    }

    /// 파일 내용을 읽는다. 마지막 조각이 링크면 열지 않고(`Link`), 일반 파일이 아니면 읽지 않고(`NotRegular`), `max`가 있으면 크기를 **읽기 전에** 봐서 넘으면 `TooLarge`.
    /// `max`가 있으면 확인한 크기까지만 읽는다(확인 뒤에 파일이 늘어나도 그 뒤는 읽지 않는다)
    pub fn read_file(root: &Path, relative: &str, max: Option<f64>) -> Result<Vec<u8>, Failure> {
        let opened = open_parent(root, relative, true, false)?;
        let Some(leaf) = &opened.leaf else {
            return Err(Failure::NotRegular);
        };
        let file = open_leaf_read(&opened.parent, leaf)?;
        let meta = file.metadata().map_err(|error| Failure::Os(errno_name(error.raw_os_error().unwrap_or(0))))?;
        if !meta.is_file() {
            return Err(Failure::NotRegular);
        }
        let size = meta.len();
        match max {
            Some(limit) => {
                if size as f64 > limit {
                    return Err(Failure::TooLarge(size));
                }
                let mut buffer = vec![0u8; size as usize];
                let mut offset = 0usize;
                while offset < buffer.len() {
                    match FileExt::read_at(&file, &mut buffer[offset..], offset as u64) {
                        Ok(0) => break,
                        Ok(read) => offset += read,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(error) => return Err(Failure::Os(errno_name(error.raw_os_error().unwrap_or(0)))),
                    }
                }
                buffer.truncate(offset);
                Ok(buffer)
            }
            None => {
                let mut buffer = Vec::new();
                let mut reader = &file;
                std::io::Read::read_to_end(&mut reader, &mut buffer).map_err(|error| Failure::Os(errno_name(error.raw_os_error().unwrap_or(0))))?;
                Ok(buffer)
            }
        }
    }

    /// 파일을 쓴다. 부모 폴더는 링크 없이 내려가며(`make_dirs`면 없는 것을 만들며) 열고, 파일은 부모 서술자 아래에서 `O_NOFOLLOW`로 연다.
    /// 일반 파일이 아니면 비우기 전에 거절한다(`NotRegular`). 비우기는 연 파일에 한다(`O_TRUNC`는 일반 파일임을 보기 전이라 쓰지 않는다). FIFO는 `O_NONBLOCK`이라 여는 데서 멈추지 않는다
    pub fn write_file(root: &Path, relative: &str, data: &[u8], make_dirs: bool) -> Result<(), Failure> {
        let opened = open_parent(root, relative, true, make_dirs)?;
        let Some(leaf) = &opened.leaf else {
            return Err(Failure::Os("EISDIR"));
        };
        let c = cstring(leaf)?;
        let fd = match openat(opened.parent.as_raw_fd(), &c, libc::O_WRONLY | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_NONBLOCK, 0o666) {
            Ok(fd) => fd,
            Err(libc::ELOOP | libc::EMLINK) => return Err(Failure::Link),
            Err(code) => return Err(Failure::Os(errno_name(code))),
        };
        let file = File::from(fd);
        let meta = file.metadata().map_err(|error| Failure::Os(errno_name(error.raw_os_error().unwrap_or(0))))?;
        if !meta.is_file() {
            return Err(Failure::NotRegular);
        }
        file.set_len(0).map_err(|error| Failure::Os(errno_name(error.raw_os_error().unwrap_or(0))))?;
        let mut offset = 0usize;
        while offset < data.len() {
            match FileExt::write_at(&file, &data[offset..], offset as u64) {
                Ok(0) => return Err(Failure::Os("EIO")),
                Ok(written) => offset += written,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(Failure::Os(errno_name(error.raw_os_error().unwrap_or(0)))),
            }
        }
        Ok(())
    }

    /// 항목 하나를 지운다. `unlinkat(부모, 이름, 0)`이라 **그 이름의 항목만** 지운다: 링크면 링크만 지우고 너머를 따라가지 않으며, 폴더는 지우지 못한다(오류).
    /// 부모는 링크 없이 내려간다. 루트 자신은 지우지 못한다
    pub fn remove_file(root: &Path, relative: &str) -> Result<(), Failure> {
        let opened = open_parent(root, relative, true, false)?;
        let Some(leaf) = &opened.leaf else {
            return Err(Failure::Os("EISDIR"));
        };
        let c = cstring(leaf)?;
        // SAFETY: c는 NUL로 끝나는 C 문자열이고 부모는 열려 있는 서술자다. 플래그 0은 폴더를 지우지 않는다
        if unsafe { libc::unlinkat(opened.parent.as_raw_fd(), c.as_ptr(), 0) } == 0 {
            Ok(())
        } else {
            Err(Failure::Os(errno_name(errno())))
        }
    }

    /// 변경 감지용 지문(ChangeTracker): 일반 파일은 `file:<내용 sha256>`, 링크는 `link:<가리키는 곳>`, 그 밖은 `other:<st_mode>`, 읽지 못했거나 없으면 `missing`.
    /// 경로의 조각이 링크를 거치면(git이 내놓지 않는 모양) 링크 파일로 보고 `link:`로 돌려 게이트가 받지 않게 한다(닫힌 쪽). 숨긴 이름은 걸지 않는다 — 비밀 파일의 지문도 떠야 한다.
    /// 내용은 링크를 따라가지 않는 서술자로 읽어 해시한다(상한 없음: 내용 전체의 해시여야 지문이다)
    pub fn fingerprint(root: &Path, relative: &str) -> String {
        let Ok(parts) = components(relative) else { return "missing".to_owned() };
        let Ok((_, root_fd)) = open_root(root) else { return "missing".to_owned() };
        let Some((leaf, parents)) = parts.split_last() else { return "missing".to_owned() };
        let parent = match descend(&root_fd, parents, false) {
            Ok(fd) => fd,
            Err(Failure::Link) => return "link:".to_owned(),
            Err(_) => return "missing".to_owned(),
        };
        let Ok(c) = cstring(leaf) else { return "missing".to_owned() };
        let Ok(st) = fstatat_nofollow(parent.as_raw_fd(), &c) else { return "missing".to_owned() };
        match kind_of(st.st_mode) {
            Kind::Link => {
                let mut buffer = vec![0u8; 4096];
                // SAFETY: buffer는 쓸 수 있는 자리이고 c는 NUL로 끝난다
                let length = unsafe { libc::readlinkat(parent.as_raw_fd(), c.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len()) };
                let target = if length >= 0 { String::from_utf8_lossy(&buffer[..length as usize]).into_owned() } else { String::new() };
                format!("link:{target}")
            }
            Kind::File => {
                let Ok(fd) = openat(parent.as_raw_fd(), &c, READ_FLAGS, 0) else { return "missing".to_owned() };
                let file = File::from(fd);
                match file.metadata() {
                    Ok(meta) if meta.is_file() => {}
                    Ok(meta) => return format!("other:{}", meta.mode()),
                    Err(_) => return "missing".to_owned(),
                }
                let mut hash = bstudio_guard::snapshots::Sha256::new();
                let mut buffer = vec![0u8; 64 * 1024];
                let mut offset = 0u64;
                loop {
                    match FileExt::read_at(&file, &mut buffer, offset) {
                        Ok(0) => break,
                        Ok(read) => {
                            hash.update(&buffer[..read]);
                            offset += read as u64;
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => return "missing".to_owned(),
                    }
                }
                format!("file:{}", bstudio_guard::snapshots::hex(&hash.finish()))
            }
            _ => format!("other:{}", st.st_mode),
        }
    }
}

#[cfg(not(unix))]
mod imp {
    use super::*;

    fn unsupported() -> Failure {
        Failure::Other("이 플랫폼은 지원하지 않습니다".to_owned())
    }

    pub fn read_regular_file(_absolute: &Path, _max: f64) -> FileRead {
        FileRead::Irregular("이 플랫폼은 지원하지 않습니다".to_owned())
    }

    pub fn read_project_file(_root: &Path, _relative: &str, _max: f64) -> FileRead {
        FileRead::Irregular("이 플랫폼은 지원하지 않습니다".to_owned())
    }

    pub fn resolve(_root: &Path, _relative: &str, _must_exist: bool) -> Result<String, Failure> {
        Err(unsupported())
    }

    pub fn read_dir(_root: &Path, _relative: &str) -> Result<Vec<DirEntry>, Failure> {
        Err(unsupported())
    }

    pub fn lstat(_root: &Path, _relative: &str) -> Result<Stat, Failure> {
        Err(unsupported())
    }

    pub fn read_file(_root: &Path, _relative: &str, _max: Option<f64>) -> Result<Vec<u8>, Failure> {
        Err(unsupported())
    }

    pub fn write_file(_root: &Path, _relative: &str, _data: &[u8], _make_dirs: bool) -> Result<(), Failure> {
        Err(unsupported())
    }

    pub fn remove_file(_root: &Path, _relative: &str) -> Result<(), Failure> {
        Err(unsupported())
    }

    pub fn fingerprint(_root: &Path, _relative: &str) -> String {
        "missing".to_owned()
    }
}

pub use imp::{fingerprint, lstat, read_dir, read_file, read_project_file, read_regular_file, remove_file, resolve, write_file};

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::OpenOptionsExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn fixture() -> (tempfile::TempDir, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("api/src")).unwrap();
        std::fs::write(root.path().join("api/src/App.java"), "class App {}\n").unwrap();
        std::fs::write(outside.path().join("secret.txt"), "outside secret").unwrap();
        (root, outside)
    }

    #[test]
    fn 상위_폴더가_링크면_안쪽을_가리켜도_열지_않는다() {
        let (root, outside) = fixture();
        symlink(outside.path(), root.path().join("out")).unwrap();
        symlink(root.path().join("api"), root.path().join("inner")).unwrap();
        assert_eq!(read_project_file(root.path(), "out/secret.txt", 1024.0), FileRead::Irregular("상위 폴더가 심볼릭 링크입니다".to_owned()));
        assert_eq!(read_project_file(root.path(), "inner/src/App.java", 1024.0), FileRead::Irregular("상위 폴더가 심볼릭 링크입니다".to_owned()));
        assert_eq!(read_file(root.path(), "out/secret.txt", Some(1024.0)), Err(Failure::Link));
        assert_eq!(write_file(root.path(), "out/new.txt", b"x", true), Err(Failure::Link));
        assert_eq!(remove_file(root.path(), "out/secret.txt"), Err(Failure::Link));
        assert!(!outside.path().join("new.txt").exists());
        assert_eq!(std::fs::read_to_string(outside.path().join("secret.txt")).unwrap(), "outside secret");
    }

    #[test]
    fn 마지막_조각이_링크면_따라가지_않는다() {
        let (root, outside) = fixture();
        symlink(outside.path().join("secret.txt"), root.path().join("file-link")).unwrap();
        assert_eq!(read_file(root.path(), "file-link", Some(1024.0)), Err(Failure::Link));
        assert_eq!(write_file(root.path(), "file-link", b"tampered", false), Err(Failure::Link));
        assert_eq!(read_project_file(root.path(), "file-link", 1024.0), FileRead::Irregular("심볼릭 링크입니다".to_owned()));
        assert_eq!(std::fs::read_to_string(outside.path().join("secret.txt")).unwrap(), "outside secret");
    }

    #[test]
    fn 지우기는_링크_자체만_지우고_너머를_건드리지_않는다() {
        let (root, outside) = fixture();
        std::fs::create_dir_all(outside.path().join("dir")).unwrap();
        std::fs::write(outside.path().join("dir/keep.txt"), "keep").unwrap();
        symlink(outside.path().join("dir"), root.path().join("dir-link")).unwrap();
        symlink(outside.path().join("secret.txt"), root.path().join("file-link")).unwrap();
        // 마지막 조각이 링크인 이름을 바로 지우면 링크만 사라진다(부모는 링크가 아니다). 너머는 그대로다
        assert_eq!(remove_file(root.path(), "dir-link"), Ok(()));
        assert_eq!(remove_file(root.path(), "file-link"), Ok(()));
        assert!(!root.path().join("dir-link").exists() && std::fs::symlink_metadata(root.path().join("dir-link")).is_err());
        assert_eq!(std::fs::read_to_string(outside.path().join("dir/keep.txt")).unwrap(), "keep");
        assert_eq!(std::fs::read_to_string(outside.path().join("secret.txt")).unwrap(), "outside secret");
        // 폴더는 지우지 못하고 안의 파일도 그대로다
        assert!(remove_file(root.path(), "api/src").is_err());
        assert!(root.path().join("api/src/App.java").exists());
        // 부모가 링크면 그 안의 파일을 지우지 못한다
        symlink(outside.path().join("dir"), root.path().join("dir-link2")).unwrap();
        assert_eq!(remove_file(root.path(), "dir-link2/keep.txt"), Err(Failure::Link));
        assert!(outside.path().join("dir/keep.txt").exists());
    }

    #[test]
    fn 숨긴_이름은_조각마다_다시_막는다() {
        let (root, _outside) = fixture();
        std::fs::create_dir_all(root.path().join(".git")).unwrap();
        std::fs::write(root.path().join(".git/config"), "cfg").unwrap();
        std::fs::write(root.path().join(".env"), "S=1").unwrap();
        for name in [".git/config", ".GIT/config", ".env", ".ENV", ".env.", "node_modules/x", "api/.env"] {
            assert_eq!(read_file(root.path(), name, Some(1024.0)), Err(Failure::Denied), "{name}");
            assert_eq!(write_file(root.path(), name, b"x", true), Err(Failure::Denied), "{name}");
            assert_eq!(remove_file(root.path(), name), Err(Failure::Denied), "{name}");
            assert_eq!(resolve(root.path(), name, false), Err(Failure::Denied), "{name}");
        }
        assert_eq!(read_dir(root.path(), ".git"), Err(Failure::Denied));
        // 막지 않는 읽기는 이름을 걸지 않는다
        assert!(matches!(read_project_file(root.path(), ".env", 1024.0), FileRead::Bytes { .. }));
        assert!(fingerprint(root.path(), ".env").starts_with("file:"));
        assert!(root.path().join(".git/config").exists());
    }

    #[test]
    fn 밖으로_나가는_조각은_거절한다() {
        let (root, _outside) = fixture();
        assert_eq!(read_file(root.path(), "../x", Some(1.0)), Err(Failure::Outside));
        assert_eq!(write_file(root.path(), "api/../../x", b"", true), Err(Failure::Outside));
        assert_eq!(resolve(root.path(), "..", false), Err(Failure::Outside));
        assert_eq!(read_project_file(root.path(), "../x", 1.0), FileRead::Irregular("프로젝트 밖 경로입니다".to_owned()));
        assert_eq!(fingerprint(root.path(), "../x"), "missing");
        assert_eq!(read_file(root.path(), "/etc/hosts", Some(1.0)), Err(Failure::Outside));
        assert_eq!(fingerprint(root.path(), "/etc/hosts"), "missing");
    }

    #[test]
    fn 겹친_구분자와_점_조각은_정리해_읽는다() {
        let (root, _outside) = fixture();
        assert_eq!(read_file(root.path(), "api//src///App.java", Some(1024.0)).unwrap(), b"class App {}\n");
        assert_eq!(read_file(root.path(), "./api/./src/App.java", Some(1024.0)).unwrap(), b"class App {}\n");
    }

    #[test]
    fn resolve는_링크와_없는_파일과_새_경로를_구분한다() {
        let (root, outside) = fixture();
        symlink(outside.path(), root.path().join("out")).unwrap();
        symlink("nowhere", root.path().join("dangling")).unwrap();
        assert_eq!(resolve(root.path(), "out/x", false), Err(Failure::Link));
        assert_eq!(resolve(root.path(), "dangling", false), Err(Failure::Link));
        assert_eq!(resolve(root.path(), "api/src/App.java", true).unwrap(), "api/src/App.java");
        assert_eq!(resolve(root.path(), "api/src/None.java", true), Err(Failure::Missing));
        assert_eq!(resolve(root.path(), "api/src/App.java/inner", true), Err(Failure::Missing));
        assert_eq!(resolve(root.path(), "brand/new/dir/file.txt", false).unwrap(), "brand/new/dir/file.txt");
        assert_eq!(resolve(root.path(), "", true).unwrap(), "");
    }

    #[test]
    fn 쓰기는_부모를_만들고_짧게_덮어쓰며_폴더_자리에는_쓰지_못한다() {
        let (root, _outside) = fixture();
        write_file(root.path(), "a/b/c.txt", b"deep", true).unwrap();
        assert_eq!(std::fs::read_to_string(root.path().join("a/b/c.txt")).unwrap(), "deep");
        write_file(root.path(), "api/src/App.java", b"x", false).unwrap();
        assert_eq!(std::fs::read_to_string(root.path().join("api/src/App.java")).unwrap(), "x");
        assert_eq!(write_file(root.path(), "no/parent.txt", b"x", false), Err(Failure::Os("ENOENT")));
        assert!(write_file(root.path(), "api/src", b"x", false).is_err());
        assert!(write_file(root.path(), "api/src/App.java/inner", b"x", true).is_err());
    }

    #[test]
    fn 쓰기는_fifo를_멈추지_않고_거절한다() {
        let (root, _outside) = fixture();
        let fifo = std::ffi::CString::new(root.path().join("pipe").as_os_str().as_bytes()).unwrap();
        // SAFETY: 임시 폴더 안에 FIFO를 만든다
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        // 읽는 쪽이 없으면 열기가 ENXIO로 끝난다(멈추지 않는다)
        assert_eq!(write_file(root.path(), "pipe", b"x", false), Err(Failure::Os("ENXIO")));
        // 읽는 쪽이 있어 열리면 일반 파일이 아니라고 비우기 전에 거절한다
        let _reader = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(root.path().join("pipe")).unwrap();
        assert_eq!(write_file(root.path(), "pipe", b"x", false), Err(Failure::NotRegular));
        assert_eq!(read_file(root.path(), "pipe", Some(10.0)), Err(Failure::NotRegular));
        assert!(matches!(read_project_file(root.path(), "pipe", 10.0), FileRead::Irregular(_)));
    }

    #[test]
    fn 읽기는_상한을_읽기_전에_본다() {
        let (root, _outside) = fixture();
        std::fs::write(root.path().join("edge.bin"), vec![7u8; 1024]).unwrap();
        assert!(matches!(read_project_file(root.path(), "edge.bin", 1024.0), FileRead::Bytes { complete: true, .. }));
        assert!(matches!(read_project_file(root.path(), "edge.bin", 1023.0), FileRead::Irregular(reason) if reason == "너무 큽니다(1024바이트, 상한 1023바이트)"));
        assert_eq!(read_file(root.path(), "edge.bin", Some(1023.0)), Err(Failure::TooLarge(1024)));
        assert_eq!(read_file(root.path(), "edge.bin", Some(1024.0)).unwrap().len(), 1024);
        assert_eq!(read_file(root.path(), "edge.bin", None).unwrap().len(), 1024);
        // 큰 희소 파일은 내용을 읽지 않고 거절한다
        let sparse = std::fs::File::create(root.path().join("huge.log")).unwrap();
        sparse.set_len(3 * 1024 * 1024 * 1024).unwrap();
        assert_eq!(read_file(root.path(), "huge.log", Some(256.0 * 1024.0)), Err(Failure::TooLarge(3 * 1024 * 1024 * 1024)));
        assert!(matches!(read_project_file(root.path(), "huge.log", 1024.0 * 1024.0), FileRead::Irregular(_)));
    }

    #[test]
    fn 읽기_상위_폴더가_파일이면_없음이고_폴더면_일반_파일이_아니다() {
        let (root, _outside) = fixture();
        assert_eq!(read_project_file(root.path(), "api/src/App.java/inner", 1024.0), FileRead::Missing);
        assert_eq!(read_project_file(root.path(), "api/none/App.java", 1024.0), FileRead::Missing);
        assert_eq!(read_project_file(root.path(), "api/src", 1024.0), FileRead::Irregular("일반 파일이 아닙니다".to_owned()));
    }

    #[test]
    fn 목록은_숨긴_이름을_빼고_링크를_링크로_알린다() {
        let (root, outside) = fixture();
        std::fs::create_dir_all(root.path().join("node_modules")).unwrap();
        std::fs::write(root.path().join(".env"), "s").unwrap();
        symlink(outside.path(), root.path().join("linkdir")).unwrap();
        let mut entries = read_dir(root.path(), ".").unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(entries, vec![DirEntry { name: "api".to_owned(), kind: Kind::Dir }, DirEntry { name: "linkdir".to_owned(), kind: Kind::Link }]);
        assert_eq!(read_dir(root.path(), "linkdir"), Err(Failure::Link));
    }

    #[test]
    fn 지문은_종류별_꼴이다() {
        let (root, outside) = fixture();
        symlink(outside.path().join("secret.txt"), root.path().join("l")).unwrap();
        symlink(outside.path(), root.path().join("dir-link")).unwrap();
        assert_eq!(fingerprint(root.path(), "api/src/App.java"), format!("file:{}", sha_hex(b"class App {}\n")));
        assert_eq!(fingerprint(root.path(), "l"), format!("link:{}", outside.path().join("secret.txt").display()));
        assert!(fingerprint(root.path(), "api").starts_with("other:"));
        assert_eq!(fingerprint(root.path(), "none"), "missing");
        assert_eq!(fingerprint(root.path(), "dir-link/secret.txt"), "link:");
    }

    fn sha_hex(data: &[u8]) -> String {
        let mut hash = bstudio_guard::snapshots::Sha256::new();
        hash.update(data);
        bstudio_guard::snapshots::hex(&hash.finish())
    }

    #[test]
    fn 고정과_비교는_같은_읽기를_쓴다() {
        let (root, outside) = fixture();
        let mut pins = PinStore::new();
        std::fs::write(root.path().join("guard.txt"), "original").unwrap();
        pins.pin(root.path(), "guard.txt");
        pins.pin(root.path(), "new.txt");
        std::fs::write(root.path().join("guard.txt"), "changed").unwrap();
        // 두 번째 고정은 무시한다(처음 한 번만)
        pins.pin(root.path(), "guard.txt");
        let files = vec!["guard.txt".to_owned(), "new.txt".to_owned(), "unknown.txt".to_owned()];
        assert_eq!(pins.restored(root.path(), &files), vec!["new.txt".to_owned()]);
        std::fs::write(root.path().join("guard.txt"), "original").unwrap();
        assert_eq!(pins.restored(root.path(), &files), vec!["guard.txt".to_owned(), "new.txt".to_owned()]);
        std::fs::write(root.path().join("new.txt"), "x").unwrap();
        assert_eq!(pins.restored(root.path(), &files), vec!["guard.txt".to_owned()]);
        // 링크로 바뀐 파일은 내용이 같아도 같다고 하지 않는다
        std::fs::remove_file(root.path().join("guard.txt")).unwrap();
        std::fs::write(outside.path().join("t"), "original").unwrap();
        symlink(outside.path().join("t"), root.path().join("guard.txt")).unwrap();
        assert!(!pins.restored(root.path(), &files).contains(&"guard.txt".to_owned()));
        // 이미 있는 고정값은 "고정하지 않음" 표시가 덮어쓰지 못한다(처음 한 번만)
        std::fs::write(root.path().join("first.txt"), "v").unwrap();
        pins.pin(root.path(), "first.txt");
        pins.pin_unpinned("first.txt", "이미 바뀐 파일입니다");
        assert_eq!(pins.restored(root.path(), &["first.txt".to_owned()]), vec!["first.txt".to_owned()]);
        // 완전하게 읽지 못한 고정값(읽는 동안 바뀜)은 내용이 같아 보여도 같다고 하지 않는다
        pins.pins.insert("half.txt".to_owned(), FileRead::Bytes { content: b"v".to_vec(), complete: false });
        std::fs::write(root.path().join("half.txt"), "v").unwrap();
        assert!(pins.restored(root.path(), &["half.txt".to_owned()]).is_empty());
        // 고정하지 않기로 한 파일은 비교에서 빠진다
        pins.pin_unpinned("skip.txt", "이미 바뀐 파일입니다");
        std::fs::write(root.path().join("skip.txt"), "x").unwrap();
        assert!(pins.restored(root.path(), &["skip.txt".to_owned()]).is_empty());
    }

    #[test]
    fn 고정은_상한_경계에서_갈린다() {
        let (root, _outside) = fixture();
        let limit = 1024 * 1024;
        std::fs::write(root.path().join("edge"), vec![1u8; limit]).unwrap();
        std::fs::write(root.path().join("over"), vec![2u8; limit + 1]).unwrap();
        let mut pins = PinStore::new();
        pins.pin(root.path(), "edge");
        pins.pin(root.path(), "over");
        let files = vec!["edge".to_owned(), "over".to_owned()];
        assert_eq!(pins.restored(root.path(), &files), vec!["edge".to_owned()]);
    }

    /// 짧게 읽힘·덧붙음을 흉내 내는 원본. 두 번째 `fstat`이 크기만 달라지거나 수정 시각만 달라지는 경우를 따로 만든다
    struct Fake {
        size: u64,
        reads_zero: bool,
        second_size_delta: u64,
        second_mtime_delta: i64,
        metas: AtomicUsize,
    }

    impl Fake {
        fn new(size: u64) -> Self {
            Self { size, reads_zero: false, second_size_delta: 0, second_mtime_delta: 0, metas: AtomicUsize::new(0) }
        }
    }

    impl Source for Fake {
        fn meta(&self) -> std::io::Result<Meta> {
            let second = self.metas.fetch_add(1, Ordering::SeqCst) >= 1;
            Ok(Meta { is_file: true, size: self.size + if second { self.second_size_delta } else { 0 }, mtime: (1, if second { self.second_mtime_delta } else { 0 }) })
        }

        fn read_at(&self, buf: &mut [u8], _offset: u64) -> std::io::Result<usize> {
            if self.reads_zero {
                return Ok(0);
            }
            buf.fill(9);
            Ok(buf.len())
        }
    }

    #[test]
    fn 읽는_동안_줄거나_늘면_완전한_읽기가_아니다() {
        assert_eq!(read_source(&Fake::new(4), 100.0), FileRead::Bytes { content: vec![9; 4], complete: true });
        // 확인한 크기만큼 읽지 못했다
        assert_eq!(read_source(&Fake { reads_zero: true, ..Fake::new(4) }, 100.0), FileRead::Bytes { content: vec![], complete: false });
        // 읽는 동안 크기만 달라졌다 / 수정 시각만 달라졌다
        assert!(matches!(read_source(&Fake { second_size_delta: 1, ..Fake::new(4) }, 100.0), FileRead::Bytes { complete: false, .. }));
        assert!(matches!(read_source(&Fake { second_mtime_delta: 1, ..Fake::new(4) }, 100.0), FileRead::Bytes { complete: false, .. }));
        // 상한은 읽기 전에 본다: 상한을 넘으면 내용을 읽지 않는다
        assert!(matches!(read_source(&Fake { reads_zero: true, ..Fake::new(101) }, 100.0), FileRead::Irregular(_)));
        assert!(matches!(read_source(&Fake::new(100), 100.0), FileRead::Bytes { complete: true, .. }));
    }

    #[test]
    fn 저장_이름은_실제_이름으로_돌려주고_밖이면_거절하며_풀지_못하면_받은_이름이다() {
        let root = Path::new("/real/root");
        let given = ["api", "src", "New.java"];
        // 운영체제가 안쪽 이름의 대소문자만 다르게 알려 주는 경우
        assert_eq!(stored_segments(root, Ok(root.join("API/src")), &given[..2]).unwrap(), vec!["API".to_owned(), "src".to_owned()]);
        // 루트 밖을 가리키는 값은 거절한다(허용 목록: 모르면 밖)
        assert_eq!(stored_segments(root, Ok(Path::new("/elsewhere/App.java").to_path_buf()), &given), Err(Failure::Outside));
        // `..`로 시작하는 안쪽 이름은 밖이 아니다
        assert_eq!(stored_segments(root, Ok(root.join("..x/App.java")), &given).unwrap(), vec!["..x".to_owned(), "App.java".to_owned()]);
        // 실제 이름을 풀지 못하면 받은 이름이다
        assert_eq!(stored_segments(root, Err(std::io::Error::from(std::io::ErrorKind::NotFound)), &given).unwrap(), vec!["api".to_owned(), "src".to_owned(), "New.java".to_owned()]);
        // 실제 이름이 숨긴 이름이면 걸린다
        assert_eq!(stored_segments(root, Ok(root.join(".GIT")), &given[..1]), Err(Failure::Denied));
    }
}
