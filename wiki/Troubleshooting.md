# 문제 해결

## 먼저 확인할 것

```bash
node --version
pnpm --version
docker version
docker compose version
pnpm test
pnpm typecheck
```

`pnpm studio up examples/orders --keep`으로 실패 환경을 남기면 컨테이너 상태와 로그를 추가로 확인할 수 있습니다. 분석이 끝난 뒤에는 남은 컨테이너와 볼륨을 직접 확인해 정리하세요.

## 자주 만나는 증상

| 증상 | 먼저 볼 곳 |
|---|---|
| 첫 Next.js 요청이 타임아웃 | readiness는 기동 중 연결 오류를 허용하고 전체 `timeoutSeconds`까지 기다리는지 확인 |
| 코드 변경 뒤 옛 화면이 보임 | 호스트 파일 공유 캐시와 변경 파일 반영 확인 로그 점검 |
| 컴파일 오류인데 게이트가 통과 | 새 파일·새 폴더가 컨테이너 목록에 보이는지 확인 |
| 되돌린 뒤 DB 오류 | `databases` 등록과 해당 체크포인트의 DB 덤프 확인 |
| HMR WebSocket 실패 | edge의 Host/Origin 변환과 원격 미리보기 도메인 확인 |
| 샌드박스가 외부 API를 못 부름 | `network.egress` 또는 external 서비스 정책 확인 |
| 로그에 시크릿이 보임 | 즉시 값을 폐기하고 마스킹·인코딩 경로와 시크릿 선언 확인 |
| 두 세션을 함께 띄울 때 Gradle 실패 | 공유 쓰기 Gradle 홈 대신 세션별 볼륨인지 확인 |
| 컨테이너형 Studio가 Git을 못 찾음 | 호스트와 컨테이너의 프로젝트·세션 경로가 같은지 확인 |

실제 실행에서 발견한 37개 문제의 현상·원인·해결·검증은 [전체 트러블슈팅 문서](https://github.com/dj258255/b-studio/blob/main/docs/troubleshooting.md)에 있습니다. 해당 문서의 번호를 Issue와 PR에서 함께 사용하면 추적하기 쉽습니다.
