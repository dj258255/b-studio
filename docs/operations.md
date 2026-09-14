# 운영과 배포

이 문서는 b-studio를 개인 개발 환경이 아닌 공유 서버에서 운영할 때 확인해야 할 항목을 정리합니다.

## 실행 모드

| `B_STUDIO_MODE` | 용도 | 주의 사항 |
|---|---|---|
| `demo` | 모델 없이 제품 흐름 시연 | 실제 코드 작업용이 아님 |
| `claude-code` | 개인 PC의 Claude Code 로그인 사용 | 공유 서버에서 사용하지 않음 |
| API 모드 | 모델 레지스트리와 API 자격 증명 사용 | 공유 환경 권장 |

프로젝트, 세션, Fleet, 배포 데이터는 각각 `B_STUDIO_PROJECTS_DIR`, `B_STUDIO_SESSIONS_DIR`, `B_STUDIO_FLEETS_DIR`, `B_STUDIO_DEPLOYS_DIR`로 위치를 분리할 수 있습니다. 운영에서는 영속 볼륨에 두고 접근 권한을 제한하세요.

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
