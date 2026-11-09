//! `git-mask.ts`의 파일 시스템 I/O를 옮긴 것(ADR-193, 2c-6). 무엇을 가릴지의 판정은 `bstudio-guard`(git_mask)가 하고,
//! 여기는 그 판정에 쓸 사실(링크를 푼 경로, `.git`의 종류, 상태 폴더 유무)을 읽고 가림 자리를 준비하는 syscall만 한다.
//!
//! 지우는 코드가 하나 있다(`prepare_empty_directory`). 규칙:
//! - 재귀로 지우지 않는다. 지우는 것은 **그 자리의 항목 하나**(링크 또는 파일)뿐이고, 링크를 따라가지 않는다
//!   (`remove_file`은 링크 자체를 지운다. 링크가 가리키는 폴더는 열어 보지도 않는다).
//! - 폴더에 내용이 있으면 지우지 않고 멈춘다.
//! - 여러 번, 동시에 불려도 같은 결과다: 이미 빈 폴더면 그대로 두고, `create_dir_all`은 동시 생성을 오류로 보지 않는다.

use std::path::Path;

use bstudio_guard::node_path;

const GIT: &str = ".git";
const STATE: &str = "b-studio";
/// 상태 폴더 자리에 읽기 전용으로 얹을 빈 폴더 이름(`.git` 안)
pub const STATE_MASK: &str = "b-studio-empty";

/// 프로젝트 폴더나 그 상위에서 찾은 `.git` 하나. TS `GitEntry`와 같다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitEntry {
    pub dir: String,
    /// "directory" 또는 "file"
    pub kind: String,
    pub has_state: bool,
}

/// 링크를 푼 실제 경로. 풀지 못하면(없는 경로 등) `path.resolve`와 같이 `cwd` 기준 절대 경로로 정규화한다.
pub async fn real_path(target: &str, cwd: &str) -> String {
    match tokio::fs::canonicalize(target).await {
        Ok(resolved) => resolved.to_string_lossy().into_owned(),
        Err(_) => node_path::resolve(cwd, &[target]),
    }
}

/// 프로젝트 폴더에서 위로 올라가며 `.git`이 든 폴더를 찾는다(TS `detectGitEntries`).
/// 프로젝트 폴더의 상위를 마운트한 서비스가 있으면 가장 위의 그 마운트 소스까지, 없으면 프로젝트 폴더만 본다.
pub async fn detect_git_entries(project_root: &str, mount_sources: &[String], cwd: &str) -> Vec<GitEntry> {
    let root = real_path(project_root, cwd).await;
    let mut above = Vec::new();
    for source in mount_sources {
        let resolved = real_path(source, cwd).await;
        if node_path::is_inside(cwd, &resolved, &root) {
            above.push(resolved);
        }
    }
    // JS 정렬은 안정이고 길이는 UTF-16 코드 단위다
    above.sort_by_key(|path| path.encode_utf16().count());
    let stop = above.into_iter().next().unwrap_or_else(|| root.clone());

    let mut entries = Vec::new();
    let mut dir = root;
    loop {
        if let Some(entry) = inspect_git(&dir).await {
            entries.push(entry);
        }
        let parent = node_path::dirname(&dir);
        if dir == stop || dir == parent {
            break;
        }
        dir = parent;
    }
    entries
}

/// `dir/.git`의 종류. 심볼릭 링크 `.git`은 마운트 지점으로 쓸 수 없어 건너뛴다(링크를 따라가지 않는다: lstat).
async fn inspect_git(dir: &str) -> Option<GitEntry> {
    let meta = tokio::fs::symlink_metadata(Path::new(dir).join(GIT)).await.ok()?;
    if meta.is_dir() {
        let has_state = tokio::fs::symlink_metadata(Path::new(dir).join(GIT).join(STATE)).await.map(|m| m.is_dir()).unwrap_or(false);
        return Some(GitEntry { dir: dir.to_owned(), kind: "directory".into(), has_state });
    }
    if meta.is_file() {
        return Some(GitEntry { dir: dir.to_owned(), kind: "file".into(), has_state: false });
    }
    None
}

/// 저장소 설정에 `[b-studio]` 절이 있는가(b-studio가 만든 체크포인트 저장소). JS `/^\[b-studio\]/m`과 같이
/// `\n`·`\r`·U+2028·U+2029 뒤의 줄 머리도 줄 시작으로 본다. 못 읽으면 아니다.
pub async fn is_bstudio_repository(dir: &str) -> bool {
    match tokio::fs::read(Path::new(dir).join(GIT).join("config")).await {
        Ok(bytes) => String::from_utf8_lossy(&bytes).split(['\n', '\r', '\u{2028}', '\u{2029}']).any(|line| line.starts_with("[b-studio]")),
        Err(_) => false,
    }
}

/// 상태 폴더 준비가 실패한 자리. TS가 `SandboxError`로 바꾼다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaskFailure {
    pub state: String,
    pub detail: String,
}

/// 항목마다 b-studio가 만든 저장소인데 상태 폴더가 없으면 상태 폴더와 그 위에 얹을 빈 폴더를 미리 만든다(TS `computeGitMask`의 앞 구간).
/// 사용자 자신의 저장소(`[b-studio]` 없음, 상태 폴더 없음)에는 흔적을 남기지 않는다. 만들지 못하면 거기서 멈추고 실패를 돌려준다.
/// 성공한 항목의 `has_state`는 true로 바뀐다.
pub async fn prepare_state_masks(entries: &mut [GitEntry]) -> Result<(), MaskFailure> {
    for entry in entries.iter_mut() {
        if entry.kind != "directory" {
            continue;
        }
        if !entry.has_state && !is_bstudio_repository(&entry.dir).await {
            continue;
        }
        let git = Path::new(&entry.dir).join(GIT);
        let state = git.join(STATE);
        let run = async {
            tokio::fs::create_dir_all(&state).await.map_err(|e| e.to_string())?;
            prepare_empty_directory(&git, STATE_MASK).await
        };
        if let Err(detail) = run.await {
            return Err(MaskFailure { state: state.to_string_lossy().into_owned(), detail });
        }
        entry.has_state = true;
    }
    Ok(())
}

/// `parent` 바로 아래에 `name`이라는 **진짜 빈 폴더**가 있게 한다. 아무것도 재귀적으로 지우지 않는다.
/// - 없으면 만든다. 이미 폴더면 그대로 둔다(동시 호출에도 안전).
/// - 그 자리에 링크나 파일이 있으면 그 항목 하나만 지우고 폴더를 만든다. 링크를 따라가지 않는다.
/// - 폴더에 내용이 있으면 지우지 않고 오류로 멈춘다.
/// - 마지막에 실제 위치가 `parent` 바로 아래인지 확인한다.
pub async fn prepare_empty_directory(parent: &Path, name: &str) -> Result<(), String> {
    let target = parent.join(name);
    let shown = target.to_string_lossy().into_owned();
    if let Ok(before) = tokio::fs::symlink_metadata(&target).await {
        if !before.is_dir() {
            // 링크든 파일이든 그 항목 하나만 지운다(force: 그 사이 사라졌어도 괜찮다)
            match tokio::fs::remove_file(&target).await {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
        }
    }
    tokio::fs::create_dir_all(&target).await.map_err(|e| e.to_string())?;
    let after = tokio::fs::symlink_metadata(&target).await.map_err(|e| e.to_string())?;
    let real_target = tokio::fs::canonicalize(&target).await.map_err(|e| e.to_string())?;
    let real_parent = tokio::fs::canonicalize(parent).await.map_err(|e| e.to_string())?;
    if !after.is_dir() || real_target != real_parent.join(name) {
        return Err(format!("{shown}이(가) 폴더가 아니거나 다른 곳을 가리킵니다"));
    }
    let mut reader = tokio::fs::read_dir(&target).await.map_err(|e| e.to_string())?;
    let mut children = Vec::new();
    while let Some(child) = reader.next_entry().await.map_err(|e| e.to_string())? {
        children.push(child.file_name().to_string_lossy().into_owned());
    }
    // read_dir의 순서는 운영체제가 정한다. 오류 문구가 실행마다 같도록 정렬한다
    children.sort();
    if !children.is_empty() {
        let first = children.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
        let more = if children.len() > 5 { format!(" 외 {}개", children.len() - 5) } else { String::new() };
        return Err(format!(
            "{shown} 폴더가 비어 있지 않습니다({first}{more}). 이 폴더는 상태 폴더를 가리는 데 쓰는 빈 폴더입니다. 안의 항목을 확인해 직접 지운 뒤 다시 시도하세요"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn s(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    async fn root() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let real = tokio::fs::canonicalize(dir.path()).await.unwrap();
        let root = s(&real);
        (dir, root)
    }

    #[tokio::test]
    async fn real_path는_링크를_풀고_없는_경로는_절대로_정규화한다() {
        let (_guard, root) = root().await;
        let base = Path::new(&root);
        tokio::fs::create_dir(base.join("proj")).await.unwrap();
        symlink(base.join("proj"), base.join("link")).unwrap();
        assert_eq!(real_path(&s(&base.join("link")), "/x").await, s(&base.join("proj")));
        assert_eq!(real_path("/no/such/../path", "/x").await, "/no/path");
        assert_eq!(real_path("rel/a", "/work").await, "/work/rel/a");
    }

    #[tokio::test]
    async fn detect는_git_폴더_상태_폴더_파일_링크를_구분한다() {
        let (_guard, root) = root().await;
        let base = Path::new(&root);
        tokio::fs::create_dir_all(base.join("a/.git/b-studio")).await.unwrap();
        let a = s(&base.join("a"));
        assert_eq!(detect_git_entries(&a, &[a.clone()], "/").await, vec![GitEntry { dir: a.clone(), kind: "directory".into(), has_state: true }]);

        tokio::fs::create_dir(base.join("b")).await.unwrap();
        let b = s(&base.join("b"));
        assert!(detect_git_entries(&b, &[b.clone()], "/").await.is_empty());
        tokio::fs::write(base.join("b/.git"), "gitdir: x\n").await.unwrap();
        assert_eq!(detect_git_entries(&b, &[b.clone()], "/").await, vec![GitEntry { dir: b.clone(), kind: "file".into(), has_state: false }]);

        tokio::fs::create_dir_all(base.join("c/real-git")).await.unwrap();
        symlink("real-git", base.join("c/.git")).unwrap();
        let c = s(&base.join("c"));
        assert!(detect_git_entries(&c, &[c.clone()], "/").await.is_empty());
    }

    #[tokio::test]
    async fn detect는_상위를_마운트한_서비스가_있을_때만_위로_올라간다() {
        let (_guard, root) = root().await;
        let repo = Path::new(&root).join("repo");
        tokio::fs::create_dir_all(repo.join(".git/b-studio")).await.unwrap();
        tokio::fs::create_dir(repo.join("api")).await.unwrap();
        let (repo_s, api) = (s(&repo), s(&repo.join("api")));
        assert!(detect_git_entries(&api, &[api.clone()], "/").await.is_empty());
        assert_eq!(detect_git_entries(&api, &[repo_s.clone()], "/").await, vec![GitEntry { dir: repo_s, kind: "directory".into(), has_state: true }]);
    }

    #[tokio::test]
    async fn is_bstudio_repository는_줄_머리의_절만_본다() {
        let (_guard, root) = root().await;
        let git = Path::new(&root).join(".git");
        tokio::fs::create_dir(&git).await.unwrap();
        assert!(!is_bstudio_repository(&root).await);
        tokio::fs::write(git.join("config"), "[core]\n\tx = 1\n[b-studio]\n\ta = b\n").await.unwrap();
        assert!(is_bstudio_repository(&root).await);
        tokio::fs::write(git.join("config"), "[core]\n  [b-studio]\n# [b-studio]\n").await.unwrap();
        assert!(!is_bstudio_repository(&root).await);
        tokio::fs::write(git.join("config"), "[core]\r[b-studio]\r").await.unwrap();
        assert!(is_bstudio_repository(&root).await);
    }

    #[tokio::test]
    async fn prepare_empty_directory는_없으면_만들고_있으면_그대로_두며_여러_번_같다() {
        let (_guard, root) = root().await;
        let parent = Path::new(&root);
        prepare_empty_directory(parent, "e").await.unwrap();
        prepare_empty_directory(parent, "e").await.unwrap();
        assert!(parent.join("e").is_dir());
        let mut tasks = Vec::new();
        for _ in 0..24 {
            let parent = parent.to_owned();
            tasks.push(tokio::spawn(async move { prepare_empty_directory(&parent, "e").await }));
        }
        for task in tasks {
            assert_eq!(task.await.unwrap(), Ok(()));
        }
    }

    #[tokio::test]
    async fn prepare_empty_directory는_링크를_지우되_링크_너머_폴더는_건드리지_않는다() {
        let (_guard, root) = root().await;
        let parent = Path::new(&root).join("git");
        let victim = Path::new(&root).join("victim");
        tokio::fs::create_dir_all(&parent).await.unwrap();
        tokio::fs::create_dir(&victim).await.unwrap();
        tokio::fs::write(victim.join("keep.txt"), "중요").await.unwrap();
        symlink(&victim, parent.join("e")).unwrap();
        prepare_empty_directory(&parent, "e").await.unwrap();
        let meta = tokio::fs::symlink_metadata(parent.join("e")).await.unwrap();
        assert!(meta.is_dir() && !meta.file_type().is_symlink());
        assert_eq!(tokio::fs::read_to_string(victim.join("keep.txt")).await.unwrap(), "중요");
    }

    #[tokio::test]
    async fn prepare_empty_directory는_파일을_지우고_폴더로_바꾼다() {
        let (_guard, root) = root().await;
        let parent = Path::new(&root);
        tokio::fs::write(parent.join("e"), "x").await.unwrap();
        prepare_empty_directory(parent, "e").await.unwrap();
        assert!(parent.join("e").is_dir());
    }

    #[tokio::test]
    async fn prepare_empty_directory는_내용이_있으면_지우지_않고_멈춘다() {
        let (_guard, root) = root().await;
        let parent = Path::new(&root);
        tokio::fs::create_dir(parent.join("e")).await.unwrap();
        for i in 0..7 {
            tokio::fs::write(parent.join("e").join(format!("f{i}")), "x").await.unwrap();
        }
        let error = prepare_empty_directory(parent, "e").await.unwrap_err();
        assert!(error.contains("비어 있지 않습니다") && error.contains("외 2개"), "{error}");
        assert!(tokio::fs::read_dir(parent.join("e")).await.unwrap().next_entry().await.unwrap().is_some());
    }

    #[tokio::test]
    async fn prepare_state_masks는_b_studio_저장소에만_준비하고_사용자_저장소에는_흔적이_없다() {
        let (_guard, root) = root().await;
        let base = Path::new(&root);
        tokio::fs::create_dir_all(base.join("mine/.git")).await.unwrap();
        tokio::fs::create_dir_all(base.join("ours/.git")).await.unwrap();
        tokio::fs::write(base.join("ours/.git/config"), "[b-studio]\n").await.unwrap();
        let mut entries = vec![
            GitEntry { dir: s(&base.join("mine")), kind: "directory".into(), has_state: false },
            GitEntry { dir: s(&base.join("ours")), kind: "directory".into(), has_state: false },
            GitEntry { dir: s(&base.join("file")), kind: "file".into(), has_state: false },
        ];
        prepare_state_masks(&mut entries).await.unwrap();
        assert!(!entries[0].has_state && entries[1].has_state && !entries[2].has_state);
        assert!(!base.join("mine/.git/b-studio").exists() && !base.join("mine/.git/b-studio-empty").exists());
        assert!(base.join("ours/.git/b-studio").is_dir() && base.join("ours/.git/b-studio-empty").is_dir());
    }

    #[tokio::test]
    async fn prepare_state_masks는_내용이_든_빈_폴더에서_멈추고_상태를_알린다() {
        let (_guard, root) = root().await;
        let base = Path::new(&root);
        tokio::fs::create_dir_all(base.join("ours/.git/b-studio-empty")).await.unwrap();
        tokio::fs::write(base.join("ours/.git/b-studio-empty/x"), "x").await.unwrap();
        let mut entries = vec![GitEntry { dir: s(&base.join("ours")), kind: "directory".into(), has_state: true }];
        let failure = prepare_state_masks(&mut entries).await.unwrap_err();
        assert!(failure.state.ends_with(".git/b-studio") && failure.detail.contains("비어 있지 않습니다"), "{failure:?}");
        assert!(base.join("ours/.git/b-studio-empty/x").exists());
    }
}
