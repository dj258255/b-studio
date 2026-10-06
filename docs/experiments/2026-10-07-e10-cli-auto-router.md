# 실험 E10: claude-code 자동 모델 선택은 Sonnet 고정보다 싼가

결론: 싸지 않았다. 자동 선택(auto)의 성공 1건당 비용은 $0.446으로 Sonnet 고정($0.234)의 191%였다(H23 기각). 성공은 8/9 대 7/9로 구별되지 않았다(H24 채택, Fisher p = 1.0). 비용 차이는 전부 order-summary 한 과제에서 나왔다. 이 과제의 요청에 샘플 상태 이름 "결제 완료(PAID)"가 있었고, 위험도 분류가 "결제"라는 단어만 보고 세 번 모두 Opus로 올렸다. 이 과제를 빼면 auto $0.27 대 Sonnet $0.25다(사전 등록하지 않은 탐색 비교).

- 날짜: 2026-10-06 19:38 ~ 23:13 KST(2차 실행). 1차 실행(07:45 ~ 12:58)은 네트워크 장애로 18회 중 14회가 environment 실패라 무효 처리했다([#411 코멘트](https://github.com/dj258255/b-studio/issues/411))
- 관련 이슈: [#411](https://github.com/dj258255/b-studio/issues/411)(사전 등록·순서 변경·무효 처리), 장애 대응 [#419](https://github.com/dj258255/b-studio/pull/419)
- 커밋: 057b3ee(#419 병합 직후)에 고정한 별도 워크트리
- 원자료: `~/.cache/b-studio/bench/e10/{auto,sonnet}-r{1,2,3}/`, 핵심 열은 [`data/2026-10-07-e10-results.csv`](data/2026-10-07-e10-results.csv)

- 관련: [ADR-091 CLI 백엔드 자동 모델 선택](../decisions.md#adr-089-cli-백엔드-자동-모델-선택), [ADR-047](../decisions.md#adr-047-멀티-모델-라우터-공통-도구-계약-위에서-검증된-작업당-비용을-고른다), [E8](2026-09-30-e8-plan-execute-split.md), [E9](2026-10-01-e9-narrow-plan.md)

## 왜 이 실험인가

ADR-047의 멀티 모델 라우터는 `api` 백엔드에만 있다. 사용자는 API 키 대신 구독 CLI(`claude-code`)로 돌리는데, 지금까지는 대화에서 모델을 하나 골라 세션 내내 고정해야 했다. ADR-091는 요청마다 haiku(질문)·sonnet(단순 만들기)·opus(복잡·위험한 만들기)를 자동으로 고르고, 세션 안에서는 이미 성공한 단계를 내리지 않는(stickiness) 규칙을 만들었다.

E8·E9는 세션 안에서 모델을 자주 바꾸면(계획 모델 ↔ 실행 모델) 프롬프트 캐시가 새로 만들어져 비용이 크게 뛴다는 것을 쟀다(E8-split: 단일 모델 대비 +538%). 자동 선택도 요청마다 모델이 바뀔 수 있는 설계라 같은 위험이 있다 — stickiness가 그 위험을 얼마나 줄이는지, 그리고 haiku로 답한 질문·opus로 올라간 위험한 요청이 전체 비용·성공률에 어떤 영향을 주는지는 아직 재지 않았다.

## 가설(실행 전에 이슈에 먼저 적을 것)

- **H23**: 자동 선택(E10-auto)의 성공 1건당 비용은 Sonnet 고정(E10-sonnet, E8-sonnet/E9의 조건과 동일)의 120% 이내다(같은 과제군에서 크게 비싸지지 않는다).
- **H24**: 자동 선택의 성공률은 Sonnet 고정과 구별되지 않는다(성공 건수 차이 1건 이하).
- **H25**: 세션 안에서 모델이 바뀌는 횟수(승격 포함)는 과제당 평균 1회 미만이다 — stickiness가 실제로 모델을 자주 바꾸지 않는지 확인한다(E8-split처럼 계획↔실행을 오가는 패턴이 재현되지 않아야 한다).

## 조건

| 조건 | 설정 |
|---|---|
| E10-auto | S0, `--backend claude-code --model auto` |
| E10-sonnet(비교 기준) | S0, `--backend claude-code --model sonnet`(E8-sonnet·E9와 같은 조건) |
| 공통 | 로컬 Claude Code 구독, E8·E9와 같은 과제 3개(orders-list, order-detail, order-summary) × 3회, 자가 확인 full |

## 측정할 것

- **주 지표**: 성공 1건당 API 환산 비용(E8/E9와 같은 단가표), 성공률(9회 중 성공 건수).
- **보조 지표**: 과제 안에서 모델이 바뀐 횟수(자동 선택이 고른 단계 + 승격 발생 여부, `route`·`model_escalated` 이벤트로 셀 수 있다), 과제별 최종 선택 단계(haiku/sonnet/opus 분포 — 질문이 없는 순수 만들기 과제라 이론상 전부 sonnet 또는 opus여야 한다).

## 실행 방법

사전 등록(이슈에 H23~H25를 먼저 적고 커밋을 고정한 뒤)하고 나서:

```bash
# 자동 선택
pnpm bench:coordination --backend claude-code --model auto --strategies S0 \
  --tasks orders-list,order-detail,order-summary --repeats 3 --out ~/.cache/b-studio/bench/coordination/e10-auto

# Sonnet 고정(비교 기준)
pnpm bench:coordination --backend claude-code --model sonnet --strategies S0 \
  --tasks orders-list,order-detail,order-summary --repeats 3 --out ~/.cache/b-studio/bench/coordination/e10-sonnet
```

배선 확인(실제 실행 없이, 이 세션에서 이미 돌려 확인함):

```bash
pnpm bench:coordination --dry --tasks orders-list --repeats 1 --out /tmp/e10-dry-check
```

`--dry`는 항상 openai 가짜 상류를 쓰고 `--backend`/`--model`을 받지 않으므로(claude-code 자동 선택 자체는 실 CLI 호출이 있어야 확인된다) 이 dry-run은 "하네스가 여전히 도는지"만 증명한다. `--model auto`가 인자 파싱·`resolveBackend`를 통과하는지는 `apps/studio/bench/coordination/backends.test.ts`의 단위 테스트로 따로 확인했다(실제 실행 없이).

## 결과

과제 3개 × 3바퀴, 바퀴마다 auto → sonnet 순서로 번갈아 돌렸다(사전 등록 뒤 실행 전에 순서를 바꾼 이유는 #411에 적었다). 비용은 E8과 같은 단가표로 모델별 사용량에 곱했다(Sonnet 5 $2/$10, 캐시 읽기 $0.20, 쓰기 $2.50 · Opus 5 $5/$25/$0.50/$6.25 · Haiku 4.5 $1/$5/$0.10/$1.25, 백만 토큰당).

| 조건 | 성공 | 토큰 합 | 성공 1건당 토큰 | API 환산 비용 합 | 성공 1건당 비용 | 종단 중앙값 |
|---|---|---|---|---|---|---|
| auto | 8/9 | 4,583,928 | 572,991 | $3.57 | $0.446 | 6.3분 |
| sonnet | 7/9 | 3,010,079 | 430,011 | $1.63 | $0.234 | 5.0분 |

### 과제별

| 과제 | auto 성공 | auto 성공 1건당 비용 | auto가 고른 모델 | sonnet 성공 | sonnet 성공 1건당 비용 |
|---|---|---|---|---|---|
| orders-list | 2/3 | $0.205 | Sonnet | 3/3 | $0.188 |
| order-detail | 3/3 | $0.312 | Sonnet | 2/3 | $0.342 |
| order-summary | 3/3 | $0.740 | **Opus(3번 모두)** | 2/3 | $0.193 |

두 조건 모두 Haiku 토큰이 9천 남짓(auto 9,124 · sonnet 9,141) 있다. b-studio가 고른 것이 아니라 Claude Code CLI가 스스로 부르는 몫이라 모델 전환으로 세지 않았다.

### 실패 3건

| 실행 | 분류 | 내용 |
|---|---|---|
| auto r3 orders-list | lane_gate | 레인 세션이 20분 안에 끝나지 않음. 모델 호출 0회, 74.9분 |
| sonnet r2 order-detail | lane_gate | 레인 세션이 30분 안에 끝나지 않음. 모델 호출 8회, 41.8분 |
| sonnet r2 order-summary | environment | 앱 기동 중 `registry.npmjs.org: 이름을 풀지 못함`(edge 502, #419가 남긴 기록) |

environment 1건은 #419 덕분에 DNS 장애로 확정됐다. lane_gate 2건은 같은 시간대(21:00 무렵)에 모델 호출이 거의 없이 시간 초과가 났다. 네트워크 장애로 보이지만 근거가 남지 않아 확정하지 못했다. 사전 등록대로 실패는 빼지 않고 표에 남겼다.

### 판정

- **H23 기각**: 성공 1건당 비용 비율 $0.446 / $0.234 = 1.91(기준 1.20 이하).
- **H24 채택**: 성공 8 대 7, 차이 1건(기준 1건 이하). Fisher 양측 p = 1.0.
- **H25 채택**: auto 9회 모두 과제 안에서 주 모델이 하나였다(Sonnet 6회, Opus 3회). 승격(`model_escalated`)은 0회. 과제당 평균 전환 0회(기준 1회 미만). stickiness가 E8-split처럼 모델을 오가게 하지는 않았다.

### 비용이 오른 원인

`routeCliTier`는 위험도가 high이거나 복잡도가 complex면 Opus를 고른다(`packages/agent/src/cli-router.ts`). 위험도는 `HIGH_RISK` 정규식(`packages/agent/src/model-router.ts`)으로 정하는데, 여기에 `결제`가 들어 있다. order-summary의 api 레인 요청 "샘플 값은 결제 완료(PAID) 2건…"이 이 단어에 걸렸다. 결제를 처리하는 코드가 아니라 상태 이름 데이터였다. 같은 과제를 Sonnet은 2/2(유효 실행 기준) 성공했으니 Opus로 올린 값어치가 없었다.

## 결론

- 자동 선택은 단어 하나로 비싼 모델로 올라가며, 이 과제군에서는 그만큼 성공을 더 사지 못했다.
- 승격 규칙과 stickiness 자체는 문제를 만들지 않았다(모델 전환 0회).
- 위험 키워드는 "무엇을 하라는가"가 아니라 "어떤 단어가 있는가"를 본다. 결제·정산이 일상 용어인 도메인(예: 이커머스 백엔드)에서는 거의 모든 요청을 Opus로 보낼 것이다.

## 결정에 주는 영향

- claude-code의 기본 모델은 계속 Sonnet 고정으로 둔다. auto는 사람이 고르는 선택지로만 남긴다.
- 위험도 분류를 단어 일치에서 바꾸기 전에는 결제 도메인 프로젝트에서 auto를 권하지 않는다. 바꾼다면 "요청이 인증·결제·마이그레이션 코드를 고치는가"를 대상 파일·경로로 판정하는 쪽을 먼저 검토한다.

## 다음에 확인할 것

- 위험 키워드를 데이터 단어와 구별하게 고친 뒤 같은 조건으로 다시 재면 auto가 Sonnet 고정의 120% 안으로 들어오는가(이번 탐색 비교로는 order-summary를 빼고 108%).
- lane_gate 시간 초과 2건의 원인을 가릴 수 있게 레인 시간 초과에도 마지막 도구 호출·네트워크 상태를 남긴다.
