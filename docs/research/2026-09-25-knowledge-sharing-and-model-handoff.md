# 에이전트 간 지식 공유, 가벼운 통신 도구, 작업 중 모델 교체 — 아이디어 검토

- 작성: 2026-09-25
- 상태: **검토 문서.** 결정은 아니다. 결정은 실험 E1(#45) 결과를 본 뒤 ADR로 남긴다
- 관련: 추적 #42, 측정 도구 #44·#49, 실험 #45, Codex 백엔드 #48
- 표시: ✅ 원문을 직접 열어 확인한 출처 · ⚠️ 검색 요약·초록만 확인한 출처. ⚠️ 수치는 인용 전에 원문과 대조한다

## 검토한 문장

1. 에이전트끼리 필요한 지식을 적당한 양만 공유하게 해서, 새로운 탐색은 줄이지 않고 실패만 줄이는 식으로 지식을 공유한다
2. 기존 에이전트 간 통신 도구는 이 목적에 쓰기 불편해서, 필요한 만큼만 동작하는 가벼운 도구를 만든다
3. 같은 기능을 처음부터 끝까지 비싼 모델로 만들지 않고, 적당한 시점에 싸고 빠른 모델로 바꿔 더 싸고 빠르게 만든다

## 결론 먼저

| | 판정 | 이유 한 줄 |
|---|---|---|
| 1. 적당한 양의 지식 공유 | **가장 가치 있다. 중심 문제로 삼는다** | 공유를 늘리면 실패는 줄지만 토큰이 늘고 탐색의 독립성이 줄어든다. 실제로 부딪히는 트레이드오프이고 실험 없이는 정할 수 없다 |
| 2. 가벼운 통신 도구 | **따로 내세우지 않는다. 1번을 실험하는 수단으로 둔다** | 구현 자체는 AI가 금방 만든다. 가치는 전송 방식이 아니라 "무엇을 통과시키는가"의 규칙에 있고, 그 규칙이 1번이다 |
| 3. 작업 중 모델 교체 | **가치 있다. 1번 다음 순서로 둔다** | 패턴 자체는 이미 알려져 있다(Aider architect/editor, Claude Code opusplan, FrugalGPT). 주장할 수 있는 것은 "작업 도중 교체"를 같은 과제·같은 검증기로 잰 수치뿐이다 |

세 가지는 한 문제로 이어진다. **싼 모델이 끝까지 해내려면 무엇을 알고 시작해야 하는가**다. 이렇게 묶으면 1번의 공유 형식이 3번의 교체 시점에 넘기는 내용이 되고, 2번은 그 형식을 담는 그릇이 된다.

단, 세 문장 모두 지금은 **주장이 아니라 가설**이다. "실패만 줄였다", "탐색은 줄지 않았다", "더 싸고 빨랐다"는 아래에서 정의한 지표로 재기 전에는 쓸 수 없다.

---

## 1. 적당한 양의 지식 공유

### 1.1 이 저장소에서 "공유"가 필요한 곳은 세 군데이고, 목적이 서로 반대다

| 곳 | 지금 상태 | 공유의 목적 | 너무 많이 공유하면 |
|---|---|---|---|
| 작업 분해의 병렬 레인 (ADR-051) | 레인끼리 아무것도 넘기지 않는다. 같은 레인 안의 다음 작업은 앞 작업의 제목과 대화 기록 전체를 받는다 | **맞물리기.** api 레인과 web 레인이 같은 필드 이름을 쓰게 | 병렬로 나눈 의미가 사라지고 사실상 직렬화된다 |
| Agent Fleet 후보 (ADR-048) | 후보끼리 아무것도 넘기지 않는다 | **독립.** 서로 다른 구현이 나와야 비교할 가치가 있다 | 후보들이 같은 답으로 수렴한다. 비교 대상이 사라진다 |
| 같은 세션의 게이트 재시도 | 게이트 실패 내용을 다음 사용자 메시지로 넣는다 | **같은 실패 반복 방지** | 대화가 길어져 호출당 입력 토큰이 커진다 |

그래서 "적당한 양"은 하나의 숫자가 아니다. **목적에 따라 공유의 방향이 반대**다. 이 점이 이 아이디어를 정답이 있는 문제가 아니라 판단이 필요한 문제로 만든다.

### 1.2 "탐색은 줄이지 않고 실패만 줄인다"를 재려면

지금 문장은 측정할 수 없다. 두 단어를 이 저장소의 관측값으로 바꾼다.

| 말 | 이 저장소에서 재는 값 | 어디서 얻나 |
|---|---|---|
| 실패 | 게이트 실패 횟수(`verifyAttempts`), 작업 분해 통합 게이트 실패, 벤치마크 수용 확인 실패, **같은 실패 서명의 반복 횟수** | B16 지표, `bench:coordination` 원자료 |
| 실패 서명 | (게이트 단계, 서비스, 오류 메시지 첫 줄을 정규화한 값, 관련 파일) | 게이트 보고서에서 만든다 |
| 탐색 | 레인·후보가 읽은 서로 다른 파일 수, 도구 호출 중 읽기 도구 비율 | 도구 이벤트 기록 |
| 탐색의 독립성 (Fleet) | 후보 사이 변경 파일 집합의 차이, 변경 줄의 차이 | 후보 체크포인트 diff |
| 공유 비용 | 공유 메시지 수·바이트, 받은 쪽 호출당 입력 토큰 증가분 | 게시판 기록, B16 지표 |

이렇게 바꾸면 문장은 가설이 된다.

> H4. 실패 서명과 인터페이스 계약만 공유하면, 아무것도 공유하지 않을 때보다 통합 실패와 같은 실패 서명의 반복이 줄고, 레인이 읽는 파일 수와 Fleet 후보 사이 차이는 줄지 않는다. 공유 비용은 레인당 입력 토큰 기준 X% 이하다.

X는 E1에서 잰 기준선을 보고 정한다. 지금 정하면 숫자를 지어내는 것이다.

### 1.3 무엇을 넘기고 무엇을 넘기지 않나 (제안)

| 넘긴다 | 이유 |
|---|---|
| 인터페이스 계약 (경로, 필드, 타입) — **산출물 참조로** | 레인이 맞물리는 데 필요한 최소 정보. 계약 본문이 아니라 체크포인트 SHA와 파일 경로를 넘긴다 |
| 검증기가 만든 실패 서명 | 모델의 추측이 아니라 결정론적 검증기(재기동·계약·테스트)가 관측한 사실이다 |
| 환경 사실 (서비스 주소, 명령, 포트) | 모든 레인이 같은 사실을 따로 알아내는 중복 탐색을 줄인다 |

| 넘기지 않는다 | 이유 |
|---|---|
| 풀이·diff 전체·대화 기록 | 받는 쪽이 같은 풀이로 수렴하고(Fleet의 독립성 손실), 입력 토큰이 커진다 |
| 모델의 "이렇게 하면 될 것 같다" 같은 추측 | 틀린 추측이 여러 레인으로 번진다. 검증을 통과한 사실만 넘긴다 |
| Fleet 후보 사이의 구현 내용 | 독립이 목적이다. 넘긴다면 실패 서명만 넘긴다 |

### 1.4 업계는 이미 무엇을 알고 있나

| 알려진 것 | 누가 | 이 계획에 주는 뜻 | 출처 |
|---|---|---|---|
| 하위 에이전트는 결과를 파일·산출물로 남기고 주 에이전트에는 가벼운 참조만 넘긴다. 전화 게임(game of telephone)을 피하기 위해서다 | Anthropic | 산출물 참조 방식의 직접 선례 | [multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) ✅ |
| 멀티 에이전트는 채팅의 약 15배 토큰을 쓰고, BrowseComp에서 토큰 사용량이 성능 분산의 약 80%를 설명한다 | Anthropic | 공유는 공짜가 아니다. 공유 비용을 반드시 같이 잰다 | 같은 글 ✅ |
| 하위 에이전트가 수만 토큰을 탐색해도 주 에이전트에는 1,000~2,000토큰 요약만 돌려준다 | Anthropic | "적당한 양"의 업계 기준점 하나 | [effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) ✅ |
| 코드를 쓰는 일은 병렬화가 어렵다. 행동에 암묵적 결정이 담겨 있어, 문맥을 공유하지 않은 하위 에이전트들이 서로 맞지 않는 결과를 만든다 | Cognition | S1(격리 병렬)이 실패할 것이라는 H1의 근거 | [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) ✅ |
| 약 10개월 뒤 수정: 쓰기는 한 흐름에 두면 멀티 에이전트가 동작한다. 리뷰 에이전트는 **작성자의 문맥을 공유하지 않을 때** 더 잘 잡는다 | Cognition | 공유의 방향이 목적에 따라 반대라는 1.1의 근거 | [multi-agents working](https://cognition.com/blog/multi-agents-working) ✅ |
| 실패한 행동을 문맥에서 지우지 않아야 같은 실수를 반복하지 않는다 | Manus | 실패 서명 공유의 근거(단, 한 에이전트 안에서) | [Context Engineering: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) ✅ |
| 읽기 작업은 병렬화가 잘 되고 쓰기 작업은 어렵다. 하위 에이전트에는 겹치지 않는 범위를 명시한다 | LangChain | ADR-051 쓰기 범위 분리와 같은 결론 | [How and when to build multi-agent systems](https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems) ✅ |
| 문맥 관리 4가지: 쓰기·고르기·압축·격리 | LangChain | 공유 설계를 설명하는 용어 | [Context engineering for agents](https://www.langchain.com/blog/context-engineering-for-agents) ✅ |
| 멀티 에이전트 실패 1,600여 건 중 에이전트 간 불일치가 36.94% | UC Berkeley MAST | 공유가 부족할 때의 실패 비중 | [MAST](https://sites.google.com/berkeley.edu/mast/home) ✅, [arXiv 2503.13657](https://arxiv.org/abs/2503.13657) |
| 이전 시도의 실패를 말로 된 반성으로 남겨 다음 시도에 넣는다 | Reflexion | 실패 서명의 선행 연구(한 에이전트의 다음 시도) | [arXiv 2303.11366](https://arxiv.org/abs/2303.11366) ⚠️ |
| 과거 궤적에서 재사용할 작업 흐름을 뽑아 다음 작업에 선택적으로 넣는다 | Agent Workflow Memory | "원자료 대신 걸러낸 것만" 넣는 선례 | [arXiv 2409.07429](https://arxiv.org/abs/2409.07429) ⚠️ |
| 긴밀하게 조율하는 구조일수록 결과의 다양성이 줄어든다 | 2026 연구 | Fleet에 공유를 넣으면 안 되는 이유 | [arXiv 2604.18005](https://arxiv.org/html/2604.18005v2) ✅ (단일 논문, 재현 여부 미확인) |

### 1.5 이 저장소가 새로 주장할 수 있는 것과 없는 것

- **주장하지 않는다**: "요약·참조로 공유하면 싸다", "문맥을 공유하지 않으면 코딩 하위 에이전트가 어긋난다", "실패를 남기면 반복이 준다". 모두 위에 선례가 있다
- **주장할 수 있다 (측정한 뒤에만)**:
  - 쓰기 범위를 나눈 병렬 코딩 레인에서, **결정론적 검증기가 만든 실패 서명만** 레인 사이에 공유했을 때의 효과. 조사 범위에서 레인 사이(시도 사이가 아니라) 실패 공유를 잰 사례는 찾지 못했다
  - "공유한 바이트·토큰"과 "통합 실패 감소" 사이의 관계를 전략별로 잰 곡선. 이 곡선도 조사 범위에서 찾지 못했다
  - 같은 공유 규칙이 레인(맞물림)에는 도움이 되고 Fleet(독립)에는 해가 되는지
- "찾지 못했다"는 "없다"가 아니다. 문서에는 조사 범위를 함께 적는다

### 1.6 기존 실험 계획과의 관계

E1(#45)은 S0(직렬화)과 S1(격리 병렬)만 잰다. 이 문서의 1번은 M3 전략 목록을 다음처럼 바꾸자는 제안이다.

| 전략 | 공유하는 것 | 1번과의 관계 |
|---|---|---|
| S0 직렬화 | 대화 기록 전체 (같은 세션) | 공유 최대치의 기준선 |
| S1 격리 병렬 | 없음 | 공유 최소치의 기준선 |
| S2 계약 먼저 | 계획 단계가 낸 인터페이스 계약 (산출물 참조) | 1.3 "인터페이스 계약" |
| S3 게시판 | 레인이 쓰는 자유 메모 | 비교군. 자유 메모가 범위를 넘는지 본다 |
| **S5 실패 서명만** (신규) | 다른 레인·이전 시도의 검증기 실패 서명 | 1번 문장을 가장 직접 시험한다 |
| S4 통합 후 수리 | 통합 게이트 실패를 한 번 더 모델에 | 실패가 난 뒤에만 비용을 내는 대조군 |

E1에서 H1이 틀리면(S1도 엮인 과제를 잘 맞추면) 레인 사이 공유는 필요가 약해진다. 그래도 **같은 세션 재시도**와 **Fleet**에서 1번을 시험할 수 있으므로 1번 자체가 사라지지는 않는다. 범위가 좁아질 뿐이다.

---

## 2. 가벼운 통신 도구

### 2.1 "기존 도구가 불편하다"를 구체적으로

면접에서 가장 먼저 받을 질문은 "왜 A2A나 기존 프레임워크를 쓰지 않았나"다. "불편해서"로는 답이 되지 않는다. 설계 대상이 다르다는 것을 근거로 답한다.

| 선택지 | 설계 대상 | 이 저장소의 레인에 맞지 않는 점 | 출처 |
|---|---|---|---|
| A2A | 서로 다른 회사·프레임워크의 불투명한 에이전트끼리 협업. Agent Card, 작업 상태 머신, JSON-RPC over HTTPS, 인증 | 레인은 같은 프로세스·같은 신뢰 경계 안에 있다. 발견·인증·전송이 필요 없고, 필요한 것은 무엇이 통과하는지의 **정책**이다 | [What is A2A](https://a2a-protocol.org/latest/topics/what-is-a2a/) ✅ |
| MCP | 에이전트 ↔ 도구 (A2A 문서 표현으로 "수직") | 에이전트끼리의 대화 수단이 아니다. 단, 게시판을 **도구로** 노출하는 데는 이미 쓰고 있다(로컬 CLI 러너가 b-studio 도구를 MCP로 넘김) | [A2A and MCP](https://a2a-protocol.org/latest/topics/a2a-and-mcp/) ✅ |
| AutoGen topic·subscription | 같은 런타임 안의 발행·구독 | 런타임과 액터 모델을 새로 들여와야 한다. AutoGen은 유지보수 단계로 넘어갔다 | [topic and subscription](https://microsoft.github.io/autogen/stable//user-guide/core-user-guide/core-concepts/topic-and-subscription.html) ⚠️ |
| 공유 파일·산출물 | 같은 팀·같은 런타임의 에이전트 | 가장 가깝다. Anthropic·Manus가 쓰는 방식 | 1.4 표 |

Microsoft Agent Framework 안내도 같은 결론이다. 같은 프로세스·같은 팀이면 "도구로서의 에이전트"가 더 단순하고, A2A는 프로세스·서비스·조직 경계를 넘을 때 가치가 있다고 한다 ([agent-to-agent](https://learn.microsoft.com/en-us/agent-framework/journey/agent-to-agent) ⚠️).

### 2.2 최소 설계 (제안)

전송은 이미 있는 것을 쓴다. 새로 만드는 것은 **통과 규칙**이다.

- 저장: 작업 계획 기록 옆 파일 하나(추가만 가능). 계획이 끝나면 함께 남아 나중에 다시 볼 수 있다
- 도구 두 개: `post_note(kind, body, refs)`, `read_notes(kinds?)`. 기존 도구 정책(허용 도구 목록)을 그대로 탄다
- 종류는 셋만: `contract`(인터페이스, 산출물 참조 필수), `failure`(검증기 실패 서명, 플랫폼만 쓴다), `fact`(환경 사실)
- 상한: 메모 하나 2KB, 레인당 쓰기 N개, 읽을 때 최근 M개. 넘으면 거부하고 이유를 돌려준다
- 출처: 누가(레인·작업), 언제, 어느 체크포인트에서 썼는지
- 가림: 기존 시크릿 가림을 통과한 뒤 저장
- 받기 방식: 필요할 때 읽는다(pull). 밀어 넣으면(push) 모든 레인의 입력이 커진다
- `failure`는 모델이 쓰지 못하게 한다. 검증기가 쓴다. 이것이 "추측은 넘기지 않는다"를 코드로 강제하는 곳이다

### 2.3 포트폴리오에서 조심할 표현

- 쓰지 않는다: "에이전트 간 통신 프로토콜을 만들었다", "경량 메시지 버스"
- 쓴다: "같은 신뢰 경계 안의 레인에는 발견·인증·전송이 필요 없어 A2A 대신 계획 단위 게시판 도구 두 개를 두었고, 무엇이 통과하는지를 종류·크기·작성자 규칙으로 제한했다. 그 규칙이 통합 실패와 토큰에 준 영향은 …"

---

## 3. 작업 중 모델 교체

### 3.1 이미 알려진 패턴

| 패턴 | 누가 | 언제 바꾸나 | 보고된 수치 | 출처 |
|---|---|---|---|---|
| architect / editor | Aider | 강한 모델이 풀이를 쓰고 다른 모델이 편집으로 옮긴다. 턴마다 두 번 호출 | o1-preview + o1-mini 조합 85.0% (자체 133문항) | [aider.chat architect](https://aider.chat/2024/09/26/architect.html) ✅ |
| opusplan | Claude Code | 계획 모드에서만 Opus, 실행에 들어가면 Sonnet | 수치 없음 | [model config](https://code.claude.com/docs/en/model-config) ✅ |
| 하위 에이전트 기본 Haiku | Claude Code | 모델을 지정하지 않은 하위 에이전트와 배경 작업 | 수치 없음 | [sub-agents](https://code.claude.com/docs/en/sub-agents) ✅ |
| 빠른 적용 모델 | Cursor | 최상위 모델이 수정을 계획하고, 작은 미세조정 모델이 파일을 다시 쓴다 | 약 1,000 tok/s, 기존 대비 약 13배 | [Instant Apply](https://cursor.com/blog/instant-apply) ✅ |
| 빠른 탐색 하위 에이전트 | Cognition SWE-grep | 파일 찾기만 작은 RL 모델에 맡긴다 | 약 20배 빠른 탐색 | [SWE-grep](https://cognition.com/blog/swe-grep) ⚠️ |
| 연쇄(cascade) | FrugalGPT | 싼 모델부터, 점수가 낮으면 다음 모델로 | 최대 98% 비용 절감 (벤치마크별) | [arXiv 2305.05176](https://arxiv.org/abs/2305.05176) ✅ |
| 사전 라우팅 | RouteLLM | 생성 전에 강한/약한 모델 선택 | MT-Bench 85% 이상 비용 절감 | [LMSYS](https://www.lmsys.org/blog/2024-07-01-routellm/) ✅ |
| 같은 계열 안 라우팅 | AWS Bedrock | 요청마다 작은/큰 모델 | Anthropic 계열 평균 56% 절감 | [AWS blog](https://aws.amazon.com/blogs/machine-learning/use-amazon-bedrock-intelligent-prompt-routing-for-cost-and-latency-benefits/) ✅ |
| 자기 검증 뒤 승격 | AutoMix | 작은 모델 답을 자기 검증해 승격 여부 결정 | 50% 이상 비용 절감 | [arXiv 2310.12963](https://arxiv.org/abs/2310.12963) ⚠️ |

위 수치는 각 벤치마크·모델 조합·요청 분포에 묶인 값이다. **이 저장소의 기대 절감률로 옮겨 쓰지 않는다.**

주의할 점이 하나 있다. 위 수치 대부분은 **생성 전에 요청마다** 모델을 고르는 방식이다. 이 저장소의 멀티 모델 라우터(ADR-047)도 요청 단위다. 3번 문장이 말하는 **한 작업 도중의 교체**(문맥을 들고 넘어가는 것)를 같은 작업 항목으로 잰 수치는 조사 범위에서 찾지 못했다.

### 3.2 교체 시점 후보

| 방식 | 싼 모델이 하는 일 | 비싼 모델이 하는 일 | 바꾸는 신호 |
|---|---|---|---|
| A. 계획 후 교체 (opusplan형) | 구현·반복 수정 | 계획·쓰기 범위 결정 | 계획 승인 |
| B. 실패 시 승격 (cascade형) | 처음 시도 | 게이트 실패가 N번 반복될 때부터 | **검증기 실패** |
| C. 탐색 위임 (SWE-grep형) | 파일 찾기·읽기 | 구현 | 도구 종류 |

이 저장소에 가장 자연스러운 것은 **B**다. 승격 여부를 모델의 자기 평가(AutoMix)나 학습된 점수(FrugalGPT)가 아니라 **결정론적 검증기**가 정한다. 연쇄 방식의 약점으로 꼽히는 "싼 검증기의 사각지대"([arXiv 2609.01345](https://arxiv.org/pdf/2609.01345) ⚠️)를 줄일 수 있는 조건이다. 다만 게이트가 통과시킨 잘못된 구현(제품 적합성)은 여전히 못 잡는다(ADR-048 한계와 같다).

### 3.3 교체의 비용 (감수해야 하는 것)

- **프롬프트 캐시는 모델마다 따로다.** 모델을 바꾸면 쌓인 캐시를 쓰지 못하고 새 모델에서 다시 쓴다. 모델마다 최소 캐시 길이와 캐시 읽기 단가도 다르다 ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) ✅). 짧은 작업에서는 교체 비용이 절감분보다 클 수 있다
- **넘기는 내용이 곧 품질이다.** 새 모델이 대화 기록 전체를 받으면 캐시 없이 큰 입력을 다시 읽고, 요약만 받으면 앞 모델이 알던 것을 잃는다. 여기서 1번의 공유 형식(계약 참조 + 실패 서명 + 환경 사실)을 그대로 쓴다
- **승격 임계치.** N을 작게 잡으면 거의 항상 비싼 모델로 넘어가 절감이 사라지고, 크게 잡으면 싼 모델이 헛돈다. 이것도 실험으로 정한다

### 3.4 구독 제약 아래서 잴 수 있나

잴 수 있다. 로컬 Claude Agent 러너는 모델 이름을 받을 수 있고(`B_STUDIO_CLAUDE_CODE_MODEL`, #49), 한 구독에서 Haiku·Sonnet·Opus를 모두 쓸 수 있다. 비용은 청구가 없으므로 **API 단가 환산 추정치**로만 적는다. 대신 두 가지를 기록한다.

- 모델마다 구독 사용 한도가 다르게 줄어든다. 한도에 걸린 실행은 `rate_limited`로 따로 분류한다(#49)
- 로컬 러너는 모델 응답 대기 시간을 재지 못한다(`modelMs` = 0). "더 빠르다"는 종단 시간(벽시계)으로만 말한다

> H5. 같은 과제에서 "싼 모델로 시작하고 게이트가 같은 실패 서명을 두 번 내면 비싼 모델로 승격"하는 방식은, 처음부터 비싼 모델을 쓸 때보다 API 단가 환산 비용이 낮고 통합 성공 건수는 같다. 종단 시간은 승격이 일어난 실행에서 더 길 수 있다.

---

## 4. 평가 기준에 대어 본 표

| 질문 | 1. 공유 | 2. 통신 도구 | 3. 모델 교체 |
|---|---|---|---|
| AI에게 며칠 맡기면 나오는가 | 코드는 나온다. **무엇을 넘길지는 실험 없이 못 정한다** | 나온다 | 코드는 나온다. **언제 바꿀지는 실험 없이 못 정한다** |
| 실제 트레이드오프가 있나 | 실패 ↔ 토큰 ↔ 독립성 | 약하다(1번의 규칙이 전부) | 비용 ↔ 캐시 손실 ↔ 성공률 ↔ 시간 |
| 정답이 정해진 문제인가 | 아니다. 목적(맞물림/독립)에 따라 반대 | 설계 대상 비교로 거의 정해진다(A2A는 경계 밖용) | 아니다. 과제 길이·실패 빈도에 따라 달라진다 |
| 기반 지식이 쓰이나 | 캐시·문맥 크기, 분산 시스템의 공유 상태와 일관성 | 신뢰 경계, 인증이 필요 없는 조건 | 캐시 적중률, 지연과 처리량 구분 |
| 측정 가능한가 | 예. 벤치 + 게이트 | 해당 없음(1번으로 잰다) | 예. 벤치 + 게이트 + 구독 |
| 과장 위험 | "탐색은 안 줄었다"를 재지 않고 쓰는 것 | "프로토콜을 만들었다" | 남의 절감률을 옮겨 쓰는 것 |

---

## 5. 제안하는 순서와 예상

| 순서 | 할 일 | 예상 | 불확실성 |
|---|---|---|---|
| 1 | E1: S0·S1 기준선 (#45, 진행 대기) | 기계 시간 2~5시간 | Docker를 비울 시간대, 구독 한도 |
| 2 | 레인 도구 기록 확장: 읽은 파일 수·실패 서명을 원자료에 남김 (1.2 지표) | 2~3시간 | 실패 서명 정규화 규칙 |
| 3 | M3 재정의: S2·S5를 먼저, S3는 비교군. 게시판(2.2) 구현 | 1~2일 | E1 결과에 따라 범위가 줄 수 있다 |
| 4 | E2: 전략 비교 + Fleet에 실패 서명 공유를 넣었을 때 후보 차이 | 기계 시간 5~10시간 | 반복 수가 작아 효과가 작으면 구분이 안 될 수 있다 |
| 5 | M5 모델 교체: 방식 B(실패 시 승격) 구현과 E3 | 1~2일 + 기계 시간 | 모델별 구독 한도, 캐시 손실 크기 |
| 6 | ADR(공유 규칙, 교체 규칙), 실험 보고서 | 반나절 | — |

E1 결과가 나오면 이 표의 3~5번 예상을 다시 적는다.

---

## 6. 포트폴리오 문장 (측정 뒤 채울 틀)

나쁜 예:
> 에이전트끼리 필요한 지식만 공유하는 경량 통신 도구를 만들어 실패를 줄이고, 싼 모델로 교체해 비용을 절감했습니다.

무엇을 얼마나 줄였는지, 무엇을 포기했는지, 왜 그 방식인지가 없다.

나은 예 (숫자는 측정 뒤 채운다):
> 쓰기 범위를 나눈 병렬 코딩 레인은 서로의 변경을 보지 못해, 인터페이스로 엮인 과제 □건 중 □건이 통합 게이트에서 실패했습니다. 대화 기록을 모두 넘기면(직렬화) 실패는 □건으로 줄었지만 종단 시간이 □배, 레인당 입력 토큰이 □배 늘었습니다. 검증기가 만든 실패 서명과 인터페이스 계약 참조만 넘기도록 제한하자 통합 실패는 □건, 입력 토큰 증가는 □%였고, 레인이 읽은 파일 수는 줄지 않았습니다. 같은 규칙을 Agent Fleet에 넣으면 후보 사이 변경 차이가 □% 줄어, Fleet에는 넣지 않았습니다.

---

## 7. 다른 해석: ML 파이프라인을 개선하는 이야기일 수도 있다

세 문장은 에이전트 개발 도구가 아니라 **ML 파이프라인**(데이터 → 학습 → 평가 → 서빙) 이야기로도 읽힌다. 어느 쪽인지에 따라 무엇을 재야 하는지가 달라서, 원래 말한 사람에게 확인할 가치가 있다.

| 문장 | 에이전트 개발 도구로 읽으면 (이 문서 1~6절) | ML 파이프라인으로 읽으면 |
|---|---|---|
| 1. 적당한 양의 공유 | 병렬 코딩 레인이 계약·실패 서명만 공유 | 여러 실험(또는 실험을 돌리는 여러 에이전트)이 **실패한 구성·원인**을 공유해 같은 실패를 반복하지 않되, 탐색 공간은 좁히지 않는다. 병렬 하이퍼파라미터 탐색·population-based training에서 오래된 긴장(활용 ↔ 탐색)과 같다 |
| 2. 가벼운 통신 도구 | A2A 대신 계획 단위 게시판 | 무거운 실험 추적 플랫폼·오케스트레이터 대신, 실험끼리 필요한 것만 주고받는 가벼운 기록·조회 층 |
| 3. 싼 모델로 교체 | 작업 도중 LLM을 싼 것으로 바꿈 | 서빙 단의 연쇄(cascade)·추측 디코딩, 또는 학습 파이프라인에서 싼 대리 평가(작은 모델·일부 데이터)로 먼저 거르고 유망한 것만 비싼 평가로 올리는 것 |

두 해석은 같은 뼈대를 공유한다. **병렬 탐색에서 무엇을 공유해야 실패는 줄고 다양성은 남는가, 그리고 비싼 자원은 언제 쓰는가.** 차이는 검증기다.

- 에이전트 개발 도구: 검증기가 결정론적이다(재기동·계약·테스트). 한 번 실행으로 성공/실패가 정해진다
- ML 파이프라인: 검증 지표에 잡음이 있다(시드, 데이터 분할). 실패 서명을 공유할 때 "진짜 나쁜 구성"과 "운 나쁜 시드"를 구분해야 하고, 그래서 공유가 탐색을 잘못 좁힐 위험이 더 크다

b-studio에서 이어 가려면 첫 번째 해석이 맞다. 결정론적 검증기가 이 저장소의 가장 큰 자산이기 때문이다. 두 번째 해석이 원래 뜻이었다면, 1번은 "실험 기록의 공유 범위" 문제로, 3번은 "대리 평가 → 본 평가 승격 규칙" 문제로 옮겨 같은 틀(정의 → 가설 → 선택지 → 측정)을 쓸 수 있다. 이 절의 ML 쪽 서술은 일반적인 설명이며, 이번 조사에서 출처를 따로 확인하지 않았다.

---

## 출처

✅ 직접 확인 · ⚠️ 요약·초록만

- Anthropic, [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) ✅ · [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) ✅ · [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) ⚠️ · [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) ✅
- Claude Code 문서, [Model configuration](https://code.claude.com/docs/en/model-config) ✅ · [Sub-agents](https://code.claude.com/docs/en/sub-agents) ✅
- Cognition, [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) ✅ · [Multi-agents working](https://cognition.com/blog/multi-agents-working) ✅ · [SWE-grep](https://cognition.com/blog/swe-grep) ⚠️
- Manus, [Context Engineering for AI Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) ✅
- LangChain, [Context engineering for agents](https://www.langchain.com/blog/context-engineering-for-agents) ✅ · [How and when to build multi-agent systems](https://www.langchain.com/blog/how-and-when-to-build-multi-agent-systems) ✅
- Google, [A2A](https://a2a-protocol.org/latest/topics/what-is-a2a/) ✅ · [A2A and MCP](https://a2a-protocol.org/latest/topics/a2a-and-mcp/) ✅ · [ADK state](https://google.github.io/adk-docs/sessions/state/) ⚠️ · [Speculative cascades](https://research.google/blog/speculative-cascades-a-hybrid-approach-for-smarter-faster-llm-inference/) ⚠️
- OpenAI, [Agents SDK handoffs](https://openai.github.io/openai-agents-python/handoffs/) ⚠️ · [Swarm](https://github.com/openai/swarm) ⚠️
- Microsoft, [AutoGen topic and subscription](https://microsoft.github.io/autogen/stable//user-guide/core-user-guide/core-concepts/topic-and-subscription.html) ⚠️ · [Agent Framework: agent-to-agent](https://learn.microsoft.com/en-us/agent-framework/journey/agent-to-agent) ⚠️
- Aider, [Separating code reasoning and editing](https://aider.chat/2024/09/26/architect.html) ✅ · Cursor, [Instant Apply](https://cursor.com/blog/instant-apply) ✅
- AWS, [Bedrock intelligent prompt routing](https://aws.amazon.com/blogs/machine-learning/use-amazon-bedrock-intelligent-prompt-routing-for-cost-and-latency-benefits/) ✅ · LMSYS, [RouteLLM](https://www.lmsys.org/blog/2024-07-01-routellm/) ✅
- 논문: FrugalGPT [2305.05176](https://arxiv.org/abs/2305.05176) ✅ · AutoMix [2310.12963](https://arxiv.org/abs/2310.12963) ⚠️ · Reflexion [2303.11366](https://arxiv.org/abs/2303.11366) ⚠️ · Agent Workflow Memory [2409.07429](https://arxiv.org/abs/2409.07429) ⚠️ · MAST [2503.13657](https://arxiv.org/abs/2503.13657) ([사이트](https://sites.google.com/berkeley.edu/mast/home) ✅) · 조율과 다양성 [2604.18005](https://arxiv.org/html/2604.18005v2) ✅ · Cheap verifiers [2609.01345](https://arxiv.org/pdf/2609.01345) ⚠️
