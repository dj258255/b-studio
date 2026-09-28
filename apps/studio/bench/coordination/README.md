# 협업 벤치마크 (`pnpm bench:coordination`)

작업 분해의 두 전략을 같은 과제·같은 모델로 반복 실행해 비교할 원자료를 남깁니다.

- **S0 직렬화**: api 작업과 web 작업을 한 레인에 넣습니다(web이 api에 의존). web 작업은 api가 바꾼 파일을 같은 세션에서 봅니다.
- **S1 격리 병렬**: 두 작업을 다른 레인에서 동시에 돌립니다. 서로의 변경을 보지 못합니다(현재 ADR-051 동작).
- 알고 싶은 것은 "쓰기 범위가 겹치지 않아도 인터페이스로 엮인 작업(api 응답 ↔ web 화면)에서 S1이 통합 뒤 실제로 맞물리는가, 그 대신 시간·토큰은 얼마나 아끼는가"입니다.

결과는 `docs/experiments/`에 실험 보고서 양식으로 옮겨 적습니다(실험 #45).

## 실행

`--dry`가 아니면 `--backend`가 필수입니다. 모델 경로(유료 API / 로컬 구독 CLI)를 조용한 기본값으로 고르지 않습니다.

```bash
# 실제 모델 호출 없이(과금 없음) 실행 경로만 확인. --dry는 항상 openai 가짜 상류를 쓴다
pnpm bench:coordination --dry

# openai: 유료 API
BENCH_UPSTREAM_BASE_URL=https://api.example.com/v1 \
BENCH_UPSTREAM_API_KEY=... \
BENCH_UPSTREAM_MODEL=... \
BENCH_PRICE_INPUT_PER_M=3 BENCH_PRICE_OUTPUT_PER_M=15 \
pnpm bench:coordination --backend openai

# claude-code: 이 PC에 로그인된 구독 CLI (유료 API 없이 E1을 돌린다)
pnpm bench:coordination --backend claude-code --model sonnet --tasks orders-list --strategies S0,S1 --repeats 1

# 일부만 (openai)
pnpm bench:coordination --backend openai --tasks orders-list,independent --strategies S0,S1 --repeats 2 --out /tmp/bench-run
```

인자:

- `--backend claude-code|openai` — 필수(`--dry` 제외). `--dry`와 함께 쓰면 오류
- `--model <이름>` — `claude-code`에서만. 기본 `sonnet`. `B_STUDIO_CLAUDE_CODE_MODEL`로 넘어간다
- `--tasks a,b`, `--strategies S0,S1`, `--repeats N`(기본 3, `--dry`는 1), `--out <dir>`, `--force`
- `--on-rate-limit stop|wait`(기본 `stop`), `--rate-limit-wait-minutes N`(기본 30)

**claude-code**는 프록시와 상류를 띄우지 않고 `BENCH_UPSTREAM_*`도 요구하지 않습니다. 모델 레지스트리도 쓰지 않습니다(계획은 `presetPlan`으로 서버 안에서 넘기고, 세션은 레지스트리를 요구하지 않습니다). 실행 전에 `preflightClaudeCode`로 로그인을 확인하고, 실패하면 종료 코드 3으로 멈춥니다.

**openai**는 `BENCH_UPSTREAM_BASE_URL`, `BENCH_UPSTREAM_API_KEY`, `BENCH_UPSTREAM_MODEL`이 필요합니다. `--dry`는 이 백엔드의 가짜 상류라 이 값들이 필요 없습니다. `BENCH_PRICE_INPUT_PER_M`·`BENCH_PRICE_OUTPUT_PER_M`는 선택이고, 없으면 0으로 두고 경고합니다.

## 사용 한도

실행 뒤 분류가 `rate_limited`면(모델 응답에 `usage limit`, `rate limit`, `429`, `hit your limit`, `limit reached`, `overloaded`) 정책에 따라 처리합니다.

- `--on-rate-limit stop`(기본): 다음 실행을 시작하지 않고 멈춥니다.
- `--on-rate-limit wait`: `--rate-limit-wait-minutes`만큼 기다린 뒤 **같은 실행을 한 번만** 다시 시도합니다. 다시 시도한 실행은 행의 `retryOf`로 표시하고, 원래 행도 지우지 않고 남깁니다.

## 사전 확인이 멈추는 이유

시작 전에 `docker ps`를 보고 `studio-`로 시작하지 않는 컨테이너가 있으면 목록과 함께 종료 코드 2로 멈춥니다. 메모리를 나눠 쓰면 다른 프로젝트 DB가 OOM으로 죽을 수 있기 때문입니다. 정말 진행하려면 `--force`를 줍니다(경고만 하고 진행). 이 저장소는 한 번에 계획 하나만 돌리고, 끝나면 그 계획의 세션을 모두 내린 뒤 남은 `studio-<벤치 프로젝트>-` 컨테이너가 0개인지 확인합니다. 남아 있으면 다음 실행을 시작하지 않고 멈춥니다.

## 결과 파일

`--out`(기본 `~/.cache/b-studio/bench/coordination/<YYYYMMDD-HHmmss>`) 아래에 남깁니다.

- `results.jsonl`: 실행 한 번이 한 줄입니다(계획·레인·통합 지표, 수용 확인, 분류, 프록시 통계, 관측한 모델, 추정 비용).
- `summary.md`: 백엔드·요청한 모델·관측한 모델·실행 수, 과제 × 전략 표, 전략별 실패 원인 표.
- `meta.json`: 시작·끝 시각, Docker 메모리, 백엔드, 요청한 모델, 관측한 모델, 과제·전략·반복, git 커밋.

원자료에는 레인·통합 세션마다의 탐색·실패 흔적도 남깁니다.

- `traces`·`integrationTrace`: 도구 이름별 호출 수, 읽은 파일(정규화·중복 제거·정렬), 나열한 폴더, 실패 서명(발생 순서, 중복 포함), 반복 실패 수.
- `explore`: 레인 합계 `filesReadTotal`, 레인 사이 합집합 `filesReadUnionAcrossLanes`, 읽기 호출 `readCallsTotal`. 통합 세션은 모델 없이 스크립트로 돌아 합계에서 뺍니다.
- `failures`: 실패 서명 총수, 서로 다른 서명 수, 반복 실패 수. **실패 서명은 검증기가 낸 실패만 씁니다**(준비하지 못한 서비스, 어긋난 계약, 실패한 워크플로 확인). 모델 텍스트는 쓰지 않고, 메시지는 첫 줄만 남겨 줄 번호·시각·해시를 `N`·`H`로 정규화합니다.

실제로 쓴 모델 이름은 실행마다 레인·통합 세션의 이벤트 기록에서 읽어 `observedModels`에 넣습니다. 상류 API 키는 환경 변수에서만 읽고 JSONL·요약·로그에 쓰지 않습니다. 결과를 쓰기 직전에 키가 들어 있으면 `***`로 바꿉니다.

## 한계

- **본인 PC에서 본인이 로그인한 CLI만 씁니다.** `claude-code` 백엔드는 개인 구독 계정용이고, 공유 서버에서는 쓰지 않습니다(ADR의 로컬 CLI 원칙).
- **고정 계획이라 계획 모델의 품질은 재지 않습니다.** 전략 차이만 재기 위해 계획은 과제마다 미리 정해 둡니다(openai는 로컬 프록시가, claude-code는 `presetPlan`이 그대로 넘깁니다).
- **로컬 CLI 러너는 모델 응답 대기 시간을 재지 못해 `modelMs`가 0입니다.** 0은 "재지 않음"이고, 추측값을 넣지 않습니다. 비용은 청구가 없고, 단가를 주면 API 단가 환산 추정치만 계산합니다.
- 실패 서명 메시지는 숫자열을 `N`으로 바꿉니다. 그래서 `exit code 1`과 `exit code 2`, 다른 포트 번호가 같은 서명이 됩니다. 줄 번호·시각·해시 때문에 같은 원인이 갈라지지 않게 한 선택입니다.
- `repeatedFailures`는 **한 세션 안에서** 같은 서명이 다시 나온 횟수이고, `distinctSignatures`는 실행 전체(레인 + 통합)의 서로 다른 서명 수입니다. 두 값의 범위가 다릅니다.
- 세션 기록은 5,000개 이벤트를 넘으면 오래된 것부터 잘립니다. 아주 긴 세션은 탐색량(`filesRead`, 도구 호출)이 실제보다 적게 잡힐 수 있습니다.
- 추정 비용은 단순화했습니다. 입력 토큰은 `inputTokens + cacheReadTokens + cacheWriteTokens`를 입력 단가로 곱하고, 캐시 할인은 반영하지 않습니다. 청구서 금액이 아닙니다.
- 반복이 적어 비율 대신 건수로 적습니다. 결과는 이 저장소·이 모델·이 과제에 한정됩니다.
