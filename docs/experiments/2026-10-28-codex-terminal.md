# 실측: 로그인한 Codex CLI로 세션 터미널 열기와 문맥 % 원천

- 날짜: 2026-10-28
- 관련 이슈: [#978](https://github.com/dj258255/b-studio/issues/978)(문맥 % 원천 결정), 앞선 실측 [Claude로 desk 써 보기](2026-10-27-real-claude-desk.md)와 [#966](https://github.com/dj258255/b-studio/issues/966)
- 모델: 이 컴퓨터에 ChatGPT로 로그인한 codex-cli 0.160.1. 가설 없는 관찰이다

## 방법

- main 271e61a에서 진짜 스튜디오 서버(포트 3931, `B_STUDIO_TERMINAL=host`, 실험 기능 켬, 등록 목록·세션 폴더는 작업 폴더 안의 실측 폴더)를 띄웠다.
- README 하나만 있는 저장소를 코드·테스트만으로 등록하고(`test -f README.md`), desk의 새 요청과 같은 `POST /api/sessions`(`backend: codex`, `terminal: true`)로 "README.md 끝에 한 줄을 더해 줘"를 보냈다.
- 터미널 출력 통로는 `studio launch`가 연 창에서만 열리므로, Codex가 띄운 창은 같은 작업 복사본에서 codex를 PTY로 띄워 첫 화면만 읽었다. 키는 보내지 않았다.
- 문맥 % 원천은 `codex exec`를 짧게 돌려 세션 기록, 텔레메트리(로컬 수신기), `codex app-server generate-ts`의 타입을 봤다.

## 본 것

### 새 작업 복사본마다 폴더 신뢰 창에서 멈춘다

- 보내고 10초 뒤 응답: `terminal.pasted: true`, "요청을 CLI에 넘겼지만 10초 안에 실행이 시작되지 않았습니다".
- `/api/agents`의 그 항목: `state: dormant`, `terminal: { cli: 'down', waiting: 'input', message: '그 칸에서 폴더 신뢰 등 CLI 시작 창에 답하세요' }`. #966의 표시가 Codex에서도 그대로 맞는다. desk는 이 값으로 카드와 확인 필요 줄에 "입력 필요"를 그린다.
- 같은 작업 복사본에서 띄운 codex의 첫 화면:

```
  Folder access
  …/sessions/proj-72a8eec9
  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. …
› 1. Trust and continue
  2. Back to Agent Command Center
```

- 신뢰는 사람이 고를 일이라 답하지 않았다. 그래서 그 너머(훅의 session_id, 도구 시작 훅, 권한 대기, 턴 끝)는 이번에도 보지 못했다.
- Codex TUI가 처음 뜨며 `~/.codex/config.toml`에 `[tui] screen_reader_detection_done = true` 한 줄을 스스로 남겼다. 신뢰 기록은 없다.

### 신뢰하지 않은 훅은 말없이 건너뛴다

설정 덮어쓰기(`-c hooks.Stop=…` 등)로 훅을 걸고 `codex exec`를 돌렸더니 훅이 하나도 돌지 않았고 아무 말도 없었다. 감싸개의 주석대로 Codex는 훅 명령 글의 해시로 신뢰를 기억한다. 폴더를 신뢰한 뒤에도 훅을 검토하라는 창이 한 번 더 뜰 것으로 본다(확인하지 못함). 그 전에는 desk의 "지금 하는 일"이 Codex 세션에서 비어 있다. 감싸개가 직접 보내는 "CLI 떠 있음"(세션 시작·끝)과 텔레메트리는 훅 신뢰와 상관없다.

### 문맥 %의 원천

| 원천 | 입력 토큰 | 문맥 창 크기 | b-studio가 읽어도 되는가 |
|---|---|---|---|
| 텔레메트리 `codex.sse_event`(response.completed) | 있음(`input_token_count`, 이번 14,179) | 없음 | 된다. 관문이 이미 받는다 |
| 텔레메트리 `codex.conversation_starts` | 없음 | 없음 | 된다 |
| `codex app-server`의 `Model`, `Config` | 없음 | `Model`에 없음, `Config.model_context_window`는 사용자가 적었을 때만 | 된다 |
| 세션 기록 `token_count`(`$CODEX_HOME/sessions/…/rollout-*.jsonl`) | 있음(`last_token_usage`) | 있음(`model_context_window`, 이번 475,000) | 지금 경계로는 안 된다 |

세션 기록 첫 줄(`session_meta`)에 `cwd`가 있어 세션 작업 복사본으로 기록을 찾을 수 있다. 하지만 b-studio는 계정 설정 폴더 안의 파일을 읽지 않는다고 정해 두었고(`ai-accounts.ts`), 그 파일에는 대화 내용이 들어 있다. 그래서 구현하지 않고 [#978](https://github.com/dj258255/b-studio/issues/978)에 선택지를 적었다.

## 남은 것

- 사람이 Codex 칸에서 폴더 신뢰(와 훅 검토)를 고른 뒤: 훅 입력의 session_id와 기록 경로, 도구 시작 훅, 권한 대기 문구, 턴 끝, 카드의 지금 줄
- 문맥 %: [#978](https://github.com/dj258255/b-studio/issues/978)의 결정
