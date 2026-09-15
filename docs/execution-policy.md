# 실행 정책과 도구 호출 통제

b-studio는 모델에게 `운영 배포하지 마`라고 부탁하는 것만으로 안전을 가정하지 않습니다. 모델이 도구를 호출하면 `@b-studio/agent`가 샌드박스에 넘기기 전에 실행 정책을 검사합니다.

```text
실행 인자 → 정책 선택 → 모델 도구 호출 → 실행기 정책 검사 → 허용 또는 차단 → 샌드박스
```

## 기본으로 차단하는 명령

`run_in_service`는 셸 문자열이 아니라 프로그램과 인자의 배열을 받습니다. 실행기는 다음 작업을 기본 차단합니다.

- `git push`, `git reset --hard`, `git clean`
- `kubectl`, `helm`
- `terraform apply`, `terraform destroy`
- `docker`, `podman`
- `psql`, `mysql`, `redis-cli`, `mongosh`

따라서 모델이 프롬프트 지침을 잘못 해석하거나 최신 모델로 바뀌어도 이 명령은 컨테이너 실행 함수에 도달하지 않습니다. 프로젝트 테스트·빌드(`pnpm test`, `./gradlew test` 등)는 계속 허용됩니다.

## 추가 정책

API를 직접 호출하는 실행자는 `RunAgentOptions.policy`로 허용 도구와 추가 차단 규칙을 정할 수 있습니다.

```ts
await runAgent({
  request,
  project,
  sandbox,
  client,
  policy: {
    allowedTools: ['list_files', 'read_file', 'write_file', 'edit_file', 'run_in_service', 'service_logs', 'service_stats'],
    deniedCommands: ['npm publish', 'make release'],
    requireApprovalFor: ['write_file', 'edit_file', 'restart_service'],
  },
  requestApproval: async ({ tool, summary }) => approvalService.confirm({ tool, summary }),
});
```

승인 콜백이 없거나 승인이 거부되면 해당 호출은 실행되지 않습니다. 승인 토큰을 사용하는 통합에서는 `approvalToken`을 전달할 수 있으며, 토큰 값 자체는 이벤트나 결과에 기록하지 않습니다.

## 감사 로그와 한계

모든 도구 호출에는 `policy` 이벤트가 붙습니다. 허용·차단 여부와 사유만 기록하고 파일 내용·시크릿은 기록하지 않습니다. 웹 세션에서는 이 이벤트가 세션 이벤트 스트림에 남아 재생할 수 있고, CLI에서는 도구 결과와 함께 확인할 수 있습니다.

이 정책은 의도적으로 b-studio 도구 경계에 적용됩니다. 임의의 호스트 셸이나 모델 기본 도구를 활성화하면 이 보장을 약화시키므로, Claude Agent 실행도 기본 도구를 끄고 b-studio MCP 도구만 노출합니다. 운영 배포·실제 DB 변경은 별도의 배포 권한과 환경 경계를 유지해야 합니다.
