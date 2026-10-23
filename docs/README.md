# b-studio 문서

README는 프로젝트를 빠르게 파악하고 실행하는 데 필요한 내용만 담습니다. 상세한 설정과 운영 절차, 구현 근거는 아래 문서에서 관리합니다.

## 처음 사용하는 사람

1. [시작하기](getting-started.md) — 요구 사항, 설치, 첫 샌드박스와 첫 에이전트 요청, 터미널 작업대(`studio desk`)
2. [`studio.yaml` 설정](configuration.md) — 서비스, 준비 확인, 계약, 자원, 네트워크, 시크릿
3. [트러블슈팅](troubleshooting.md) — 실제 실행 중 발견한 증상과 해결 방법

## 운영하는 사람

- [운영과 배포](operations.md) — 인증, 데이터 경로, 배포, 롤백, Kubernetes, 백업
- [실행 정책과 도구 호출 통제](execution-policy.md) — 모델 지침과 별개로 도구·명령을 실행기에서 허용/차단하는 경계
- [아키텍처](architecture.md) — 컴포넌트, 요청 흐름, 신뢰 경계
- [보안 정책](../SECURITY.md) — 취약점 제보와 운영 전 확인 사항

## 개발하고 검토하는 사람

- [기여 가이드](../CONTRIBUTING.md) — 개발 명령, 변경 원칙, PR 체크리스트
- [로드맵](../ROADMAP.md) — 현재 단계, 완료 조건, 예상과 실제
- [변경 기록](../CHANGELOG.md) — 날짜별로 정리한 사용자 변경
- [구현 상태와 일정](status.md) — 영역별 구현 상태와 만든 순서, 작업 방식
- [공구함](toolkit.md) — 신뢰 장치별 역할·코드 위치·뒷받침하는 측정
- [실험 기록](experiments/README.md) — 결정 전에 측정한 결과
- [문서 양식](templates/adr.md) — ADR과 [실험 보고서](templates/experiment-report.md) 작성 틀
- [검토 문서](research/2026-09-25-knowledge-sharing-and-model-handoff.md) — 결정 전 아이디어 검토(에이전트 간 지식 공유, 작업 중 모델 교체)
- [여러 에이전트 관리 도구 조사](research/2026-09-29-multi-agent-management.md) — herdr·Conductor·claude-squad 등 여러 에이전트를 한 곳에서 다루는 도구와 개입 필요 인박스
- [부하·동시성·테스트 조사](research/2026-09-29-testing-load-concurrency.md) — 빅테크의 테스트 품질·동시성 검사 사례와 b-studio 적용 메모
- [PR 중심 에이전트 작업 흐름 조사](research/2026-09-30-pr-agent-workflows.md) — 에이전트가 PR을 만들고 리뷰를 받는 흐름의 빅테크 사례
- [토큰 줄이기 조사](research/2026-09-30-token-reduction-sources.md) — 빅테크 기술 블로그·오픈소스 에이전트 코드가 호출마다 다시 읽히는 문맥을 줄이는 방법, b-studio에 적용할 후보
- [도메인 범위와 ML·데이터 검증 조사](research/2026-10-16-domain-scope-and-ml-verification.md) — 다른 에이전트 도구의 도메인 범위와 완료 전 검증, ML·데이터 작업의 거짓 성공 사례와 종료 코드로 잡는 검사(ADR-175)
- [문서 관리 실무 조사](research/2026-10-12-bigtech-doc-management-practice.md) — 빅테크가 사내 문서를 관리하는 규칙(문서를 코드처럼, owner·신선도, 타입 분리), 문서 관련 결정에 참고할 후보
- [설계 결정 기록](decisions.md) — ADR-001부터 이어지는 선택과 트레이드오프
- [검증 기록과 한계](verification.md) — 자동 검사, 실제 환경 검증, 확인하지 못한 범위

## 문서 관리 원칙

- 명령과 설정은 현재 코드에서 실행 가능한 형태로 적습니다.
- 구현 상태와 계획을 섞지 않고, 검증한 환경을 함께 표시합니다.
- 새로운 설계 선택은 기존 ADR을 고쳐 쓰지 않고 다음 번호의 ADR로 추가합니다.
- 재현 가능한 장애 해결 과정은 [트러블슈팅](troubleshooting.md)에 추가합니다.
- README, `docs/`, Wiki에서 같은 설명을 길게 복제하지 않고 이 문서를 기준으로 연결합니다.
- 계획과 예상은 [로드맵](../ROADMAP.md)과 이슈에, 들어간 변경은 [변경 기록](../CHANGELOG.md)에 적습니다.
