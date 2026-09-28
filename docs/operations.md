# 운영과 배포

이 문서는 b-studio를 개인 개발 환경이 아닌 공유 서버에서 운영할 때 확인해야 할 항목을 정리합니다.

## 실행 모드

| `B_STUDIO_MODE` | 용도 | 주의 사항 |
|---|---|---|
| `demo` | 모델 없이 제품 흐름 시연 | 실제 코드 작업용이 아님 |
| `claude-code` | 개인 PC의 Claude Code 로그인 사용 | 공유 서버에서 사용하지 않음 |
| `codex` | 개인 PC의 Codex CLI(ChatGPT 로그인) 사용 | 공유 서버에서 사용하지 않음 |
| `commandcode` | 개인 PC의 Command Code 로그인 사용(모델 선택, 무료 모델) | 공유 서버에서 사용하지 않음 |
| `opencode` | 개인 PC에 설치된 OpenCode CLI 사용(모델 선택, 기본 무료 모델) | 공유 서버에서 사용하지 않음 |
| API 모드 | 모델 레지스트리와 API 자격 증명 사용 | 공유 환경 권장 |

프로젝트, 세션, Fleet, 배포 데이터는 각각 `B_STUDIO_PROJECTS_DIR`, `B_STUDIO_SESSIONS_DIR`, `B_STUDIO_FLEETS_DIR`, `B_STUDIO_DEPLOYS_DIR`로 위치를 분리할 수 있습니다. 운영에서는 영속 볼륨에 두고 접근 권한을 제한하세요.

`claude-code` 모드에서 쓸 모델은 `B_STUDIO_CLAUDE_CODE_MODEL`로 고정할 수 있습니다(예: `sonnet`). 비우면 로그인 계정의 기본 모델을 씁니다. 실제로 쓴 모델 이름은 세션 이벤트로 기록됩니다.

> **실제 계정 확인 전**: 이 모드는 단위 테스트로만 확인했습니다. ChatGPT 계정 사용 한도(2026-10-25 재설정) 때문에 실제 실행으로 확정하지 못한 항목 5개가 [#54](https://github.com/dj258255/b-studio/issues/54)에 있습니다(토큰이 턴별인지 누적인지, 캐시 포함 여부, 노출 도구 목록, 격리된 설정에서 로그인 유지, 사용 한도 오류 모양).

`codex` 모드는 `pnpm studio:codex`(`B_STUDIO_MODE=codex`)로 켭니다. 쓸 모델은 `B_STUDIO_CODEX_MODEL`로 고정하고, 비우면 로그인 계정의 기본 모델을 씁니다. Codex SDK에는 대화를 갈라 이어받는 경로가 없어 **이전 대화를 이어받지 않습니다**. 대신 세션에 최근 3개 요청의 요약(요청 앞 200자·결과 앞 300자, 블록 전체 2,000자 상한)만 남겨 다음 요청 앞에 붙입니다. 격리는 세 겹입니다: 실행마다 만드는 빈 작업 폴더 + 읽기 전용 샌드박스 + 빈 `CODEX_HOME`(로그인 파일 `auth.json`만 심볼릭 링크로 빌려오고 사용자 `~/.codex`의 설정·스킬·MCP 서버는 읽지 않음). 다른 사람이 쓰는 서버가 아니라 **본인 PC 전용**입니다.

`commandcode` 모드는 `pnpm studio:commandcode`(`B_STUDIO_MODE=commandcode`)로 켭니다. 모델은 세션을 만들 때 화면에서 고르거나 `B_STUDIO_CMD_MODEL`로 고정하고, 비우면 로그인 계정의 기본 모델(보통 DeepSeek)을 씁니다. `B_STUDIO_CMD_FREE_ONLY=1`이면 무료 모델만 쓰도록 강제합니다(고른 모델이 무료가 아니면 세션을 만들지 않습니다). 무료 모델 목록은 화면의 "무료 모델만" 체크박스로도 걸러 볼 수 있습니다. 실제로 쓴 모델 이름은 세션 이벤트로 기록됩니다. 격리는 실행마다 만드는 빈 작업 폴더 + 프로젝트 `.commandcode/settings.json`의 `permissions.allow: ["mcp__b_studio__*"]`(그 밖의 내장 도구는 헤드리스 기본에서 거부) + 빈 임시 HOME(로그인 파일 `~/.commandcode/auth.json`만 심볼릭 링크로 빌려오고 사용자 설정·스킬·mods·MCP 서버는 읽지 않음) 세 겹입니다. Command Code는 대화를 갈라(fork) 이어받으므로 이전 대화를 이어서 작업할 수 있습니다. 다른 사람이 쓰는 서버가 아니라 **본인 PC 전용**입니다.

`opencode` 모드는 `pnpm studio:opencode`(`B_STUDIO_MODE=opencode`)로 켭니다. **모델을 반드시 골라야 합니다**(CLI·벤치·스튜디오 모두 기본 모델을 추측하지 않습니다). 로그인한 제공자의 모델을 고르고, 로그인 파일(`~/.local/share/opencode/auth.json`)이 있으면 실행마다 임시 HOME에 심볼릭 링크로만 빌려옵니다(내용을 읽거나 복사하지 않습니다). `B_STUDIO_OPENCODE_FREE_ONLY=1`이면 무료 모델만 보여줍니다(기본은 꺼짐). 실제로 쓴 모델 이름은 세션 이벤트로 기록됩니다.

**무료 Zen 거절(중요).** 무료 Zen 티어(`opencode` 제공자의 free 모델)는 b-studio처럼 내장 도구를 좁힌 구성을 거절합니다. 조건을 나눠 잰 결과입니다(무료 모델, 요청 "reply with the single word ok").

| 조건 | 결과 |
|---|---|
| 격리 HOME·XDG, 설정 없음, 기본 에이전트 | 성공 |
| 전용 에이전트 `b-studio`(`*: deny`, `read: allow`), MCP 없음 | 403 `OpenCode's free tier can only be used from within OpenCode` |
| 내장 `build` 에이전트 권한만 덮어씀(`*: deny`, `read: allow`), MCP 없음 | 같은 403 |

원인은 격리 HOME도 MCP도 아니라 **내장 도구 구성을 좁힌 것**입니다. b-studio 경계("모델은 b-studio 도구만")를 풀어 이 검사를 통과시키지 않습니다 — 보안 후퇴이고 제공자 정책 우회입니다. 대신 무료 Zen 모델을 `usable: false`로 표시해 고를 수 없게 하고, 러너는 이 오류를 `provider_gate`로 분류해 재시도하지 않고 한 번만 알립니다(게이트 재시도·fork 포함). 그 오류 뒤 `opencode run`이 멈출 수 있어, 러너는 오류 이벤트를 받으면 자식을 죽이고 제한 시간 안에 실패로 끝냅니다. 쓸 수 있는 모델이 하나도 없으면 화면이 `opencode auth login` 안내를 보여줍니다.

격리는 세 겹입니다: 실행마다 만드는 빈 작업 폴더 + 그 폴더의 `opencode.json`에 정의한 전용 에이전트 `b-studio`(`permission`에서 넓은 `*: deny`를 먼저, 좁은 `b_studio_*: allow`를 나중에 둡니다 — opencode는 마지막으로 맞는 규칙이 이기고, 허용 키는 MCP 도구 이름 글롭입니다) + 빈 임시 HOME(XDG 경로까지 임시 HOME 아래로 돌리고, `OPENCODE_CONFIG`로 실행별 설정만 싣고 `OPENCODE_DISABLE_PROJECT_CONFIG`로 상위 폴더 설정을 막습니다). OpenCode는 대화를 갈라(fork) 이어받으므로 이전 대화를 이어서 작업할 수 있습니다. 다른 사람이 쓰는 서버가 아니라 **본인 PC 전용**입니다.

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
