# 실험 계획 E10: claude-code 자동 모델 선택은 Sonnet 고정보다 싼가

**계획 — 아직 실행하지 않음.** 사용자는 API 예산이 없고 구독 CLI(로컬 Claude Code 로그인)의 사용량으로 실제 비용을 치르므로, 이 문서는 실행 방법만 적어 두고 사전 등록 없이는 돌리지 않는다.

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

아직 실행하지 않았다. 실행하면 이 절을 E8/E9와 같은 형식(조건별 성공/토큰/비용 표, 과제별 표, 실패 상세)으로 채운다.
