# 실측: 체크포인트 원격 경로를 Rust로 옮긴 뒤 실제 GitHub 원격으로 돌려 보기 (ADR-195 4f A2)

- 날짜: 2026-11-12
- 관련: 이슈 #1193, 브랜치 `feat/4f-a2-remote`
- 모델 호출: 없음. 스튜디오를 거치지 않고 이 브랜치의 `CheckpointStore`를 작은 스크립트(tsx)에서 바로 불렀다(세션 API에는 올리기·가져오기 경로가 없다)
- 원격: 시험용 저장소 `dj258255/test`(비공개)만 썼다. 실측 브랜치는 끝나고 지웠고, `main`은 건드리지 않았다(실측 전후 `d5ca12b`)
- 환경: macOS, 시스템 git. `gitBin`에 인자를 적고 진짜 git을 부르는 껍데기를 주어 git 호출을 기록했다. 모두 한 번 잰 값이다

## 방법

1. `dj258255/test`를 임시 폴더에 복제하고 `CheckpointStore.clone`으로 세션 브랜치 `b-studio-a2-measure-mwdce9eg`를 만든다.
2. 파일 하나를 쓰고 체크포인트를 만든 뒤 `push`.
3. 다른 복제본에서 같은 원격 세션 브랜치에 커밋을 더해 올린 뒤 `integrateRemote` → `acceptRemote`.
4. `baseStatus({ force: true })`.
5. 로컬 설정에 `url.https://evil.invalid/.insteadOf https://github.com/`를 넣고 `push`. 끝나고 설정을 지운다.
6. 터미널이 기록을 바꾼 것처럼 다른 브랜치(`stray`)로 옮겨 커밋하고 추적되지 않은 파일을 남긴 뒤 `assertTrustedGit` → `restoreRememberedHead` → 다시 `assertTrustedGit`.

## 결과

1. `push`(3.0초): 신뢰 확인(`rev-parse HEAD` → `symbolic-ref` → `remote get-url origin` → `config --list --includes --show-scope --show-origin -z`) 다음에 `push --force-with-lease=refs/heads/<브랜치>: origin HEAD:refs/heads/<브랜치>`, 그 뒤 `b-studio.pushed`·`b-studio.remote` 기록. 결과 `{"commits":1,"forced":false}`.
2. `integrateRemote`: `merged`, 가져온 파일 `a2-remote.txt`, 커밋 1개, 새 체크포인트 `a99f66b`. `acceptRemote` 뒤 `remoteSha`가 원격 커밋으로 기록됐다.
3. `baseStatus`: `{"base":"main","behind":0,"aheadCommits":3}`.
4. **위험한 설정에서 멈춤**: `push`가 `작업 복사본의 Git 설정이 b-studio가 기억한 것과 달라 멈췄습니다`로 멈췄고, 이유 두 줄(`remote.origin.url이 기억한 주소와 다릅니다(지금: https://evil.invalid/dj258255/test.git)`, `저장소 설정에 url.https://evil.invalid/.insteadof이(가) 있습니다`)이 나왔다. git 호출 기록에서 이 단계는 `config --list …`로 끝나고 **`push`를 부르지 않았다**.
5. `assertTrustedGit`이 다른 브랜치와 다른 HEAD를 둘 다 알렸다. `restoreRememberedHead`의 git 호출 순서는 `rev-parse --verify <체크포인트>^{commit}` → `config --list …` → `rev-parse --git-path info/attributes`(HARDENED: `add -A` 앞의 안전 확인) → `add -A` → `diff --cached`(이름·패치·백업용 바이너리 패치) → `checkout -f <세션 브랜치>` → `reset -q --hard <체크포인트>` → `clean -q -fd`. 백업 `2026-11-12T09-25-44-991Z-0001`에 `loose.txt`·`stray.txt`가 담겼고, 되돌린 뒤 작업 폴더에는 둘 다 없고 HEAD는 세션 브랜치의 `a99f66b`다. 다시 부른 `assertTrustedGit`은 통과했다.

## 보지 못한 것

- 원격과 충돌하는 가져오기, 원격에만 병합 커밋이 있는 경우, 기준 브랜치가 앞선 상태의 `integrateBase`, `pullRequestTarget`은 실제 원격으로 돌리지 않았다(로컬 bare 원격의 차등 시험으로만).
- 스튜디오 세션 경로(세션 화면이나 desk에서 올리기·가져오기)로는 재지 않았다.
- DB 분기는 이 조각에서 옮기지 않았으므로 재지 않았다.
- 실측 중 `pendingFiles()`가 `check-ignore -z --stdin`을 한 번에 29번 불렀다. TS에 남은 단계(중첩 저장소 검사)이고 이 조각에서 바뀌지 않았다. 느려지는지는 재지 않았다.
