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

## 6. 작업 분해

웹 스튜디오의 "작업 분해"에서 한 요청을 여러 레인(세션)으로 나눠 동시에 실행합니다. 모델이 작업·쓰기 범위·의존 관계를 제안하고 스튜디오가 검증하면, 사람이 승인한 뒤 레인마다 세션을 띄웁니다. 모든 레인이 게이트를 통과하면 새 세션에서 결과를 합쳐 같은 게이트로 다시 검증합니다.

### 관계 그래프

계획 카드의 "그래프" 보기로 레인·작업·통합과 그 사이의 관계를 한 그림에서 봅니다(기존 "목록" 보기와 전환).

- 노드: 왼쪽부터 레인 한 열씩, 레인 안 작업이 위에서 아래 순서, 통합이 맨 오른쪽 한 칸입니다. 노드마다 상태를 색과 함께 아이콘·글자(● 완료 / ◐ 실행 중 / ○ 대기 / ✕ 실패 / ! 범위 위반)로 보여 줍니다. 레인이 쓰기 범위 밖 파일을 바꿨으면 범위 위반으로 표시합니다.
- 간선: 작업 의존(같은 레인이면 세로, 다른 레인이면 가로 곡선), 작업 → 통합, 게시판 메모(작성 레인 → 읽을 수 있는 레인)입니다. 메모 종류별로 선 모양이 다릅니다(계약 실선, 실패 점선, 사실 가는 선). 조율 topology가 star면 레인끼리 직접 잇지 않고 허브(통합)를 거쳐 그립니다.
- 노드를 누르면(또는 Tab으로 옮겨 Enter) 오른쪽 패널에 작업 요청 앞부분·실행 결과 요약·토큰·시간·쓴 메모가 나옵니다. 메모 선을 누르면 메모 본문이 나옵니다.
- 실행 중에는 계획 카드의 2초 갱신 주기로 그래프도 다시 그립니다. 화면이 좁으면(390px) 그래프 영역을 가로로 밀어 봅니다.

## 7. 다음 단계

- 새 프로젝트 작성: [`studio.yaml` 설정](configuration.md)
- 인증과 운영 배포: [운영과 배포](operations.md)
- 기동 실패나 미리보기 문제: [트러블슈팅](troubleshooting.md)
- 내부 구조 이해: [아키텍처](architecture.md)
