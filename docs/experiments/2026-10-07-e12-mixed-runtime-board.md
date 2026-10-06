# 실험 E12: 레인마다 다른 CLI를 붙여도 게시판으로 협업하는가

레인마다 다른 에이전트 런타임을 붙이는 기능(ADR-117)을 처음 실측했다. 같은 실행에서 #396의 게시판 읽기 시점 안내도 다시 쟀다.

## 결론

1. 혼합 레인(api Claude Code + web Command Code)은 4/9, Claude 단독은 9/9였다(Fisher 양측 p = 0.029).
   - → 원인은 모델이 아니라 배선이었다. Command Code 실행기는 게시판 도구(`post_note`·`read_notes`)를 받지 못했다.
   - → 계약을 읽지 못한 web 레인이 인수 검사에서 무너졌다(acceptance 실패 4건).
2. Claude 토큰은 혼합에서 30%로 줄었다(916,113 / 3,015,259).
   - → 다만 Command Code 레인의 사용량이 실행 단위 집계에서 빠져, 혼합 조건의 전체 비용은 셀 수 없었다.
3. #396의 읽기 시점 안내는 효과가 있었다.
   - → 빈 게시판을 읽은 레인이 E11 mesh 14/18에서 0/17로 줄었다. 성공은 7/9에서 9/9가 됐다.

- 날짜: 2026-10-07 05:04 ~ 07:09 KST
- 관련 이슈: [#428](https://github.com/dj258255/b-studio/issues/428)(사전 등록, 결과 코멘트)
- 커밋: ba1a79c(#427 병합 직후)에 고정한 별도 워크트리
- 원자료: `~/.cache/b-studio/bench/e12/{mixed,claude}-r{1,2,3}/`, 핵심 열은 [`data/2026-10-07-e12-results.csv`](data/2026-10-07-e12-results.csv)

## 1. 질문과 가설

- 질문: 작업 분해의 레인마다 다른 런타임을 붙여도 S3 게시판으로 계약을 주고받아 통합까지 가는가. 한쪽을 다른 CLI로 돌리면 Claude 구독 사용량이 얼마나 줄어드는가.
- H29: 혼합의 성공 건수는 Claude 단독과 구별되지 않는다(9회 중 차이 1건 이하).
- H30: 혼합에서 Command Code 레인도 게시판을 쓴다(web 레인이 `post_note`·`read_notes`를 1회 이상 부른 실행이 9회 중 7회 이상).
- H31: 혼합의 Claude 모델 토큰 합이 단독보다 30% 이상 적다.
- H27 재검(E11): #396 뒤 같은 설정(Claude 단독 = E11-mesh)에서 빈 게시판을 읽은 레인 비율이 E11보다 낮다.

## 2. 조건

| 조건 | 설정 |
|---|---|
| E12-mixed | S3 `--topology mesh`, `--backend claude-code --model sonnet`, `--lane-backend api=claude-code --lane-backend web=commandcode`(모델 지정 없음 = 계정 기본) |
| E12-claude | S3 `--topology mesh`, `--backend claude-code --model sonnet`(모든 레인 Claude Code) |
| 공통 | orders-list·order-detail·order-summary × 3바퀴, 바퀴마다 mixed → claude 교대, 자가 확인 full |

## 3. 결과

| 조건 | 성공 | Claude 토큰 합 | web 레인이 게시판을 쓴 실행 | 종단 시간 중앙값 |
|---|---|---|---|---|
| E12-mixed | 4/9 | 916,113 | 0/9 | 8.3분 |
| E12-claude | 9/9 | 3,015,259 | 9/9 | 4.5분 |

혼합 실패 5건:

| 실행 | 분류 | 내용 |
|---|---|---|
| mixed r1·r2·r3 order-detail | acceptance | web 화면 `/orders/1`이 500 또는 값 불일치. 레인 게이트는 통과 |
| mixed r2 order-summary | acceptance | 화면 값 불일치 |
| mixed r3 order-summary | lane_gate | 레인 게이트 실패 |

게시판 읽기(레인별 `read_notes` 결과 글자 수):

| | E11 mesh(#396 전) | E12-claude(#396 후) |
|---|---|---|
| 읽기 바이트 중앙값 | 10 | 466 |
| 빈 게시판을 읽은 레인(20자 이하) | 14/18 | 0/17 |
| 성공 | 7/9 | 9/9 |

## 4. 판정

- H29 기각: 4 대 9, p = 0.029.
- H30 기각. 다만 측정이 가설을 시험하지 못했다.
  - → `commandcode-runner.ts`는 `buildTools(project)`를 게시판 옵션 없이 부른다. 같은 파일 주석에 "레인 조율 게시판(board)은 아직 받지 않는다"고 적혀 있었다.
  - → OpenCode·Gemini 실행기도 같다. 사전 등록 때 이 제약을 확인하지 못했다.
- H31 채택: 0.30(기준 0.7 이하). 단 Command Code 레인 사용량이 `usageByModel`에 빠져 있어, 줄어든 만큼이 다른 곳으로 옮겨 간 비용은 세지 못했다.
- H27 재검 채택: 빈 게시판을 읽은 레인 14/18 → 0/17.

## 5. 원인

- web 레인은 Command Code로 돌며 `get_contract`·`read_file`·`run_in_service` 같은 b-studio 도구는 받았다.
- 게시판 도구는 받지 못해 api 레인이 게시한 계약을 읽을 수 없었다.
  - → E1(격리 병렬 4/9)과 같은 실패 모양이다. 각자의 게이트는 통과했지만 레인 경계의 값이 맞지 않았다.
- 레인별 백엔드 기능(ADR-117)이 "모든 레인에 같은 도구 계약이 있다"는 전제를 확인하지 않고 백엔드를 섞게 해 줬다.

## 6. 결정에 주는 영향

1. Command Code·OpenCode·Gemini 실행기에도 게시판 도구를 넘긴다.
2. CLI 레인 사용량을 실행 단위 `usageByModel`에 합산한다.
3. 게시판이 필요한 전략에서 게시판을 못 받는 백엔드를 고르면 시작 전에 막는다.
4. #396의 읽기 시점 안내는 그대로 둔다. E11에서 판정 불가였던 H27이 이번에 채택됐다.

## 7. 다음에 확인할 것

- 배선을 고친 뒤 mixed 조건만 9회 다시 돌린다(E12b). 비교 기준은 이번 E12-claude 9/9다.
- 그때 Command Code 레인 사용량까지 넣어 혼합 조건의 전체 비용을 단가표로 환산한다.
