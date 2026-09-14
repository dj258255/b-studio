# 검증 기록과 알려진 한계

이 문서는 “구현되어 있음”과 “실제 환경에서 확인함”을 구분합니다. 재현 과정과 원인 분석이 필요한 항목은 [트러블슈팅](troubleshooting.md), 설계 근거는 [ADR](decisions.md)에 있습니다.

## 자동 검사

```bash
pnpm test
pnpm typecheck
pnpm --filter @b-studio/studio lint
pnpm --filter @b-studio/studio build
```

CI는 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)을 기준으로 실행합니다.

## 실제 환경에서 확인한 범위

| 영역 | 확인 방법 | 결과 |
|---|---|---|
| Docker 샌드박스 | 주문 예제의 web·api·db 기동과 종료 | 준비 판정, URL 출력, 정리 확인 |
| 에이전트 검증 게이트 | 의도적으로 컴파일 오류를 만든 scripted E2E | 실패 반환 뒤 수정·통과 확인 |
| 웹 스튜디오 | 데모/로컬 모드와 실제 브라우저 | 대화, 미리보기, API, 로그, 코드, 기록 탭 확인 |
| 체크포인트 | Git 변경과 PostgreSQL 덤프 비교 | 저장, 취소, 실패, 되돌리기 확인 |
| 세션 복구 | 프로세스 강제 종료 뒤 재시작 | 잔여 샌드박스 정리와 마지막 체크포인트 복원 확인 |
| 원격 저장소 | 로컬 bare 원격과 Gitea | 세션 브랜치, 충돌, lease push, PR 흐름 확인 |
| 자원·네트워크 | 실제 Docker 컨테이너 | 메모리/CPU 상한, egress 차단과 허용 확인 |
| 시크릿·정책 프록시 | 로그·명령·HTTP·Git 경로 | 주입, 마스킹, 커밋 거부, 호출 정책 확인 |
| gVisor | 격리된 Docker-in-Docker | runtime 적용과 서비스 통신 확인 |
| Kubernetes | kind + agent-sandbox | 네임스페이스, Sandbox, gVisor, 준비 판정 확인 |
| 멀티 모델 라우터 | 로컬 호환 공급자 + Docker | 공통 도구 계약, 선택 설명, 관측 저장 확인 |
| Agent Fleet | 2개 독립 후보 E2E | 분리된 브랜치·샌드박스, 결과 비교와 선택 확인 |
| 운영 배포 | 실제 Docker와 고정 주소 | 새 릴리스 전환, 상태, 롤백, 제거 확인 |
| 인증과 한도 | token/proxy 모드, 실제 모델 | 세션 권한, 사용자별·세션별 토큰 차단 확인 |

## 재현용 명령

```bash
pnpm test
pnpm typecheck
pnpm e2e:agent
pnpm e2e:fleet
pnpm bench:boot examples/orders 3
```

E2E는 이미지 다운로드, 컨테이너 생성, 포트 사용, 모델 인증 또는 로컬 브라우저 상태에 영향을 받습니다. 공유 개발 환경에서는 실행 전에 남은 샌드박스와 사용 가능한 자원을 확인하세요.

## 알려진 한계

- API 키를 사용하는 실제 외부 공급자 경로는 자격 증명이 있는 환경에서 별도 확인이 필요합니다.
- GitHub와 GitLab PR API는 계약 테스트를 갖지만, 실제 원격에서의 전체 흐름은 Gitea 실검증과 구분해야 합니다.
- Kubernetes 검증은 로컬 kind 기준입니다. 관리형 클러스터 차이는 별도 검증이 필요합니다.
- Docker 소켓을 마운트하는 운영 방식은 호스트 수준 권한을 가질 수 있습니다.
- 로컬 Claude Code 로그인 모드는 개인 PC 전용입니다.
- 배포 롤백은 데이터베이스 마이그레이션을 되돌리지 않습니다.
- 별도 라이선스가 아직 선언되어 있지 않아 외부 사용·배포 권한을 자동으로 부여하지 않습니다.

새 검증을 추가할 때는 사용한 환경, 입력, 기대 결과, 실제 결과를 함께 기록하세요.
