# 시작하기

## 요구 사항

- Node.js 22 이상
- pnpm 10.29.3
- Docker Desktop 또는 Colima
- Git
- 실제 모델 실행 시 Anthropic API 키 또는 로그인된 Claude Code CLI

## 설치

```bash
git clone https://github.com/dj258255/b-studio.git
cd b-studio
corepack enable
pnpm install
pnpm test
pnpm typecheck
```

## 주문 예제 실행

```bash
pnpm studio up examples/orders
```

준비가 끝나면 web 미리보기와 API 계약 주소가 표시됩니다. 종료할 때 `Ctrl+C`를 누르면 샌드박스 전용 컨테이너와 볼륨을 정리합니다. 문제를 분석하려고 환경을 남길 때만 `--keep`을 사용하세요.

## 웹 스튜디오

```bash
# 모델을 호출하지 않는 시연 모드
pnpm studio:demo

# 개인 PC의 Claude Code 로그인 사용
pnpm studio:local
```

기본 주소 `http://127.0.0.1:3000`에서 프로젝트를 선택하고 세션을 만듭니다. 로컬 로그인 모드는 개인 PC 전용입니다.

## CLI 에이전트

```bash
# Anthropic API
ANTHROPIC_API_KEY=... pnpm studio agent examples/orders \
  "주문 목록에 상태 필터를 추가해 줘"

# Claude Code 로그인
pnpm studio agent examples/orders \
  "주문 목록에 상태 필터를 추가해 줘" \
  --backend claude-code
```

| 옵션 | 설명 |
|---|---|
| `--backend api\|claude-code` | 모델 실행 방식 |
| `--model <id>` | 모델 지정 |
| `--effort <level>` | `low`부터 `max`까지 추론 노력 지정 |
| `--logs` | 서비스 로그 함께 출력 |
| `--allow-breaking` | 명시적으로 요청한 API 호환성 파괴 허용 |
| `--keep` | 종료 뒤 샌드박스 유지 |

다음 단계는 [[프로젝트 설정|Project-Configuration]]입니다. 더 자세한 로컬 실행 설명은 [저장소 시작 가이드](https://github.com/dj258255/b-studio/blob/main/docs/getting-started.md)를 참고하세요.
