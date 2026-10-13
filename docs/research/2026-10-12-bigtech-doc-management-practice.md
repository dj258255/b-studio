# 빅테크의 사내 문서 관리 실무 — 문서 관련 결정에 참고할 규칙

- 작성: 2026-10-12
- 상태: **검토 문서.** 결정은 아니다. b-studio의 문서 관련 기능(문서 탭, 요구사항 추적) 결정에 참고할 후보를 모은 것이다
- 관련: 별도 프로젝트 DocForge의 조사에서 파생. b-studio와 DocForge는 결합하지 않고 각자 설계한다
- 표시: ✅ 원문을 직접 열어 확인한 출처. 이 문서의 규칙은 **모두 ✅**(원문 확인)

## 왜 적는가

b-studio는 이미 문서 탭(ADR-094)과 요구사항 추적을 갖고 있다. 문서를 "더 잘 관리하는" 방법이 필요할 때 남들이 어떻게 하는지가 참고가 된다. 여기 모은 것은 **b-studio에 넣을 후보**이지 결론이 아니다.

## 공통 바닥 — 문서를 코드처럼 (✅)

Google의 *Software Engineering at Google* 10장이 이 바닥을 정의한다. GitLab과 Spotify도 같은 방향이다.

- **문서를 코드처럼** 다룬다: 소스 관리 아래에 두고, owner를 두고, 리뷰하고, 버그로 추적하고, 신선도를 관리한다.
- Google은 사내 위키(`GooWiki`)로 시작했다가 **소스 관리로 옮겼다.** 위키는 owner가 없어 방치됐고, 폐기 시점에 **약 90% 문서가 최근 몇 달간 조회·수정이 없었다**(2015년 스냅숏). 문서 품질이 개발자 1위 불만이 됐다.
- `g3doc`(Google): 문서를 **소스 코드 옆에**(Markdown) 두고, 코드와 **함께** 바꾼다.
- Spotify는 `TechDocs`로 이 방식을 사내 표준으로 만들었다. Markdown을 GitHub에 쓰면 Backstage 포털에 모여 검색된다.

## 따라할 만한 규칙 (참고 후보) — 모두 원문 확인

| 규칙 | 내용 | 어디서 |
| --- | --- | --- |
| 문서를 코드처럼 | 소스 관리·owner·리뷰·버그 추적. 코드 옆에 둔다 | Google(`g3doc`) ✅ · Spotify(`TechDocs`) ✅ |
| owner + 리뷰 강제 | 문서마다 책임자, 변경 시 리뷰 | Google ✅ · Microsoft(CODEOWNERS) ✅ |
| 단일 진실 공급원 | 중복 문서는 deprecate, canonical 하나만 | Google ✅ · GitLab(문서 = SSoT) ✅ |
| 신선도 관리 | 문서에 owner + 마지막 리뷰 날짜, 낡음 감지 | Google(`freshness date`) ✅ |
| 문서 타입 분리 | tutorial / how-to / reference / explanation, 한 문서 = 한 목적 | Diátaxis ✅ · GitLab(topic types) ✅ |
| CI에서 자동 검사 | 링크·린트·빌드를 파이프라인으로 | GitLab(markdownlint·Vale) ✅ |
| 통합 포털 | 흩어진 문서를 한 곳에서 검색 | Spotify(Backstage TechDocs) ✅ |
| 문서도 버그로 추적 | 이슈 트래커에 문서 이슈 | Google ✅ · Spotify ✅ |
| 답을 문서로 되돌린다 | 답이 문서에 있으면 링크, 없으면 문서를 추가한다 | GitLab(docs-first) ✅ |
| 3종 리뷰 | 기술(정확성) / 독자(명료성) / 문장(일관성) | Google ✅ |

## 개인에게는 규칙이 달라진다

위 규칙 대부분은 **여러 사람**을 전제한다(리뷰어, owner 분산, 조직 SSoT). 대상이 **개인**이면 그대로 옮기지 않고, 팀이 하던 사람 역할을 **도구가 대신**하는 쪽으로 바꾼다.

- 리뷰어 → 자동 검사 · 작성자 → 초안 생성 · 지식 보유자 → 검색 · 신선도 리마인드 → 코드 변경 시 자동 감지(drift)
- b-studio는 여러 사람이 쓰는 도구라 규칙 대부분이 유효하다. 문서 탭을 **혼자 쓰는 사용자**까지 고려하면 이 변환도 함께 본다.

## b-studio에 넣을 후보 (검토용, 결정 아님)

- 문서에 **owner·신선도**를 붙여 낡음을 감지하는 것(drift). 이미 있는 "문서 탭"과 겹치는 부분을 먼저 확인한다.
- **문서 타입 분리**를 템플릿에 반영하는 것 (`packages/agent/src/docs.ts`의 템플릿과의 관계 확인).
- 문서를 **버그/이슈로 추적**하는 것 (요구사항 추적과의 관계 확인).

## 원문에서 인용 가능한 것

- **Spotify(2020년 글 기준)**: 조직 전체 **3,000+ doc site**를 Backstage에서 검색. Golden Path 튜토리얼에 **CODEOWNERS**로 소유 추적, GitHub bot으로 이슈 알림. 추적 지표는 **총 방문·실제 문서 업데이트 수·문서 이슈/PR·성공한 검색**(doc site 수는 버니티 지표로 봄).
- **GitLab**: 문서가 **단일 진실 공급원(SSoT)**. `topic types`로 문서 구조화, 답을 문서로 되돌리는 docs-first, markdownlint·Vale로 린트.
- **Diátaxis**: 4종(tutorial/how-to/reference/explanation). Vonage·Gatsby·Cloudflare 등 채택.
- **Microsoft**: 코드 소유는 GitHub `CODEOWNERS` / Azure Repos required reviewers로 파일 경로 기준 리뷰 강제.

## 출처 (모두 ✅ 원문 확인)

- ✅ [Documentation — Software Engineering at Google (ch.10)](https://abseil.io/resources/swe-book/html/ch10.html)
- ✅ [Documentation Style Guide — GitLab Docs](https://docs.gitlab.com/development/documentation/styleguide/)
- ✅ [Ten tips for maintaining docs like code — Spotify(Gary Niemen)](https://www.docslikecode.com/articles/ten-tips-maintaining-long-term-docs-like-code/)
- ✅ [Diátaxis](https://diataxis.fr/)
- ✅ [Enforcing code ownership — Microsoft(PSRule for Azure)](https://azure.github.io/PSRule.Rules.Azure/customization/enforce-codeowners/)
