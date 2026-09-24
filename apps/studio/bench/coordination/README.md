# 협업 벤치마크 (`pnpm bench:coordination`)

작업 분해의 두 전략을 같은 과제·같은 모델로 반복 실행해 비교할 원자료를 남깁니다.

- **S0 직렬화**: api 작업과 web 작업을 한 레인에 넣습니다(web이 api에 의존). web 작업은 api가 바꾼 파일을 같은 세션에서 봅니다.
- **S1 격리 병렬**: 두 작업을 다른 레인에서 동시에 돌립니다. 서로의 변경을 보지 못합니다(현재 ADR-051 동작).
- 알고 싶은 것은 "쓰기 범위가 겹치지 않아도 인터페이스로 엮인 작업(api 응답 ↔ web 화면)에서 S1이 통합 뒤 실제로 맞물리는가, 그 대신 시간·토큰은 얼마나 아끼는가"입니다.

결과는 `docs/experiments/`에 실험 보고서 양식으로 옮겨 적습니다(실험 #45).

## 실행

```bash
# 실제 모델 호출 없이(과금 없음) 실행 경로만 확인. 과제 orders-list, 전략 S0·S1, 반복 1로 고정
pnpm bench:coordination --dry

# 실제 실행
BENCH_UPSTREAM_BASE_URL=https://api.example.com/v1 \
BENCH_UPSTREAM_API_KEY=... \
BENCH_UPSTREAM_MODEL=... \
BENCH_PRICE_INPUT_PER_M=3 BENCH_PRICE_OUTPUT_PER_M=15 \
pnpm bench:coordination

# 일부만
pnpm bench:coordination --tasks orders-list,independent --strategies S0,S1 --repeats 2 --out /tmp/bench-run
```

인자: `--dry`, `--tasks a,b`, `--strategies S0,S1`, `--repeats N`(기본 3, `--dry`는 1), `--out <dir>`, `--force`.

`BENCH_PRICE_INPUT_PER_M`·`BENCH_PRICE_OUTPUT_PER_M`는 선택입니다. 없으면 0으로 두고 경고합니다.

## 사전 확인이 멈추는 이유

시작 전에 `docker ps`를 보고 `studio-`로 시작하지 않는 컨테이너가 있으면 목록과 함께 종료 코드 2로 멈춥니다. 메모리를 나눠 쓰면 다른 프로젝트 DB가 OOM으로 죽을 수 있기 때문입니다. 정말 진행하려면 `--force`를 줍니다(경고만 하고 진행). 이 저장소는 한 번에 계획 하나만 돌리고, 끝나면 그 계획의 세션을 모두 내린 뒤 남은 `studio-<벤치 프로젝트>-` 컨테이너가 0개인지 확인합니다. 남아 있으면 다음 실행을 시작하지 않고 멈춥니다.

## 결과 파일

`--out`(기본 `~/.cache/b-studio/bench/coordination/<YYYYMMDD-HHmmss>`) 아래에 남깁니다.

- `results.jsonl`: 실행 한 번이 한 줄입니다(계획·레인·통합 지표, 수용 확인, 분류, 프록시 통계, 추정 비용).
- `summary.md`: 과제 × 전략 표와 전략별 실패 원인 표.
- `meta.json`: 시작·끝 시각, Docker 메모리, 모델 이름, 과제·전략·반복, git 커밋.

상류 API 키는 환경 변수에서만 읽고 JSONL·요약·로그에 쓰지 않습니다. 결과를 쓰기 직전에 키가 들어 있으면 `***`로 바꿉니다.

## 한계

- **고정 계획이라 계획 모델의 품질은 재지 않습니다.** 전략 차이만 재기 위해 계획은 과제마다 미리 정해 두고, 로컬 프록시가 계획 요청에 그대로 돌려줍니다.
- 추정 비용은 단순화했습니다. 입력 토큰은 `inputTokens + cacheReadTokens + cacheWriteTokens`를 입력 단가로 곱하고, 캐시 할인은 반영하지 않습니다. 청구서 금액이 아닙니다.
- 반복이 적어 비율 대신 건수로 적습니다. 결과는 이 저장소·이 모델·이 과제에 한정됩니다.
