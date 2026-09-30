# PR 중심 에이전트 작업 흐름 — 빅테크 기술 블로그 조사

- 작성: 2026-09-30
- 상태: **검토 문서.** 무엇을 만들지는 ADR로 남긴다
- 관련: [토큰 줄이기 조사](2026-09-30-token-reduction-sources.md), [여러 에이전트 관리](2026-09-29-multi-agent-management.md)
- 표시: ✅ 원문을 직접 열어 수치를 대조한 출처 · ⚠️ 조사 에이전트가 읽은 요약만 확인한 출처(인용 전에 원문과 대조한다)

## 왜 조사했나

실무자 글에서 다음 주장을 봤다.

- 사람이 하는 일 대부분이 에이전트 결과물을 이곳저곳으로 나르는 것이다. 최종 산출물은 저장소의 PR이다.
- 첫 1~2번 리뷰 라운드는 자동화할 수 있다. 사람의 판단은 머지 결정에 몰린다.
- 오래된 브랜치가 빠르게 움직이는 main과 충돌하면 싼 에이전트가 다시 맞추고 평가를 다시 돌린다.
- 며칠 쓰고 나면 로그에서 에이전트의 반복 행동을 찾아 스크립트로 굳혀 토큰을 아낀다.
- 뼈대는 똑똑한 모델로, 토큰을 많이 먹는 지루한 부분은 싼 모델로. 세션 포크, 문맥 증가 감시.

이것을 큰 팀들이 실제로 어떻게 하는지, 수치가 있는지 찾았다.

## 1. PR 자동 리뷰 라운드

- ✅ **Stripe Minions**: CI 피드백은 두 라운드뿐이다. 두 번째 푸시와 CI 뒤에는 브랜치를 사람에게 돌려보낸다. 주당 1,300건 넘는 PR이 사람이 코드를 쓰지 않은 채 머지되고, 리뷰는 사람이 한다. (https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2)
- ✅ **Uber uReview**: 주당 약 6.5만 건의 diff 중 90% 넘게 분석한다. 사용자가 코멘트의 75%를 유용하다고 표시했고 65% 넘게 반영됐다(사람 코멘트는 51%). 주당 약 1,500시간, 연 39 개발자년을 아낀다고 추산한다. (https://www.uber.com/en-IT/blog/ureview/)
- ⚠️ **Cursor Bugbot**: PR이 바뀔 때마다 증분 리뷰를 하고, 자동 수정은 PR당 최대 3회로 제한한다. (https://cursor.com/docs/bugbot)
- ⚠️ **Graphite Agent**: 리뷰 루프가 1시간에서 90초로 줄었고, 코멘트의 67%가 구현됐다. (https://claude.com/customers/graphite)
- ⚠️ **GitHub Copilot coding agent**: 이슈를 맡기면 draft PR을 만들고 테스트를 돌린다. 이슈를 만든 사람은 그 PR을 승인할 수 없다. .NET 런타임 팀 10개월 기록에서 AGENTS.md를 넣기 전후로 머지율이 38.1%에서 69%로 올랐다. (https://devblogs.microsoft.com/dotnet/ten-months-with-cca-in-dotnet-runtime)
- ⚠️ **Google**: 리뷰 코멘트 해결을 ML로 제안한다. 코멘트의 52%에 제안을 내고, 도구 안 적용률은 70%를 넘는다. (https://research.google/blog/resolving-code-review-comments-with-ml)
- 공통점: **라운드 수에 상한을 두고, 머지 판단은 사람이 한다.**

## 2. 브랜치 최신 유지와 충돌

- ⚠️ **Graphite `gt sync`**: 스택의 모든 브랜치를 trunk 최신으로 자동 재배치한다. 충돌이 나면 LLM으로 풀지 않고 사람에게 넘긴다. (https://graphite.com/docs/collaborate-on-a-stack)
- ⚠️ **GitHub "Fix with Copilot"와 GitLab Duo**가 자동 충돌 해결을 내놨다. 둘 다 성공률은 공개하지 않았다.
- ⚠️ **Google LSC/Rosie**: 큰 변경을 원자적 조각으로 나눠 자동 테스트와 자동 승인을 거친다. 이상한 경우만 사람이 본다. (https://abseil.io/resources/swe-book/html/ch22.html)

## 3. 반복 행동을 스크립트로 굳히기

- ⚠️ **Anthropic Agent Skills**: 정렬을 토큰 생성으로 하는 것은 정렬 알고리즘을 돌리는 것보다 훨씬 비싸다는 논지다. 쓰지 않는 스크립트는 문맥에 0토큰이다. (https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- ⚠️ **Anthropic 코드 실행 + MCP**: 도구 정의를 직접 실으면 15만 토큰, 코드 실행 방식은 2천 토큰이었다(98.7% 절감). (https://www.anthropic.com/engineering/code-execution-with-mcp)
- ⚠️ **OpenAI Codex Record & Replay**: 사람이 한 번 시연한 작업을 스킬로 저장한다. (https://developers.openai.com/codex/record-and-replay)

## 4. 모델 나누기와 병렬 세션 비용

- ✅ **Cognition Devin Fusion**: FrontierCode 1.1에서 63.1점을 과제당 $1.35에 냈다. Opus 5는 63.6점에 $3.51, Fable 5는 64.9점에 $10.53이다. Fable 5와 조합하면 같은 성능에 41% 싸다. 내부에서 머지된 PR의 88%를 자동 라우터가 처리했다. (https://www.cognition.com/blog/devin-fusion)
- ⚠️ **Aider architect/editor**: 설계 모델과 편집 모델을 짝지으면 대부분 단독보다 점수가 올랐다. (https://aider.chat/2024/09/26/architect.html)
- ⚠️ **Anthropic 멀티에이전트 조사 시스템**: 채팅 대비 에이전트는 토큰을 약 4배, 멀티에이전트는 약 15배 쓴다. (https://www.anthropic.com/engineering/multi-agent-research-system)
- ⚠️ **16개 병렬 Claude로 만든 C 컴파일러**: 세션 약 2,000개, $20,000가 들었다. 핵심 교훈은 검증기가 거의 완벽해야 한다는 것이다. (https://www.anthropic.com/engineering/building-c-compiler)
- ⚠️ **Claude Code 세션 포크**: `--resume`에 `--fork-session`을 붙이면 대화를 복사해 새 세션을 만들고 원본은 그대로 둔다. (https://code.claude.com/docs/en/sessions)

## 5. 문맥 증가 감시

- ⚠️ **Claude Code `/context`, `/usage`**: 사용량의 10% 넘게 차지하는 행동을 자동으로 짚는다. (https://code.claude.com/docs/en/costs)
- ⚠️ **OpenHands Condenser**: 압축하지 않으면 비용이 제곱으로 늘고, 압축하면 선형이 된다. API 비용 50% 절감을 보고했다.
- ⚠️ **Aider**는 자동 압축 없이 `/tokens`, `/drop` 같은 수동 명령만 둔다. 설계상 반대 선택이다.

## b-studio에 비춰 보면

| 기능 | b-studio |
|---|---|
| 이슈 → PR, 검증 게이트, PR 미리보기 | 있음 |
| 계획을 이슈로 발행, 토큰 보고서 | 있음 |
| 문맥 급증 원인 표시 | 이번에 추가(토큰 탭) |
| PR 자동 리뷰 1~2라운드 | 없음 |
| 머지 전 자동 rebase, 충돌 시 사람에게 | 없음 |
| 계획은 비싼 모델, 실행은 싼 모델 기본 라우팅 | 절반(싼 모델 → 비싼 모델 승급만 있고 꺼져 있음) |
| 반복 행동 → 스크립트 제안 | 없음 |
| 세션 포크 | 없음 |

## 추천 순서

1. 문맥 급증 원인 표시 (S)
2. PR 자동 리뷰 1~2라운드, 라운드 상한, 머지는 사람 (M)
3. 계획과 실행의 모델 나누기 (S~M). E 실험으로 성공률과 토큰을 잰다
4. 반복 행동을 스크립트로 바꾸자는 제안 (M)
5. 머지 전 자동 rebase, 충돌은 사람에게 (M)
6. 수십 세션 규모의 중간 오케스트레이터 (L)
