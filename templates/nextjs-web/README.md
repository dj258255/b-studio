# Next.js Web Template

b-studio가 managed web 서비스를 만들 때 사용하는 Next.js 템플릿입니다. Next.js 16, React 19, Tailwind CSS 4, pnpm을 기준으로 하며 개발용과 운영용 Dockerfile을 따로 제공합니다.

## 템플릿 구성

- `Dockerfile.dev`: 샌드박스에서 개발 서버와 파일 변경 감지를 실행
- `Dockerfile`: standalone 운영 이미지 생성
- `next.config.ts`: 샌드박스 개발과 운영 빌드 설정
- `AGENTS.md`, `CLAUDE.md`: 현재 Next.js 버전에 맞춘 에이전트 지침
- `pnpm-lock.yaml`: 재현 가능한 의존성 설치

## 템플릿을 바꿀 때

이 폴더는 pnpm 워크스페이스에 포함되지 않습니다. 변경 뒤 템플릿 자체만 확인하지 말고 복사되어 실제 프로젝트가 되는 경로까지 검증하세요.

```bash
# 저장소 루트
pnpm test
pnpm typecheck
pnpm studio up examples/orders
```

Next.js 규칙은 이 폴더의 `AGENTS.md`와 설치된 `next/dist/docs/`를 기준으로 확인합니다. 개발·운영 Dockerfile 중 하나만 고치면 두 환경이 달라질 수 있으므로 함께 검토하세요.

프로젝트 명세 작성법은 [`../../docs/configuration.md`](../../docs/configuration.md)를 참고하세요.
