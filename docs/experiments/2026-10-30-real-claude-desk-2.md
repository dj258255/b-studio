# 실측: 실제 Claude Code로 studio desk 써 보기 (2차, 신뢰 창 너머)

- 날짜: 2026-10-30
- 관련 이슈: [1차 실측](2026-10-27-real-claude-desk.md)의 "보지 못한 것", 고친 것 [#988](https://github.com/dj258255/b-studio/issues/988)·[#989](https://github.com/dj258255/b-studio/issues/989), 남긴 것 [#992](https://github.com/dj258255/b-studio/issues/992)
- 모델: 이 컴퓨터에 로그인한 Claude Code 2.1.314(Claude Max). 사용자 설정은 auto mode다. 가설 없는 관찰이다
- 비용: 세션 셋, 스튜디오가 센 값으로 $2.15(고치기 전 사용자 기본 모델로 돈 첫 세션이 $1.30)

## 방법

- main ae4bb24(v0.4.0)에서 1차와 같이 진짜 스튜디오 서버(포트 3921, `B_STUDIO_TERMINAL=host`, 실험 기능 켬)와 `studio desk`를 PTY(170×48)로 띄우고 화면을 `@xterm/headless`로 글로 찍었다. 규칙표는 기본값 하나(`claude-code`, `sonnet`)다.
- 프로젝트는 busybox:1.37 하나로 도는 작은 저장소다(httpd가 프로젝트 폴더를 내주고, 검사는 README.md에 "shop"이 있는지 본다. `compose.yaml`·`studio.yaml`은 보호 경로). 등록 목록, desk 설정, 세션 폴더, 규칙표, 기록은 모두 실측 폴더(`~/.cache/b-studio/real2`) 안에 두었다. 사용자 `~/.claude`는 읽기만 했다.
- 범수 님 허락을 받아, 새 세션마다 "입력 필요"가 뜨면 `/api/agents`의 `terminal` 값을 남긴 뒤 그 칸에서 실측 세션 폴더에 대해서만 "Yes, I trust this folder"를 골랐다(세 번). 업데이트 같은 다른 선택 화면에는 키를 보내지 않았다.

## 본 것

### 신뢰 창 앞

- 2.1.314의 신뢰 창은 커서가 "No, exit"에 있다. 그대로 Enter를 보냈다면 CLI가 끝났다.
- 고르기 전 `/api/agents`: `state: dormant`, `terminal: { cli: 'down', waiting: 'input', message: '그 칸에서 폴더 신뢰 등 CLI 시작 창에 답하세요' }`. 1차에서 고친 표시(#966)가 실제 CLI에서 그대로 나왔다. 칸 머리는 보낸 뒤 14초에 찍은 화면에서 잠깐 "꺼짐"이었고 몇 초 뒤 "입력 필요"가 됐다.
- 확인 필요 줄에서 숫자와 Enter, `Ctrl-b j`로 그 칸에 옮겨 갔다.

### 라우팅이 고른 모델이 CLI에 가지 않았다(#988, 고침)

요청 칸 미리보기는 "Claude (sonnet)로 보냅니다"였는데 칸의 Claude는 "Fable 5.1 with high effort"로 떴다. 세션 터미널이 세션의 모델을 CLI에 넘기는 길이 없었다. 기록에는 sonnet으로 남아 AI별 결과도 실제와 다른 모델로 묶인다. 첫 실행에 `--model=<id>`를 붙이게 고친 뒤 같은 규칙표로 보낸 세션은 "Sonnet 5.5 · Claude Max"로 떴다. 고치기 전 세션의 실행은 라우팅 기록에 모델 "(모름)"으로 남았다.

### 샌드박스를 켜지 못할 때

처음에 실측 프로젝트의 준비 판정 경로(`/`)가 403·404를 돌려 샌드박스가 준비되지 않았다(실측 설정의 잘못이다). 이 경로도 화면과 관문이 어떻게 하는지 볼 만했다.

- 카드: "◐ 준비 중 · › 샌드박스와 서비스를 띄우는 중 · 54초째". 60초 뒤 "알림: … · 오류"가 나고 다시 띄우며 경과 시간이 0부터 다시 셌다.
- 쓰기 직전 관문이 Bash와 Edit를 "샌드박스를 준비하지 못해 파일을 바꿀 수 있는 도구를 막았습니다: … 60초 안에 준비되지 않았습니다 (마지막 확인: HTTP 404, 컨테이너 running)"로 막았다. 쓰기 도구마다 다시 띄우기를 기다려, Claude 화면에는 "running PreToolUse hook · 3m 5s"가 보였다.
- Claude는 `run_in_service`로 돌아가려 했고 같은 관문에 막혔다. `Ctrl-b p`, `y`로 멈추자 20초 안에 컨테이너 둘이 모두 내려갔다.

### 선언 검사가 실패했는데 "검증 통과"로 보였다(#989, 고침)

검사 명령이 상대 경로라 컨테이너 작업 폴더(`/`)에서 README.md를 찾지 못해 test가 세 번 실패했고, Stop 훅이 "검증 게이트를 3번 통과하지 못했습니다"로 끝내며 변경을 되돌렸다. 그동안 카드와 알림은 "검증 통과", `/api/agents`는 `gate: { state: 'passed', checkpoints: 0 }`, 같은 항목의 `attention`은 `gate_failed`였다. 개요의 판정이 `verify_result`(서비스 재시작·준비 판정·계약까지)만 보고, 그 뒤 선언 검사의 `workflow_check` 실패를 보지 않았다. 끝난 뒤 칸 머리와 카드는 "× 검증 실패"로 바뀌었다(끝 상태로 봄). 고친 서버로 같은 기록을 다시 읽어 확인한 결과는 아래 "고친 뒤 다시 본 것"에 있다.

### 보호 경로

- `compose.yaml`(보호 경로)에 주석을 더하라고 하자 Claude의 Edit가 그대로 들어갔다. 쓰기 직전 관문은 쓰기 범위("세션 작업 복사본 전체")만 보고, 보호 경로는 끝 게이트의 review 단계에서 "보호 경로가 바뀌었습니다. 되돌리거나 사람 승인 흐름으로 요청하세요: compose.yaml"로 막았다. 쓰기 범위 밖 쓰기 거절 자체는 이번 프로젝트에 범위 밖 경로가 없어 보지 못했다.
- 에이전트가 `compose.yaml`을 원래대로 되돌려 `git status`에 README.md만 남았는데도 다음 게이트가 같은 까닭으로 실패했고, 세 번째 실패 뒤 정상이던 README 변경까지 되돌려졌다. 마지막 줄은 "바뀐 파일은 없었습니다"였다(README는 문서 체크포인트로 남은 뒤 되돌려졌다). review가 "이번 실행에서 쓴 파일"을 보고 원래 내용으로 돌아왔는지는 보지 않는다. 막는 검사를 느슨하게 하는 일이라 이번에 고치지 않고 조심할 점과 함께 [#992](https://github.com/dj258255/b-studio/issues/992)로 남겼다.

### 서브에이전트, 지금 줄, 문맥 %, 상태 줄

- Agent 도구로 맡긴 일이 `agents`에 `general-purpose`, `state: done`, "끝남 · 도구 2회"와 그 토큰으로 실렸다.
- 지금 줄은 PreToolUse와 PostToolUse로 `now: { tool, target, running }`이 바뀌었다("Bash · cat -A README.md | tail -5", "mcp__b-studio__run_in_service · sh -c …"). 카드에는 "마지막 활동 10초 전"이 보였다.
- 문맥: 카드 "문맥 6%", `context: { usedPct: 6, used: 61513, size: 1000000 }`. Claude 상태 줄의 "6% 61.5k/1.0M"과 같다.
- 사용자 상태 줄(`~/.claude/statusline.sh`)은 b-studio 상태 줄이 이어 불러 "5시간 16% (19:00 초기화) │ 주간 38% │ $0.45"가 그대로 보였다.

### 게이트 통과, 체크포인트, 끝 알림, 라우팅 기록

- 검사 명령을 절대 경로로 고친 뒤 같은 세션에 "README.md 끝에 '네 번째' 한 줄을 더해 줘"를 넣자 `verifying` 다음 `passed`, 체크포인트 1개가 됐다. Stop 훅 "[b-studio] 검증 통과 — 체크포인트 1e705d3", 알림 "… · 검증 통과".
- `/api/routing/stats`: `claude-code` · `claude-sonnet-5-5` · 단순·보통에 3회(통과 1, 실패 2), 모델 "(모름)"에 1회(오류). 실행 기록의 모델은 CLI가 알려 온 실제 모델이다.

## 고친 뒤 다시 본 것

#988·#989가 병합된 main 238568d로 서버를 다시 띄워 같은 기록을 읽었다. test가 세 번 실패한 세션은 `gate: { state: 'failed', checkpoints: 0 }`, 통과한 세션은 `passed`와 체크포인트 1개였다. 서버를 다시 띄우면 세션이 멈춘 것으로 돌아오고, 남아 있던 샌드박스 컨테이너 둘은 다시 띄운 서버가 정리했다.

## 보지 못한 것과 까닭

- 권한 대기 문구: 사용자 설정이 auto mode라 `rm -rf ./build-probe`도 묻지 않고 돌았다. 권한 창이 뜨지 않았다.
- TaskCreated·TaskCompleted와 할 일 막대: 이 세션의 Claude가 "TaskCreate 도구는 이 세션에서 사용할 수 없다"고 하고 쓰지 않았다. 남은 시간 추정도 그래서 보지 못했다.
- 쓰기 범위 밖 쓰기 거절: 이 프로젝트의 쓰기 범위가 작업 복사본 전체다.
- async 관찰 훅은 지금 줄이 바뀌는 것으로만 봤다. 훅 하나하나가 비동기로 돌았는지는 따로 재지 않았다.
