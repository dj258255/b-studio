# 실측: Rust 앞단(ADR-195 4a·4c)으로 실제 Claude Code 세션 돌려 보기

- 날짜: 2026-11-11
- 관련 이슈: [#1149](https://github.com/dj258255/b-studio/issues/1149)(4a), [#1151](https://github.com/dj258255/b-studio/issues/1151)(4c), [#992](https://github.com/dj258255/b-studio/issues/992), 새로 연 것 [#1155](https://github.com/dj258255/b-studio/issues/1155)
- 관련: PR #1150(4a), #1152(4c), #992 수정(main a7997cc)
- 모델: 이 컴퓨터에 로그인한 Claude Code 2.1.322(Claude Max), 규칙표는 기본값 하나(claude-code, sonnet). 가설 없는 관찰이다
- 비용: 4a 세션 $0.184, 4c 세션 $0.228(스튜디오가 센 값)

## 방법
- b-studio-run을 origin/feat/4a-server-front(7d146e4), origin/feat/4c-auth-front(b72ca7a)로 옮겨 `pnpm studio launch --mode local --port 3921`. 환경: B_STUDIO_TERMINAL=host, B_STUDIO_EXPERIMENTAL=1, 등록 목록·세션 폴더·규칙표·기록은 ~/.cache/b-studio/real3.
- studio desk를 PTY(170x48)로 띄우고 @xterm/headless로 화면을 글로 찍었다. 폴더 열기(a) -> 새 요청(n) -> 신뢰 창(실측 세션 폴더만 확인 후 "Yes, I trust this folder") -> 게이트.
- 프로젝트: busybox:1.37 하나(httpd가 /work를 내줌, 검사 `grep -q shop /work/README.md` 절대 경로, 보호 경로 compose.yaml·studio.yaml).

## 앞단 확인(두 회차 같음)
- ps: bstudio-server(PID 부모 1) -> pnpm exec tsx -> node, 인자에 `--socket ~/.cache/b-studio/launch/run/studio-<pid>.sock`.
- lsof -iTCP:3921: bstudio-server만 LISTEN. 소켓 폴더 `run`은 drwx------(0700), 소켓 파일은 srwxr-xr-x.
- /api/health: `{"status":"ok","app":"b-studio","terminal":true,"apiVersion":1}` 200. launch 약 15초(앞단 빌드가 이미 되어 있었음).
- launch 로그(~/.cache/b-studio/launch/studio.log, 이어 쓰는 파일)의 이번 구간: "b-studio 서버가 소켓에서 듣습니다 / 떴습니다" 두 줄뿐. "[b-studio 앞단]" 줄·502·오류 0건. 앞단은 오류일 때만 그 줄을 찍는다(코드 확인). Node 쪽은 이번에 요청 로그를 찍지 않았다.

## 세션 흐름
### 4a
- 17:46:12 요청 -> 칸 "입력 필요"(폴더 신뢰 안내가 /api/agents terminal에 실림) -> 17:46:50쯤 신뢰 선택 -> cli up 17:46:54 -> booting -> working -> gate verifying(17:47:08) -> idle·gate passed·체크포인트 1(17:47:21). 신뢰 뒤 약 31초.
- 체크포인트 82ee812(세션 git: README.md만 바뀜). Stop 훅 "[b-studio] 검증 통과 — 체크포인트 82ee812". 카드: 준비 중 -> 작업 중·검증 중 -> 검증 통과.
- 비용 $0.184, 라우팅 통계 claude-sonnet-5-5 1회 통과, 중앙 소요 27.0초.
### 4c
- 요청 17:50쯤 -> 신뢰 선택 17:51:22 -> working 17:51:33 -> verifying 17:51:40 -> (아래 #992) -> 최종 idle·passed·체크포인트 1 17:51:59. 체크포인트 257b086. 비용 $0.228, 중앙 소요 35.5초.

## SSE
- desk 카드 상태 변화는 모두 앞단을 거쳐 갱신됐다(준비 중 -> 작업 중 -> 검증 중 -> 검증 통과).
- 별도 curl로 /api/agents/stream(쿠키 b_studio_local)을 앞단 통해 열어 40초(4a)·35초(4c) 잼: 처음 `data: {"type":"full",...}` 한 번, 그 뒤 15초마다 `: ping`. 끊김 없음. 세션이 움직이는 동안의 curl 스트림은 따로 재지 않았다(desk 화면 갱신으로만 확인).

## 인증 판단(4c 회차 값, 4a 회차도 같은 상태 코드)
| 요청 | 결과 |
|---|---|
| GET /api/agents, Host: evil.example | 403 `{"error":"인증 없이 띄운 스튜디오는 이 컴퓨터의 주소(127.0.0.1 · localhost)로 온 요청만 받습니다. …"}` |
| Host: 127.0.0.1:3921 / localhost:3921 / [::1]:3921 | 200 / 200 / 200 |
| POST /api/sessions, Origin: http://evil.example | 403 `{"error":"다른 출처에서 보낸 요청은 받지 않습니다"}` |
| POST /api/sessions, Origin: http://127.0.0.1:3921, 본문 {} | 400(검사 통과 후 본문 오류) |
- 4a(앞단은 그대로 넘기기만 함)에서도 403·200·403이었다. 4a의 403 본문은 적어 두지 않았다. 이 요청들이 Node에 닿았는지는 로그로 확인할 수 없었다(Node가 요청 로그를 안 찍고 앞단은 오류만 찍음). 앞단이 직접 답했다는 것은 이번 실측으로 증명하지 못했다.

## #992 수정(4c 회차 같은 세션)
요청: "compose.yaml 맨 위에 주석 한 줄(# probe)을 Edit 도구로 먼저 더하고, 게이트가 보호 경로라며 막으면 compose.yaml을 Edit 도구로 원래 내용 그대로 되돌린 뒤, README.md 끝에도 shop 문장 한 줄을 더해 줘".
- Claude가 Edit로 compose.yaml에 `# probe`를 더하고 README에 한 줄을 더했다. 쓰기 직전 관문은 막지 않았다(쓰기 범위 전체).
- 첫 Stop 훅 게이트: "워크플로 검사 실패: [review] protected-paths (시도 1회) 보호 경로가 바뀌었습니다 … compose.yaml". 에이전트는 막히기 전 "막히지 않았다"고 말했다가 훅 뒤 정정했다.
- 되돌린 도구: Edit(`# probe` 줄 제거). 다음 게이트 통과, Stop says "[b-studio] 검증 통과 — 체크포인트 257b086".
- 세션 git: compose.yaml은 원본과 `cmp` 바이트 동일, 변경 파일은 README.md 1개(+1줄), 커밋 257b086 하나. README 변경 남음. -> 수정 의도대로 동작.
- 시도는 2번째에 통과(세 번째 실패로 되돌려지는 경로는 보지 않음). "바뀐 파일은 없었습니다" 문구는 실패로 끝나 되돌려질 때만 보이므로 이번엔 보지 못했다.
- 본 것 1(결함 후보, [#1155](https://github.com/dj258255/b-studio/issues/1155)): Stop 훅 오류 본문이 "검증 통과 - 샌드박스 파일 반영 확인 … - web: 재시작 후 준비 완료" 다음에 "워크플로 검사 실패"를 이어 써, 맨 앞줄이 "검증 통과"다(2차 기록 #989와 같은 꼴의 문구). 에이전트용 본문이라 화면 카드는 아니다.
- 본 것 2(결함 후보, [#1155](https://github.com/dj258255/b-studio/issues/1155)): /api/agents 폴링에서 17:51:52 `gate: passed, checkpoints 0` 다음 1초 뒤 17:51:53 `failed`로 바뀌었다(첫 게이트 결과 직후 한 번 passed가 1초 보임). 17:51:58 verifying -> 17:51:59 passed·체크포인트 1. 앞단 때문인지 개요 판정(#989 관련)인지는 가르지 못했다. 앞단 없이 재현하는 비교는 하지 않았다.
- 칸 아래에 "게이트 다시 돌려 봐"가 입력줄에 보였다. 내가 보낸 글이 아니고 Claude 입력 제안 문구로 보인다(확인하지 않음).

## 보지 못한 것
- 앞단 없는 main과의 시간 비교, 부하 상황, 여러 세션·여러 칸 동시, 앞단이 502를 내는 장애(Node 죽이기)·재시작, 세션 중 SSE 스트림을 curl로 따로 연 것, 세 번 실패해 되돌려지는 #992 경로, 인증 켠 모드(none 모드만).

## 정리

실측 studio·desk·세션 컨테이너는 끝에 모두 멈췄다. 사용자 `~/.claude`는 읽기만 했고, 폴더 신뢰 기록은 범수 님 허락을 받아 실측 세션 폴더 둘에만 남겼다. 하네스와 원자료는 저장소 밖(`~/.cache/b-studio-ship/real3`, `~/.cache/b-studio/real3`)에 있다.
