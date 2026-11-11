//! 시험용 가짜 docker(셸 스크립트). 명령마다 `<키>.<호출 번호>.out|err|code|sleep`(없으면 `<키>.out|err|code|sleep`)을 읽어 흉내 내고,
//! 부른 인자를 `calls`에 남긴다. 키: `run`·`inspect`·`volume`·`rm`(docker rm)·`startid`(docker start)·`compose`의 명령 단어
//! (`config`·`up`·`ps`·`down`·`start`·`composerm`(compose rm)·`exec`)·`info`·`imagels`(image ls)·`imagerm`(image rm). 진짜 docker는 쓰지 않는다.

use std::fs;
use std::os::unix::fs::PermissionsExt;

pub struct Fake {
    pub dir: tempfile::TempDir,
}

impl Fake {
    pub fn new() -> Fake {
        let dir = tempfile::tempdir().unwrap();
        let script = format!(
            r#"#!/bin/sh
D='{}'
printf '%s\n' "$*" >> "$D/calls"
key=other
case "$1" in
  run) key=run ;;
  inspect) key=inspect; [ "$2" = --format ] && key=state ;;
  volume) key=volume ;;
  rm) key=rm ;;
  info) key=info ;;
  image) key=imagels; [ "$2" = rm ] && key=imagerm ;;
  start) key=startid ;;
  compose) for a in "$@"; do case "$a" in config) key=config ;; up) key=up ;; ps) key=ps ;; down) key=down ;; start) key=start ;; rm) key=composerm ;; exec) key=exec ;; esac; done ;;
esac
n=$(cat "$D/n.$key" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$D/n.$key"
[ -f "$D/$key.$n.sh" ] && . "$D/$key.$n.sh"
pick() {{ if [ -f "$D/$key.$n.$1" ]; then cat "$D/$key.$n.$1"; elif [ -f "$D/$key.$1" ]; then cat "$D/$key.$1"; fi; }}
s=$(pick sleep)
[ -n "$s" ] && sleep "$s"
pick out
pick err >&2
code=$(pick code)
exit ${{code:-0}}
"#,
            dir.path().display()
        );
        let bin = dir.path().join("docker");
        fs::write(&bin, script).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        // 리눅스에서 방금 쓴 파일을 실행하면, 다른 시험 스레드가 그 사이 띄운 자식이 쓰기 fd를 물려받아 exec 전까지 쥐고 있을 때
        // ETXTBSY로 실패한다(container_verify·up_loop 시험이 CI에서 겪은 것과 같다). 실행될 때까지 기다린 뒤 그 호출의 흔적을 지운다
        for _ in 0..500 {
            match std::process::Command::new(&bin).arg("__probe__").output() {
                Err(error) if error.raw_os_error() == Some(26) => std::thread::sleep(std::time::Duration::from_millis(10)),
                Err(error) => panic!("가짜 docker를 실행하지 못했습니다: {error}"),
                Ok(_) => break,
            }
        }
        let _ = fs::remove_file(dir.path().join("calls"));
        let _ = fs::remove_file(dir.path().join("n.other"));
        Fake { dir }
    }

    pub fn set(&self, key: &str, out: &str) -> &Self {
        fs::write(self.dir.path().join(format!("{key}.out")), out).unwrap();
        self
    }

    pub fn fail(&self, key: &str, code: i32, err: &str) -> &Self {
        fs::write(self.dir.path().join(format!("{key}.code")), code.to_string()).unwrap();
        fs::write(self.dir.path().join(format!("{key}.err")), err).unwrap();
        self
    }

    /// `<키>.<호출 번호>` 호출이 시작될 때 실행할 셸 조각(부수 효과를 흉내 낸다)
    pub fn hook(&self, key: &str, call: u32, script: &str) -> &Self {
        fs::write(self.dir.path().join(format!("{key}.{call}.sh")), script).unwrap();
        self
    }

    pub fn bin(&self) -> String {
        self.dir.path().join("docker").to_string_lossy().into_owned()
    }

    pub fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.dir.path().join("calls")).unwrap_or_default().lines().map(str::to_owned).collect()
    }

    /// 호출의 첫 단어나 `compose`의 명령 단어만 남긴다(경로 인자를 빼고 순서만 견준다)
    pub fn verbs(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .map(|call| {
                let words: Vec<&str> = call.split(' ').collect();
                if words[0] == "compose" {
                    ["config", "up", "ps", "down", "start", "rm", "exec"].iter().find(|verb| words.contains(verb)).map(|verb| format!("compose {verb}")).unwrap_or_else(|| "compose".to_owned())
                } else {
                    words[0].to_owned()
                }
            })
            .collect()
    }
}
