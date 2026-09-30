# 협업 벤치마크 (`pnpm bench:coordination`)

작업 분해 전략(S0~S5)과 기준선(P0)을 같은 과제·같은 모델로 반복 실행해 비교할 원자료를 남깁니다.

- **P0 기준선(그냥 Claude Code)**: 작업 분해·조율 없이 Claude Code 하나가 과제 전체를 한 번에 처리합니다. `--backend claude-code` 전용입니다.
- **S0 직렬화**: api 작업과 web 작업을 한 레인에 넣습니다(web이 api에 의존). web 작업은 api가 바꾼 파일을 같은 세션에서 봅니다.
- **S1 격리 병렬**: 두 작업을 다른 레인에서 동시에 돌립니다. 서로의 변경을 보지 못합니다(현재 ADR-051 동작).
- 알고 싶은 것은 "쓰기 범위가 겹치지 않아도 인터페이스로 엮인 작업(api 응답 ↔ web 화면)에서 S1이 통합 뒤 실제로 맞물리는가, 그 대신 시간·토큰은 얼마나 아끼는가"입니다.

결과는 `docs/experiments/`에 실험 보고서 양식으로 옮겨 적습니다(실험 #45).

## 레인 사이 계약 (`--contracts`)

S2(계약 먼저)에서 **계약을 누가 쓰는가**만 바꿉니다. 고정 계획(레인·작업)은 그대로 두기 때문에 전략 차이와 계약 출처 차이를 섞지 않고 잴 수 있습니다.

- `--contracts human`(기본): 과제 정의에 사람이 써 둔 계약을 그대로 씁니다([`tasks.ts`](./tasks.ts)의 `contract`). E2와 같은 조건입니다.
- `--contracts model`: 고정 계획의 레인으로 계획 모델에게 계약을 받아 `coordination.contracts`로 넘깁니다. 제품(studio의 `B_STUDIO_PLAN_CONTRACTS`)과 **같은 함수·같은 프롬프트**(`requestLaneContracts`·`buildContractSystem`)를 씁니다.

```bash
pnpm bench:coordination --backend claude-code --model sonnet --strategies S2 --contracts model --tasks orders-list,order-detail,order-summary --repeats 3
```

- `--contracts model`은 **S2에서만** 쓸 수 있습니다. 다른 전략과 함께 주면 시작 전에 거부합니다(계약을 쓰지 않는 전략에 주면 그 행이 무엇을 잰 것인지 알 수 없습니다).
- 백엔드는 `openai`(상류 ModelClient, 프록시 경유)와 `claude-code`(Claude Agent SDK `query` 한 번: 도구 없음·`maxTurns: 1`·설정 없음·세션 저장 없음)에서만 됩니다. `codex`는 한 번 호출 경로를 만들지 않아 시작 전에 거부합니다.
- `--contracts model`인데 모델 계약을 못 받으면(형식 오류·사용 한도·연결 실패) **그 실행을 실패로 남깁니다.** 계약 없이 레인을 돌리면 그 행은 S1을 S2라고 적는 것이 되기 때문입니다(제품은 반대로 계약 없이 진행하고 경고를 남깁니다 — 가용성이 먼저입니다).
- 행의 `contracts: { source, count, usage? }`에 출처·계약 수·호출 토큰이 남고, 요약표의 **성공 1건당 토큰**에 계약 호출 토큰이 포함됩니다(빼면 모델 계약이 공짜처럼 보입니다). 맨 위 줄에도 `계약 human|model`이 적힙니다.
- 모델이 쓴 계약 **원문**은 결과 폴더의 `contracts/<과제>-r<반복>-<순번>.json`에 저장합니다(나중에 불일치 원인을 보려고). 본문은 JSONL·요약에 넣지 않습니다.
- 레인이 2개 미만이면 모델을 부르지 않습니다(레인 사이 경계가 없습니다).

## 기준선 P0 (그냥 Claude Code)

`--backend claude-code`에서만 쓸 수 있는 비교 기준입니다. 작업 분해·조율 없이 Claude Code 하나가 과제 전체(전체 요청 + api 요청 + web 요청)를 한 번에 처리합니다. "같은 과제를 그냥 Claude Code로 하면 어떻게 되는가"를 S0~S5와 같은 방식으로 재기 위한 것입니다. 다른 백엔드는 Docker·모델을 건드리기 전에 거부합니다.

P0 실행 한 번은 이렇게 돕니다.

1. 새 프로젝트 복사본을 만듭니다(반복마다 처음 상태로 되돌립니다).
2. 복사본에서 Claude Code를 한 번 돌립니다. 시스템 프롬프트는 Claude Code 프리셋(`{ type: 'preset', preset: 'claude_code' }`), 도구는 `Read`·`Edit`·`Write`·`Glob`·`Grep`, 설정은 복사본의 프로젝트 설정만(`settingSources: ['project']`) 씁니다.
3. 그 복사본으로 **세션만 만들어** 샌드박스를 띄우고(에이전트 요청 없음) 서비스가 준비되면 기존 인수 검사(`runAcceptance`)를 돌립니다.
4. 세션·샌드박스를 다른 전략과 같은 경로로 정리합니다(남은 컨테이너 검사 포함).

무엇을 재는지: 토큰(입력·캐시읽기·캐시쓰기·출력), 모델 호출 수, 최대 컨텍스트, 실행 전후 복사본에서 바뀐 파일, 종단 시간, 샌드박스 기동 시간, 인수 검사 결과입니다. 요약 표의 **성공 1건당 토큰** 열로 S0~S5와 같은 기준에서 비교합니다.

**한계 — Bash가 없어 스스로 실행해 볼 수 없습니다.** P0는 모델에게 `Bash`·`WebFetch`·`WebSearch`·`Task`를 주지 않습니다(호스트에서 명령을 돌리지 않게 하려는 것입니다). 그래서 모델이 스스로 빌드·테스트를 돌리거나 서비스를 띄워 확인할 수 없습니다. 결과가 나쁘게 나와도 "모델이 못 만들어서"인지 "스스로 확인할 도구가 없어서"인지 이 실행만으로는 가릴 수 없습니다. 그 확인은 뒤에서 스튜디오가 세션을 띄워 대신 합니다.

```bash
pnpm bench:coordination --backend claude-code --model sonnet --strategies P0,S0 --tasks orders-list,order-detail,order-summary --repeats 3
```

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

# claude-code 승격(H5): haiku로 시작해 게이트가 같은 실패 서명을 2번 내면 sonnet으로 올린다
pnpm bench:coordination --backend claude-code --model haiku --escalate-to sonnet --tasks orders-list --strategies S0 --repeats 1

# 계획-실행 분리(ADR-075, E8): opus가 계획을 한 번 쓰고, haiku가 그 계획을 붙여 실행한다
pnpm bench:coordination --backend claude-code --model haiku --plan-model opus --execute-model haiku --tasks orders-list --strategies S0,S1 --repeats 3

# 가볍게 확인(E5): 레인·통합 게이트가 서비스 재시작·준비·계약만 확인한다(테스트·화면·리뷰는 건너뜀)
pnpm bench:coordination --backend claude-code --model sonnet --strategies S0 --verify light --tasks orders-list,order-detail,order-summary --repeats 3

# 자가 확인 lean(E7): 게이트와 겹치는 전체 빌드·테스트·확인을 줄이게 안내하고, 성공한 명령 출력을 800자로 줄인다(B_STUDIO_SELF_CHECK=lean). P0에는 적용되지 않는다
pnpm bench:coordination --backend claude-code --model sonnet --strategies S0 --self-check lean --tasks orders-list,order-detail,order-summary --repeats 3

# 자동 모델 선택(ADR-089, E10 계획 — 아직 실행하지 않음): 요청마다 haiku(질문)·sonnet(단순 만들기)·opus(복잡·위험)를 고르고,
# 세션 안에서는 성공한 단계를 유지한다(캐시 재생성 비용을 피한다, E8/E9). sonnet 고정과 성공률·성공 1건당 비용을 비교한다
pnpm bench:coordination --backend claude-code --model auto --strategies S0 --tasks orders-list,order-detail,order-summary --repeats 3
pnpm bench:coordination --backend claude-code --model sonnet --strategies S0 --tasks orders-list,order-detail,order-summary --repeats 3

# codex: 이 PC에 ChatGPT로 로그인된 Codex CLI. --model을 생략하면 로그인 계정의 기본 모델을 쓴다
pnpm bench:coordination --backend codex --tasks orders-list --strategies S0,S1 --repeats 1

# commandcode: 이 PC에 로그인된 Command Code CLI. 무료 모델로 비용 없이 돌린다 (모델을 생략하면 계정 기본 모델)
pnpm bench:coordination --backend commandcode --model poolside/laguna-s-2.1-free --free-only --tasks orders-list --strategies S0,S1 --repeats 1

# opencode: 이 PC에 설치된 OpenCode CLI. --model이 필수다(무료 Zen 모델은 내장 도구를 끈 b-studio 구성에서 거절된다)
pnpm bench:coordination --backend opencode --model <로그인한 제공자의 모델> --tasks orders-list --strategies S0,S1 --repeats 1

# 레인마다 다른 백엔드: api 레인은 Claude Code, web 레인은 Command Code. 통합 세션은 --backend(계획 기본)를 쓴다
pnpm bench:coordination --backend claude-code --model sonnet \
  --lane-backend api=claude-code --lane-backend web=commandcode \
  --tasks orders-list --strategies S1 --repeats 1

# 일부만 (openai)
pnpm bench:coordination --backend openai --tasks orders-list,independent --strategies S0,S1 --repeats 2 --out /tmp/bench-run
```

인자:

- `--backend claude-code|codex|commandcode|opencode|openai` — 필수(`--dry` 제외). `--dry`와 함께 쓰면 오류
- `--model <이름>` — `claude-code`·`codex`·`commandcode`·`opencode`에서만. `claude-code` 기본 `sonnet`(`B_STUDIO_CLAUDE_CODE_MODEL`로 넘어간다), `codex`는 기본이 없어 생략하면 계정 기본 모델을 쓴다(`B_STUDIO_CODEX_MODEL`), `commandcode`도 기본이 없어 생략하면 계정 기본 모델을 쓴다(`B_STUDIO_CMD_MODEL`), `opencode`는 **필수**다(기본 모델을 추측하지 않는다. `B_STUDIO_OPENCODE_MODEL`)
  - `--model auto` — `claude-code`에서만(ADR-089, E10 계획). 고정 별칭이 아니라 요청마다 스튜디오가 haiku·sonnet·opus 중 하나를 고른다(`routeCliTier`, ADR-047의 복잡도·위험도 분류 재사용). 세션 안에서는 stickiness로 이미 성공한 단계를 내리지 않는다. S2(`--contracts model`)의 계약 호출과 레인(`--lane-backend`)에는 아직 연결하지 않았다
- `--free-only` — `commandcode`·`opencode`에서만. commandcode는 무료가 아닌 `--model`이면 오류, opencode는 `usable`한 무료 모델만 고르고 쓸 수 있는 무료 모델이 하나도 없으면 시작 전에 멈춘다
- `--tasks a,b`, `--strategies P0,S0,S1,S2,S3,S4,S5`, `--repeats N`(기본 3, `--dry`는 1), `--out <dir>`, `--force`
  - `--strategies`의 기본값은 `S0,S1`이고 P0는 넣어야 돕니다. `P0`는 `--backend claude-code`에서만 쓸 수 있습니다. `--dry`는 P0를 모릅니다(항상 `S0,S1`만 돕니다)
- `--on-rate-limit stop|wait`(기본 `stop`), `--rate-limit-wait-minutes N`(기본 30)
- `--context-clearing on|off`(기본 `off`) — 컨텍스트가 커지면 오래된 도구 결과를 묶어서 비웁니다(`B_STUDIO_CONTEXT_CLEARING=on`으로 넘어갑니다). `--backend openai`(API 루프)에서만 쓸 수 있습니다. 행의 `contextCleared`와 요약표의 "비운 도구 결과 중앙값"으로 몇 개를 비웠는지 봅니다
- `--integration-checks`(기본 꺼짐) — 엮인 과제 3개의 **통합 게이트**에만, 과제 요청에 적힌 샘플 값이 web 화면에 보이는지 확인(`pageChecks.expectAllText`·`expectAnyText`)을 덧붙입니다(orders-list `김민수`·`이영희`·`박철수` 모두, order-detail `김민수`·`문 앞에 놓아 주세요` 모두, order-summary `45000`/`45,000` 중 하나). 인수 검사와 **같은 값을 같은 규칙(모두/하나라도)으로** 봅니다 — E4 첫 묶음에서 첫 값 하나만 보던 확인은 '김민수'만 보이는 화면을 통과시켰습니다. 필드 이름은 쓰지 않습니다. 이 값들은 인수 검사(`runAcceptance`)와 **같은 값**이라, 이 확인은 "통합 게이트가 인수 검사와 같은 신호를 보게 되면 S4 수리가 시작되는가"를 재는 것입니다([#124](https://github.com/dj258255/b-studio/issues/124), E2 H10). 각 실행 행에 `integrationChecks: true/false`를 남기고 `meta.json`에도 기록합니다. 레인 게이트는 그대로이고 통합 게이트만 바뀝니다(서버 안에서만 넘기는 `createTaskPlan.integrationChecks`)
- `--verify full|light`(기본 `full`) — `light`(가볍게 확인)면 작업 분해의 **레인 실행과 통합 실행**(S4 수리 포함)에 `verify=light`를 넘겨, 게이트가 서비스 재시작·준비 판정·계약 비교만 하고 테스트·화면 확인·리뷰를 건너뜁니다. 전체 검증(E0~E4)과 가볍게 확인을 같은 과제·모델로 비교하는 E5용입니다. 각 실행 행에 `verify`, `meta.json`에 `verify`, 요약 맨 위 줄에 `검증 full` 또는 `검증 light(가볍게)`가 남습니다. 사람이 보낸 세션 메시지가 아니라 **서버 안에서만** 넘깁니다(HTTP 라우트는 받지 않음, `createTaskPlan.verify`). `P0`(그냥 Claude Code)는 b-studio 게이트를 쓰지 않으므로 light와 함께 주면 무시하고 경고 한 줄만 남깁니다
- `--contracts human|model`(기본 `human`) — S2에서 레인 사이 계약을 누가 쓰는지 정합니다. `model`은 계획 모델에게 한 번 받아 씁니다(S2에서만, `--backend openai|claude-code`에서만). 위의 "레인 사이 계약" 절을 보세요
- `--escalate-to <모델>` — claude-code 백엔드(계획 기본 또는 레인 중 하나)가 있을 때만. `--model`로 시작해 게이트가 **같은 실패 서명**을 `--escalate-after`번 내면 이 모델로 올린다(`B_STUDIO_CLAUDE_CODE_ESCALATE_MODEL`). claude-code가 하나도 없는데 주면 시작 전에 오류를 낸다
- `--escalate-after <n>` — 기본 2. `--escalate-to`와 함께 쓴다(`B_STUDIO_ESCALATE_AFTER`)
- `--escalate-after-failures <n>` — 서명과 무관하게 게이트 실패가 N번이면 올린다(기본 없음). 서명이 매번 달라 승격 계기가 없는 실행(E4의 5회)을 재기 위한 규칙이다(`B_STUDIO_ESCALATE_AFTER_FAILURES`)
- `--escalate-retry-budget <n>` — 기본 2. 승격한 뒤 게이트 재시도를 **새로** 주는 횟수다. 남은 횟수에 더하지 않고 "지금까지 시도한 수 + N"으로 상한을 다시 잡는다(E4에서 승격 뒤 한 번밖에 남지 않던 것을 겨냥). `0`이면 새 예산 없음 = 승격 규칙을 넣기 전과 같다(`B_STUDIO_ESCALATE_RETRY_BUDGET`)
- `--plan-model <모델>`, `--execute-model <모델>` — 계획-실행 분리(ADR-075, "계획은 큰 모델, 실행은 작은 모델"). claude-code 백엔드(계획 기본 또는 레인 중 하나)가 있을 때만 쓸 수 있다(`--escalate-to`와 같은 제약 — 계획 호출 경로가 claude-code·api에만 있고, 벤치 openai는 실행마다 단일 모델 레지스트리라 계획 모델을 끼울 자리가 없다). `--plan-model`만 주면 계획은 그 모델이 쓰고 실행은 `--model`을 그대로 쓴다. 둘 다 서버 프로세스 환경 변수(`B_STUDIO_PLAN_MODEL`·`B_STUDIO_EXECUTE_MODEL`)로 넘어가 스튜디오 코드와 같은 경로(`planExecuteConfig`)를 탄다. 행마다 `planExecute: { plan?, execute? }`로 남고, `meta.json`에도 `planModel`·`executeModel`로, 요약 맨 위 줄에도 `계획-실행 분리: 계획 X → 실행 Y`로 남는다
- `--plan-always` — 요청 복잡도와 무관하게 계획을 세운다(`B_STUDIO_PLAN_BRIEF=always`). 벤치 과제는 짧아 기본(auto)이면 `simple`로 분류돼 계획을 건너뛴다. 계획-실행 분리를 재려면 함께 준다
- `--lane-backend <레인 그룹>=<백엔드>[:<모델>]` — 반복할 수 있습니다. 레인 그룹은 `api`·`web`(레인의 첫 쓰기 경로)입니다. 모르는 그룹·백엔드면 시작 전에 오류를 냅니다. 쓰는 CLI는 시작 전에 각각 로그인을 확인합니다. 요약표 "레인 백엔드" 열(예 `api:claude-code web:commandcode`)과 행의 레인별 `backend`·`model`로 남습니다. `--backend`는 계획 기본(통합 세션)으로 남습니다
- `--prices <json 파일>` — 모델 이름 일부 → 단가 표(아래 형식). 있으면 행의 모델별 사용량(`metrics.usageByModel`)으로 `costUsd`(모델별 합)를 계산하고, 요약표의 "API 환산 비용($)" 열에 합계/중앙값(달러)을 냅니다. 단가가 없는 모델이 하나라도 있으면 비용 대신 `costNote: "단가 없음: <모델>"`을 남깁니다. **단가 값은 코드에 적지 않고 파일로만 받습니다**
- `--concurrency N`(기본 1) — 여러 실행을 동시에 돌립니다. 아래 "동시 실행" 절을 보세요

`--prices` 파일 형식(키는 모델 이름에 포함되면 매칭합니다. 예 `haiku-4-5`. 값은 100만 토큰당 달러이고, 예시는 형식만 보여 줍니다):

```json
{
  "<모델 이름 일부>": { "inputPerM": …, "outputPerM": …, "cacheReadPerM": …, "cacheWritePerM": … }
}
```

**claude-code**는 프록시와 상류를 띄우지 않고 `BENCH_UPSTREAM_*`도 요구하지 않습니다. 모델 레지스트리도 쓰지 않습니다(계획은 `presetPlan`으로 서버 안에서 넘기고, 세션은 레지스트리를 요구하지 않습니다). 실행 전에 `preflightClaudeCode`로 로그인을 확인하고, 실패하면 종료 코드 3으로 멈춥니다.

**commandcode**는 `claude-code`와 같지만 모델을 고를 수 있고, 무료 모델(예: `poolside/laguna-s-2.1-free`)로 비용 없이 실험할 수 있습니다. `B_STUDIO_CMD_MODEL`로 모델을 고정하고, 실행 전에 `preflightCommandCode`로 로그인을 확인해 실패하면 종료 코드 3으로 멈춥니다. 사용 한도(종료 코드 5)와 크레딧 부족(종료 코드 10)은 둘 다 `rate_limited`로 묶되 detail로 구분합니다.

**opencode**는 `claude-code`와 같지만 `--model`이 필수입니다(기본 모델을 추측하지 않습니다). 무료 Zen 모델은 내장 도구를 좁힌 b-studio 구성을 제공자가 거절하므로 쓸 수 없고, 로그인한 제공자의 모델을 고르세요. 실행 전에 `preflightOpenCode`로 CLI가 있는지 확인해 실패하면 종료 코드 3으로 멈춥니다. OpenCode는 종료 코드가 0/1/130뿐이라 한도는 "…사용 한도…" 문구로 `rate_limited`, 무료 Zen 거절은 `provider_gate`로 묶습니다.

**openai**는 `BENCH_UPSTREAM_BASE_URL`, `BENCH_UPSTREAM_API_KEY`, `BENCH_UPSTREAM_MODEL`이 필요합니다. `--dry`는 이 백엔드의 가짜 상류라 이 값들이 필요 없습니다. `BENCH_PRICE_INPUT_PER_M`·`BENCH_PRICE_OUTPUT_PER_M`는 선택이고, 없으면 0으로 두고 경고합니다.

## 사용 한도

실행 뒤 분류가 `rate_limited`면(모델 응답에 `usage limit`, `rate limit`, `429`, `hit your limit`, `limit reached`, `overloaded`) 정책에 따라 처리합니다.

- `--on-rate-limit stop`(기본): 다음 실행을 시작하지 않고 멈춥니다.
- `--on-rate-limit wait`: `--rate-limit-wait-minutes`만큼 기다린 뒤 **같은 실행을 한 번만** 다시 시도합니다. 다시 시도한 실행은 행의 `retryOf`로 표시하고, 원래 행도 지우지 않고 남깁니다.

## 사전 확인이 멈추는 이유

시작 전에 `docker ps`를 보고 `studio-`로 시작하지 않는 컨테이너가 있으면 목록과 함께 종료 코드 2로 멈춥니다. 메모리를 나눠 쓰면 다른 프로젝트 DB가 OOM으로 죽을 수 있기 때문입니다. 정말 진행하려면 `--force`를 줍니다(경고만 하고 진행). 이 저장소는 한 번에 계획 하나만 돌리고, 끝나면 그 계획의 세션을 모두 내린 뒤 남은 `studio-<벤치 프로젝트>-` 컨테이너가 0개인지 확인합니다. 남아 있으면 다음 실행을 시작하지 않고 멈춥니다.

## 동시 실행 (`--concurrency`)

`--concurrency N`(기본 1, 지금까지와 같은 직렬 실행)을 주면 계획한 실행(과제 × 전략 × 반복)을 최대 N개까지 동시에 돌립니다. 실험을 여러 번 나눠 돌리는 대신 한 번에 끝내려는 것입니다.

```bash
pnpm bench:coordination --backend claude-code --model sonnet --strategies S0,S1 --tasks orders-list,order-detail,order-summary --repeats 3 --concurrency 3
```

- **어떻게 도는가**: 이 프로세스는 실행을 직접 돌리지 않습니다. 자기 자신(`run.ts`)을 자식 프로세스로 최대 N개까지 띄우고, 자식마다 실행 하나(과제 하나 · 전략 하나 · 반복 하나)를 맡깁니다. 자식마다 프로세스가 다르므로 `B_STUDIO_SESSIONS_DIR`·`B_STUDIO_PROJECTS_DIR` 같은 환경 변수, 임시 작업 폴더(workRoot), 프로젝트 복사본이 자연히 따로입니다. 프록시(`--backend openai`)는 자식마다 새로 떠서 빈 포트를 스스로 고르고(포트 0으로 열어 OS가 배정), 샌드박스 compose 프로젝트 이름도 자식마다 `bench-orders-<순번>`으로 겹치지 않습니다(샌드박스 컨테이너 이름 자체에도 세션마다 무작위 16진수 6자리가 더 붙어 이중으로 안전합니다). 그래서 동시에 여러 실행이 떠도 서로의 세션·포트·컨테이너를 침범하지 않습니다.
- **순서와 결과**: `order`는 직렬 실행이었다면 매겼을 값과 같습니다(반복 → 과제 → 전략, 반복마다 전략 순서를 뒤집는 규칙도 그대로). `results.jsonl`은 완료되는 순서대로 한 줄씩 쌓이지만 각 행에 `order`가 남아 분석에는 영향이 없고, `summary.md`는 항상 `order`로 정렬한 뒤 만들어 완료 순서와 무관하게 같은 표가 나옵니다. 행과 `meta.json`에 `concurrency`가 남습니다 — **동시 실행일 때의 시간 지표(종단 시간·기동 시간 등)는 직렬 실행과 같은 기준으로 비교할 수 없습니다**(Docker VM 자원을 나눠 쓰기 때문입니다). `summary.md` 맨 위 줄에도 이 사실을 함께 적습니다.
- **메모리**: 시작 전에 필요한 메모리(`N × 샌드박스 한 벌` — `examples/orders/studio.yaml`의 `resources`(api·web·db) 합 + edge 컨테이너 오버헤드(128MB) + 여유분 2GB)를 Docker VM의 남은 메모리(전체 메모리 − 이미 도는 컨테이너가 쓰는 메모리)와 비교합니다. 모자라면 `--concurrency`를 낮추거나 Docker VM 메모리를 늘리라는 안내와 함께 종료 코드 2로 멈춥니다(예: `colima stop && colima start --cpu 8 --memory 16`). 정말 진행하려면 `--force`를 줍니다. 이 계산은 "동시 실행 하나 = 샌드박스 한 벌"로 어림잡습니다 — S1 이상의 전략은 레인·통합 세션이 여러 개 동시에 뜰 수 있어 실제로는 더 쓸 수 있으니, 여유를 넉넉히 두거나 `--force` 판단은 신중히 하세요.
- **사용 한도**: 실행 하나가 사용 한도(`rate_limited`)에 걸리면 그 뒤로 새 실행을 더 띄우지 않습니다(이미 도는 실행은 끝까지 돕니다). `--on-rate-limit wait`의 "기다렸다 같은 실행을 한 번만 다시 시도" 동작은 그 실행을 맡은 자식 안에서 그대로 일어납니다.
- **남은 컨테이너**: 어느 실행이든 남은 컨테이너를 남기면(정리 실패) 그 뒤로 새 실행을 더 띄우지 않습니다(직렬 실행의 "남은 컨테이너" 중단과 같은 규칙).
- **Ctrl-C**: 새 실행을 더 띄우지 않고, 도는 자식 프로세스 모두에 SIGINT를 보냅니다. 자식은 직렬 실행과 같은 정리 경로(세션 내리기·임시 폴더 지우기)를 그대로 밟습니다. 정리할 시간을 준 뒤에도 남아 있는 자식은 강제 종료합니다.
- **결과 폴더**: `--out` 아래 `.units/<order>/`에 자식마다 결과 폴더(자식이 만든 `results.jsonl`·`summary.md`·`meta.json`·`child.log`)가 남습니다. 부모가 합친 `results.jsonl`·`summary.md`·`meta.json`은 평소와 같은 자리(`--out` 바로 아래)에 남습니다.
- 자식 프로세스가 결과를 하나도 남기지 못하고 죽으면(설정 단계에서 실패 등) 그 실행은 실패 행(`category: unknown`, 로그 마지막 줄 포함)으로 채워 실험에서 그 자리를 잃지 않게 합니다.

## 결과 파일

`--out`(기본 `~/.cache/b-studio/bench/coordination/<YYYYMMDD-HHmmss>`) 아래에 남깁니다.

- `results.jsonl`: 실행 한 번이 한 줄입니다(계획·레인·통합 지표, 모델별 사용량 `metrics.usageByModel`, 수용 확인, 분류, 프록시 통계, 관측한 모델, 승격 결과, 계획-실행 분리 설정 `planExecute`, 추정 비용 `estimatedCostUsd`, `--prices`가 있으면 모델별 API 환산 비용 `costUsd` 또는 사유 `costNote`, 계약 `contracts`)
- `contracts/`: `--contracts model`일 때 모델이 쓴 계약 원문(`<과제>-r<반복>-<순번>.json`). 불일치 원인을 나중에 보려고 남깁니다.
- `summary.md`: 백엔드·요청한 모델·관측한 모델·실행 수, 과제 × 전략 표, 전략별 실패 원인 표. 과제 × 전략 표에는 **성공 1건당 토큰**(입력+캐시읽기+캐시쓰기+출력 합 ÷ 성공 수, 성공 0이면 `—`), "승격 건수", "수리(시도/성공)"(S4가 통합 실패 뒤 모델 수리를 요청한 실행 수 / 수리 실행이 done으로 끝난 수), "API 환산 비용($)" 열이 있습니다.
- `meta.json`: 시작·끝 시각, Docker 메모리, 백엔드, 요청한 모델, 관측한 모델, 과제·전략·반복, topology, 계약 출처(`contracts`), 승격 설정(`escalateTo`·`escalateAfter`·`escalateAfterFailures`·`escalateRetryBudget`), 계획-실행 분리 설정(`planModel`·`executeModel`), 단가 파일 경로(`pricesPath`), git 커밋, 동시성(`concurrency`, `--concurrency`를 안 줬으면 1).

행의 `escalation`은 `{ to, after, afterFailures?, retryBudget, escalated, attempt? }`입니다. `to`·`after`·`afterFailures`·`retryBudget`는 설정값이고, `escalated`·`attempt`는 세션 기록의 `model_escalated` 이벤트에서 읽습니다(설정하지 않았으면 `escalated: false`).

원자료에는 레인·통합 세션마다의 탐색·실패 흔적도 남깁니다.

- `traces`·`integrationTrace`: 도구 이름별 호출 수, 읽은 파일(정규화·중복 제거·정렬), 나열한 폴더, 실패 서명(발생 순서, 중복 포함), 반복 실패 수, 모델 호출별 기록 `turns`(`{ context, output, outputChars, cacheRead, cacheWrite, tools: [{ name, chars }] }`). P0는 같은 모양을 `plainTurns`에 남깁니다.
- `explore`: 레인 합계 `filesReadTotal`, 레인 사이 합집합 `filesReadUnionAcrossLanes`, 읽기 호출 `readCallsTotal`. 통합 세션은 모델 없이 스크립트로 돌아 합계에서 뺍니다.
- `failures`: 실패 서명 총수, 서로 다른 서명 수, 반복 실패 수. **실패 서명은 검증기가 낸 실패만 씁니다**(준비하지 못한 서비스, 어긋난 계약, 실패한 워크플로 확인). 모델 텍스트는 쓰지 않고, 메시지는 첫 줄만 남겨 줄 번호·시각·해시를 `N`·`H`로 정규화합니다.

### 토큰이 어디서 나왔는지 나누기 (`pnpm bench:coordination:tokens`)

```bash
pnpm bench:coordination:tokens ~/.cache/b-studio/bench/coordination/<폴더> [<폴더>...]
```

모델 호출별 기록(`turns`·`plainTurns`)으로 조건(전략, 가볍게 확인이면 `(light)`)마다 문맥 합을 나눠 마크다운 표로 출력합니다. 세션(레인·통합·P0)마다 대화가 따로라 세션마다 나눈 뒤 더합니다.

- **고정 문맥**: 세션 첫 호출의 문맥 × 호출 수. 시스템 프롬프트·도구 설명·요청처럼 호출마다 다시 실리는 양의 근사입니다.
- **출력 재읽기**와 **도구 결과 재읽기**: 호출 뒤 늘어난 문맥을 그 응답에서 모델이 쓴 글자(글·도구 입력 JSON, `outputChars`)와 도구 결과 글자의 비율로 나누고, 각각 × 그 뒤 호출 수. 한 호출이 도구를 여럿 부르면 결과 글자 수 비율로 다시 나눕니다. 도구별 상위 5개를 따로 보여 줍니다.
- **비워서 줄어든 양**: 오래된 결과를 비워 문맥이 줄어든 만큼 × 그 뒤 호출 수.

고정 + 출력 재읽기 + 도구 결과 재읽기 − 비워서 줄어든 양 = 문맥 합으로 맞아떨어집니다. 이 기록이 생기기 전(E1~E5)의 결과는 건너뛰고 몇 행인지 알립니다. 출력 토큰 값으로 나누지 않는 이유는 로컬 Claude Code가 응답 첫 조각의 사용량만 알려 출력이 거의 0으로 잡히기 때문입니다(그러면 `Write`로 쓴 파일 내용이 도구 결과로 넘어갑니다). 글자 비율은 글과 JSON의 토큰 밀도가 비슷하다고 보는 근사입니다.

실제로 쓴 모델 이름은 실행마다 레인·통합 세션의 이벤트 기록에서 읽어 `observedModels`에 넣습니다. 상류 API 키는 환경 변수에서만 읽고 JSONL·요약·로그에 쓰지 않습니다. 결과를 쓰기 직전에 키가 들어 있으면 `***`로 바꿉니다.

## 한계

- **본인 PC에서 본인이 로그인한 CLI만 씁니다.** `claude-code` 백엔드는 개인 구독 계정용이고, 공유 서버에서는 쓰지 않습니다(ADR의 로컬 CLI 원칙).
- **고정 계획이라 계획 모델의 품질은 재지 않습니다.** 전략 차이만 재기 위해 계획은 과제마다 미리 정해 둡니다(openai는 로컬 프록시가, claude-code는 `presetPlan`이 그대로 넘깁니다). `--contracts model`만 예외로, **계약 문장의 품질**은 재게 됩니다(계획 품질은 여전히 재지 않습니다).
- **로컬 CLI 러너는 모델 응답 대기 시간을 재지 못해 `modelMs`가 0입니다.** 0은 "재지 않음"이고, 추측값을 넣지 않습니다. 비용은 청구가 없고, 단가를 주면 API 단가 환산 추정치만 계산합니다.
- 실패 서명 메시지는 숫자열을 `N`으로 바꿉니다. 그래서 `exit code 1`과 `exit code 2`, 다른 포트 번호가 같은 서명이 됩니다. 줄 번호·시각·해시 때문에 같은 원인이 갈라지지 않게 한 선택입니다.
- `repeatedFailures`는 **한 세션 안에서** 같은 서명이 다시 나온 횟수이고, `distinctSignatures`는 실행 전체(레인 + 통합)의 서로 다른 서명 수입니다. 두 값의 범위가 다릅니다.
- 세션 기록은 5,000개 이벤트를 넘으면 오래된 것부터 잘립니다. 아주 긴 세션은 탐색량(`filesRead`, 도구 호출)이 실제보다 적게 잡힐 수 있습니다.
- 추정 비용은 단순화했습니다. 입력 토큰은 `inputTokens + cacheReadTokens + cacheWriteTokens`를 입력 단가로 곱하고, 캐시 할인은 반영하지 않습니다. 청구서 금액이 아닙니다.
- 반복이 적어 비율 대신 건수로 적습니다. 결과는 이 저장소·이 모델·이 과제에 한정됩니다.
- `--integration-checks`의 확인은 과제 요청에 적힌 **샘플 값**이 web 화면에 보이는지만 봅니다(필드 이름·값의 모양은 보지 않음). api와 화면이 일관되게 다른 필드 이름을 쓰거나 값의 모양(맵 vs 배열)이 달라도, 그 값이 화면에 보이면 이 확인은 통과합니다 — 그런 불일치는 인수 검사가 잡습니다. 그래서 이 확인이 재는 것은 "통합 게이트가 인수 검사와 같은 신호로 실패하면 S4 수리가 시작되는가"입니다. 값은 하나만 보므로(예: 목록 첫 고객 이름) 목록의 다른 항목이 빠지는 것은 잡지 못합니다.
