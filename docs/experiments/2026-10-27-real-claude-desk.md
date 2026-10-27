# 실측: 실제 Claude Code로 studio desk 써 보기

- 날짜: 2026-10-27
- 관련 이슈: 추적 [#820](https://github.com/dj258255/b-studio/issues/820)·[#834](https://github.com/dj258255/b-studio/issues/834)·[#876](https://github.com/dj258255/b-studio/issues/876)의 마지막 항목(실제 로그인한 CLI로 desk 실측), 고친 것 [#966](https://github.com/dj258255/b-studio/issues/966)·[#967](https://github.com/dj258255/b-studio/issues/967)
- 앞선 점검: 가짜 claude(진짜 훅 스크립트를 부르는 스크립트)로 한 실사용 점검 세 번([#947](https://github.com/dj258255/b-studio/issues/947))
- 모델: 이 컴퓨터에 로그인한 Claude Code 2.1.310 구독. 가설 없는 관찰이다

## 방법

- main 6392248에서 진짜 스튜디오 서버(포트 3921, `B_STUDIO_TERMINAL=host`, 실험 기능 켬)와 `studio desk`를 PTY(170×48)로 띄웠다. 화면은 `@xterm/headless`로 해석해 글로 찍었다.
- 프로젝트는 busybox:1.37 하나로 도는 작은 저장소(README 검사 하나)를 실측 폴더에 복사해 폴더 열기(`a`)로 등록했다. 스튜디오의 등록 목록·desk 설정·세션 폴더는 실측 폴더에 따로 두어 사용자의 것을 건드리지 않았다. 사용자 `~/.claude`는 읽기만 했다.
- 새 요청 칸에 "README.md 끝에 … 한 줄을 더해 줘"를 쓰고 규칙대로(Claude) 보냈다.

## 본 것

### 새 세션 폴더마다 폴더 신뢰 창에서 멈춘다

- 보내고 10초 뒤 desk 아래 줄: "세션을 열었지만 첫 요청을 넣지 못했습니다: 요청을 CLI에 넘겼지만 10초 안에 실행이 시작되지 않았습니다. CLI가 시작할 때 묻는 창(폴더 신뢰 등)이 떠 있으면 그 터미널에서 …". 170열에서도 끝이 잘려 무엇을 하라는지가 보이지 않았다. 요청은 넘겼으니 "넣지 못했습니다"도 틀린 말이다.
- 칸을 열어 보니 claude가 "Quick safety check: Is this a project you created or one you trust?" 창에서 기다렸다. 실측 폴더의 상위 폴더(`~/Desktop`)는 이미 신뢰한 폴더인데도 물었다. 세션 작업 복사본이 Git 저장소라 상위 신뢰가 이어지지 않는다(`terminal-lane.ts`에 2.1.302에서 잰 것과 같다).
- 그동안 카드는 "○ 꺼짐", `/api/agents`는 `state: dormant`, `terminal: { cli: 'down' }`만 줬다. 확인 필요 줄에도 올라오지 않았다. 사람이 그 칸에서 답해야 한다는 사실이 화면에 남지 않았다.
- 가짜 claude는 신뢰 창을 흉내 내지 않아 세 번의 점검에서 잡지 못했다.

고친 것(#966): 첫 요청을 CLI 실행 인자로 넘겨 연 터미널에서 8초가 지나도 CLI가 떴다는 훅이 오지 않으면 `terminal`에 `waiting: 'input'`과 안내 한 줄을 싣는다. CLI가 뜨거나 터미널이 닫히면 지운다. 처음 문구("CLI가 시작하며 묻는 창(폴더 신뢰 등)에 답을 기다립니다…")는 카드 한 줄에서 "답을…"까지만 보여 할 일 중심으로 줄였다. 고친 서버로 다시 보내 보니 같은 신뢰 창에서 다음이 보였다.

```
 확인 필요 1  숫자로 고르고 Enter로 그 칸에 열기
 › 1  shop · shop  입력 필요 · 그 칸에서 폴더 신뢰 등 CLI 시작 창에 답하세요
 ...
 │ shop   Claude  칸1                  ● 입력 필요 │
 │ › 그 칸에서 폴더 신뢰 등 CLI 시작 창에 답하세요 │
 알림: Claude · shop · 입력 필요
```

보낸 뒤 아래 줄 안내도 "Claude로 보냈습니다. CLI가 폴더 신뢰 같은 것을 물으면 그 칸에서 고르세요"로 바꿨다.

### 새 요청 칸에서 Ctrl-u가 먹지 않는다

폴더 열기 칸에서 쓰던 `Ctrl-u`로 요청 칸을 비우려 했는데 지워지지 않아 앞 글 뒤에 새 요청이 붙었다("wREADME.md 끝에 …"). `Ctrl-b n`이 프로젝트 고르기부터 열어 바로 친 글은 버려지고, 그 뒤 `Ctrl-b w`의 "w"가 요청 칸에 들어간 것이다. 고친 것(#967): 요청 칸에서도 `Ctrl-u`가 쓴 글을 모두 지운다. 고친 desk에서 같은 칸을 `Ctrl-u`로 비우고 다시 보냈다.

## 보지 못한 것과 까닭

신뢰 창에 답하는 것은 사용자의 보안 판단이라 b-studio도, 이 실측도 대신 답하지 않았다. 창 너머의 것은 모두 보지 못했다.

- async 관찰 훅과 TaskCreated·TaskCompleted 수용, PreToolUse·PostToolUse 짝, 서브에이전트 행
- 권한 대기 문구, 상태 줄의 문맥 %와 사용자 상태 줄(`~/.claude/statusline.sh`) 이어 부르기
- 카드의 지금 줄·N분째·남은 시간, 게이트 통과와 체크포인트, 끝 알림, 쓰기 범위 밖 쓰기 거절
- 라우팅 기록(Claude 쪽). Codex는 이 컴퓨터에 로그인돼 있지 않다

이어 하려면 사람이 desk에서 새 요청을 보내고, "입력 필요"가 뜬 칸에서 "Yes, I trust this folder"를 고르면 된다. 그 뒤 위 항목을 차례로 본다.
