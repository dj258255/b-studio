# b-studio Wiki

b-studio는 여러 코딩 에이전트를 독립 작업 공간에서 실행하고 진행 상태·토큰·미리보기·diff·검증 결과를 한눈에 비교하는 AI 개발 환경(ADE)입니다.

`studio.yaml`로 프로젝트를 정의하면 작업 난도와 위험도에 맞는 모델을 고르고, 후보마다 독립 Git 작업 공간과 Docker 또는 Kubernetes 샌드박스를 만듭니다. 화면은 Plan → Code → Run → Verify 단계와 토큰·비용·로그·실행 결과를 실시간으로 연결합니다. 사용자는 검증을 통과한 후보의 diff와 미리보기를 비교해 하나를 선택합니다.

## 어디서 시작할까요?

| 목적 | 문서 |
|---|---|
| 주문 예제를 바로 실행하고 싶다 | [[시작하기|Getting-Started]] |
| 새 프로젝트의 `studio.yaml`을 쓰고 싶다 | [[프로젝트 설정|Project-Configuration]] |
| 구성 요소와 요청 흐름을 이해하고 싶다 | [[아키텍처|Architecture]] |
| 에이전트가 무엇을 검증하는지 알고 싶다 | [[에이전트와 검증|Agent-and-Verification]] |
| 공유 서버에 배포하고 싶다 | [[운영과 보안|Operations-and-Security]] |
| 실행 오류를 해결하고 싶다 | [[문제 해결|Troubleshooting]] |
| 코드를 고치거나 PR을 보내고 싶다 | [[개발 참여|Development]] |

## 핵심 흐름

```mermaid
flowchart LR
  U[요청] --> M[모델 + 제한된 도구]
  M --> S[격리된 샌드박스]
  S --> G[재시작 + readiness + 계약 검사]
  G -->|통과| C[Git + DB 체크포인트]
  G -->|실패| M
```

## 현재 구현 범위

- Docker와 Kubernetes 샌드박스 제공자
- Next.js·Spring Boot·FastAPI 템플릿
- 웹 스튜디오, CLI, 미리보기, API 탐색기, 로그와 코드 탭
- 검증 게이트, 요청 취소, 체크포인트, DB 복원, 세션 복구
- 원격 브랜치·PR 흐름과 Agent Fleet
- 자원 한도, egress 제어, 시크릿 가림, external API 정책 프록시
- Anthropic·OpenAI 호환 API·Gemini 모델 라우팅과 로컬 Claude Code 실행

소스와 최신 상태는 [GitHub 저장소](https://github.com/dj258255/b-studio), 상세 설계는 [ADR](https://github.com/dj258255/b-studio/blob/main/docs/decisions.md)에서 확인할 수 있습니다.
