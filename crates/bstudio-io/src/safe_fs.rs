//! 평가 자산 복사본의 링크 안전 준비(ADR-193, 2c-1b). TS `evaluation-assets.ts`의 `prepareSlot`·`removeEvaluationAssets`를 옮긴 것이다.
//! (마스크 쪽 빈 폴더 준비는 2c-6의 `git_mask_fs.rs`가 맡는다.)
//!
//! 지우는 쪽 규칙: 폴더를 비우려고 재귀로 지우는 길은 `remove_sandbox_dir`의 `remove_tree` 하나뿐이고, 거기서도
//! 항목마다 `symlink_metadata`로 종류를 보아 링크는 링크만 지운다(따라가지 않는다). 나머지는 `remove_file`(링크는 링크만,
//! 파일은 그 파일만)과 비어 있는 폴더의 `remove_dir`뿐이라, 경로가 링크로 바뀌어도 링크 너머의 폴더는 지워지지 않는다.
//! 이름을 받는 함수는 먼저 한 이름짜리인지 본다 — 모르는 모양(`..`, 구분자, NUL, 빈 이름)은 거부한다(fail-closed).
//! 동기 함수가 본체이고, `*_async`는 `spawn_blocking`으로 감싼 것이다(napi 층과 4단계 서버가 쓴다).

use std::fs::{self, File, OpenOptions};
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(ErrorKind::InvalidInput, message.into())
}

/// `parent` 바로 아래의 한 이름이어야 한다. 구분자(`/`, `\`)·NUL·`.`·`..`·빈 이름은 거부한다.
/// 역슬래시는 POSIX에서는 이름의 글자지만 Windows에서는 구분자라 어디서든 거부한다(거부 목록을 넓히면 더 막을 뿐이다).
fn check_single_name(name: &str) -> io::Result<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return Err(invalid(format!("{name:?}은(는) 폴더 바로 아래의 한 이름이 아닙니다")));
    }
    Ok(())
}

/// 링크든 파일이든 그 항목 하나만 지운다. 없으면 무시한다(TS `rm(force)`). 진짜 폴더는 지우지 않는다.
fn remove_non_directory(target: &Path) -> io::Result<()> {
    match fs::remove_file(target) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => {
            // Windows의 폴더 링크는 remove_dir로만 지워진다. 링크일 때만 시도하고 진짜 폴더는 건드리지 않는다
            if cfg!(windows) && fs::symlink_metadata(target).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
                return fs::remove_dir(target);
            }
            Err(error)
        }
    }
}

/// 평가 자산 복사본 자리의 종류
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotKind {
    File,
    Directory,
}

/// 평가 자산 복사본 자리를 준비한다(TS `prepareSlot`). `source`는 `parent` 바로 아래여야 한다.
///  - 폴더 자리: 링크·파일이면 그 항목만 지우고 폴더를 만든다. 이미 폴더면 그대로 둔다(내용은 이후 sync가 맞춘다).
///  - 파일 자리: 링크면 링크만 지운다. 폴더면 **비어 있을 때만** 지우고 아니면 멈춘다(옛 TS는 폴더를 재귀로 지웠다).
///    그다음 빈 파일로 만든다. 링크를 따라가지 않는다: 새로 만들 때는 `create_new`, 있는 파일은 `O_NOFOLLOW`로 열어
///    일반 파일인지 다시 보고 자른다.
pub fn prepare_slot(source: &Path, kind: SlotKind, parent: &Path) -> io::Result<()> {
    if source.parent() != Some(parent) {
        return Err(io::Error::other(format!("평가 자산 복사본 자리가 복사본 폴더 바로 아래가 아닙니다: {}", source.display())));
    }
    match source.file_name().and_then(|name| name.to_str()) {
        Some(name) => check_single_name(name)?,
        None => return Err(invalid("자리 이름을 읽을 수 없습니다")),
    }
    let current = fs::symlink_metadata(source).ok();
    match kind {
        SlotKind::Directory => {
            if current.as_ref().is_some_and(|meta| !meta.is_dir()) {
                remove_non_directory(source)?;
            }
            if !fs::symlink_metadata(source).map(|meta| meta.is_dir()).unwrap_or(false) {
                match fs::create_dir(source) {
                    Ok(()) => {}
                    Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error),
                }
            }
        }
        SlotKind::File => {
            if let Some(meta) = &current {
                if meta.is_dir() {
                    fs::remove_dir(source)?;
                } else if !meta.is_file() {
                    remove_non_directory(source)?;
                }
            }
            truncate_regular_file(source)?;
        }
    }
    let after = fs::symlink_metadata(source)?;
    let made = match kind {
        SlotKind::Directory => after.is_dir(),
        SlotKind::File => after.is_file(),
    };
    if !made {
        return Err(io::Error::other(format!("평가 자산 복사본 자리를 만들지 못했습니다: {}", source.display())));
    }
    Ok(())
}

/// 링크를 따라가지 않고 빈 일반 파일로 만든다. 없으면 새로 만들고(`create_new`), 있으면 `O_NOFOLLOW`로 열어 자른다.
fn truncate_regular_file(path: &Path) -> io::Result<()> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file: File = options.open(path)?;
    // 연 뒤의 fstat이라 그 사이의 바꿔치기와 무관하다
    if !file.metadata()?.is_file() {
        return Err(io::Error::other(format!("{}이(가) 일반 파일이 아닙니다", path.display())));
    }
    file.set_len(0)
}

/// 한 샌드박스의 복사본 폴더를 지운다(TS `removeEvaluationAssets`). 그 폴더 자체가 링크면 링크만 지우고 너머는 건드리지 않는다.
/// 진짜 폴더면 안을 지운다 — 안에서도 링크는 링크만 지우고 따라가지 않는다. 없으면 무시한다.
pub fn remove_sandbox_dir(dir: &Path) -> io::Result<()> {
    let meta = match fs::symlink_metadata(dir) {
        Ok(meta) => meta,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if meta.is_dir() {
        remove_tree(dir)
    } else {
        remove_non_directory(dir)
    }
}

/// 링크를 따라가지 않는 재귀 지우기. 항목마다 `symlink_metadata`로 종류를 보고, 진짜 폴더일 때만 안으로 들어간다.
fn remove_tree(dir: &Path) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_dir() => remove_tree(&path)?,
            Ok(_) => remove_non_directory(&path)?,
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    match fs::remove_dir(dir) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> io::Result<T> + Send + 'static) -> io::Result<T> {
    tokio::task::spawn_blocking(work).await.map_err(|error| io::Error::other(error.to_string()))?
}

pub async fn prepare_slot_async(source: PathBuf, kind: SlotKind, parent: PathBuf) -> io::Result<()> {
    blocking(move || prepare_slot(&source, kind, &parent)).await
}

pub async fn remove_sandbox_dir_async(dir: PathBuf) -> io::Result<()> {
    blocking(move || remove_sandbox_dir(&dir)).await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, MetadataExt};
    use std::sync::Arc;
    use tempfile::tempdir;

    /// 링크 너머에 두는 "지우면 안 되는" 폴더. 안에 파일과 하위 폴더가 있다
    fn outside(base: &Path) -> PathBuf {
        let dir = base.join("outside");
        fs::create_dir_all(dir.join("keep")).unwrap();
        fs::write(dir.join("important.txt"), "지우면 안 되는 파일").unwrap();
        dir
    }

    fn assert_outside_intact(dir: &Path) {
        assert_eq!(fs::read_to_string(dir.join("important.txt")).unwrap(), "지우면 안 되는 파일");
        assert!(dir.join("keep").is_dir());
    }

    // ── prepare_slot ──

    #[test]
    fn 폴더_자리는_링크면_링크만_지우고_이미_폴더면_내용을_둔다() {
        let base = tempdir().unwrap();
        let out = outside(base.path());
        let parent = base.path().join("p");
        fs::create_dir(&parent).unwrap();
        let slot = parent.join("slot");
        symlink(&out, &slot).unwrap();
        prepare_slot(&slot, SlotKind::Directory, &parent).unwrap();
        assert!(fs::symlink_metadata(&slot).unwrap().is_dir());
        assert_outside_intact(&out);
        fs::write(slot.join("kept"), "x").unwrap();
        prepare_slot(&slot, SlotKind::Directory, &parent).unwrap();
        assert!(slot.join("kept").is_file());
    }

    #[test]
    fn 동시에_불려도_폴더_자리는_하나로_남고_링크_너머는_안_지워진다() {
        let base = tempdir().unwrap();
        let out = outside(base.path());
        let parent = Arc::new(base.path().join("p"));
        fs::create_dir(&*parent).unwrap();
        symlink(&out, parent.join("slot")).unwrap();
        let handles: Vec<_> = (0..24)
            .map(|_| {
                let parent = parent.clone();
                std::thread::spawn(move || prepare_slot(&parent.join("slot"), SlotKind::Directory, &parent))
            })
            .collect();
        let ok = handles.into_iter().map(|h| h.join().unwrap()).filter(|r| r.is_ok()).count();
        assert!(ok >= 1);
        assert!(fs::symlink_metadata(parent.join("slot")).unwrap().is_dir());
        assert_outside_intact(&out);
        // 한 번 더 불러도 같은 결과(멱등)
        prepare_slot(&parent.join("slot"), SlotKind::Directory, &parent).unwrap();
    }

    #[test]
    fn 파일_자리는_링크_너머_파일을_자르지_않는다() {
        let base = tempdir().unwrap();
        let victim = base.path().join("victim.txt");
        fs::write(&victim, "보존").unwrap();
        let parent = base.path().join("p");
        fs::create_dir(&parent).unwrap();
        let slot = parent.join("slot");
        symlink(&victim, &slot).unwrap();
        prepare_slot(&slot, SlotKind::File, &parent).unwrap();
        assert_eq!(fs::read_to_string(&victim).unwrap(), "보존");
        assert!(fs::symlink_metadata(&slot).unwrap().is_file());
        assert_eq!(fs::read_to_string(&slot).unwrap(), "");
        // 끊어진 링크 아래로도 새 파일을 만들지 않는다
        let ghost = base.path().join("ghost.txt");
        fs::remove_file(&slot).unwrap();
        symlink(&ghost, &slot).unwrap();
        prepare_slot(&slot, SlotKind::File, &parent).unwrap();
        assert!(!ghost.exists());
    }

    #[test]
    fn 파일_자리에_내용이_든_폴더가_있으면_재귀로_지우지_않고_멈춘다() {
        let base = tempdir().unwrap();
        let parent = base.path().join("p");
        fs::create_dir_all(parent.join("slot").join("sub")).unwrap();
        fs::write(parent.join("slot").join("sub").join("f"), "x").unwrap();
        assert!(prepare_slot(&parent.join("slot"), SlotKind::File, &parent).is_err());
        assert!(parent.join("slot").join("sub").join("f").is_file());
        // 빈 폴더는 지우고 파일로 바꾼다
        let empty = parent.join("empty");
        fs::create_dir(&empty).unwrap();
        prepare_slot(&empty, SlotKind::File, &parent).unwrap();
        assert!(empty.is_file());
    }

    #[test]
    fn 파일_자리의_기존_파일은_inode를_두고_비운다() {
        let base = tempdir().unwrap();
        let slot = base.path().join("slot");
        fs::write(&slot, "내용").unwrap();
        let before = fs::metadata(&slot).unwrap().ino();
        prepare_slot(&slot, SlotKind::File, base.path()).unwrap();
        assert_eq!(fs::metadata(&slot).unwrap().ino(), before);
        assert_eq!(fs::read_to_string(&slot).unwrap(), "");
    }

    #[test]
    fn 자리가_부모_바로_아래가_아니거나_이름이_이상하면_거부한다() {
        let base = tempdir().unwrap();
        let parent = base.path().join("p");
        fs::create_dir_all(parent.join("deep")).unwrap();
        assert!(prepare_slot(&parent.join("deep").join("slot"), SlotKind::Directory, &parent).is_err());
        assert!(prepare_slot(&parent.join(".."), SlotKind::Directory, &parent).is_err());
        assert!(prepare_slot(&parent.join("a").join(".."), SlotKind::Directory, &parent).is_err());
        assert!(!parent.join("deep").join("slot").exists());
    }

    // ── remove_sandbox_dir ──

    #[test]
    fn 샌드박스_폴더가_링크면_링크만_지운다() {
        let base = tempdir().unwrap();
        let out = outside(base.path());
        symlink(&out, base.path().join("sb")).unwrap();
        remove_sandbox_dir(&base.path().join("sb")).unwrap();
        assert!(fs::symlink_metadata(base.path().join("sb")).is_err());
        assert_outside_intact(&out);
    }

    #[test]
    fn 샌드박스_폴더_안의_링크는_따라가지_않고_지운다() {
        let base = tempdir().unwrap();
        let out = outside(base.path());
        let sb = base.path().join("sb");
        fs::create_dir_all(sb.join("a").join("b")).unwrap();
        fs::write(sb.join("a").join("f"), "x").unwrap();
        symlink(&out, sb.join("a").join("b").join("dirlink")).unwrap();
        symlink(out.join("important.txt"), sb.join("filelink")).unwrap();
        remove_sandbox_dir(&sb).unwrap();
        assert!(!sb.exists());
        assert_outside_intact(&out);
    }

    #[test]
    fn 없는_폴더는_무시하고_일반_파일이면_그_파일만_지운다() {
        let base = tempdir().unwrap();
        remove_sandbox_dir(&base.path().join("none")).unwrap();
        fs::write(base.path().join("f"), "x").unwrap();
        remove_sandbox_dir(&base.path().join("f")).unwrap();
        assert!(!base.path().join("f").exists());
    }
}
