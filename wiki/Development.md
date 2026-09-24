# 개발 참여

## 기본 검사

```bash
corepack enable
pnpm install
pnpm test
pnpm typecheck
pnpm --filter @b-studio/studio lint
pnpm --filter @b-studio/studio build
```

Docker 관련 변경은 `pnpm studio up examples/orders`, 에이전트 게이트는 `pnpm e2e:agent`, Fleet는 `pnpm e2e:fleet`로 관련 흐름을 확인합니다.

## 코드 경계

- `packages/spec`: 명세와 입력 검증
- `packages/sandbox`: 실행 환경과 보안 경계
- `packages/agent`: 모델, 제한된 도구, 검증과 체크포인트
- `apps/cli`: 명령행 진입점
- `apps/studio`: 세션 API와 웹 UI
- `templates`: 새 서비스 원본
- `examples/orders`: 전체 통합 예제

## 작업 흐름

1. 새 기능·개선은 "착수 명세" 이슈로 열어 문제·선택지·완료 조건·예상 시간을 먼저 적습니다.
2. `main`에서 `feature/...`, `fix/...`, `docs/...` 브랜치를 딴 뒤 PR 템플릿의 모든 절을 채웁니다.
3. PR은 squash 병합하고, 병합 뒤 `CHANGELOG.md`와 `ROADMAP.md`를 갱신합니다.

자세한 내용은 [CONTRIBUTING.md](https://github.com/dj258255/b-studio/blob/main/CONTRIBUTING.md)를 참고하세요.

## 변경할 때 지킬 것

- 성공 경로만큼 실패·취소·복구 경로를 테스트합니다.
- 보안 경계와 장기 제약을 바꾸면 새 ADR을 씁니다.
- 공개 명령이나 설정을 바꾸면 README, `docs/`, Wiki를 함께 고칩니다.
- 로그, fixture, 스크린샷, 커밋에 토큰과 개인정보를 넣지 않습니다.
- 실제로 실행하지 못한 검증은 PR에 명시합니다.

자세한 체크리스트는 [CONTRIBUTING.md](https://github.com/dj258255/b-studio/blob/main/CONTRIBUTING.md), 설계 근거는 [ADR](https://github.com/dj258255/b-studio/blob/main/docs/decisions.md)를 참고하세요.
