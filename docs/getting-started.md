# 시작하기

이 문서는 로컬 Docker에서 주문 예제를 실행하고 첫 에이전트 요청을 보내는 데까지 안내합니다.

## 1. 요구 사항

| 항목 | 요구 사항 |
|---|---|
| Node.js | 22 이상 |
| pnpm | 10.29.3 (`packageManager` 기준) |
| 컨테이너 런타임 | Docker Desktop 또는 Colima |
| Git | 체크포인트와 원격 저장소 연동에 필요 |
| 모델 인증 | Anthropic API 키 또는 로그인된 Claude Code CLI |

처음 실행할 때 Docker가 Node, Java, PostgreSQL 이미지와 의존성을 내려받으므로 시간이 걸릴 수 있습니다.

## 2. 저장소 설치

```bash
git clone https://github.com/dj258255/b-studio.git
cd b-studio
corepack enable
pnpm install
```

기본 검사를 먼저 실행하면 로컬 환경 문제를 일찍 찾을 수 있습니다.

```bash
pnpm test
pnpm typecheck
```

## 3. 주문 예제 실행

```bash
pnpm studio up examples/orders
```

b-studio는 명세와 compose 구성을 검증하고, 샌드박스를 만든 뒤 각 서비스의 준비 상태를 확인합니다. 준비가 끝나면 미리보기와 OpenAPI 주소를 출력합니다.

종료할 때는 `Ctrl+C`를 한 번 누르세요. 디버깅을 위해 컨테이너를 남기려면 `--keep`을 붙입니다.

```bash
pnpm studio up examples/orders --keep
```

## 4. 웹 스튜디오 실행

```bash
# 모델 없이 세션 흐름 확인
pnpm studio:demo

# 개인 PC의 Claude Code 로그인 사용
claude --version
pnpm studio:local
```

브라우저에서 `http://127.0.0.1:3000`을 열고 `examples/orders` 프로젝트로 세션을 만듭니다. `claude-code` 모드는 로그인된 개인 PC에서만 사용하세요. 여러 사용자가 접속하는 서버에서는 API 모드와 웹 인증을 구성해야 합니다.

## 5. 첫 에이전트 요청

```bash
# Anthropic API
export ANTHROPIC_API_KEY="..."
pnpm studio agent examples/orders "주문 목록에 상태 필터를 추가해 줘"

# Claude Code 로그인
pnpm studio agent examples/orders \
  "주문 목록에 상태 필터를 추가해 줘" \
  --backend claude-code
```

| 옵션 | 의미 |
|---|---|
| `--backend api\|claude-code` | 모델 실행 방식 선택 |
| `--model <id>` | 사용할 모델 지정 |
| `--effort low\|medium\|high\|xhigh\|max` | 추론 노력 수준 지정 |
| `--logs` | 서비스 로그를 함께 출력 |
| `--allow-breaking` | 요청이 명시한 API 호환성 파괴 허용 |
| `--keep` | 종료 또는 실패 뒤에도 샌드박스 유지 |

## 6. 다음 단계

- 새 프로젝트 작성: [`studio.yaml` 설정](configuration.md)
- 인증과 운영 배포: [운영과 배포](operations.md)
- 기동 실패나 미리보기 문제: [트러블슈팅](troubleshooting.md)
- 내부 구조 이해: [아키텍처](architecture.md)
