# 운영과 보안

## 공유 서버의 기본 원칙

- `claude-code` 모드는 개인 PC에서만 사용합니다.
- 공유 서버는 API 모드와 `token` 또는 `proxy` 인증을 사용합니다.
- Docker 소켓 또는 Kubernetes 권한을 가진 b-studio 프로세스 접근자를 제한합니다.
- 세션, DB 덤프, 사용량, 배포 기록은 영속 볼륨에 두고 암호화·백업합니다.
- 모델 키와 프로젝트 시크릿은 저장소가 아닌 시크릿 관리자에서 주입합니다.

## 인증

token 모드용 토큰은 다음 명령으로 만듭니다.

```bash
pnpm studio auth token alice
```

`B_STUDIO_AUTH=token`, 서명 키, 사용자별 토큰 해시, 관리자 목록을 서버에서 설정합니다. proxy 모드는 공유 비밀과 검증된 사용자 헤더를 사용하며 앱으로 직접 들어오는 우회 경로를 네트워크에서 막아야 합니다.

## 한도

`B_STUDIO_SESSION_TOKEN_LIMIT`으로 세션별 한도를, `B_STUDIO_USER_TOKEN_LIMIT`과 `B_STUDIO_USER_TOKEN_WINDOW`으로 사용자별 기간 한도를 설정할 수 있습니다. 공급자 측 청구 한도도 별도로 두세요.

## 배포

```bash
pnpm studio deploy examples/orders
pnpm studio deploy examples/orders --status
pnpm studio deploy examples/orders --rollback <release-id>
pnpm studio deploy examples/orders --remove
```

롤백은 이미지 트래픽만 이전 릴리스로 전환하고 DB 마이그레이션은 되돌리지 않습니다. DB 볼륨은 `--remove --volumes`에서만 제거됩니다.

## 운영 전 확인

- [ ] TLS와 인증 프록시 우회 방지
- [ ] 프로젝트별 자원 상한과 최소 egress
- [ ] 시크릿 주입과 로그 보존 정책
- [ ] 세션·DB·배포 상태 백업과 실제 복구 훈련
- [ ] Kubernetes RuntimeClass, NetworkPolicy, RBAC와 이미지 출처
- [ ] DB 마이그레이션 하위 호환성과 별도 롤백 절차

전체 환경 변수와 절차는 [운영 가이드](https://github.com/dj258255/b-studio/blob/main/docs/operations.md), 취약점 제보와 경계는 [보안 정책](https://github.com/dj258255/b-studio/blob/main/SECURITY.md)을 참고하세요.
