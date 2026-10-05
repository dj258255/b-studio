# 공구함 — AI에게 코딩을 맡기려고 만든 장치들

b-studio는 앱 하나처럼 보이지만, 안을 열면 "에이전트의 결과를 믿어도 되게 만드는 장치"들의 모음입니다. 이 문서는 그 장치를 하나씩 꺼내, 무엇을 하는지·코드가 어디 있는지·어떤 측정이 뒷받침하는지를 한 줄씩 적습니다. 측정하지 않은 효과는 적지 않습니다.

| 장치 | 무엇을 하나 | 코드 | 뒷받침하는 측정 |
|---|---|---|---|
| 검증 게이트 | 에이전트의 완료 선언 대신 서비스 재시작, HTTP 준비, OpenAPI 계약, 실제 Chromium 화면, 테스트, 리뷰로 완료를 판정한다 | [`packages/agent/src/gate.ts`](../packages/agent/src/gate.ts) | 게이트 범위 밖이던 통합에서 "각자 게이트는 통과한 거짓 성공" 5건을 잡은 것이 계기([E1](experiments/2026-09-29-e1-isolated-parallel-baseline.md)) |
| Git+DB 체크포인트 | 게이트를 통과한 파일과 그 시점의 PostgreSQL 덤프만 남기고, 실패·취소는 되돌린다 | [`packages/agent/src/checkpoints.ts`](../packages/agent/src/checkpoints.ts) | 도그푸딩 중 되돌리기가 문서를 버린 사고 뒤 백업·복원을 더해 같은 유형 재발 0건([검증 기록](verification.md#명세-기반-풀스택-도그푸딩)) |
| 실행 정책 경계 | 보호 경로, 레인별 쓰기 범위, egress 허용 목록, 시크릿 가림을 모델 지침이 아니라 실행기에서 강제한다 | [`packages/agent/src/policy.ts`](../packages/agent/src/policy.ts) · [`packages/sandbox/src/edge-config.ts`](../packages/sandbox/src/edge-config.ts) | 레인 3개 병렬 통합 E2E에서 범위 밖 쓰기 차단, 레인 간 변경 충돌 0건([검증 기록](verification.md)) |
| 조율 게시판 | 레인이 계약·사실·실패 서명을 주고받는 pull 게시판. 읽기 범위를 topology(star·hierarchical·mesh)로 제한한다 | [`packages/agent/src/coordination/`](../packages/agent/src/coordination/) | 계약 공유 17/18 대 비공유 9/18, p = 0.007([E2](experiments/2026-09-29-e2-coordination-strategies.md)). topology는 활성 성분이 아니고 읽는 시점이 문제([E11](experiments/2026-10-05-e11-board-topology.md)) |
| 멀티 CLI 러너 계약 | Claude Code·Codex·Command Code·OpenCode를 같은 도구 계약으로 묶어 백엔드를 바꿔도 게이트·체크포인트가 그대로 돈다 | [`packages/agent/src/cli-router.ts`](../packages/agent/src/cli-router.ts) · [`packages/agent/src/model-router.ts`](../packages/agent/src/model-router.ts) | 같은 벤치 하네스로 백엔드만 바꿔 측정([E3](experiments/2026-09-29-e3-baseline-budget-escalation.md) 이후 전 실험) |
| 토큰 경제 장치 | 도구 결과 예산, 게이트와 겹치는 자가 확인 줄이기(lean), 모델 승격 | [`packages/agent/src/loop.ts`](../packages/agent/src/loop.ts) (에이전트 루프의 예산·자가 확인) | 성공 1건당 토큰 −41%([E7](experiments/2026-09-30-e7-lean-self-check.md)), 계획·실행 모델 분리는 +538%로 기각([E8](experiments/2026-09-30-e8-plan-execute-split.md)) |
| 벤치 하네스 | 가설을 이슈로 사전 등록하고, 같은 과제를 반복 실행해 Fisher 정확 검정으로 판정한다 | [`apps/studio/bench/coordination/`](../apps/studio/bench/coordination/) | 실험 11개, 기각 2건 포함([실험 기록](experiments/README.md)) |

## 하나만 집어 써 보기: `studio verify`

에이전트를 거치지 않은 변경 — 편집기로 직접 고친 코드 — 도 같은 게이트에 넣을 수 있습니다.

```bash
pnpm studio verify <프로젝트 경로>
```

재시작, 준비 판정, 화면, 테스트, 리뷰를 그대로 돌리고 판정만 합니다(체크포인트는 만들지 않습니다). 구현은 [`apps/cli/src/commands/verify.ts`](../apps/cli/src/commands/verify.ts)에 있고, 모델 없이 전체 흐름을 보려면 `pnpm studio:demo`로 5분 안에 확인할 수 있습니다([시작하기](getting-started.md)).

## 왜 이 문서인가

AI가 코드를 잘 쓰는 시기에는 "누가 더 잘 짰나"보다 "짠 것을 어떤 경계 안에서 확인하고 되돌릴 수 있나"가 판가름합니다. 위 장치들은 전부 그 질문에 답하려고 만들었고, 각 줄의 측정값이 실제로 답이 됐는지를 말해 줍니다. 장치들이 생긴 순서와 각 결정의 근거는 [ADR](decisions.md), 한계는 [검증 기록](verification.md)에 있습니다.
