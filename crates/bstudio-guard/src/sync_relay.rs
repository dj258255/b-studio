//! 파일 반영 확인(`LocalDockerSandbox.sync`)·변경 알림(`relayChanges`)·포트 충돌 재시도(`#composeUpWithPortRetry`)의 판정 부분(ADR-195 4f A4c-2).
//! docker를 부르는 순서와 파일 읽기는 `bstudio-io`의 `sync_relay`·`port_retry`가 하고, 여기는 그 사이의 판정만 한다. 파일 시스템도 읽지 않는다.
//!
//! **`sync`의 판정은 통과시키는 판정이다.** 검증 게이트가 "파일이 컨테이너에 반영됐다"를 믿는 근거라서, 아래는 모두 통과가 아니라 "아직"이다.
//!  - 컨테이너 출력에 그 파일의 줄이 없음
//!  - 같은 파일의 줄이 둘 이상(옛 `parse_sync_output`은 나중 줄이 이겼다 — HARDENED, 트러블슈팅 191)
//!  - `<값> <경로>` 꼴이 아닌 줄이 하나라도 있음(어느 파일의 줄인지 알 수 없는 출력은 모든 파일을 "아직"으로 본다 — HARDENED)
//!  - 기대한 값과 다른 값(`UNREADABLE`·이전 내용·`MISSING`인데 지워지지 않음)
//!
//! 근거를 읽는 대상과 견주는 대상은 같은 목록이다: 호스트 해시를 구한 `(파일, 해시)` 목록 하나만 받아, 그 목록의 파일만 본다.
//!
//! 막는 쪽/여는 쪽: `pending_files`는 **여는 쪽**(비면 통과)이므로 넓게 맞추지 않는다 — 문자열이 정확히 같을 때만 같다고 읽고(대소문자·유니코드 정규화·
//! 링크를 접지 않는다), 모르는 출력은 모두 "아직"이다. `is_conflict_detail`은 재시도를 여는 쪽이라 `is_port_bind_conflict`를 그대로 쓴다.

use crate::relay::RelayTarget;

/// 아직 반영되지 않은 파일과, 그 파일에 대해 컨테이너가 알려 준 값(줄이 없거나 믿을 수 없으면 `None`)
pub type Pending = (String, Option<String>);

/// `expected`는 호스트에서 구한 `(파일, 기대 값)` 목록이다. 컨테이너 출력(`<sha256|MISSING|UNREADABLE> <경로>` 한 줄씩)을 읽어
/// 아직 맞지 않은 파일을 `expected`의 순서대로 돌려준다. 비어 있어야 통과다.
///
/// 경로에 공백이 있을 수 있으므로 첫 공백에서만 나눈다(옛 `parse_sync_output`과 같다). 빈 줄은 건너뛴다(내용이 없다)
pub fn pending_files(expected: &[(String, String)], stdout: &str) -> Vec<Pending> {
    let mut seen: Vec<(&str, &str)> = Vec::new();
    let mut ambiguous: Vec<&str> = Vec::new();
    let mut malformed = false;
    for line in stdout.split('\n') {
        if line.is_empty() {
            continue;
        }
        let Some(space) = line.find(' ').filter(|space| *space > 0) else {
            malformed = true;
            continue;
        };
        let (value, path) = (&line[..space], &line[space + 1..]);
        if seen.iter().any(|(seen_path, _)| *seen_path == path) {
            ambiguous.push(path);
        } else {
            seen.push((path, value));
        }
    }
    expected
        .iter()
        .filter_map(|(file, want)| {
            if malformed || ambiguous.contains(&file.as_str()) {
                return Some((file.clone(), None));
            }
            match seen.iter().find(|(path, _)| path == file) {
                Some((_, value)) if value == want => None,
                Some((_, value)) => Some((file.clone(), Some((*value).to_owned()))),
                None => Some((file.clone(), None)),
            }
        })
        .collect()
}

/// 알림 하나에 넘기는 위치 인자. `move`는 `m:`, 그 밖은 `n:`이다(컨테이너 안 스크립트가 `m:*`·`n:*`만 알아본다)
pub fn relay_arg(target: &RelayTarget) -> String {
    format!("{}:{}", if target.action == "move" { 'm' } else { 'n' }, target.container_path)
}

/// 컨테이너 스크립트가 **실제로 알렸다고 출력한** 인자의 알림만 파일로 풀어 돌려준다. 재시작 중이어서 알리지 못한 경로는 빠진다.
/// 출력 줄은 인자와 글자 하나까지 같아야 한다(줄바꿈이 든 경로는 줄이 쪼개져 맞지 않으므로 알리지 않은 것으로 본다)
pub fn relayed_files(service: &str, targets: &[RelayTarget], stdout: &str) -> Vec<(String, String)> {
    let done: Vec<&str> = stdout.split('\n').filter(|line| !line.is_empty()).collect();
    targets
        .iter()
        .filter(|target| done.contains(&relay_arg(target).as_str()))
        .flat_map(|target| target.files.iter().map(|file| (service.to_owned(), file.clone())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const OTHER: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn expected(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items.iter().map(|(file, hash)| ((*file).to_owned(), (*hash).to_owned())).collect()
    }

    fn files(pending: &[Pending]) -> Vec<&str> {
        pending.iter().map(|(file, _)| file.as_str()).collect()
    }

    #[test]
    fn 모두_기대한_값이면_비어_있다() {
        let want = expected(&[("a.txt", HASH), ("dir", "MISSING"), ("b c.txt", OTHER)]);
        let out = format!("{HASH} a.txt\nMISSING dir\n{OTHER} b c.txt\n");
        assert!(pending_files(&want, &out).is_empty());
    }

    #[test]
    fn 줄이_없는_파일은_아직이다_지워져야_하는_파일도_줄이_있어야_한다() {
        let want = expected(&[("a.txt", HASH), ("gone", "MISSING")]);
        let pending = pending_files(&want, &format!("{HASH} a.txt\n"));
        assert_eq!(pending, vec![("gone".to_owned(), None)]);
        assert_eq!(files(&pending_files(&want, "")), ["a.txt", "gone"]);
    }

    #[test]
    fn 다른_값은_본_값과_함께_아직이다() {
        let want = expected(&[("a.txt", HASH), ("b.txt", "MISSING")]);
        let pending = pending_files(&want, &format!("{OTHER} a.txt\nUNREADABLE b.txt\n"));
        assert_eq!(pending, vec![("a.txt".to_owned(), Some(OTHER.to_owned())), ("b.txt".to_owned(), Some("UNREADABLE".to_owned()))]);
    }

    #[test]
    fn 같은_파일의_줄이_둘이면_뒤의_값이_맞아도_아직이다() {
        let want = expected(&[("a.txt", HASH), ("b.txt", OTHER)]);
        // 옛 parse_sync_output은 나중 줄이 이겨 통과였다
        let pending = pending_files(&want, &format!("{OTHER} a.txt\n{HASH} a.txt\n{OTHER} b.txt\n"));
        assert_eq!(pending, vec![("a.txt".to_owned(), None)]);
        // 값이 같은 중복도 아직이다(스크립트는 인자마다 한 줄만 낸다)
        assert_eq!(files(&pending_files(&want, &format!("{HASH} a.txt\n{HASH} a.txt\n{OTHER} b.txt\n"))), ["a.txt"]);
    }

    #[test]
    fn 모양을_모르는_줄이_있으면_모든_파일이_아직이다() {
        let want = expected(&[("a.txt", HASH), ("b.txt", OTHER)]);
        for noise in ["garbage", " leading space", "no-space-at-all"] {
            let out = format!("{HASH} a.txt\n{OTHER} b.txt\n{noise}\n");
            assert_eq!(files(&pending_files(&want, &out)), ["a.txt", "b.txt"], "{noise:?}");
        }
    }

    #[test]
    fn 줄바꿈이_든_이름이_다른_파일의_줄을_꾸며_내도_통과하지_못한다() {
        // 대상 `y\n<기대 해시> a.txt`의 출력은 `MISSING y`와 `<기대 해시> a.txt` 두 줄로 쪼개진다. 뒤 줄이 a.txt의 줄처럼 보이고, 진짜 a.txt의 줄(이전 해시)이 앞에 있다.
        // 옛 parse_sync_output은 나중 줄이 이겨 a.txt가 통과였다
        let hostile = format!("y\n{HASH} a.txt");
        let want = expected(&[("a.txt", HASH), (hostile.as_str(), "MISSING")]);
        let out = format!("{OTHER} a.txt\nMISSING y\n{HASH} a.txt\n");
        let pending = pending_files(&want, &out);
        assert!(files(&pending).contains(&"a.txt"), "{pending:?}");
    }

    #[test]
    fn 빈_줄은_건너뛴다() {
        let want = expected(&[("a.txt", HASH)]);
        assert!(pending_files(&want, &format!("\n{HASH} a.txt\n\n")).is_empty());
    }

    #[test]
    fn 경로는_글자_그대로_견준다() {
        // 대소문자·유니코드 정규화를 접지 않는다(호스트와 컨테이너가 다르게 읽는 자리는 통과가 아니라 아직이다)
        let want = expected(&[("README.md", HASH), ("caf\u{e9}.txt", HASH)]);
        assert_eq!(files(&pending_files(&want, &format!("{HASH} readme.md\n{HASH} cafe\u{301}.txt\n"))), ["README.md", "caf\u{e9}.txt"]);
    }

    #[test]
    fn 기대_목록에_없는_줄은_통과에_쓰이지_않는다() {
        let want = expected(&[("a.txt", HASH)]);
        assert_eq!(files(&pending_files(&want, &format!("{HASH} other.txt\n"))), ["a.txt"]);
    }

    fn target(action: &'static str, container_path: &str, files: &[&str]) -> RelayTarget {
        RelayTarget { action, container_path: container_path.to_owned(), files: files.iter().map(|f| (*f).to_owned()).collect() }
    }

    #[test]
    fn 알림_인자는_종류_글자와_컨테이너_경로다() {
        assert_eq!(relay_arg(&target("move", "/app/new", &[])), "m:/app/new");
        assert_eq!(relay_arg(&target("nudge", "/app", &[])), "n:/app");
    }

    #[test]
    fn 출력에_찍힌_인자의_알림만_알린_것이다() {
        let targets = vec![target("move", "/app/new", &["new/a.ts", "new/b.ts"]), target("nudge", "/app", &["gone.ts"])];
        assert_eq!(relayed_files("api", &targets, "n:/app\n"), vec![("api".to_owned(), "gone.ts".to_owned())]);
        assert_eq!(relayed_files("api", &targets, "m:/app/new\nn:/app\n").len(), 3);
        assert!(relayed_files("api", &targets, "").is_empty());
        // 글자 하나라도 다르면 알리지 않은 것이다
        assert!(relayed_files("api", &targets, "m:/app/new \nn:/app/\nM:/app/new\n").is_empty());
    }
}
