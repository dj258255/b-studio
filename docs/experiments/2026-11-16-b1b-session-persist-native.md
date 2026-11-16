# 실측: 세션 저장을 Rust로 옮긴 뒤 실제 Claude Code 세션의 저장, studio 재시작 뒤 복구, 이어받기 (B1b)

- 날짜: 2026-11-16(09:55~10:00 KST)
- 관련: 이슈 #1253(추적 #1250), 브랜치 `feat/b1b-session-persist`, [ADR-203](../decisions.md)
- 모델: 이 컴퓨터에 로그인한 Claude Code CLI 2.1.325(Max 구독)
- 환경: macOS arm64, 로컬 Docker(Colima)
  - 이 브랜치의 worktree에서 `B_STUDIO_EXPERIMENTAL`·`B_STUDIO_TERMINAL`을 지운 셸로 `pnpm studio launch --mode local --port 3923`을 실행했다.
  - 세션 폴더는 실측 전용 `B_STUDIO_SESSIONS_DIR`이다. 이전 판들(2026-11-11~16, B1b 앞의 TS 저장)이 남긴 세션 18개가 들어 있었다.
  - 프로젝트는 `vf3`다(정적 웹 서비스 하나와 화면 확인 둘).
  - 하네스(`~/.cache/b-studio-ship/real4/h5/measure-b1b.mjs`)는 화면 없이 API만 부른다. 세션 만들기 → 메시지 → SSE 기록, 저장 파일 사본과 지문, 다시 띄운 뒤 목록·되감기를 저장 파일과 견준다.
- 한 번씩 잰 값이다.

## 무엇을 보려 했나

이 브랜치에서 세션 저장(500ms 모으기, 쓰기 줄, 원자적 쓰기, 종료 때 동기 쓰기, 읽기·형식 검사, 끝나지 못한 요청 닫기)이 Rust `Persister`로 옮겨졌다. history는 Rust 기록에서 파일에 바로 끼운다. 실제 세션에서 다음을 본다.

- 옛 판이 쓴 저장 파일을 새 판이 읽는가
- 새 판이 쓴 파일이 옛 파일 모양인가
- studio를 내렸다 다시 띄우면 세션과 기록이 돌아오는가
- 이어받기와 멈추기에서도 저장되는가

## 결과

- **옛 파일 읽기:** 띄우자마자 목록에 세션 18개가 모두 `stopped`로 나왔다. 로그에 "기록을 읽지 못해 복구하지 않았습니다"나 "저장하지 못했습니다"는 없었다.
- **실제 세션(`3ccfb0da`):** "README.md 끝에 \"B1b 실측: 저장과 복구 — 한글·emoji 🙂\" 한 줄을 더해 줘"
  - 결과는 `done`이었다.
  - 2초 뒤 저장 파일은 12,053바이트, history 35개였다. 키 순서는 `version,savedAt,owner,snapshot,history,conversation,demoIndex,claudeCode,codex,commandCode,openCode,gemini,sourceDirtyFiles,sandbox,previewToken,git`로, 옛 `toPersisted`와 같다.
  - 파일을 `JSON.parse`한 뒤 `JSON.stringify`한 글자가 파일과 바이트까지 같았다. 옛 저장은 `JSON.stringify(toPersisted(session))`이므로, 옛 구현이 같은 상태로 쓸 글자와 모양이 같다는 뜻이다. 바이트 동일은 차등 시험(무작위 60개 시드)이 직접 확인한다.
- **종료 때 동기 저장(`pnpm studio stop`):** 내리기 전과 후에 파일을 견줬다.
  - 신호 처리의 `flushSync`가 파일을 다시 썼다(12,035바이트, history 같음).
  - 세션 폴더에 `.tmp` 파일은 남지 않았다.
- **다시 띄운 뒤 복구**
  - 목록 19개에 이 세션이 `stopped`로 있었다. 마지막 요청 글자(한글·emoji)가 그대로였다.
  - SSE 되감기 이벤트 35개가 저장 파일의 history와 글자까지 같았다. 종류는 `run_started` 1, `agent` 29, `notice` 1, `boot_network` 1, `tokens` 1, `checkpoint` 1, `run_finished` 1이다.
  - 처음 스냅샷의 오류는 "스튜디오 서버가 다시 시작돼 이전 샌드박스를 정리하는 중입니다."였다. 정리가 끝난 뒤 보관 세션 저장(`writeStoredSession`, 기록 전체)이 파일을 다시 썼다(주인 PID가 새 프로세스로 바뀌었다).
- **이어받기 → 멈추기**
  - `POST /api/sessions/:id/resume` 뒤 `ready`가 됐다. 파일은 새로 써졌다(12,104바이트).
  - `DELETE /api/sessions/:id`(멈추기)는 `stopped`를 돌려줬다. 파일은 `status: stopped`, history 37개이고 끝이 `…, checkpoint, run_finished, boot_network, resumed`였다. `.tmp`는 남지 않았다.
- **옛 읽기와 새 읽기 대조:** 이 브랜치의 시험 코드로 같은 세션 폴더를 견줬다.
  - 옛 TS 읽기(`legacyReadSessions`)와 새 Rust 읽기(`readSessions`)가 둘 다 19개를 읽었다. 새 판이 쓴 파일 하나도 들어 있다.
  - history 합계는 1,342개였다. 세션마다 history와 나머지 상태가 같았다.
  - 한 번 다르게 나왔는데, 시험용 호환 함수 `readSessions`가 history를 객체 끝에 붙여 키 순서가 달랐기 때문이다. 이 함수는 시험에서만 쓴다. 복구는 history를 객체로 풀지 않는 `readStoredSessions`를 쓴다.

## 보지 못한 것

- B1b가 쓴 파일을 옛 판(main) studio로 다시 띄워 읽는 것은 하지 않았다. 대신 위의 옛 TS 읽기 대조와, 새 파일이 `JSON.stringify(JSON.parse(파일))`와 같다는 확인으로 갈음했다.
- 쓰기 실패(디스크 가득, 권한)와 동시에 여러 세션이 저장되는 부하는 실제 환경에서 만들지 않았다(시험으로만 확인).
- 이어받은 세션에 새 요청을 보내 CLI 대화가 이어지는지는 이번에 보지 않았다(저장과 무관한 러너 동작).
