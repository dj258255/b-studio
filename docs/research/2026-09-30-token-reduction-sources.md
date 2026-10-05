# 에이전트 토큰 줄이기 — 빅테크 기술 블로그와 오픈소스 코드 조사

- 작성: 2026-09-30
- 상태: **검토 문서.** 결정은 실측(E6, #187) 뒤에 ADR로 남긴다
- 관련: 추적 #42, [E5 보고서](../experiments/2026-09-29-e5-light-verify.md), 앞선 검토 [2026-09-25 지식 공유·모델 교체](2026-09-25-knowledge-sharing-and-model-handoff.md)
- 표시: ✅ 원문을 직접 열어 수치를 대조한 출처 · ⚠️ 조사 에이전트가 읽은 요약만 확인한 출처(인용 전에 원문과 대조한다) · 🔎 코드에서 직접 읽은 값(커밋 고정 링크)

## 왜 조사했나

E3~E5에서 잰 사실은 다음과 같다.

- 작은 엮인 과제에서 b-studio(S0)는 성공 1건당 토큰이 그냥 Claude Code(P0)의 약 2배다(43.7만 대 21.8만).
- 토큰의 92~93%가 캐시 읽기이고, 합계는 거의 "모델 호출 수 × 문맥 크기"로 정해진다(호출당 약 1.9만).
- 검증 게이트를 건너뛰어도 토큰은 줄지 않는다. 게이트는 모델을 부르지 않는다(E5).
- 도구 결과 예산(자르기·반복 대체)은 캐시 읽기를 34% 줄였다(E3).

그래서 "호출마다 다시 읽히는 것"을 줄이는 방법을 다른 팀들이 어떻게 다루는지 찾았다.

## 조사하며 새로 알게 된 b-studio의 사실

- **구독 모드(로컬 Claude Code 러너)에서는 오래된 도구 결과 비우기가 동작하지 않는다.**
  - 묶어서 비우기(`packages/agent/src/context-clearing.ts`, 문맥 6만 토큰에서 발동, 최근 4개 유지)는 직접 API 루프(`loop.ts`)에만 있다.
  - Claude Code 러너는 대화 기록을 Claude Code가 관리해 b-studio가 고칠 수 없다. E5 18회에서 비운 횟수는 0이었다.
  - 한번 들어온 도구 결과는 실행이 끝날 때까지 매 호출 다시 읽힌다. 구독 모드에서 b-studio가 줄일 수 있는 것은 셋이다.
    - 도구가 돌려주는 결과의 크기
    - 시스템 프롬프트와 도구 설명(고정 문맥)
    - 호출 수
- b-studio 러너는 Claude Code의 기본 시스템 프롬프트 대신 자체 프롬프트를 쓰고, 내장 도구를 끈 채 자체 MCP 도구만 싣는다(`claude-code-runner.ts`). P0는 Claude Code 기본 프롬프트에 파일 도구 5개(`Read`·`Edit`·`Write`·`Glob`·`Grep`)를 싣는다. 어느 쪽 고정 문맥이 큰지는 재 봐야 안다(E6).

## 1. 호출마다 붙는 고정 문맥 줄이기

- ✅ Anthropic, [Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
  - 도구 정의를 미리 싣지 않고 검색해서 불러오는 Tool Search Tool: 토큰 사용 **85% 감소**. 정확도는 Opus 4가 49% → 74%, Opus 4.5가 79.5% → 88.1%였다.
  - 여러 도구 호출을 코드로 묶고 중간 결과를 모델에 보이지 않는 Programmatic Tool Calling: 복잡한 조사 과제에서 평균 43,588 → 27,297 토큰(**37% 감소**).
- ⚠️ Anthropic, [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp): 도구를 파일시스템의 코드로 노출해 필요한 정의만 읽게 하는 예시에서 150,000 → 2,000 토큰(98.7%).
- ⚠️ Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): 시스템 프롬프트는 "작고 신호가 높은 토큰"으로, 기능이 겹치는 도구를 두지 말 것(수치 없음).

## 2. 도구 결과 다루기

- ✅ Anthropic, [Managing context on the Claude Developer Platform](https://claude.com/blog/context-management)
  - 오래된 도구 호출·결과를 자동으로 지우는 context editing: 100턴 웹 검색 평가에서 **토큰 84% 감소**. 문맥이 바닥나 실패하던 작업도 끝까지 갔다.
  - 성능은 context editing만으로 29%, 메모리 도구와 함께 쓰면 39% 좋아졌다.
- ⚠️ Manus, [Context Engineering for AI Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
  - KV 캐시 적중률이 가장 중요한 단일 지표라고 한다. 앞부분을 바꾸지 않고 뒤에만 붙여 캐시를 지킨다.
  - 파일시스템을 외부 기억으로 쓰고, 문맥에는 경로만 남긴다.
  - 실패한 행동과 오류는 지우지 말고 남겨 다시 밟지 않게 한다.
- 🔎 오픈소스 코드 (값은 코드에서 읽음)
  - [gemini-cli `chatCompressionService.ts`](https://github.com/google-gemini/gemini-cli/blob/fe6350238c18/packages/core/src/context/chatCompressionService.ts)
    - 최근 3턴(`RECENT_TURNS_PROTECTED = 3`)의 도구 응답만 원문으로 둔다. 그 이전 응답은 2KB 미리보기와 생략 표시로 접는다.
    - `read_file`처럼 조회하는 도구는 접지 않는다.
    - 저장 단계에서 이미 64KB로 자른다.
  - [OpenCode `compaction.ts`](https://github.com/sst/opencode/blob/7945de208964/packages/opencode/src/session/compaction.ts): 최근 도구 출력 4만 토큰은 보호하고, 그 이전 것이 2만 토큰 넘게 쌓이면 원문을 지운다(`PRUNE_PROTECT`·`PRUNE_MINIMUM`). 이름은 달라도 b-studio의 묶어서 비우기와 같은 발상이다.
  - [Codex `output-truncation`](https://github.com/openai/codex/blob/d515b2f85ec1/codex-rs/utils/output-truncation/src/lib.rs): 가운데를 자르고 앞뒤를 남기며, 원래 토큰 수를 경고로 붙인다. b-studio도 이미 앞뒤를 남기고 "전체 N자 중 M자 생략"을 적는다.
  - [SWE-agent `history_processors.py`](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f3/sweagent/agent/history_processors.py): 최근 n개 관측만 남기는 프로세서가 "프롬프트 캐싱을 깬다"고 코드 주석에 스스로 적었다. 자르는 지점을 덜 자주 옮겨(`polling`) 캐시가 깨지는 빈도를 줄인다.

**공통점**: 앞쪽 기록을 고치면 그 지점부터 프롬프트 캐시가 깨진다. 그래서 두 방식 중 하나를 고른다.
- 정해진 때에만 드물게 지운다(OpenCode, gemini-cli, b-studio 묶어서 비우기).
- 압축을 아예 "새 대화 시작"으로 본다(Codex).

**결과를 처음부터 작게 돌려주는 것은 기록을 나중에 고치지 않으므로 캐시를 깨지 않는다.** 구독 모드에서 b-studio가 쓸 수 있는 유일한 방식이기도 하다.

## 3. 압축 뒤에도 지식 남기기

- ✅ 위 Anthropic context management 글: 메모리 도구(문맥 밖 파일)와 지우기를 함께 쓰면 성능이 39% 좋아졌다.
- ⚠️ LangChain, [Context engineering for agents](https://www.langchain.com/blog/context-engineering-for-agents): 원본을 다시 찾을 수 있게 남기는 압축(가역)을 먼저 하고, 되돌릴 수 없는 요약은 그다음에 한다. 가장 최근 도구 호출은 압축하지 않는다.
- 🔎 [gemini-cli 압축 프롬프트](https://github.com/google-gemini/gemini-cli/blob/fe6350238c18/packages/core/src/context/chatCompressionService.ts): 목표·제약·알아낸 것·바꾼 파일·최근 행동·남은 일을 정해진 틀(`<state_snapshot>`)로 요약한다. 문맥의 50%에서 앞 70%를 요약하고 뒤 30%는 원문으로 둔다.

## 4. 에이전트 사이 지식 공유

- ✅ Anthropic, [Patterns and problems in multiagent systems](https://www.anthropic.com/research/multiagent-systems)
  - 쏠림: 에이전트 30개 중 18개가 같은 브랜치 이름(`mvp-game-loop`)을 만들었다.
  - 숨은 정보 과제(각자 다른 비공개 정보를 가짐): 최신 모델 그룹은 약 85%, 다른 모델들은 17~36%였다. 혼자 풀 때의 상한은 100% 가까이다. **모두가 아는 정보로 수렴하는 문제는 모델이 좋아지면 줄어들지만 사라지지는 않았다.**
  - 협력하는 무리는 취약점 266개(2,700만 토큰), 독립 병렬은 21개(650만 토큰)를 찾았다. 공유가 탐색을 보완한 사례다. 다만 토큰도 4배 썼다.
- ⚠️ Cognition, [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)
  - 행동에는 암묵적 결정이 들어 있어, 서로 충돌하는 결정이 나쁜 결과를 낳는다고 본다.
  - 쪼갤 때는 요약이 아니라 전체 흔적을 공유하라고 한다.
- ⚠️ Cognition, [Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working): 쓰기는 한 줄기로 유지한다. 리뷰 에이전트는 사전 공유 없이 diff만 볼 때 가장 잘 찾았다고 한다.

b-studio와의 관계:
- E2에서 계약만 먼저 공유한 S2가 가장 좋았다(계약 공유 17/18 대 공유 없음 9/18).
- 게시판으로 더 많이 공유한 전략은 더 낫지 않았다.
- 위 출처들과 방향이 같다. **검증된 것(계약)과 실패는 공유하고, 검증되지 않은 성공은 퍼뜨리지 않는다.**

## 5. 모델 전환

- ✅ Cognition, [Devin Fusion](https://cognition.com/blog/devin-fusion)
  - "어차피 캐시가 깨지는 문맥 압축 때 모델을 바꾼다."
  - FrontierCode에서 최대 60% 비용 개선(회사 자체 벤치마크). 내부 사용자의 병합 PR 88%가 자동 라우터로만 진행됐다.
- 🔎 [Aider `architect_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f/aider/coders/architect_coder.py)
  - 설계는 주 모델이, 실제 편집은 `editor_model`이 한다.
  - 편집 쪽에는 저장소 지도를 다시 만들지 않고(`map_tokens=0`) 캐시도 기대하지 않는다(`cache_prompts=False`).

b-studio와의 관계:
- E4의 "Haiku로 시작해 실패하면 Sonnet으로 올리기"는 1/9로 나빴다. 위 두 출처는 **반대 방향**이다.
  - 실패 뒤에 올리는 것이 아니라, 단계가 바뀌는 때에 바꾼다.
  - 비싼 모델이 계획하고 싼 모델이 따른다.
- 그래서 E4 결과로 이 방식까지 나쁘다고 볼 수는 없다. 따로 재야 한다.

## 6. 외부 검증기가 있을 때 에이전트의 자가 확인

- 에이전트가 스스로 다시 확인하는 호출을 줄이면 토큰이 준다는 **정량 근거는 찾지 못했다.**
- ⚠️ Anthropic의 [multi-agent research system](https://www.anthropic.com/engineering/built-multi-agent-research-system)은 인용 검증을 별도 에이전트로 뗀 사례를 든다. 다만 근거가 토큰이 아니라 정확도다.
- b-studio에서 직접 재야 한다(E6 도구별 재읽기에서 `restart_service`·`http_request`·`run_in_service`의 몫).

## b-studio에 적용할 후보 (E6 실측으로 순서를 확정한다)

| 후보 | 근거 | 구독 모드 적용 | E6에서 볼 값 |
|---|---|---|---|
| A. 큰 도구 결과를 작업 공간 파일로 빼고 앞뒤 요약 + 경로만 돌려주기 | Manus, Anthropic code execution with MCP | 됨(도구가 b-studio 것) | 도구별 결과 재읽기 중 `run_in_service`·`service_logs`의 몫 |
| B. 고정 문맥 줄이기(시스템 프롬프트·도구 설명 다이어트, 단계별 도구) | Anthropic advanced tool use(85%) | 됨 | 세션 첫 호출 문맥 × 호출 수의 몫, P0와 비교 |
| C. 게이트와 겹치는 자가 확인 줄이기(안내 문구) | 근거 약함 | 됨 | 자가 확인 도구의 호출 수·재읽기 |
| D. 단계 경계에서 싼 모델로 전환 | Devin Fusion, Aider | 레인·통합 세션 단위로만 됨 | 토큰보다 성공률 실험(별도) |
| E. 검증된 계약과 실패만 공유 | Anthropic 다중 에이전트, E2 | 됨 | 성공률 실험(별도) |

## 근거가 약하거나 충돌하는 주장

- FrugalGPT(최대 98%)·RouteLLM(85% 이상) 같은 라우팅 논문 수치는 질문·답 벤치마크의 값이다. 코딩 에이전트 작업에 그대로 옮길 수 없다. 이번에 읽은 공식 블로그에서 이 논문들을 직접 인용한 곳도 확인하지 못했다.
- "싼 모델로 시작"과 "단계별 전환"이 한데 묶여 소개되는 경우가 많지만, 둘은 다른 메커니즘이다(위 5절).
- 공유는 무조건 좋지 않다.
  - Anthropic의 무리 실험은 공유로 더 많이 찾았지만 토큰을 4배 썼다.
  - Cognition의 리뷰 에이전트는 공유가 없을 때 더 잘 찾았다.
  - 따라서 무엇을 공유하느냐의 문제다.
