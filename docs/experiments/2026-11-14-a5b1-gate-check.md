# 실측: 게이트 check의 상태 기계를 Rust로 옮긴 뒤 실제 Claude Code 세션으로 돌려 보기 (ADR-195 4f A5b-1)

- 날짜: 2026-11-14
- 관련: 이슈 #1199, 브랜치 `feat/4f-a5b1-gate-check`
- 모델: 이 컴퓨터에 로그인한 Claude Code(Claude Max). 규칙표는 기본값 하나(claude-code, sonnet)
- 환경: macOS, 로컬 Docker(Colima). 이 브랜치의 worktree에서 `pnpm studio launch --mode local --port 3923`(`B_STUDIO_TERMINAL=host`, `B_STUDIO_EXPERIMENTAL=1`, 등록 목록·세션 폴더는 실측 전용 폴더). desk를 PTY(170x48)로 띄우고 `@xterm/headless`로 화면을 글로 찍었다. 세션 상태는 1초마다 `/api/agents`로 기록했다
- 모두 한 번 잰 값이다

## 무엇을 보려 했나

이 브랜치의 `VerificationGate.#check()`는 `native.gateCheckRun`(Rust `crates/bstudio-io/src/gate_check.rs`)만 부른다. 실제 세션의 게이트가 그 경로로 통과, 바뀐 파일 0개, 시도 소진 세 갈래를 옛 동작대로 내는지 본다.

## 프로젝트

A5a 실측과 같은 프로젝트다. busybox:1.37 httpd 하나(`/work`를 내줌). `studio.yaml`에 준비 경로 `/README.md`(30초), 계약 `contract: { extract: /openapi.json }`, 검사 `grep -q shop /work/README.md`. `openapi.json`은 `Order { id, total }` 하나를 가진 OpenAPI 3.0.3 문서다.

## 결과

desk에서 폴더를 열고 한 세션(`36bbc668`)에 요청 셋을 차례로 보냈다. 폴더 신뢰는 실측 세션 폴더에만 했다.

1. **통과.** "README.md 끝에 \"shop 게이트 실측 1\" 한 줄을 Edit 도구로 더해 줘". 상태는 working → verifying → passed → idle·체크포인트 1로 흘렀다. 체크포인트 `4a9b479`의 커밋에 실린 보고서: `샌드박스 파일 반영 확인: 0.2초`, `web: 재시작 후 준비 완료`, `web 계약: 계약 변경 없음`, `게이트가 확인함: [test] readme-has-shop(통과)`, 끝 줄 `Workflow-Passed: run, contract_check, test, review`. 단계별 통과 집계가 네 단계 모두 들어갔다.
2. **바뀐 파일 0개.** "README.md가 몇 줄인지 읽어서 알려 줘. 파일은 하나도 바꾸지 마." Claude가 "README.md는 4줄입니다"로 답했다. 상태는 working → idle이었고 게이트 상태는 `none`, 체크포인트는 1 그대로, 세션 git도 그대로(`4a9b479`, `026cdc4`)였다. 바뀐 파일 0개 분기에서 기록 검사가 통과해 검증 없이 지나갔다(verifying이 한 번도 찍히지 않았다).
3. **시도 소진.** "openapi.json의 Order 스키마에서 id 속성을 Edit 도구로 지워 줘. 게이트가 막으면 되돌리지 말고 막힌 이유를 짧게 알리고 멈춰." 게이트가 `검증 실패 ⚠️ 호환 깨짐 property-removed Order.id`와 #1200에서 고친 안내("이 요청은 호환을 깨는 변경을 허용하지 않았습니다(허용은 사람이 요청할 때 켭니다)…")로 막았다. Claude는 두 번 모두 되돌리지 않고 막힌 이유를 알렸고, 세 번째에 `[b-studio] 검증 게이트를 3번 통과하지 못했습니다 바뀐 파일 1개를 되돌렸습니다(대화 탭에서 되살릴 수 있습니다).`가 나왔다. 요청에서 소진까지 약 40초(12:23:49 → 12:24:29). 끝난 뒤 `openapi.json`에 `id`가 돌아와 있었고 세션 작업 트리는 깨끗했다. 세션 상태는 idle, 게이트 `failed`, 끝난 이유 `gate_failed`, 체크포인트는 1 그대로였다.

## 본 것

- 3번의 1초 간격 상태 기록에는 verifying → failed가 두 번만 찍혔다. 화면의 소진 문구가 "3번"이고 앞의 두 실패 안내가 화면에 남아 있어 세 번 돌았다. 세 번째 시도가 1초 안에 끝나 기록 사이에 빠진 것으로 본다(기록 간격의 한계이며 따로 재지 않았다).
- 실측 도중 desk 입력줄에 Claude가 다음 요청 제안("README.md 마지막 줄 지워 줘")을 띄웠다. 보내지 않았다.

## 보지 못한 것

- 남은 프로세스 처리, 새 부가 서비스 경고, 플랫폼 실패 뒤 다시 하기, `light` 분기, 다시 견줌(TOCTOU)이 결과를 실패로 바꾸는 경우, 부하 플랫폼 실패, 필수 단계 누락, 사람 확인 기록 사유, 선언 변경 안내, 취소는 실제로 재지 않았다(차등 시험 44개와 Rust 단위 시험으로만).
- 선언한 검사 실행(`#runDeclaredChecks`)은 이 조각에서 TS 콜백으로 남겼다(A5b-2에서 옮김). 1번의 `[test]` 통과는 그 콜백 경로다.
- 다른 러너(codex 등)와 Kubernetes 제공자는 재지 않았다.

## 정리

실측 세션은 `DELETE /api/sessions/36bbc668`로 샌드박스를 멈췄고, 컨테이너·네트워크·볼륨이 남지 않은 것을 `docker ps`·`network ls`·`volume ls`로 확인했다. desk 하네스·상태 기록기와 스튜디오(PID 11492)도 멈췄다. 다른 프로젝트의 컨테이너는 건드리지 않았다. 하네스와 원자료(화면·상태 기록·세션 git 기록)는 저장소 밖(`~/.cache/b-studio-ship/real4/h5`의 `a5b1-*`)에 있다.
