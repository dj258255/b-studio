# 운영과 배포

이 문서는 b-studio를 개인 개발 환경이 아닌 공유 서버에서 운영할 때 확인해야 할 항목을 정리합니다.

## 실행 모드

| `B_STUDIO_MODE` | 용도 | 주의 사항 |
|---|---|---|
| `demo` | 모델 없이 제품 흐름 시연 | 실제 코드 작업용이 아님 |
| `claude-code` | 개인 PC의 Claude Code 로그인 사용 | 공유 서버에서 사용하지 않음 |
| `codex` | 개인 PC의 Codex CLI(ChatGPT 로그인) 사용 | 공유 서버에서 사용하지 않음 |
| API 모드 | 모델 레지스트리와 API 자격 증명 사용 | 공유 환경 권장 |

프로젝트, 세션, Fleet, 배포 데이터는 각각 `B_STUDIO_PROJECTS_DIR`, `B_STUDIO_SESSIONS_DIR`, `B_STUDIO_FLEETS_DIR`, `B_STUDIO_DEPLOYS_DIR`로 위치를 분리할 수 있습니다. 운영에서는 영속 볼륨에 두고 접근 권한을 제한하세요.

`claude-code` 모드에서 쓸 모델은 `B_STUDIO_CLAUDE_CODE_MODEL`로 고정할 수 있습니다(예: `sonnet`). 비우면 로그인 계정의 기본 모델을 씁니다. 실제로 쓴 모델 이름은 세션 이벤트로 기록됩니다.

> **실제 계정 확인 전**: 이 모드는 단위 테스트로만 확인했습니다. ChatGPT 계정 사용 한도(2026-10-25 재설정) 때문에 실제 실행으로 확정하지 못한 항목 5개가 [#54](https://github.com/dj258255/b-studio/issues/54)에 있습니다(토큰이 턴별인지 누적인지, 캐시 포함 여부, 노출 도구 목록, 격리된 설정에서 로그인 유지, 사용 한도 오류 모양).

`codex` 모드는 `pnpm studio:codex`(`B_STUDIO_MODE=codex`)로 켭니다. 쓸 모델은 `B_STUDIO_CODEX_MODEL`로 고정하고, 비우면 로그인 계정의 기본 모델을 씁니다. Codex SDK에는 대화를 갈라 이어받는 경로가 없어 **이전 대화를 이어받지 않습니다**. 대신 세션에 최근 3개 요청의 요약(요청 앞 200자·결과 앞 300자, 블록 전체 2,000자 상한)만 남겨 다음 요청 앞에 붙입니다. 격리는 세 겹입니다: 실행마다 만드는 빈 작업 폴더 + 읽기 전용 샌드박스 + 빈 `CODEX_HOME`(로그인 파일 `auth.json`만 심볼릭 링크로 빌려오고 사용자 `~/.codex`의 설정·스킬·MCP 서버는 읽지 않음). 다른 사람이 쓰는 서버가 아니라 **본인 PC 전용**입니다.

## 웹 인증

### token 모드

```bash
pnpm studio auth token alice
```

출력된 평문 토큰은 사용자에게 한 번만 전달하고, 해시 값은 `B_STUDIO_AUTH_TOKENS`에 넣습니다. 주요 변수는 `B_STUDIO_AUTH=token`, `B_STUDIO_AUTH_SECRET`, `B_STUDIO_AUTH_TOKENS`, `B_STUDIO_AUTH_ADMINS`, `B_STUDIO_AUTH_SESSION_HOURS`입니다.

### proxy 모드

oauth2-proxy 같은 신뢰할 수 있는 인증 프록시 뒤에 둘 때 사용합니다. `B_STUDIO_AUTH=proxy`, `B_STUDIO_AUTH_PROXY_SECRET`, `B_STUDIO_AUTH_USER_HEADER`를 설정하고, 외부 요청이 b-studio에 직접 닿지 않도록 네트워크 계층에서도 프록시를 강제하세요.

## 토큰 사용량 제한

- `B_STUDIO_SESSION_TOKEN_LIMIT`: 세션 하나의 누적 토큰 상한
- `B_STUDIO_USER_TOKEN_LIMIT`: 사용자별 기간 상한
- `B_STUDIO_USER_TOKEN_WINDOW`: 사용자 한도 기간
- `B_STUDIO_USAGE_DIR`: 사용자별 사용량 기록 위치

상한을 넘으면 진행 중인 요청을 멈추고 검증 전 변경을 되돌립니다. 모델 공급자 청구 한도도 별도로 설정해야 합니다.

## 관제 화면

여러 에이전트를 동시에 돌릴 때 홈 상단의 **관제** 버튼(개입 필요 수 배지)으로 `/agents`를 엽니다. 세션·작업 분해 레인·플릿 구성원을 한 목록으로 모아, **지금 사람이 봐야 할 것**을 먼저 보여 줍니다.

- **탭**: 개입 필요 · 작업 중 · 전체. 개입 필요가 0이면 "지금 볼 것이 없습니다".
- **개입 필요 사유**(우선순위 순, 여러 개면 높은 것 하나만): 되묻기 대기 > 계획 승인 대기 > 검증 실패 > 세션 오류 > 토큰 한도.
- **행**: 상태 점·종류 배지(세션/레인/플릿)·제목(마지막 요청 앞 80자, 없으면 프로젝트 이름)·프로젝트·사유·진행 시간·토큰·현재 활동(마지막 에이전트 이벤트 한 줄). 누르면 그 세션으로 가고, 계획 승인 대기는 작업 분해 화면으로 갑니다.
- **갱신**: 3초마다, 보이는 탭일 때만 다시 읽습니다(헤더 배지는 15초). 마지막 갱신 시각을 표시합니다. 목록은 세션 기록 전체를 읽지 않고 스냅샷과 최근 이벤트 몇 개만 씁니다.
- **범위**: 기존 목록 함수(세션 목록·`listTaskPlans`·`listFleets`)가 돌려주는 것 그대로입니다. 권한 규칙을 새로 만들지 않습니다(읽기는 로그인한 사람, 바꾸기는 만든 사람·관리자).

되묻기(`pendingQuestion`)는 아직 스냅샷에 없는 필드라, **있을 때만** 개입 사유로 씁니다(없으면 무시합니다).

## 모델 레지스트리

[`config/model-registry.example.json`](../config/model-registry.example.json)을 복사해 공급자, 모델, 비용과 기능을 설정하고 `B_STUDIO_MODEL_REGISTRY`로 경로를 지정합니다. API 키는 레지스트리 파일에 넣지 말고 공급자별 환경 변수나 시크릿 저장소에서 주입하세요.

## 로컬 Docker 배포

```bash
pnpm studio deploy examples/orders
pnpm studio deploy examples/orders --status
pnpm studio deploy examples/orders --rollback <release-id>
pnpm studio deploy examples/orders --remove
pnpm studio deploy examples/orders --remove --volumes
```

`--rollback`은 컨테이너 이미지만 이전 릴리스로 되돌립니다. 데이터베이스 마이그레이션은 자동으로 되돌리지 않으므로, 하위 호환 마이그레이션과 별도 복구 절차를 준비해야 합니다. `--remove`는 DB 볼륨을 기본적으로 보존하며 `--volumes`를 붙일 때만 함께 제거합니다.

## 남은 샌드박스 자원 정리

비정상 종료나 실패로 남은 샌드박스 자원(컨테이너·이미지·볼륨·네트워크)을 확인하고 지웁니다. Docker VM 디스크가 가득 차 샌드박스가 뜨지 않을 때도 같은 명령을 씁니다.

```bash
pnpm studio sandbox prune --dry-run
pnpm studio sandbox prune
```

`--dry-run`은 지울 목록만 보여 주고 아무것도 지우지 않습니다. 기본 동작은 지울 목록을 먼저 보여 준 뒤 지웁니다.

이름이 `studio-<프로젝트>-<6자리 16진수>` 형태인 compose 자원만 대상으로 하며, 다음은 지우지 않고 건너뜁니다.

- `b-studio.cache=true` 라벨이 붙은 공유 캐시 볼륨 — 다음 세션의 기동 속도가 여기에 달려 있습니다.
- compose 라벨이 없는 익명 볼륨 — 어느 프로젝트가 만들었는지 알 수 없습니다.
- 실행 중인 샌드박스의 자원 — 다른 세션이 쓰는 중일 수 있습니다.

강제 삭제(`-f`)를 쓰지 않으므로 사용 중인 자원은 건너뜁니다. 지우지 못한 자원은 이유와 함께 출력합니다.

## Kubernetes 제공자

`B_STUDIO_SANDBOX_PROVIDER=kubernetes`로 선택하며 환경에 따라 `B_STUDIO_KUBECONFIG`, `B_STUDIO_KUBECTL`, `B_STUDIO_K8S_CONTEXT`, `B_STUDIO_K8S_RUNTIME_CLASS`, `B_STUDIO_K8S_REGISTRY`를 설정합니다. 로컬 kind 검증에는 `B_STUDIO_K8S_KIND_CLUSTER`, `B_STUDIO_K8S_HOST_PATHS`도 사용합니다.

실제 운영 전에는 RuntimeClass, NetworkPolicy, 이미지 레지스트리, 스토리지 클래스, 로그 보존을 조직 정책에 맞게 검증하세요.

## 원격 미리보기

다른 PC에서 미리보기를 열려면 `B_STUDIO_PREVIEW_DOMAIN`, `B_STUDIO_PREVIEW_BIND`, `B_STUDIO_PREVIEW_PORT`로 호스트 기반 게이트웨이를 구성합니다. TLS 종료 프록시가 원래 `Host` 정보를 보존해야 합니다.

### 원격 브라우저와 QA 화면

미리보기 패널의 "원격 브라우저" 보기를 켜면 스튜디오 서버가 세션마다 Chromium 인스턴스 하나를 띄워, 화면을 CDP screencast로 중계하고 사람의 클릭·스크롤·키 입력을 되돌려 보냅니다. 화면 확인(browser_check)도 같은 프레임 채널로 실시간 화면을 보여 주고, 끝나면 단계별 스크린샷을 남깁니다.

- **메모리**: 원격 브라우저 한 개가 수백 MB의 **호스트 메모리**를 씁니다. 보기를 여는 동안에만 띄우고, 보기를 떠나거나 세션을 중지하면 닫습니다. 입력이 **10분** 동안 없으면 자동으로 닫습니다. 세션당 하나만 열립니다.
- **프레임 전송량**: 프레임은 **세션 기록에 남기지 않습니다.** 지금 연결된 브라우저에만 흘려보내고, 새로 연결하면 마지막 한 장만 보냅니다. 대신 스크린샷 산출물은 디스크에 남습니다.
- **산출물 한도**: 화면 확인 단계 스크린샷과 요소 선택 스크린샷은 세션 폴더의 `.git/b-studio/artifacts`에 남깁니다. **세션당 최대 200개·50MB**로 제한하고, 넘으면 오래된 실행 폴더부터 지웁니다. 산출물은 세션을 멈춘 뒤에도 남아 QA 기록에서 다시 볼 수 있습니다.
- **요소 선택**: 미리보기에서 고른 요소는 요청 앞에 `[선택한 요소]` 블록(선택자·HTML·주요 CSS)으로 붙습니다. 스크린샷은 모델에 이미지로 보내지 않고 참조 경로만 적습니다(이미지 입력을 받는 모델과 그렇지 않은 모델이 섞여 있어 한쪽에 맞춘 형식이 다른 쪽에서 오류가 되거나 무시되기 때문입니다).

## Figma 연동

디자인이 Figma에 있는 과제에서 에이전트가 디자인을 보고, 시각 비교의 기준 이미지를 가져오게 하려면 개인 액세스 토큰을 서버에 둡니다.

- **토큰 발급**: Figma → Settings → Security → Personal access tokens에서 새 토큰을 만듭니다. 읽기만 필요하므로 파일 콘텐츠 읽기 권한(`file_content:read`)이면 충분합니다.
- **설정**: 서버 환경 변수 `FIGMA_TOKEN`에만 넣습니다. `studio.yaml`이나 세션 설정에는 토큰을 적지 않습니다. 값은 로그·오류·화면·모델 어디에도 넘기지 않습니다.
- **파일 URL**: `studio.yaml`의 `design.figma.fileUrl`에 두거나, 세션의 "디자인" 패널에서 세션 단위로 저장합니다(세션 설정이 우선). `.fig` 파일은 Figma에 한 번 Import해야 파일 키가 생깁니다.
- **동작**: 페이지·프레임 목록과 노드 요약(자동 레이아웃·색·글꼴·간격, 깊이 3·노드 200·8KB 상한)을 서버가 대신 읽어 에이전트 도구로 넘깁니다. 프레임 PNG는 세션 산출물로 저장하고 참조 경로만 모델에 주며, 이미지 자체는 모델에 보내지 않습니다.
- **가져오기**: 화면에서 고른 프레임은 세션 작업 복사본의 `design/<이름>.png`로 저장됩니다. 이 파일은 세션 변경으로 남아 체크포인트·게이트·PR에 함께 실립니다.
- **요청 한도**: Figma API 요청 한도(429)를 만나면 `Retry-After`를 존중해 한 번만 다시 시도하고, 그래도 막히면 실패로 알립니다. 파일 목록·노드는 파일 `version` 기준으로 메모리에 캐시합니다.
- **토큰이 없으면** 디자인 패널이 설정 안내를 보여 주고, 세션에 디자인 도구가 활성화되지 않습니다.

## 백업과 복구

세션·체크포인트, DB 덤프, 사용량 기록, 배포 상태, 인증 설정, 모델 레지스트리를 백업하세요. 소스 코드와 데이터베이스 내용이 포함될 수 있으므로 암호화와 보존 기간을 조직 정책에 맞추고 실제 복구 훈련을 수행해야 합니다.

## 운영 전 체크리스트

- [ ] 웹 인증과 관리자 목록을 설정했다.
- [ ] TLS와 인증 프록시 우회 방지를 확인했다.
- [ ] 모델 및 사용자 토큰 한도를 설정했다.
- [ ] 세션·배포·사용량 경로를 영속 볼륨에 두었다.
- [ ] 프로젝트별 `resources`, `network.egress`, `secrets`를 검토했다.
- [ ] Docker 소켓 또는 Kubernetes 권한을 최소화했다.
- [ ] 백업과 복구, DB 마이그레이션 롤백 절차를 시험했다.
- [ ] [보안 정책](../SECURITY.md)의 알려진 경계를 검토했다.
