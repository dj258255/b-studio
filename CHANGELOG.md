# 변경 기록

이 문서는 사용자가 알아볼 변경을 날짜 순으로 적습니다. [Keep a Changelog](https://keepachangelog.com/) 형식을 따르되, 아직 릴리스 버전이 없어 날짜(KST, UTC+9)로 묶습니다. 2026-09-24 이전 항목은 PR·커밋 기록으로 나중에 재구성한 것입니다. `docs:`, `chore:`처럼 사용자 동작에 영향이 없는 커밋은 `### 문서`로 모으거나 생략했습니다. PR로 병합된 변경은 끝에 `(#번호)`를, PR 없이 main에 직접 들어간 커밋은 끝에 짧은 해시를 붙였습니다. 병합 커밋 제목에 `(#번호)`가 없던 과거 PR도 병합 커밋 해시 대응으로 PR 번호를 되찾아 적었습니다.

## 아직 릴리스하지 않음

### 추가

- 세션마다 백엔드(api·Claude Code·Codex·Command Code)를 고르고, 작업 분해의 고정 계획에서 레인마다 다른 백엔드로 한 계획을 돌립니다(`B_STUDIO_BACKENDS`, 기본은 서버 모드 하나). 세션을 이어서 할 때도 지금 서버의 허용 목록을 확인합니다 ([#145](https://github.com/dj258255/b-studio/pull/145)).
- 게이트가 이번 실행에서 바뀐 Next.js 페이지를 찾아 열어 보는 `workflow.autoPageChecks`를 추가했습니다(기본 끔). 상태가 200이어도 Next.js 오류 화면 문구가 보이면 실패로 봅니다 ([#142](https://github.com/dj258255/b-studio/pull/142)).
- 화면 확인에 모두 있어야 통과하는 `expectAllText`를 추가했습니다 ([#144](https://github.com/dj258255/b-studio/pull/144)).
- 샌드박스 이미지만 캐시 없이 빌드하는 `B_STUDIO_SANDBOX_BUILD_NO_CACHE`와 기동 시간·수신 바이트를 재는 `pnpm studio boot-probe`를 추가했습니다. 캐시 측정 절차에서 다른 프로젝트 캐시까지 지우는 `docker builder prune`을 뺐습니다 ([#146](https://github.com/dj258255/b-studio/pull/146)).
- Command Code 백엔드를 추가했습니다. 로그인된 Command Code CLI를 b-studio 도구만 쓰게 제한해 돌리고, 세션마다 모델을 고릅니다. 실제 계정 실행에서 찾은 "다음 실행에서 세션을 이어받지 못함"을 세션별 고정 상태 폴더로 고쳤습니다 ([#61](https://github.com/dj258255/b-studio/pull/61), 트러블슈팅 47).
- 싼 모델로 시작하고 게이트가 같은 실패 서명을 두 번 내면 비싼 모델로 올리는 승격을 추가했습니다(기본 끔). 모델별 사용량(`metrics.usageByModel`)을 남기고, 벤치 `--prices`로 모델별 단가를 곱합니다 ([#98](https://github.com/dj258255/b-studio/pull/98), ADR-060).
- 토큰 탭에 모델별 사용량과 모델별 단가(`B_STUDIO_TOKEN_PRICES_JSON`)로 환산한 비용, 승격 줄을 보이고, 작업 분해 계획 카드에 토큰 합계를 더했습니다 ([#134](https://github.com/dj258255/b-studio/pull/134)).
- 작업 분해 때 계획 모델이 레인 사이 계약을 직접 쓰고 S2로 먼저 게시합니다(`B_STUDIO_PLAN_CONTRACTS=on`, 기본 끔). 벤치는 `--contracts model`로 같은 함수를 씁니다 ([#129](https://github.com/dj258255/b-studio/pull/129)).
- 게이트의 화면 확인에 `expectFromApi`(api 응답 값이 화면에 있는지)와 `expectAnyText`를 더하고, 작업 분해의 통합 게이트에만 확인을 덧붙일 수 있게 했습니다. 벤치는 `--integration-checks` ([#130](https://github.com/dj258255/b-studio/pull/130)).
- 승인한 작업 계획을 추적 이슈·하위 이슈로 올리고, 통합 PR이 하위 이슈를 닫습니다. 로컬 Gitea에서 실제 함수로 이슈 생성과 PR 병합 시 닫힘을 확인했습니다 ([#68](https://github.com/dj258255/b-studio/pull/68)).
- PR을 만들기 전에 이슈 연결과 누락된 검증 단계를 미리 보여 줍니다 ([#60](https://github.com/dj258255/b-studio/pull/60), ADR-061).
- 작업 분해 계획 카드에 관계 그래프 보기를 추가했습니다. 레인·작업 의존·게시판 메모(계약·실패·사실)·통합을 한 그림으로 보고, 노드와 메모를 눌러 상세를 봅니다 ([#122](https://github.com/dj258255/b-studio/pull/122)).
- 요청이 모호하면 에이전트가 `ask_user`로 선택지를 내고 멈추며(`awaiting_input`), 답을 누르면 같은 세션이 이어서 만듭니다 ([#99](https://github.com/dj258255/b-studio/pull/99), ADR-056).
- 에이전트가 일하는 도중 보낸 지시를 다음 모델 호출 직전에 끼워 넣습니다. 도구 호출 도중에는 끼어들지 않습니다 ([#108](https://github.com/dj258255/b-studio/pull/108), ADR-057).
- 관제 화면(`/agents`)에서 세션·작업 분해 레인·플릿 구성원을 한곳에 모으고, 질문 > 승인 > 게이트 실패 > 오류 > 예산 순으로 개입이 필요한 것부터 보여 줍니다 ([#107](https://github.com/dj258255/b-studio/pull/107)).
- 개입이 필요한 에이전트가 새로 생기면 탭 제목에 (N)을 붙이고, 켜 두었으면 브라우저 알림을 띄웁니다 ([#117](https://github.com/dj258255/b-studio/pull/117)).
- 세션 2~4개를 한 화면(`/split`)에 나란히 띄우고 칸마다 요청·진행 중 지시·질문 답을 보냅니다 ([#106](https://github.com/dj258255/b-studio/pull/106)).
- 도구 결과에 예산을 두었습니다(명령 출력 6,000자·HTML은 보이는 글자 4,000자·파일 읽기 12,000자, 완전히 같은 반복 결과는 한 줄로). 턴별 토큰과 큰 도구 결과를 스튜디오 "토큰" 탭에서 봅니다 ([#96](https://github.com/dj258255/b-studio/pull/96), ADR-055).
- API 루프에서 컨텍스트가 커지면 오래된 도구 결과를 한 번에 묶어 비웁니다. 프롬프트 캐시를 덜 깨려고 조금씩이 아니라 묶어서 비우며, 기본은 꺼져 있습니다(`B_STUDIO_CONTEXT_CLEARING=on`) ([#120](https://github.com/dj258255/b-studio/pull/120)).
- 게이트에 동시 요청 확인(`workflow.concurrencyChecks`)과 화면 로드 시간 예산(`pageChecks[].maxLoadMs`)을 넣고, 에이전트 프롬프트에 테스트 작성 기준을 두었습니다 ([#119](https://github.com/dj258255/b-studio/pull/119), ADR-058).
- 샌드박스 기동 중 서비스별로 받은·보낸 네트워크 바이트를 기록하고 리소스 탭과 기록 탭에 보입니다 ([#105](https://github.com/dj258255/b-studio/pull/105)).
- 협업 벤치에 기준선 P0(b-studio 없이 Claude Code만, 파일 도구만)를 추가하고, 모든 전략에 "성공 1건당 토큰" 열을 더했습니다 ([#93](https://github.com/dj258255/b-studio/pull/93)).
- 작업 분해에 레인 간 조율 게시판과 전략 S2(계약 먼저)·S3(게시판)·S4(통합 후 수리)·S5(실패 서명)를 추가했습니다. 크기·쓰기·읽기 예산과 topology(star·hierarchical·mesh)가 있고, 기본은 공유 없음입니다. 실험 E2에서 계약을 먼저 게시한 S2가 엮인 과제 9/9를 성공했습니다([#76](https://github.com/dj258255/b-studio/pull/76), ADR-059).
- 미리보기에 원격 브라우저·QA 보기를 추가했습니다. 게이트의 화면 확인을 실시간 프레임과 단계 스크린샷으로 보고, 서버 소유 브라우저를 조작하며, 고른 요소를 요청에 첨부합니다. Figma 프레임을 세션으로 가져와 실제 화면과 픽셀 차이 비율로 비교합니다 ([#81](https://github.com/dj258255/b-studio/pull/81)).
- 착수 명세·버그·실험 이슈 양식 3종과 PR 템플릿을 추가했습니다 ([#46](https://github.com/dj258255/b-studio/pull/46)).
- 프로젝트 로드맵(`ROADMAP.md`)과 변경 기록(`CHANGELOG.md`)을 추가했습니다 ([#46](https://github.com/dj258255/b-studio/pull/46)).
- ADR 양식(`docs/templates/adr.md`)과 실험 보고서 양식(`docs/templates/experiment-report.md`)을 추가했습니다 ([#46](https://github.com/dj258255/b-studio/pull/46)).
- 실행마다 모델 호출 수, 호출당 최대 컨텍스트, 모델·도구·게이트 시간을 남기고, 작업 계획에 계획 호출·레인·통합의 기동 시간과 전체 합계를 기록합니다 ([#49](https://github.com/dj258255/b-studio/pull/49)).
- 작업 분해에 서버 내부에서만 넘기는 고정 계획 입력을 추가했습니다. HTTP로는 받지 않고 사람 승인은 그대로입니다. 고정 계획이면 로컬 CLI 모드에서도 작업 분해를 돌립니다 ([#49](https://github.com/dj258255/b-studio/pull/49)).
- 작업 분해의 직렬화와 격리 병렬을 같은 과제로 반복 실행해 비교하는 `pnpm bench:coordination`을 추가했습니다 ([#49](https://github.com/dj258255/b-studio/pull/49)).
- 본인 PC에 로그인된 ChatGPT 구독 CLI로 에이전트를 돌리는 백엔드를 추가했습니다. 모델은 루프백 MCP 서버의 b-studio 도구만 쓰고, 셸 도구는 끄며, 실행마다 빈 작업 폴더와 격리된 설정 폴더를 씁니다. 스튜디오·CLI·벤치에서 고를 수 있습니다 ([#51](https://github.com/dj258255/b-studio/pull/51)).

### 변경

- `CONTRIBUTING.md`에 작업 흐름·예상 갱신·실험·측정 용어 절을 더하고, PR 체크리스트를 PR 템플릿으로 옮겼습니다 ([#46](https://github.com/dj258255/b-studio/pull/46)).
- 로컬 CLI 모드에서 쓸 모델을 환경 변수로 고정할 수 있습니다(`docs/operations.md`) ([#49](https://github.com/dj258255/b-studio/pull/49)).

### 수정

- 레인별 백엔드(#145) 뒤로 데모 모드 스튜디오에서 세션을 하나도 만들 수 없던 문제를 고쳤습니다. PR 미리보기 화면 흐름을 로컬 Gitea로 끝까지 확인하다 발견했습니다 ([#150](https://github.com/dj258255/b-studio/pull/150)).
- 벤치가 S4의 통합 후 수리를 행과 요약에 기록하지 않던 문제와, 통합 확인이 인수 검사보다 약하던(샘플 값 하나만 보던) 문제를 고쳤습니다 ([#144](https://github.com/dj258255/b-studio/pull/144)).
- 토큰 탭 모델별 표에 토큰을 쓰지 않은 가짜 모델이 "단가 없음"으로 보이던 문제를 고쳤습니다 ([#141](https://github.com/dj258255/b-studio/pull/141)).
- 벤치의 P0가 고친 프로젝트 복사본을 되돌리지 않아, 뒤따르는 전략이 이미 구현된 상태에서 시작하던 문제를 고쳤습니다 ([#132](https://github.com/dj258255/b-studio/pull/132), 트러블슈팅 46).
- 토큰을 쓰지 않은 가짜 모델 때문에 모델별 비용 계산 전체가 "단가 없음"이 되던 문제를 고쳤습니다 ([#135](https://github.com/dj258255/b-studio/pull/135)).
- 같은 세션 파일에 저장이 겹치면 임시 파일 이름이 부딪혀 저장이 통째로 사라지던 문제를 고쳤습니다. 동시 쓰기·부하 스모크·두 세션 동시 기동을 테스트로 고정했습니다 ([#118](https://github.com/dj258255/b-studio/pull/118), 트러블슈팅 44).
- Spring Boot 이미지(예제와 템플릿)가 테스트 의존성까지 미리 굽고 Maven Central을 Google 공식 미러에서 먼저 받습니다. 실험을 여러 번 돌리면 요청 한도(429)에 걸려 api 테스트가 실패하던 문제입니다 ([#121](https://github.com/dj258255/b-studio/pull/121), 트러블슈팅 45).
- ChatGPT 구독 러너가 ESM 전용 SDK를 정적으로 불러와, tsx로 도는 협업 벤치가 시작하지 못하던 문제를 고쳤습니다. SDK는 첫 실행 때 불러옵니다 ([#86](https://github.com/dj258255/b-studio/pull/86)).
- 게이트의 화면 확인도 세션 서비스 출처 밖 요청을 막고 service worker를 차단합니다 ([#81](https://github.com/dj258255/b-studio/pull/81)).
- 협업 벤치의 `meta.json`이 커밋을 끝날 때 읽어, 실행 중 main이 바뀌면 다른 커밋을 적던 문제를 고쳤습니다. 시작할 때 읽고, 끝날 때 다르면 `gitCommitAtEnd`를 함께 적습니다.
- 격리 샌드박스의 Node 서비스가 edge 프록시를 쓰도록 `NODE_USE_ENV_PROXY=1`을 넘깁니다 ([#71](https://github.com/dj258255/b-studio/pull/71), 이슈 [#69](https://github.com/dj258255/b-studio/issues/69)).
- 예제 api 컨테이너의 메모리 한도를 1536m에서 2048m으로 올려, 개발 서버 옆에서 테스트를 돌릴 때 OOM으로 실패하지 않게 합니다 ([#71](https://github.com/dj258255/b-studio/pull/71), 이슈 [#70](https://github.com/dj258255/b-studio/issues/70)).
- 부하가 걸리면 가끔 시간 초과로 실패하던 문법 강조 전체 로딩 테스트에만 30초 제한을 따로 줬습니다 ([#78](https://github.com/dj258255/b-studio/pull/78)).

### 문서

- 실험 E4 보고서를 추가했습니다. 통합 게이트가 실패를 보자 S4 수리가 4회 시작됐고(3회 성공), Haiku로 시작한 승격은 4회 일어났지만 1/9로 Sonnet만(8/9)보다 나빴습니다. 계획 모델이 쓴 계약으로 S2는 9/9였습니다. ADR-059·ADR-060에 측정 절을, README에 실험 결과 절을 더했습니다.
- 실험 E3 보고서를 추가했습니다. 같은 과제에서 그냥 Claude Code(P0)는 9/9 성공에 토큰이 b-studio S0의 절반이었고, 도구 결과 예산은 S0의 캐시 읽기를 E1보다 34% 줄였습니다. Haiku로 시작한 승격 조건은 승격이 한 번도 일어나지 않았습니다(게이트가 실패를 보지 못함). ADR-055·ADR-060에 측정 절을 더했습니다.
- 여러 에이전트를 한곳에서 관리하는 해외 도구(관제·나란히 보기·실행 중 지시)와, 테스트 품질·부하·동시성을 빅테크가 어떻게 재는지 조사한 문서를 추가했습니다(`docs/research/2026-09-29-*`) ([#107](https://github.com/dj258255/b-studio/pull/107), [#119](https://github.com/dj258255/b-studio/pull/119)).
- 로드맵에 M10~M12 마일스톤과 최근 병합을 반영했습니다 ([#92](https://github.com/dj258255/b-studio/pull/92)).
- 실험 E2 보고서를 추가했습니다. 계약을 공유한 전략(S2+S3) 17/18 대 공유하지 않은 전략(S1+S4) 9/18(p = 0.007)이었고, 모든 실패가 레인 경계의 계약 불일치였습니다([#76](https://github.com/dj258255/b-studio/pull/76)).
- 실험 E1 보고서를 추가했습니다. 인터페이스로 엮인 과제에서 격리 병렬은 9회 중 4회, 직렬화는 9회 모두 성공했고, 실패 5건은 모두 통합 게이트를 통과했습니다. ADR-051에 보강 절을 더했습니다.
- PR 본문에 이슈를 닫는 키워드와 필수 절이 있는지 검사하는 `pr-body` 워크플로를 추가하고, 추적 이슈·하위 이슈 규칙을 CONTRIBUTING에 적었습니다. 문서의 이슈·PR·커밋 번호를 링크로 바꿨습니다 ([#59](https://github.com/dj258255/b-studio/pull/59)).
- 에이전트 간 지식 공유와 작업 중 모델 교체를 결정 전에 검토한 문서를 추가했습니다 ([#50](https://github.com/dj258255/b-studio/pull/50)).
- `README.md`, `docs/README.md`, Wiki 개발 페이지의 문서 안내를 로드맵·변경 기록·문서 양식에 연결했습니다 ([#46](https://github.com/dj258255/b-studio/pull/46)).

## 2026-09-24

### 변경

- 스튜디오 화면의 흔한 화면 문법을 모서리·그림자 토큰으로 정리했습니다 ([#40](https://github.com/dj258255/b-studio/pull/40)).

## 2026-09-18

### 문서

- README에 일정과 작업 방식 절을 추가했습니다 ([#41](https://github.com/dj258255/b-studio/pull/41)).

## 2026-09-16

### 추가

- 검증 게이트가 워크플로 단계를 강제하고, 스튜디오가 워크플로 검사 결과를 보여 주며 릴리스 단계가 빠진 배포를 막습니다 ([cdac5c6](https://github.com/dj258255/b-studio/commit/cdac5c6), [76e7b99](https://github.com/dj258255/b-studio/commit/76e7b99)).
- 작업 분해: 계획을 사람이 승인해야 레인을 실행하고 ([7122c82](https://github.com/dj258255/b-studio/commit/7122c82)), 독립 레인을 병렬로 돌린 뒤 통합 결과를 같은 게이트로 재검증합니다 ([67ca206](https://github.com/dj258255/b-studio/commit/67ca206)). 통합만 남은 계획은 스튜디오 재시작 뒤 이어서 재시도할 수 있습니다 ([1eeea9a](https://github.com/dj258255/b-studio/commit/1eeea9a)).
- 레인이 지운 파일을 정책 검사를 거치는 도구로 처리하고 통합에 반영합니다 ([5a7e439](https://github.com/dj258255/b-studio/commit/5a7e439)).
- 헤드리스 브라우저 화면 확인과 작업 분해의 핵심을 추가하고 ([bda5240](https://github.com/dj258255/b-studio/commit/bda5240)), 화면 확인에 클릭·입력 단계를 더했습니다 ([76f55f1](https://github.com/dj258255/b-studio/commit/76f55f1)).
- Pi 내장 도구 호출을 같은 정책 코드로 막고 다음 행동을 안내하는 Pi 정책 브리지를 추가했습니다 ([675cac1](https://github.com/dj258255/b-studio/commit/675cac1)).
- `studio verify`로 편집기에서 바꾼 현재 변경도 에이전트와 같은 게이트에 넣어 확인합니다 ([fe3fcf2](https://github.com/dj258255/b-studio/commit/fe3fcf2)).
- 예제 api의 워크플로 테스트 단계에 슬라이스 테스트를 추가했습니다 ([2eed4ea](https://github.com/dj258255/b-studio/commit/2eed4ea)).

### 수정

- 워크플로 트레일러를 스튜디오가 만든 체크포인트에서만 신뢰합니다 ([230c186](https://github.com/dj258255/b-studio/commit/230c186)). 본문이 잘리거나 요약이 위조돼도 안전하게 남깁니다 ([3eb9fc2](https://github.com/dj258255/b-studio/commit/3eb9fc2)).
- Pi 브리지에서 시크릿 파일 읽기를 차단합니다 ([3ae1570](https://github.com/dj258255/b-studio/commit/3ae1570)).
- 세션을 없애거나 정리할 때 남은 샌드박스 이미지를 지웁니다 ([1d516f9](https://github.com/dj258255/b-studio/commit/1d516f9)). 남은 샌드박스 자원을 정리하고 디스크 부족 실패를 설명합니다 ([e147110](https://github.com/dj258255/b-studio/commit/e147110)).

### 문서

- 브라우저 확인, 작업 분해, 샌드박스 이미지 누수를 기록했습니다 ([9c34012](https://github.com/dj258255/b-studio/commit/9c34012)). 워크플로 강제, 릴리스 규칙, Pi 브리지 한계를 적었습니다 ([da35847](https://github.com/dj258255/b-studio/commit/da35847)).

## 2026-09-15

### 추가

- 도구 호출 전에 실행 정책을 적용합니다 ([631facd](https://github.com/dj258255/b-studio/commit/631facd)).

### 문서

- b-studio를 에이전트 개발 환경(ADE)으로 위치시켰습니다 ([fdfabd1](https://github.com/dj258255/b-studio/commit/fdfabd1)).

## 2026-09-14

### 문서

- 저장소 안내를 재구성하고 Wiki를 추가했습니다 ([4959a54](https://github.com/dj258255/b-studio/commit/4959a54)).

## 2026-09-13

### 추가

- 모델 라우팅과 Agent Fleet을 추가했습니다 ([4eb01ff](https://github.com/dj258255/b-studio/commit/4eb01ff)). 여러 모델을 같은 도구 계약으로 실행하고, 같은 요청을 독립 브랜치·샌드박스에서 병렬로 돌려 결과를 비교합니다.

## 2026-09-12

### 추가

- 운영 이미지 빌드와 무중단 배포를 추가했습니다 ([#27](https://github.com/dj258255/b-studio/pull/27)). 체크포인트를 운영에 올리는 배포 탭을 추가했습니다 ([#28](https://github.com/dj258255/b-studio/pull/28)).
- PR CI와 스튜디오 컨테이너 이미지를 추가했습니다 ([#29](https://github.com/dj258255/b-studio/pull/29)).
- 파일을 바꾸지 않는 질문 모드를 추가했습니다 ([#26](https://github.com/dj258255/b-studio/pull/26)).
- 코드 탭에서 목록 쪽 넘기기와 내용 찾기를 추가했습니다 ([#31](https://github.com/dj258255/b-studio/pull/31)).
- 에이전트 답변의 수식 렌더링을 추가하고 각주 링크를 고쳤습니다 ([#32](https://github.com/dj258255/b-studio/pull/32)).
- 사람·기간 단위 토큰 한도를 추가했습니다 ([#33](https://github.com/dj258255/b-studio/pull/33)).
- 정책 프록시가 자유 텍스트 속 개인정보를 값 형태로 가립니다 ([#35](https://github.com/dj258255/b-studio/pull/35)).

### 수정

- 로그아웃 무효화, 해시 토큰, 로그인 실패 제한, 미리보기 접근 확인으로 인증을 강화했습니다 ([#30](https://github.com/dj258255/b-studio/pull/30)).
- Gradle 홈을 샌드박스마다 분리해 같은 프로젝트 동시 세션을 허용했습니다 ([#34](https://github.com/dj258255/b-studio/pull/34)).
- 인코딩된 구분자가 든 경로는 규칙을 검사할 수 없어 막습니다 ([#38](https://github.com/dj258255/b-studio/pull/38)).

### 변경

- egress 규칙에 경로와 메서드를 적용합니다 ([#36](https://github.com/dj258255/b-studio/pull/36)).
- 데이터베이스 덤프를 파일로 흘려 256MB 상한을 없앴습니다 ([#37](https://github.com/dj258255/b-studio/pull/37)).

## 2026-09-11

### 추가

- 세션 브랜치를 원격에 올리고 PR을 만드는 흐름을 추가했습니다 ([#4](https://github.com/dj258255/b-studio/pull/4)).
- 로컬 로그인 계정으로 에이전트를 실행하는 backend를 추가했습니다 ([#3](https://github.com/dj258255/b-studio/pull/3)).
- 체크포인트마다 같은 시점의 DB 상태를 남기는 DB 브랜치를 추가했습니다 ([#6](https://github.com/dj258255/b-studio/pull/6)).
- 자원 한도와 사용량 표시를 추가했습니다 ([#7](https://github.com/dj258255/b-studio/pull/7)).
- 네트워크 격리와 edge 출입구 컨테이너를 추가했습니다 ([#8](https://github.com/dj258255/b-studio/pull/8)).
- 시크릿 주입과 출력 가림을 추가했습니다 ([#9](https://github.com/dj258255/b-studio/pull/9)).
- 사내 API 정책 프록시를 추가했습니다 ([#10](https://github.com/dj258255/b-studio/pull/10)).
- gVisor 컨테이너 런타임을 추가했습니다 ([#11](https://github.com/dj258255/b-studio/pull/11)).
- Kubernetes 제공자를 추가했습니다 ([#12](https://github.com/dj258255/b-studio/pull/12)).
- 세션 복구와 남은 샌드박스 정리를 추가했습니다 ([#13](https://github.com/dj258255/b-studio/pull/13)).
- 호스트 이름으로 나누는 원격 미리보기 게이트웨이를 추가했습니다 ([#17](https://github.com/dj258255/b-studio/pull/17)).
- 모노레포 하위 폴더 프로젝트의 원격 연동을 추가했습니다 ([#16](https://github.com/dj258255/b-studio/pull/16)).
- 조작 계층을 유리로 띄운 화면 디자인과 다크 모드를 추가했습니다 ([#15](https://github.com/dj258255/b-studio/pull/15)).
- 코드 탭에서 에이전트가 쓰는 코드를 실시간으로 보여 줍니다 ([#18](https://github.com/dj258255/b-studio/pull/18)). 코드 탭과 diff에 문법 강조를 넣고 ([#20](https://github.com/dj258255/b-studio/pull/20)), 파일 찾기와 변경 감시를 추가했습니다 ([#23](https://github.com/dj258255/b-studio/pull/23)).
- 처리 중인 요청 취소와 토큰 사용량 표시를 추가했습니다 ([#19](https://github.com/dj258255/b-studio/pull/19)).
- 에이전트 답변을 마크다운으로 그립니다 ([#21](https://github.com/dj258255/b-studio/pull/21)).
- 세션 토큰 한도를 추가했습니다 ([#22](https://github.com/dj258255/b-studio/pull/22)).
- 스튜디오 인증과 세션 권한을 추가했습니다 ([#24](https://github.com/dj258255/b-studio/pull/24)).
- 내 폴더에서 바로 작업하는 세션을 추가했습니다 ([#25](https://github.com/dj258255/b-studio/pull/25)).

### 변경

- 기동 스냅샷을 적용해 측정으로 찾은 병목을 줄였습니다 ([#5](https://github.com/dj258255/b-studio/pull/5)).

### 수정

- 원격 변경 가져오기와 반영 확인을 고쳤습니다 ([#14](https://github.com/dj258255/b-studio/pull/14)).

## 2026-09-10

### 추가

- pnpm 워크스페이스와 TypeScript 설정을 갖췄습니다 ([c733cc8](https://github.com/dj258255/b-studio/commit/c733cc8)).
- `studio.yaml` 스키마와 compose 교차 검증 로더를 추가했습니다 ([4a0d0b4](https://github.com/dj258255/b-studio/commit/4a0d0b4)).
- 샌드박스 인터페이스, 준비 판정, 로컬 Docker 제공자를 추가했습니다 ([0aefdf9](https://github.com/dj258255/b-studio/commit/0aefdf9)).
- Next.js 16 · Spring Boot 4.1 · FastAPI 개발용 템플릿을 추가했습니다 ([3262618](https://github.com/dj258255/b-studio/commit/3262618)).
- `studio up` 명령과 orders 예제 프로젝트를 추가했습니다 ([4499334](https://github.com/dj258255/b-studio/commit/4499334)).
- 파일 반영 확인, 최근 로그 조회, exec 중단 신호를 추가했습니다 ([2552bbe](https://github.com/dj258255/b-studio/commit/2552bbe)).
- `studio agent` 명령과 샌드박스 세션 공통화를 추가했습니다 ([07af3cf](https://github.com/dj258255/b-studio/commit/07af3cf)).
- 웹 스튜디오(대화, 미리보기, API 탐색기, 로그)를 추가했습니다 ([#1](https://github.com/dj258255/b-studio/pull/1)).
- 세션 체크포인트와 실패한 변경 되돌리기를 추가했습니다 ([#2](https://github.com/dj258255/b-studio/pull/2)).

### 문서

- README, 설계 결정 기록, 트러블슈팅을 추가했습니다 ([6d6dd8d](https://github.com/dj258255/b-studio/commit/6d6dd8d)).
- 에이전트 루프 설계 결정, 검증 결과, 게이트 버그 트러블슈팅을 적었습니다 ([28b1e9f](https://github.com/dj258255/b-studio/commit/28b1e9f)).
