//! 파일 반영 확인(옛 TS: `LocalDockerSandbox.sync`, `sync-paths.ts`의 `withRemovedDirectories`, `hashOrMissing`)과 변경 알림
//! (`relayChanges`의 계획·exec 부분)(ADR-195 4f A4c-2).
//!
//! 판정은 `bstudio_guard::sync_relay`(와 `relay`·`docker_format`)가 하고, 여기는 호스트 파일을 읽고 docker를 부르는 순서만 한다.
//!
//! **`sync`는 통과시키는 판정이다.** 검증 게이트가 "파일이 컨테이너에 반영됐다"를 믿는 근거다. 아래는 모두 통과가 아니라 실패나 "아직"이다.
//!  - 호스트 파일을 읽지 못함(없음(`NotFound`)만 `MISSING`, 그 밖의 오류는 실패 — 권한·디렉터리·`ENOTDIR`·너무 깊은 링크)
//!  - docker 비0 종료(취소로 멈춘 것 포함)
//!  - 컨테이너 출력에 그 파일의 줄이 없음·같은 파일의 줄이 둘 이상·모양을 모르는 줄(`pending_files`)
//!
//! **근거를 읽는 대상 = 견주는 대상**: 호스트 해시를 구한 `(파일, 해시)` 목록(`expected`) 하나로 docker 인자(`targets`)와 판정을 모두 만든다.
//! **호스트와 컨테이너가 같은 입력을 다르게 읽는 자리(점검한 것, 지금 동작을 시험으로 고정)**:
//!  - 링크: 호스트 해시는 링크를 따라간 내용이고(`File::open`, Node `readFile`과 같다), 컨테이너는 `sha256sum`이 같게 따라간다. 목록 확인(`find -H`)은 폴더 링크를 따라간다
//!  - 대소문자·유니코드 정규화: 호스트 경로는 파일 시스템이 읽고(macOS 기본 볼륨은 대소문자를 접는다), 컨테이너 출력의 경로는 글자 그대로 견준다.
//!    그래서 호스트에서는 보이는 이름이 컨테이너 출력에서 다른 글자면 줄이 없는 것으로 읽혀 통과하지 못한다(열리지 않는다)
//!  - 경로 접기: 호스트 경로는 `path.join`과 같게 접는다(`node_path::join`)
//!
//! 막는 쪽/여는 쪽: `sync_files`는 여는 쪽(`Done`이 통과)이다. 모르는 입력은 모두 `Done`이 아니다.
//! `relay_changes`의 알림 계획은 알리는 경로를 정하는 쪽이라 결과를 더 좁게 읽는다(출력에 찍힌 인자만 알린 것).

use std::time::{Duration, Instant};

use bstudio_guard::docker_format::SyncObservations;
use bstudio_guard::relay::{self, FileChange};
use bstudio_guard::snapshots::{hex, Sha256};
use bstudio_guard::{node_path, sync_relay as judge};
use serde_json::Value;
use tokio::io::AsyncReadExt;

use crate::container_verify::Cancel;
use crate::up_loop::{compose_command, docker, ComposeRef};

pub const MISSING: &str = "MISSING";

/// 호스트 파일의 sha256. 없으면 `MISSING`, 그 밖의 읽기 오류는 `Err`(통과시키지 않는다). 링크는 따라간다
pub async fn host_hash_or_missing(root: &str, file: &str) -> Result<String, String> {
    let path = node_path::join(&[root, file]);
    let mut handle = match tokio::fs::File::open(&path).await {
        Ok(handle) => handle,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(MISSING.to_owned()),
        Err(error) => return Err(format!("{path}: {error}")),
    };
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        match handle.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => hash.update(&buffer[..read]),
            Err(error) => return Err(format!("{path}: {error}")),
        }
    }
    Ok(hex(&hash.finish()))
}

async fn exists(path: &str) -> bool {
    tokio::fs::metadata(path).await.is_ok()
}

fn push_unique(targets: &mut Vec<String>, item: &str) {
    if !targets.iter().any(|seen| seen == item) {
        targets.push(item.to_owned());
    }
}

/// 반영 확인 대상에 지운 파일과 함께 사라진 폴더를 더한다. 파일 공유 캐시가 상위 폴더 목록에 지운 폴더를 15초 넘게 남기는데, 그 사이 서비스를
/// 다시 띄우면 빌드 도구가 목록에 있는 폴더를 읽다가 실패한다(트러블슈팅 26). 폴더는 내용 해시가 없으므로 `MISSING`이 돌아올 때까지,
/// 즉 상위 폴더 목록에서 사라질 때까지 기다리게 된다. 옛 TS `withRemovedDirectories`와 같다(처음 나온 순서, 중복 없음)
pub async fn with_removed_directories(root: &str, files: &[String]) -> Vec<String> {
    let mut targets: Vec<String> = Vec::new();
    for file in files {
        push_unique(&mut targets, file);
    }
    for file in files {
        if exists(&node_path::join(&[root, file])).await {
            continue;
        }
        let mut dir = node_path::dirname(file);
        while dir != "." && dir != "/" && !exists(&node_path::join(&[root, &dir])).await {
            push_unique(&mut targets, &dir);
            dir = node_path::dirname(&dir);
        }
    }
    targets
}

pub struct SyncInput {
    /// docker 실행 파일·환경·프로젝트 폴더(컨테이너의 `/project`로 읽기 전용 마운트한다)
    pub compose: ComposeRef,
    pub files: Vec<String>,
    /// 이 시간(ms)이 지나도록 반영되지 않으면 실패다. NaN이면 끝나지 않는다(옛 TS와 같다)
    pub timeout_ms: f64,
    /// 컨테이너에서 도는 확인 스크립트와 이미지(TS의 `SYNC_SCRIPT`·`SYNC_HELPER_IMAGE`)
    pub script: String,
    pub image: String,
    pub poll_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncOutcome {
    Done { elapsed_ms: u64, checks: u32 },
    /// 호스트 파일을 읽지 못했다(없음이 아닌 오류)
    HostRead { file: String, message: String },
    /// docker가 비0으로 끝났다(가리기 전 stderr 원문). 취소로 멈춘 것도 여기다
    Docker { stderr: String },
    /// 시간 안에 반영되지 않았다(`describe_timeout` 글)
    Timeout(String),
    /// 기다리는 중에 취소됐다(부르는 쪽이 취소를 그대로 던진다)
    Aborted,
}

pub async fn sync_files(input: &SyncInput, cancel: &Cancel) -> SyncOutcome {
    if input.files.is_empty() {
        return SyncOutcome::Done { elapsed_ms: 0, checks: 0 };
    }
    let root = &input.compose.project_root;
    let targets = with_removed_directories(root, &input.files).await;
    // 근거를 읽는 대상: 이 목록 하나가 docker 인자와 판정을 모두 만든다
    let mut expected: Vec<(String, String)> = Vec::with_capacity(targets.len());
    for file in &targets {
        match host_hash_or_missing(root, file).await {
            Ok(hash) => expected.push((file.clone(), hash)),
            Err(message) => return SyncOutcome::HostRead { file: file.clone(), message },
        }
    }
    let started = Instant::now();
    let mut observations = SyncObservations::new();
    let mut checks: u32 = 0;
    loop {
        checks += 1;
        let mut args: Vec<String> = ["run", "--rm", "--network", "none", "--volume"].iter().map(|part| (*part).to_owned()).collect();
        args.push(format!("{root}:/project:ro"));
        args.extend([input.image.clone(), "sh".to_owned(), "-c".to_owned(), input.script.clone(), "sh".to_owned()]);
        args.extend(expected.iter().map(|(file, _)| file.clone()));
        let result = docker(&input.compose, &args, Some(cancel)).await;
        if result.exit_code != 0 {
            return SyncOutcome::Docker { stderr: result.stderr };
        }
        let pending = judge::pending_files(&expected, &result.stdout);
        if pending.is_empty() {
            return SyncOutcome::Done { elapsed_ms: started.elapsed().as_millis() as u64, checks };
        }
        for (file, seen) in &pending {
            observations.record(file, seen.as_deref());
        }
        if started.elapsed().as_millis() as f64 >= input.timeout_ms {
            // 반영이 끝나지 않은 것은 호스트와 컨테이너 사이의 파일 공유 문제다. 코드를 고쳐서 풀 수 없다
            let names: Vec<String> = pending.iter().map(|(file, _)| file.clone()).collect();
            let expected_missing: Vec<String> = expected.iter().filter(|(_, hash)| hash == MISSING).map(|(file, _)| file.clone()).collect();
            return SyncOutcome::Timeout(observations.describe_timeout(&names, &expected_missing, input.timeout_ms));
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(input.poll_ms)) => {}
            _ = cancel.cancelled() => return SyncOutcome::Aborted,
        }
    }
}

// ── 변경 알림 ───────────────────────────────────────────────────────────

pub struct RelayInput {
    /// 프로젝트 이름·폴더·compose 파일·환경(알림 명령도 `up`과 같은 파일·override로 부른다)
    pub compose: ComposeRef,
    pub override_path: String,
    /// 상대 경로를 풀 기준 폴더(TS의 `process.cwd()`)
    pub cwd: String,
    /// `compose config --format json`의 stdout 원문(세션 동안 TS가 한 번 읽어 캐시한다)
    pub config_json: String,
    /// managed 서비스 (이름, 프로젝트 루트 기준 폴더). 같은 이름이 또 나오면 뒤의 값을 쓴다
    pub managed: Vec<(String, String)>,
    pub changes: Vec<FileChange>,
    /// 컨테이너에서 도는 알림 스크립트(TS의 `RELAY_SCRIPT`)
    pub script: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayOutcome {
    /// 실제로 알린 `(서비스, 프로젝트 기준 경로)`
    Done(Vec<(String, String)>),
    /// compose 설정을 해석하지 못했거나 모양을 모른다. 알리지 않고 실패한다
    Problem(String),
}

pub async fn relay_changes(input: &RelayInput, cancel: &Cancel) -> RelayOutcome {
    if input.changes.is_empty() {
        return RelayOutcome::Done(Vec::new());
    }
    let config: Value = match serde_json::from_str(&input.config_json) {
        Ok(config) => config,
        Err(error) => return RelayOutcome::Problem(format!("compose 설정을 해석하지 못했습니다: {error}")),
    };
    let Some(services) = config.get("services").and_then(Value::as_object) else {
        return RelayOutcome::Problem("compose 설정에 services 객체가 없습니다".to_owned());
    };
    let services: Vec<(String, Value)> = services.iter().map(|(name, spec)| (name.clone(), spec.clone())).collect();
    let managed: Vec<String> = input.managed.iter().map(|(name, _)| name.clone()).collect();
    // ADR-088: managed 서비스가 전부 프로젝트 루트를 통째로 마운트하므로, 서비스 폴더(subroot)로 한 번 더 좁혀야 같은 루트를 마운트한 다른 서비스로 잘못 알리지 않는다
    let mounts = match relay::bind_mounts(&input.cwd, &services, &managed, &input.managed) {
        Ok(mounts) => mounts,
        Err(message) => return RelayOutcome::Problem(message),
    };
    let mut relayed: Vec<(String, String)> = Vec::new();
    for (service, targets) in relay::plan_relay(&input.cwd, &input.compose.project_root, &input.changes, &mounts) {
        let mut rest: Vec<String> = ["exec", "-T"].iter().map(|part| (*part).to_owned()).collect();
        rest.extend([service.clone(), "sh".to_owned(), "-c".to_owned(), input.script.clone(), "sh".to_owned()]);
        rest.extend(targets.iter().map(judge::relay_arg));
        let result = docker(&input.compose, &compose_command(&input.compose, &input.override_path, &rest), Some(cancel)).await;
        // 컨테이너가 재시작 중이면 알리지 못한 경로가 생긴다. 다시 뜬 서비스는 파일을 처음부터 읽으므로 알린 경로만 돌려준다
        relayed.extend(judge::relayed_files(&service, &targets, &result.stdout));
    }
    RelayOutcome::Done(relayed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fake_docker::Fake;
    use serde_json::json;
    use std::fs;
    use std::path::Path;

    const SCRIPT: &str = "SYNC_SCRIPT_BODY";

    fn sha(text: &str) -> String {
        let mut hash = Sha256::new();
        hash.update(text.as_bytes());
        hex(&hash.finish())
    }

    struct Project {
        _dir: tempfile::TempDir,
        root: String,
    }

    fn project() -> Project {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap().join("proj");
        fs::create_dir_all(root.join("src")).unwrap();
        Project { root: root.to_string_lossy().into_owned(), _dir: dir }
    }

    fn compose(fake: &Fake, project: &Project) -> ComposeRef {
        ComposeRef { docker_bin: fake.bin(), env: None, project_root: project.root.clone(), compose_path: format!("{}/compose.yaml", project.root), project_name: Some("studio-p".into()) }
    }

    fn sync_input(fake: &Fake, project: &Project, files: &[&str], timeout_ms: f64) -> SyncInput {
        SyncInput { compose: compose(fake, project), files: files.iter().map(|f| (*f).to_owned()).collect(), timeout_ms, script: SCRIPT.into(), image: "busybox:1.37".into(), poll_ms: 1 }
    }

    async fn sync(input: &SyncInput) -> SyncOutcome {
        sync_files(input, &Cancel::default()).await
    }

    // ── 호스트 해시 ──

    #[tokio::test]
    async fn 호스트_해시는_내용의_sha256이고_없으면_missing이다() {
        let project = project();
        fs::write(Path::new(&project.root).join("a.txt"), "hello").unwrap();
        assert_eq!(host_hash_or_missing(&project.root, "a.txt").await.unwrap(), sha("hello"));
        assert_eq!(host_hash_or_missing(&project.root, "none.txt").await.unwrap(), MISSING);
        // path.join처럼 접는다
        assert_eq!(host_hash_or_missing(&project.root, "src/../a.txt").await.unwrap(), sha("hello"));
        assert_eq!(host_hash_or_missing(&project.root, "/a.txt").await.unwrap(), sha("hello"));
        // 접기는 글자만으로 한다(`path.join`). 없는 폴더를 거쳐 가는 `..`도 접히므로 파일 시스템이 읽을 때와 다르다
        assert_eq!(host_hash_or_missing(&project.root, "ghost/../a.txt").await.unwrap(), sha("hello"));
        // 빈 경로는 프로젝트 폴더 자신이다(폴더라서 읽을 수 없다)
        assert!(host_hash_or_missing(&project.root, "").await.unwrap_err().contains("proj"));
    }

    #[tokio::test]
    async fn 호스트_해시는_없음_말고는_읽기_오류가_실패다() {
        let project = project();
        // 폴더는 읽을 수 없다(EISDIR)
        assert!(host_hash_or_missing(&project.root, "src").await.is_err());
        // 파일 아래의 경로는 ENOTDIR이다(없음이 아니다)
        fs::write(Path::new(&project.root).join("file"), "x").unwrap();
        assert!(host_hash_or_missing(&project.root, "file/child").await.is_err());
        // 읽기 권한이 없다(root로 돌면 읽히므로 그때는 건너뛴다)
        use std::os::unix::fs::PermissionsExt;
        let secret = Path::new(&project.root).join("secret");
        fs::write(&secret, "x").unwrap();
        fs::set_permissions(&secret, fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(&secret).is_err() {
            assert!(host_hash_or_missing(&project.root, "secret").await.is_err());
        }
        // 링크 고리(ELOOP)
        let (a, b) = (Path::new(&project.root).join("la"), Path::new(&project.root).join("lb"));
        std::os::unix::fs::symlink(&b, &a).unwrap();
        std::os::unix::fs::symlink(&a, &b).unwrap();
        assert!(host_hash_or_missing(&project.root, "la").await.is_err());
        // NUL이 든 경로
        assert!(host_hash_or_missing(&project.root, "a\0b").await.is_err());
    }

    #[tokio::test]
    async fn 호스트_해시는_링크를_따라간_내용이고_깨진_링크는_없음이다() {
        let project = project();
        let root = Path::new(&project.root);
        fs::write(root.join("real.txt"), "linked").unwrap();
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("alias.txt")).unwrap();
        assert_eq!(host_hash_or_missing(&project.root, "alias.txt").await.unwrap(), sha("linked"));
        std::os::unix::fs::symlink(root.join("nowhere"), root.join("broken.txt")).unwrap();
        assert_eq!(host_hash_or_missing(&project.root, "broken.txt").await.unwrap(), MISSING);
        // 폴더 링크 아래의 파일
        std::os::unix::fs::symlink(root.join("src"), root.join("srclink")).unwrap();
        fs::write(root.join("src/in.txt"), "inside").unwrap();
        assert_eq!(host_hash_or_missing(&project.root, "srclink/in.txt").await.unwrap(), sha("inside"));
    }

    #[tokio::test]
    async fn 큰_파일도_조각으로_읽어_같은_해시를_낸다() {
        let project = project();
        let big = "x".repeat(200_000);
        fs::write(Path::new(&project.root).join("big"), &big).unwrap();
        assert_eq!(host_hash_or_missing(&project.root, "big").await.unwrap(), sha(&big));
    }

    // ── 지운 폴더 ──

    #[tokio::test]
    async fn 지운_파일과_함께_사라진_상위_폴더도_대상에_더한다() {
        let project = project();
        let root = Path::new(&project.root);
        fs::write(root.join("keep.txt"), "x").unwrap();
        fs::write(root.join("src/stay.txt"), "x").unwrap();
        let files: Vec<String> = ["keep.txt", "gone/deep/file.ts", "src/stay.txt", "src/removed.ts"].iter().map(|f| (*f).to_owned()).collect();
        // gone, gone/deep은 사라졌다. src는 남아 있어 더하지 않는다
        assert_eq!(with_removed_directories(&project.root, &files).await, ["keep.txt", "gone/deep/file.ts", "src/stay.txt", "src/removed.ts", "gone/deep", "gone"]);
        // 중복은 하나로 센다
        let twice: Vec<String> = ["a.txt", "a.txt"].iter().map(|f| (*f).to_owned()).collect();
        assert_eq!(with_removed_directories(&project.root, &twice).await, ["a.txt"]);
        // 같은 폴더가 여러 파일의 상위여도 한 번만
        let siblings: Vec<String> = ["gone/a", "gone/b"].iter().map(|f| (*f).to_owned()).collect();
        assert_eq!(with_removed_directories(&project.root, &siblings).await, ["gone/a", "gone/b", "gone"]);
    }

    // ── sync ──

    #[tokio::test]
    async fn 호스트와_컨테이너의_해시가_같으면_한_번에_통과한다() {
        let (fake, project) = (Fake::new(), project());
        fs::write(Path::new(&project.root).join("a.txt"), "hello").unwrap();
        fake.set("run", &format!("{} a.txt\n", sha("hello")));
        let outcome = sync(&sync_input(&fake, &project, &["a.txt"], 5_000.0)).await;
        assert!(matches!(outcome, SyncOutcome::Done { checks: 1, .. }), "{outcome:?}");
        // docker 인자: 읽기 전용 마운트, 네트워크 없음, 이미지, 스크립트, 대상
        assert_eq!(fake.calls(), vec![format!("run --rm --network none --volume {}:/project:ro busybox:1.37 sh -c {SCRIPT} sh a.txt", project.root)]);
    }

    #[tokio::test]
    async fn 비어_있는_목록은_아무것도_부르지_않는다() {
        let (fake, project) = (Fake::new(), project());
        assert_eq!(sync(&sync_input(&fake, &project, &[], 5_000.0)).await, SyncOutcome::Done { elapsed_ms: 0, checks: 0 });
        assert!(fake.calls().is_empty());
    }

    #[tokio::test]
    async fn 지운_파일은_컨테이너에서도_missing이어야_통과한다_사라진_폴더도_대상이다() {
        let (fake, project) = (Fake::new(), project());
        fake.set("run", "MISSING gone/a.ts\nMISSING gone\n");
        let outcome = sync(&sync_input(&fake, &project, &["gone/a.ts"], 5_000.0)).await;
        assert!(matches!(outcome, SyncOutcome::Done { .. }), "{outcome:?}");
        assert!(fake.calls()[0].ends_with("sh gone/a.ts gone"), "{:?}", fake.calls());
    }

    #[tokio::test]
    async fn 늦게_반영되면_다시_확인해_통과하고_확인_횟수를_센다() {
        let (fake, project) = (Fake::new(), project());
        fs::write(Path::new(&project.root).join("a.txt"), "new").unwrap();
        fake.set("run.1", &format!("{} a.txt\n", sha("old"))).set("run.2", "MISSING a.txt\n").set("run.3", &format!("{} a.txt\n", sha("new")));
        let outcome = sync(&sync_input(&fake, &project, &["a.txt"], 5_000.0)).await;
        assert!(matches!(outcome, SyncOutcome::Done { checks: 3, .. }), "{outcome:?}");
    }

    #[tokio::test]
    async fn 시간이_지나도_이전_내용이면_시간_초과_글로_실패한다() {
        let (fake, project) = (Fake::new(), project());
        fs::write(Path::new(&project.root).join("a.txt"), "new").unwrap();
        fake.set("run", &format!("{} a.txt\n", sha("old")));
        match sync(&sync_input(&fake, &project, &["a.txt"], 30.0)).await {
            SyncOutcome::Timeout(text) => {
                assert!(text.starts_with("0초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: a.txt"), "{text}");
                assert!(text.contains("이전 내용 그대로였습니다"), "{text}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn 컨테이너가_줄을_주지_않거나_모양을_모르면_통과하지_못하고_끝까지_시간_초과다() {
        for out in ["", "garbage\n", "x\n\ny"] {
            let (fake, project) = (Fake::new(), project());
            fs::write(Path::new(&project.root).join("a.txt"), "hello").unwrap();
            fake.set("run", out);
            let outcome = sync(&sync_input(&fake, &project, &["a.txt"], 30.0)).await;
            assert!(matches!(outcome, SyncOutcome::Timeout(_)), "{out:?}: {outcome:?}");
        }
    }

    #[tokio::test]
    async fn 같은_파일의_줄이_둘이면_뒤의_줄이_맞아도_통과하지_못한다() {
        let (fake, project) = (Fake::new(), project());
        fs::write(Path::new(&project.root).join("a.txt"), "hello").unwrap();
        fake.set("run", &format!("{} a.txt\n{} a.txt\n", sha("old"), sha("hello")));
        assert!(matches!(sync(&sync_input(&fake, &project, &["a.txt"], 30.0)).await, SyncOutcome::Timeout(_)));
    }

    #[tokio::test]
    async fn 컨테이너가_읽지_못한_파일은_통과하지_못한다() {
        let (fake, project) = (Fake::new(), project());
        fs::write(Path::new(&project.root).join("a.txt"), "hello").unwrap();
        fake.set("run", "UNREADABLE a.txt\n");
        assert!(matches!(sync(&sync_input(&fake, &project, &["a.txt"], 30.0)).await, SyncOutcome::Timeout(_)));
    }

    #[tokio::test]
    async fn 호스트에서는_있는_파일이_컨테이너_출력에서_다른_글자면_통과하지_못한다() {
        // 대소문자·유니코드 정규화를 접지 않는다. 호스트 파일 시스템이 접어 읽는 이름도 컨테이너 출력의 글자와 같아야 한다
        let (fake, project) = (Fake::new(), project());
        fs::write(Path::new(&project.root).join("README.md"), "hello").unwrap();
        fake.set("run", &format!("{} readme.md\n", sha("hello")));
        assert!(matches!(sync(&sync_input(&fake, &project, &["README.md"], 30.0)).await, SyncOutcome::Timeout(_)));
    }

    #[tokio::test]
    async fn docker가_비0이면_stderr와_함께_실패한다() {
        let (fake, project) = (Fake::new(), project());
        fs::write(Path::new(&project.root).join("a.txt"), "hello").unwrap();
        fake.fail("run", 125, "pull failed");
        assert_eq!(sync(&sync_input(&fake, &project, &["a.txt"], 5_000.0)).await, SyncOutcome::Docker { stderr: "pull failed".into() });
        assert_eq!(fake.calls().len(), 1);
    }

    #[tokio::test]
    async fn 호스트_파일을_읽지_못하면_docker를_부르지_않고_실패한다() {
        let (fake, project) = (Fake::new(), project());
        // src는 폴더다
        match sync(&sync_input(&fake, &project, &["src"], 5_000.0)).await {
            SyncOutcome::HostRead { file, message } => {
                assert_eq!(file, "src");
                assert!(message.contains("src"), "{message}");
            }
            other => panic!("{other:?}"),
        }
        assert!(fake.calls().is_empty());
    }

    #[tokio::test]
    async fn 기다리는_중에_취소하면_취소로_끝난다() {
        let (fake, project) = (Fake::new(), project());
        fs::write(Path::new(&project.root).join("a.txt"), "hello").unwrap();
        fake.set("run", "MISSING a.txt\n");
        let mut input = sync_input(&fake, &project, &["a.txt"], 60_000.0);
        input.poll_ms = 10_000;
        let cancel = std::sync::Arc::new(Cancel::default());
        let later = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            later.cancel();
        });
        assert_eq!(sync_files(&input, &cancel).await, SyncOutcome::Aborted);
    }

    // ── relay ──

    fn relay_config(project: &Project) -> String {
        json!({ "services": {
            "api": { "volumes": [{ "type": "bind", "source": project.root, "target": "/app" }] },
            "db": { "volumes": [{ "type": "volume", "source": "data", "target": "/var/lib/db" }] },
        } })
        .to_string()
    }

    fn relay_input(fake: &Fake, project: &Project, config: String, changes: &[(&str, &str)]) -> RelayInput {
        RelayInput {
            compose: compose(fake, project),
            override_path: format!("{}/compose.override.yaml", project.root),
            cwd: "/".into(),
            config_json: config,
            managed: vec![("api".into(), ".".into())],
            changes: changes.iter().map(|(file, kind)| FileChange { file: (*file).into(), kind: (*kind).into() }).collect(),
            script: "RELAY_BODY".into(),
        }
    }

    async fn relay_with(input: &RelayInput) -> RelayOutcome {
        relay_changes(input, &Cancel::default()).await
    }

    #[tokio::test]
    async fn 알림은_서비스마다_exec를_부르고_출력에_찍힌_인자만_알린_것이다() {
        let (fake, project) = (Fake::new(), project());
        fake.set("exec", "m:/app/newdir\n");
        let input = relay_input(&fake, &project, relay_config(&project), &[("newdir", "directory"), ("added.ts", "file")]);
        let outcome = relay_with(&input).await;
        // newdir은 옮겼고, 프로젝트 루트(/app)에 새 파일을 알리는 n:/app은 출력에 없어 알리지 않았다
        assert_eq!(outcome, RelayOutcome::Done(vec![("api".into(), "newdir".into())]), "{:?}", fake.calls());
        let calls = fake.calls();
        assert_eq!(calls.len(), 1);
        let expected_head = format!("compose --project-name studio-p --project-directory {} --file {}/compose.yaml --file {}/compose.override.yaml exec -T api sh -c RELAY_BODY sh ", project.root, project.root, project.root);
        assert!(calls[0].starts_with(&expected_head), "{}", calls[0]);
        assert!(calls[0].contains("m:/app/newdir") && calls[0].contains("n:/app"), "{}", calls[0]);
    }

    #[tokio::test]
    async fn 변경이_없으면_설정도_읽지_않는다() {
        let (fake, project) = (Fake::new(), project());
        assert_eq!(relay_with(&relay_input(&fake, &project, "not json".into(), &[])).await, RelayOutcome::Done(Vec::new()));
        assert!(fake.calls().is_empty());
    }

    #[tokio::test]
    async fn 알리지_못한_출력은_아무것도_알리지_않은_것이다_exec의_비0_종료는_출력만_본다() {
        let (fake, project) = (Fake::new(), project());
        fake.fail("exec", 1, "restarting");
        let input = relay_input(&fake, &project, relay_config(&project), &[("newdir", "directory")]);
        assert_eq!(relay_with(&input).await, RelayOutcome::Done(Vec::new()));
        fake.set("exec", "m:/app/newdir\n");
        assert_eq!(relay_with(&input).await, RelayOutcome::Done(vec![("api".into(), "newdir".into())]));
    }

    #[tokio::test]
    async fn 설정을_해석하지_못하거나_services가_객체가_아니면_알리지_않고_실패한다() {
        for bad in ["not json", "", "null", "[]", "{}", "{\"services\":null}", "{\"services\":[]}", "{\"services\":5}"] {
            let (fake, project) = (Fake::new(), project());
            let outcome = relay_with(&relay_input(&fake, &project, bad.into(), &[("a.ts", "file")])).await;
            assert!(matches!(outcome, RelayOutcome::Problem(_)), "{bad:?}: {outcome:?}");
            assert!(fake.calls().is_empty(), "{bad:?}");
        }
        // 마운트의 모양을 모르면 판정(bind_mounts)이 던진다
        let (fake, project) = (Fake::new(), project());
        let outcome = relay_with(&relay_input(&fake, &project, json!({ "services": { "api": { "volumes": "x" } } }).to_string(), &[("a.ts", "file")])).await;
        assert!(matches!(&outcome, RelayOutcome::Problem(message) if message.contains("volumes")), "{outcome:?}");
        assert!(fake.calls().is_empty());
    }

    #[tokio::test]
    async fn 어느_마운트에도_들지_않는_변경은_알리지_않는다() {
        let (fake, project) = (Fake::new(), project());
        let config = json!({ "services": { "api": { "volumes": [{ "type": "bind", "source": format!("{}/src", project.root), "target": "/app" }] } } }).to_string();
        let outcome = relay_with(&relay_input(&fake, &project, config, &[("other/new", "directory")])).await;
        assert_eq!(outcome, RelayOutcome::Done(Vec::new()));
        assert!(fake.calls().is_empty());
    }
}
