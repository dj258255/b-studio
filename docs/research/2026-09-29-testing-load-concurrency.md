# 부하·동시성·테스트 코드 — 빅테크 사례와 b-studio 적용 메모

## 1. 결론 먼저

- **A(에이전트가 만드는 앱)**: "테스트를 썼는가"가 아니라 "무엇을 잡아내는가"를 재야 한다. Meta는 AI가 생성한 테스트를 뮤테이션(고의 결함 주입)으로 걸러 실제로 버그를 잡는 테스트만 채택률 73%로 병합했다 — b-studio도 게이트의 `test` 단계에 "통과했는가"만 보지 말고 뮤테이션 검사를 최소 1개라도 추가할 가치가 있다.
- **A**: 동시성(이중 지불류 race, lost update)은 orders 도메인의 핵심 리스크인데 현재 studio.yaml의 `pageChecks`·`tests`에는 병렬 요청 검사가 전혀 없다. 빅테크는 이걸 "동시 요청 2개를 쏴서 재고/잔액이 안 깨지는지" 정도의 저비용 스모크로도 잡는다(Jepsen·jcstress식 정합성 체크의 축소판).
- **B(b-studio 자체)**: `apps/studio/bench/coordination/load.test.ts`는 이름과 달리 부하 테스트가 아니라 "tsx로 모듈이 로드되는가"만 확인하는 유닛 테스트다 — 실제 다중 세션/SSE 부하 테스트는 존재하지 않는다.
- **B**: `docs/troubleshooting.md` #36에 이미 실제 동시성 버그가 기록돼 있다 — 같은 프로젝트로 세션 2개를 동시에 띄우면 공유 Gradle 캐시 잠금 충돌로 두 번째 세션이 실패했다(수동으로 발견, 자동 회귀 테스트는 없음). 이런 사례가 더 있을 가능성이 높다.
- **B**: `session-store.ts`는 temp-write+rename(원자적 교체)만 쓰고 있어 단일 파일 쓰기의 원자성은 확보돼 있지만, 여러 요청이 "읽고-고치고-쓰는" 순서로 같은 세션/계획 파일을 동시에 건드릴 때의 lost-update는 검증된 적이 없다(노트북 1인 개발 규모에서는 실제 동시 쓰기 빈도가 낮아 우선순위는 중간).

## 2. 빅테크·업계 사례 표

| 주제 | 누가 | 무엇을 하나 | 보고된 수치 | 출처 |
|---|---|---|---|---|
| AI 생성 유닛테스트 개선 | Meta | TestGen-LLM: LLM이 만든 테스트를 기존 테스트 스위트에 "개선"으로만 편입(빌드 성공·기존 테스트 유지·커버리지 증가를 만족해야 채택) | Instagram/Facebook 테스트톤에서 대상 클래스의 11.5% 개선, 추천 중 73% 실서비스 채택 | [arXiv 2402.09171](https://arxiv.org/abs/2402.09171), [Meta Eng](https://engineering.fb.com/2025/02/05/security/revolutionizing-software-testing-llm-powered-bug-catchers-meta-ach/) |
| 뮤테이션 유도 AI 테스트 생성 | Meta ACH (2025) | 코드에 고의 결함(뮤턴트)을 주입 → 그 결함을 잡는 테스트만 LLM에게 생성시킴 → "통과하는 테스트"가 아니라 "결함을 잡는 테스트"만 채택 | Android Kotlin 클래스 10,795개 대상, 뮤턴트 9,095개·프라이버시 강화 테스트 571개 생성, 동등 뮤턴트 판별 정밀도 0.79/재현율 0.47(전처리 후 0.95/0.96) | [FSE 2025](https://dl.acm.org/doi/10.1145/3696630.3728544), [Meta Eng](https://engineering.fb.com/2025/09/30/security/llms-are-the-key-to-mutation-testing-and-better-compliance/) |
| 대규모 뮤테이션 테스트 | Google | 전체 코드베이스가 아니라 코드리뷰 시점에 **변경분만** 증분 뮤테이션, 개발자에게 무의미한 뮤턴트는 필터링, 연산자별 과거 성능으로 뮤턴트 선별 | 코드베이스 20억 라인, 일일 테스트 실행 1.5억+ 건, 개발자 24,000명·프로젝트 1,000+ 적용 | [research.google](https://research.google/pubs/practical-mutation-testing-at-scale-a-view-from-google/), [arXiv 2102.11378](https://arxiv.org/pdf/2102.11378) |
| 플레이키 테스트 관리 | Google | 식별→통지→분류(triage)→예방 4단계 파이프라인, 전역 상태 공유로 인한 플레이키니스를 주요 원인으로 지목 | ⚠️ 구체적 비율 미확인(글에 정성적 설명 위주) | [Testing Blog 2016](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html), [2017](https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html) |
| 숨긴 테스트로 에이전트 평가 | SWE-bench (다수 기관 공동 벤치마크) | 에이전트에게는 실패 케이스(gold test_patch)를 안 보여주고 패치만 받은 뒤, 종료 후 별도 환경에서 숨긴 테스트를 적용해 "이전에 통과하던 것 유지 + 새 실패 케이스 통과"를 per-test로 채점 | 에이전트 워크스페이스에서 숨긴 테스트가 읽혀 "정답 베끼기"가 된 사례가 보고돼, 계층 분리(에이전트가 못 보는 별도 환경에서 채점)가 원칙으로 자리잡음 | [arXiv 2505.23419](https://arxiv.org/html/2505.23419v2), 관련 논의 [arXiv 2608.14711](https://arxiv.org/pdf/2608.14711) |
| 코딩 에이전트의 자동 테스트 | GitHub Copilot coding agent | 이슈를 받아 계획 → PR 생성 → 코드 작성과 함께 테스트 생성 → 자체 환경에서 테스트·린트 실행 → 리뷰 요청까지 자동화 | ⚠️ 정량 수치 미공개, 정성적 설명만 | [GitHub Blog](https://github.blog/ai-and-ml/github-copilot/assigning-and-completing-issues-with-coding-agent-in-github-copilot/) |
| 속성 기반 테스트(PBT) | Hypothesis(Python)/jqwik(JVM)/proptest(Rust) | 예시 대신 "속성"을 정의하고 무작위·축소(shrinking)로 반례를 자동 탐색. 동시성/경합 조건보다는 입력 공간 커버리지에 강점 | jqwik은 현재 유지보수 모드(신규 기능 개발 중단), 채택은 "혼재"라는 평가가 다수 | [jqwik.net](https://jqwik.net/property-based-testing.html), [PBT 실태 논문](https://sarajuhosova.com/assets/files/2025-pbt-in-the-wild.pdf) |
| 결정적 시뮬레이션 테스트(DST) | FoundationDB | 전체 클러스터를 단일 스레드 프로세스 안에서 결정적으로 시뮬레이션. `BUGGIFY` 매크로가 코드 곳곳에서 25% 확률로 결함을 주입, 같은 시드면 항상 같은 실행 경로 재현 | 시뮬레이션 누적 약 1조 CPU-시간 추정. Jepsen 저자가 "이미 우리보다 더 혹독하게 검증했다"며 별도 검증을 거절 | [FoundationDB Docs](https://apple.github.io/foundationdb/testing.html), [Pierre Zemb 블로그](https://pierrezemb.fr/posts/diving-into-foundationdb-simulation/) |
| 결정적 시뮬레이션 테스트(VOPR) | TigerBeetle | 합의·스토리지 엔진을 시뮬레이터(VOPR)에서 실행, 네트워크 지연·파티션·디스크 손상·복제 교차 실패를 무작위 시드로 주입. 최근에는 각 복제자 내부 상태까지 프로토콜 인지형으로 점검 | 시간을 가속해 몇 달 걸릴 시나리오를 수 분 내 탐색(정성적 서술) | [TigerBeetle 블로그](https://tigerbeetle.com/blog/2026-08-20-protocol-aware-dst/), [vopr.md](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md) |
| 자율 결함 탐색 | Antithesis | 고객 시스템을 VM 클러스터에 복제해 결정적 환경에서 자율적으로 결함(네트워크 블립 등)을 주입, 버그 재현을 100% 보장 | etcd가 강건성 검증에 채택(정량 수치는 ⚠️ 사례별 비공개) | [Antithesis Docs](https://antithesis.com/docs/introduction/how_antithesis_works/), [etcd 블로그](https://etcd.io/blog/2025/autonomus_testing_with_antithesis/) |
| 분산 시스템 정합성 검증 | Jepsen | 실제 장애(파티션·프로세스 크래시)를 주입하며 선형성(linearizability) 등 정합성 위반을 탐지 | 2025년 Capela 테스트에서 문제 22건 발견(크래시 14건, 안전성 위반 3건 포함) | [jepsen.io/blog](https://jepsen.io/blog) |
| 체계적 동시성 테스트 | Microsoft Coyote | IL 재작성으로 스케줄러를 장악해 동시성 인터리빙을 체계적으로 탐색, 버그 발견 시 정확히 같은 트레이스로 100% 재현 | Azure 프로덕션 서비스 다수에 채택, 사용자 유지율 100% | [Coyote Docs](https://microsoft.github.io/coyote/), [GitHub](https://github.com/microsoft/coyote) |
| 언어 수준 동시성 테스트 | Go race detector / Java jcstress / Rust Loom / AWS Shuttle | Go: `-race`로 런타임 동적 탐지(ThreadSanitizer 기반). jcstress: JVM 메모리 모델 위반을 스트레스 테스트로 탐지. Loom: C11 메모리 모델 하 인터리빙을 모델체킹. Shuttle: Loom에 영감받아 무작위 스케줄링으로 더 큰 테스트까지 확장(완전성은 포기) | ⚠️ 각 도구 문서의 설명 위주, 정량 비교 수치 없음 | [Go blog](https://go.dev/blog/race-detector), [jcstress](https://openjdk.org/projects/code-tools/jcstress/), [Loom](https://docs.rs/loom/latest/loom/), [AWS Shuttle](https://github.com/awslabs/shuttle) |
| 분산 시스템 형식 검증 | AWS (S3, DynamoDB, EBS) | TLA+로 프로토콜을 명세하고 모델체킹으로 설계 단계 버그를 사전에 발견(2011년부터 채택) | 다수의 설계 버그를 코드 작성 전에 발견(정성적 보고, 구체 건수 ⚠️ 논문별 상이) | [Lamport PDF](https://lamport.azurewebsites.net/tla/formal-methods-amazon.pdf), [AWS Storage Blog](https://aws.amazon.com/blogs/storage/how-automated-reasoning-helps-us-innovate-at-s3-scale/) |
| SRE 부하테스트·용량계획 | Google SRE Book | 부하테스트로 파손점(breaking point)을 찾는 것이 용량계획의 전제. 회귀 테스트·최악 시나리오 대비·활용률 대 안전마진 트레이드오프에 활용 | ⚠️ 챕터는 정성적 원칙 위주, 수치 벤치마크 없음 | [sre.google 워크북](https://sre.google/workbook/managing-load/) |
| 부하테스트 도구 | k6(Grafana) / Locust / Gatling | k6: Go 엔진+JS 스크립트, CLI 임계값으로 CI 게이트(비정상 종료 코드) 지원, 단일 머신 자원 소모 적음. Locust: 순수 Python, OTel 연동, 분산 실행 내장하나 처리량은 k6보다 낮음. Gatling: JVM 기반, 보고서 품질 우수 | ⚠️ 벤더 비교 글 다수, 공식 수치 벤치마크는 케이스마다 다름 | [k6 비교](https://qainsights.com/jmeter-vs-k6-vs-locust-in-2026-which-load-testing-tool-should-you-pick/) |
| 게임데이 부하테스트 | Shopify | Genghis 툴로 실사용자 흐름(탐색→장바구니→결제)을 스크립트화, 3개 리전에서 동시에 트래픽을 점증시켜 실제 한계점 탐색, Toxiproxy로 네트워크 장애 주입 병행 | BFCM(블랙프라이데이) 대비 프로덕션 인프라에서 직접 실행(정성적 서술) | [Shopify Eng: 4 Steps to Game Day](https://shopify.engineering/four-steps-creating-effective-game-day-tests), [BFCM 준비](https://shopify.engineering/bfcm-readiness-2025) |
| 성능 예산 CI 게이트 | Google Lighthouse CI | 커밋마다 Lighthouse 실행 → `lighthouserc.js` 임계값(성능 점수, LCP, 리소스 용량) 위반 시 CI 비정상 종료 | ⚠️ 구체 채택률 수치 없음, 도구 자체 문서 | [web.dev](https://web.dev/articles/lighthouse-ci) |

## 3. b-studio 현재 상태

### A. 에이전트가 만드는 앱(examples/orders 등)

- **게이트 실행 단계** (`packages/agent/src/gate.ts`): `run → contract_check → (browser_check ∥ test) → review`만 있다. `test` 단계는 `sandbox.exec`로 워크플로에 선언된 명령을 그대로 실행해 종료 코드 0/비0만 본다(`gate.ts` `#runTest`, 88~100번째 줄 부근) — **통과 여부만 판정, 테스트가 실제로 무언가를 검증하는지는 전혀 재지 않는다.**
- **studio.yaml 현재 선언** (`examples/orders/studio.yaml`): `web-lint`(`pnpm lint`), `api-unit`(`./gradlew test`) 두 개뿐. 부하/동시성 검사는 `pageChecks`에도 `tests`에도 없다.
- **에이전트 프롬프트** (`packages/agent/src/prompts.ts`): "요청하지 않은 리팩터·이름변경·재포맷·테스트·파일 추가를 하지 마라"(66번째 줄)는 지시만 있고, 테스트를 **작성하라**는 지시나 테스트 품질 기준은 없다. 즉 현재는 "요청하면 게이트가 통과할 만큼만" 테스트를 쓰게 유도되는 구조 — Meta ACH 사례처럼 "결함을 잡는 테스트인가"를 게이트가 되묻는 장치는 없다.
- **커버리지 설정**: `vitest.config.ts`(루트, b-studio 자체 테스트용)에 coverage 설정이 없고, 에이전트가 만드는 프로젝트 템플릿(`templates/nextjs-web`, `templates/spring-boot-api`, `templates/fastapi-api`)에도 커버리지 임계값 설정이 없다.
- **동시성/부하**: `docs/verification.md`·`docs/configuration.md`를 봐도 워크플로 스키마에 부하/동시 요청 테스트 유형이 정의돼 있지 않다(스키마는 `browser_check`·`test`뿐).

### B. b-studio 자체(스튜디오 서버)

- **`apps/studio/bench/coordination/load.test.ts`**: 이름과 달리 실제 부하 테스트가 아니다. `tsx`가 CommonJS 경로에서 `@b-studio/agent`를 문제 없이 불러오는지만 확인하는 유닛 테스트(ESM 전용 의존성 정적 import로 벤치가 아예 못 뜨던 사고(#51) 재발 방지용). **다중 세션·SSE 동접·병렬 샌드박스 부하 테스트는 리포에 존재하지 않는다.**
- **`apps/studio/bench/coordination/`**: 이건 부하 테스트가 아니라 "작업 분해 전략(S0 직렬 vs S1 병렬 레인) 비교 실험" 벤치다(`README.md`) — 토큰/시간 비교가 목적이고, 동시 요청에 대한 정합성(레이스) 검증이 목적이 아니다.
- **세션 저장소** (`apps/studio/lib/server/session-store.ts`, 135줄): `writeFile`을 임시 파일에 쓴 뒤 `rename`으로 교체하는 원자적 쓰기 패턴만 사용(`writeSession`/`writeSessionSync`). 파일 단위 원자성은 확보되지만, "읽고→필드 수정→다시 씀" 형태의 동시 갱신에 대한 락이나 버전 검사는 안 보인다. 이 경로에 대한 동시 쓰기 테스트도 없음(`session-store.test.ts`에 race/lock 키워드 없음).
- **작업 계획(task-plans)** (`apps/studio/lib/server/task-plans.ts`, 481줄): 레인 실행에 `concurrency: MAX_PLAN_LANES`로 동시 실행 수 제한은 있지만(`runTaskGraph` 호출부), 레인들이 같은 계획 파일을 동시에 갱신할 때의 정합성을 검증하는 테스트는 없음.
- **실제로 이미 겪은 동시성 버그**(`docs/troubleshooting.md` #36 — 파일에는 "36. 같은 프로젝트로 두 세션을 동시에 띄우면 api 빌드가 실패함"): 같은 프로젝트로 세션 2개를 동시에 띄우면 공유 Gradle 캐시 잠금(`journal-1`)이 충돌해 두 번째 세션 빌드가 실패했다. **수동 실검증으로 우연히 발견**했고 원인은 두 컨테이너의 Gradle 프로세스 PID가 우연히 같아 "죽은 잠금"으로 인식되지 않은 것. 고치는 데 시도 4번이 걸렸다(로그가 있으니 재현 가능하지만, 이런 종류의 동시 세션 경합을 잡는 자동 회귀 테스트는 여전히 없다).
- **SSE 엔드포인트**: `apps/studio/app/api/sessions/[id]/events/route.ts`, `.../frames/route.ts`가 `text/event-stream`을 서빙. 동접 SSE 연결 수·메모리 사용량을 재는 부하 테스트는 없음.
- **`package.json` 스크립트**: `e2e:fleet`, `e2e:deploy-gate`, `e2e:task-plan` 등은 있지만 전부 "기능이 되는가"를 확인하는 기능 e2e이지 부하/동접 테스트가 아니다. `bench:boot`(`packages/sandbox/bench/boot.ts`)는 샌드박스 기동 시간만 재는 단일 실행 벤치.

## 4. 제안

### A. 에이전트가 만드는 앱

1. **게이트에 뮤테이션 기반 "테스트가 제 몫을 하는가" 체크를 최소 형태로 추가**
   - 무엇: `test` 단계 통과 후, 변경된 파일 중 1~2곳에 아주 단순한 변형(예: `<` → `<=`, 상수 하나 바꾸기)을 넣어 재실행 → 여전히 통과하면 "테스트가 이 변경을 감지하지 못했다"고 리뷰 피드백에 남긴다.
   - 왜: Google/Meta 사례처럼 "테스트 통과"와 "결함을 잡는 테스트"는 다르다는 게 반복 검증된 결론.
   - 비용/리스크: 재실행 1회 추가로 게이트 시간이 늘어남(orders 규모면 수십 초~1분). 뮤턴트 생성 로직 자체의 버그 위험.
   - 측정: 의도적으로 버그가 있는 PR을 만들어 "테스트가 잡는지"를 리허설하고, 뮤테이션 재실행이 그 결여를 실제로 알려주는지 확인.

2. **studio.yaml 워크플로 스키마에 `concurrency_check` 단계 도입(저비용 스모크)**
   - 무엇: 주문 생성/재고 차감 같은 엔드포인트에 동일 요청 N개(예: 5~10개)를 동시에 쏘아 "정확히 1건만 성공" 또는 "합계가 어긋나지 않음"을 확인하는 선언적 체크(`{ service, path, method, body, concurrent: 10, expect: 'exactly-one-success' }` 같은 최소 스키마).
   - 왜: Jepsen/jcstress가 검증하는 "동시 요청에서 정합성 유지"의 축소판. orders 도메인은 재고·중복주문 이슈가 실제 리스크.
   - 비용/리스크: 노트북 1대·컨테이너 2개 CPU 한도 안에서도 요청 10개 동시 실행은 부담이 적음(k6 없이 `fetch`를 `Promise.all`로 병렬 호출하는 정도면 충분). 다만 DB 트랜잭션 격리 수준에 따라 오탐 가능 — 임계값은 넉넉히 잡아야 함.
   - 측정: 의도적으로 락 없는 재고 차감 코드를 넣은 뒤 체크가 실패로 잡아내는지 리허설.

3. **에이전트 프롬프트에 "테스트를 쓸 때의 최소 기준" 명시**
   - 무엇: `packages/agent/src/prompts.ts`에 "요청받아 테스트를 작성할 때는 해피패스만이 아니라 최소 1개의 실패/경계 케이스를 포함하라"는 문구 추가(현재는 "요청 안 한 테스트를 추가하지 마라"만 있고 품질 기준은 없음).
   - 왜: SWE-bench 교훈 — "통과"만 보면 에이전트가 통과하기 쉬운 얕은 테스트로 수렴하는 경향이 있음.
   - 비용/리스크: 프롬프트 한 줄 추가, 리스크 거의 없음. 효과는 모델 순응도에 달림.
   - 측정: 같은 기능 요청을 프롬프트 변경 전/후로 돌려 생성된 테스트의 assert 개수·경계값 커버 여부를 비교.

4. **프론트 성능 예산은 Lighthouse CI 스타일로 가볍게(선택)**
   - 무엇: `browser_check`가 이미 헤드리스 Chromium을 띄우니, 여기서 페이지 로드 시간·JS 번들 크기 같은 간단한 임계값만 추가로 재는 정도(Lighthouse 전체 실행은 무겁다).
   - 왜: 성능 회귀를 게이트 시점에 잡는다는 원칙은 Lighthouse CI와 같으나, 노트북 자원 제약상 전체 Lighthouse 대신 "로드 시간 3초 이내" 같은 단순 임계값으로 축소.
   - 비용/리스크: 낮음(이미 브라우저를 띄우는 김에 측정치만 추가). 다만 콜리마 VM 자체가 느릴 때 오탐 가능.
   - 측정: 의도적으로 무거운 이미지/무한 루프를 넣어 임계값이 잡아내는지 확인.

### B. b-studio 자체

1. **`load.test.ts`를 이름에 맞는 실제 부하 테스트로 바꾸거나, 별도 파일로 진짜 부하 스모크를 추가**
   - 무엇: 로컬 studio 서버에 세션 N개(예: 5~10개) 동시 생성 + SSE 연결 유지 상태에서 응답 지연·메모리 사용량을 재는 스크립트(k6/Locust 설치 없이 Node `fetch` + `EventSource` 폴리필로 충분, 외부 의존성 추가 없이 `tsx` 스크립트로 작성 가능).
   - 왜: k6/Locust 사례처럼 "동접 상황에서 실패하는지"는 실제로 동접을 만들어봐야 안다 — 현재는 전혀 측정된 적이 없음.
   - 비용/리스크: colima VM 6GiB 한도 안에서 세션 5개 이상 동시 기동은 이미 troubleshooting #36에서 메모리 한계(101MB까지 하락)가 보고됐으니, 실제 샌드박스까지는 띄우지 말고 **스튜디오 서버 API·SSE 계층만** 부하를 주는 게 현실적(샌드박스는 목/스텁).
   - 측정: 동접 세션 수를 늘려가며 SSE 첫 이벤트까지의 지연, 프로세스 메모리(RSS)를 로그로 남기고 회귀 기준선으로 삼는다.

2. **동시 세션 간 공유 자원 경합을 회귀 테스트로 고정 — troubleshooting #36 재발 방지**
   - 무엇: 같은 프로젝트로 세션 2개를 동시에 만드는 통합 테스트를 `apps/studio/e2e/`에 추가해, 두 번째 세션의 기동이 실패하지 않는지 확인(Gradle 캐시 잠금 회귀 감지).
   - 왜: 이미 한 번 실제로 터진 버그이고, 원인(공유 볼륨 잠금)이 구조적이라 다른 형태(예: db 볼륨, 파일 워처)로 재발할 수 있음. Jepsen/DST 철학의 핵심은 "한 번 찾은 버그 클래스는 재현 가능한 테스트로 고정한다"는 것.
   - 비용/리스크: Docker 컨테이너 2개를 동시에 띄워야 해 CI/로컬에서 시간이 걸림(수 분). colima 메모리 공유 이슈 때문에 다른 스택을 멈춰야 할 수 있음.
   - 측정: 테스트가 고정된 상태에서 일부러 캐시 볼륨을 공유로 되돌려 실패하는지 확인(테스트가 실제로 그 결함을 잡는지 리허설 — A안의 뮤테이션 원칙과 동일).

3. **세션/계획 파일의 동시 쓰기에 대한 최소 동시성 유닛 테스트 추가**
   - 무엇: `session-store.test.ts`, `task-plans.test.ts`에 "같은 세션 id에 대해 두 번의 갱신을 동시에(Promise.all) 실행했을 때 마지막 쓰기가 유실 없이 반영되는가"를 확인하는 테스트 1~2개 추가(Go race detector·jcstress처럼 전용 인프라를 새로 들이지 않고, Node의 단일 이벤트 루프 특성을 이용해 "동시에 트리거된 async 쓰기"를 재현하는 수준).
   - 왜: 현재 원자적 쓰기(temp+rename)는 "쓰기 자체가 깨지지 않음"만 보장하지, "두 갱신이 겹치면 하나가 사라짐(lost update)"은 안 잡는다. FoundationDB/TigerBeetle 철학의 축소판이지 전체 DST 도입은 과함.
   - 비용/리스크: 낮음(순수 유닛 테스트, 신규 인프라 불필요). 다만 Node 단일 스레드 특성상 진짜 레이스보다는 "인터리빙 순서 의존성"만 잡을 수 있어 완전성은 없음(Shuttle 문서가 말하는 "sound하지 않다"는 트레이드오프와 동일선상).
   - 측정: 일부러 락 없이 두 쓰기가 서로 덮어쓰게 만든 뒤 테스트가 실패하는지 확인, 그다음 락(버전 검사 또는 큐)을 넣어 통과하는지 확인.

4. **컨테이너 자원 상한 기록을 "부하 회귀 기준선"으로 계속 쌓기(이미 하던 습관을 공식화)**
   - 무엇: studio.yaml 주석에 이미 있는 실측 관행("api 779MiB, 테스트 동시 실행 시 1,736MiB" 같은 기록)을 스튜디오 서버 자체(세션 N개 동접 시 Node 프로세스 RSS)에도 적용해 `docs/troubleshooting.md` 또는 `docs/experiments/`에 축적.
   - 왜: Shopify 게임데이처럼 "정식 부하테스트 도구" 없이도 실측치를 쌓아 회귀를 감지하는 것이 1인 개발·노트북 환경에서는 더 현실적.
   - 비용/리스크: 거의 없음(측정 스크립트 몇 줄 + 문서화 시간).
   - 측정: 이번 조사에서 세션 5개 동접 기준선을 한 번 재두고, 이후 PR에서 그 수치가 크게 벌어지면(예: RSS 2배) 회귀로 간주.

5. **(선택, 우선순위 낮음) SSE 재연결/장시간 연결 시 이벤트 드롭 여부 확인**
   - 무엇: `events/route.ts`가 5,000개 이벤트 초과 시 오래된 것부터 잘린다는 사실이 `bench/coordination/README.md`에 이미 적혀 있음 — 이 절단 로직이 SSE 구독 중간 재연결 시에도 일관되게 동작하는지 확인하는 테스트.
   - 왜: 다중 세션·긴 작업 계획에서 실제로 마주칠 수 있는 시나리오(문서에 이미 한계로 명시돼 있음).
   - 비용/리스크: 낮음, 기존 로직 이해에 약간의 시간.
   - 측정: 이벤트 5,000개 이상 생성 후 재연결 시 클라이언트가 받는 이벤트 순서·누락 여부 확인.

## 5. 출처 URL 목록

- https://arxiv.org/abs/2402.09171
- https://engineering.fb.com/2025/02/05/security/revolutionizing-software-testing-llm-powered-bug-catchers-meta-ach/
- https://dl.acm.org/doi/10.1145/3696630.3728544
- https://engineering.fb.com/2025/09/30/security/llms-are-the-key-to-mutation-testing-and-better-compliance/
- https://research.google/pubs/practical-mutation-testing-at-scale-a-view-from-google/
- https://arxiv.org/pdf/2102.11378
- https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html
- https://testing.googleblog.com/2017/04/where-do-our-flaky-tests-come-from.html
- https://arxiv.org/html/2505.23419v2
- https://arxiv.org/pdf/2608.14711
- https://github.blog/ai-and-ml/github-copilot/assigning-and-completing-issues-with-coding-agent-in-github-copilot/
- https://jqwik.net/property-based-testing.html
- https://sarajuhosova.com/assets/files/2025-pbt-in-the-wild.pdf
- https://apple.github.io/foundationdb/testing.html
- https://pierrezemb.fr/posts/diving-into-foundationdb-simulation/
- https://tigerbeetle.com/blog/2026-08-20-protocol-aware-dst/
- https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md
- https://antithesis.com/docs/introduction/how_antithesis_works/
- https://etcd.io/blog/2025/autonomus_testing_with_antithesis/
- https://jepsen.io/blog
- https://microsoft.github.io/coyote/
- https://github.com/microsoft/coyote
- https://go.dev/blog/race-detector
- https://openjdk.org/projects/code-tools/jcstress/
- https://docs.rs/loom/latest/loom/
- https://github.com/awslabs/shuttle
- https://lamport.azurewebsites.net/tla/formal-methods-amazon.pdf
- https://aws.amazon.com/blogs/storage/how-automated-reasoning-helps-us-innovate-at-s3-scale/
- https://sre.google/workbook/managing-load/
- https://qainsights.com/jmeter-vs-k6-vs-locust-in-2026-which-load-testing-tool-should-you-pick/
- https://shopify.engineering/four-steps-creating-effective-game-day-tests
- https://shopify.engineering/bfcm-readiness-2025
- https://web.dev/articles/lighthouse-ci
