# b-studio에 기여하기

b-studio는 모델이 생성한 코드를 실제 서비스처럼 실행하고 검증하는 도구이므로, 기능 동작뿐 아니라 격리·복구·실패 경로를 함께 확인합니다.

## 개발 환경

- Node.js 22 이상
- pnpm 10.29.3
- Docker Desktop 또는 Colima

```bash
corepack enable
pnpm install
pnpm test
pnpm typecheck
```

웹 스튜디오를 개발할 때는 `pnpm studio:demo`, lint, production build도 확인합니다.

## 변경 원칙

- 명세는 `spec`, 실행 경계는 `sandbox`, 모델 루프와 게이트는 `agent`, UI와 세션 API는 `studio`에 둡니다.
- 외부 입력은 스키마에서 검증하고 경로·URL·환경 변수 이름을 좁게 허용합니다.
- 모델의 완료 메시지를 신뢰하지 않고 플랫폼이 관찰할 수 있는 결과로 판정합니다.
- 실패, 취소, 프로세스 종료 뒤에도 사용자 코드와 DB가 일관된 상태로 돌아오는지 확인합니다.
- 시크릿 값, 인증 토큰, 개인정보를 로그·오류·체크포인트·fixture에 넣지 않습니다.
- 공개 동작이나 설정을 바꾸면 README 또는 `docs/`를 함께 고칩니다.

## 테스트 선택

| 변경 영역 | 최소 확인 |
|---|---|
| `packages/spec` | 관련 단위 테스트, `pnpm typecheck` |
| `packages/sandbox` | 단위 테스트, 가능하면 실제 Docker 재현 |
| `packages/agent` | 단위 테스트, 게이트 변경은 `pnpm e2e:agent` |
| `apps/studio` | 타입 검사, lint, production build, 관련 브라우저 흐름 |
| 템플릿 | 템플릿 자체 빌드와 `examples/orders` 기동 |
| 문서만 | 링크, 명령, 파일 경로가 현재 저장소와 맞는지 확인 |

## 설계 기록

보안 경계, 완료·복구 의미, 장기 제약을 만드는 선택을 바꾸면 [설계 결정 기록](docs/decisions.md)에 새 ADR을 추가합니다. 기존 ADR의 당시 판단을 지우지 말고 새 ADR에서 대체 관계를 설명합니다.

## Pull Request 체크리스트

- [ ] 변경 목적과 사용자 영향을 설명했다.
- [ ] 관련 테스트를 추가하거나 수정했다.
- [ ] `pnpm test`와 `pnpm typecheck` 결과를 확인했다.
- [ ] 필요한 경우 lint, build, Docker/Kubernetes E2E를 확인했다.
- [ ] 실패·취소·복구 경로를 검토했다.
- [ ] 문서와 예제를 현재 동작에 맞췄다.
- [ ] 시크릿이나 생성물이 커밋되지 않았는지 확인했다.
