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
    protectedPaths: ['.env', '.github/workflows', 'infra', 'migrations'],
  },
  requestApproval: async ({ tool, summary }) => approvalService.confirm({ tool, summary }),
});
```

승인 콜백이 없거나 승인이 거부되면 해당 호출은 실행되지 않습니다. 승인 토큰을 사용하는 통합에서는 `approvalToken`을 전달할 수 있으며, 토큰 값 자체는 이벤트나 결과에 기록하지 않습니다.

## 감사 로그와 한계

모든 도구 호출에는 `policy` 이벤트가 붙습니다. 허용·차단 여부와 사유만 기록하고 파일 내용·시크릿은 기록하지 않습니다. 웹 세션에서는 이 이벤트가 세션 이벤트 스트림에 남아 재생할 수 있고, CLI에서는 도구 결과와 함께 확인할 수 있습니다.

이 정책은 의도적으로 b-studio 도구 경계에 적용됩니다. 임의의 호스트 셸이나 모델 기본 도구를 활성화하면 이 보장을 약화시키므로, Claude Agent 실행도 기본 도구를 끄고 b-studio MCP 도구만 노출합니다. 운영 배포·실제 DB 변경은 별도의 배포 권한과 환경 경계를 유지해야 합니다.

## 프로젝트별 워크플로 강제

`studio.yaml`에 워크플로 정책을 선언하면 CLI·웹 스튜디오·Pi·Claude 실행 경로가 같은 기준을 공유합니다.

```yaml
workflow:
  required: [plan, implement, run, contract_check, test, review, checkpoint]
  tests:
    - { name: web-lint, service: web, command: [pnpm, lint] }
  allowedTools: [list_files, read_file, write_file, edit_file, run_in_service, restart_service, service_logs, service_stats, http_request, get_contract]
  deniedCommands: [npm publish, git push, terraform apply]
  requireApprovalFor: [restart_service]
  protectedPaths: [.env, .github/workflows, infra, migrations]
  releaseRequires: [contract_check, test, review, checkpoint]
```

`AGENTS.md`, `CLAUDE.md`와 시스템 프롬프트는 에이전트가 다음 행동을 선택하도록 돕는 컨텍스트입니다. 보안과 완료 판정은 이 파일을 믿지 않고 실행기에서 다시 검사합니다.

| 통제 | 위치 | 우회되면 |
|---|---|---|
| 허용 도구·금지 명령·보호 경로·승인 | 도구 호출 직전 (`checkToolPolicy`) | 호출이 컨테이너에 닿지 않고 `policy` 이벤트에 차단 사유가 남습니다 |
| 작업별 쓰기 범위 (`writablePaths`) | 도구 호출 직전. 작업 분해가 작업마다 `studio.yaml` 정책 위에 더함 | 범위 밖 `write_file`·`edit_file`은 막히고, 명령으로 만든 범위 밖 파일은 통합 직전에 다시 걸러집니다 |
| 재시작·계약·화면·테스트 | 검증 게이트 | 실패 결과를 모델에게 돌려주고 재시도 한도를 넘으면 `failed`로 끝납니다 |
| 보호 경로·변경 크기 (사후) | 게이트의 `review` 단계 | 도구 게이트를 거치지 않은 변경도 체크포인트 직전에 잡습니다 |
| 필수 단계 대조 | 게이트 마지막 | 어떤 경로로든 필수 검증 단계가 돌지 않았다면 완료로 인정하지 않습니다 |
| 배포 조건 | `deploySession` | 체크포인트 트레일러에 필요한 단계가 없으면 409로 거부합니다. 규칙은 체크포인트 안이 아니라 실행 중인 세션의 `studio.yaml`에서 읽어, 같은 변경으로 규칙을 느슨하게 만들어 배포하지 못합니다 |

직접 만든 루프(`runAgent`)와 로컬 Claude Code 러너(`runClaudeCodeAgent`)는 모두 `options.policy`가 없으면 `studio.yaml`의 워크플로 정책을 씁니다.

## Pi 연결

Pi는 확장으로 시스템 프롬프트를 바꾸고 도구 호출을 막을 수 있습니다. `packages/agent/pi/bstudio-policy.ts`는 환경 변수로 받은 규칙을 `checkToolPolicy`에 넘겨, b-studio 도구 게이트와 같은 코드로 판정합니다. 환경 변수는 같은 `studio.yaml`에서 만들어 두 곳의 규칙이 어긋나지 않게 합니다.

```bash
# pnpm 스크립트는 저장소 루트에서 실행되므로 프로젝트 경로는 루트 기준으로 넘긴다
eval "$(pnpm -s studio workflow examples/orders --pi-env)"
cd examples/orders   # Pi는 시작한 폴더를 프로젝트 루트로 보고 경로를 비교한다
pi -e ../../packages/agent/pi/bstudio-policy.ts
```

| Pi 내장 도구 | 판정 |
|---|---|
| `write` · `edit` | 절대 경로를 프로젝트 상대 경로로 바꿔 보호 경로를 확인하고, 프로젝트 밖 경로는 막습니다 |
| `read` · `grep` · `find` · `ls` 와 쓰기 도구 | 경로가 `.env`·`.env.*`이면 막습니다. b-studio 작업 공간의 비밀 파일 규칙(`isSecretFile`)을 그대로 씁니다 |
| `bash` · `powershell` | 명령 문자열 전체를 셸 래퍼 명령으로 보고 금지 명령을 찾습니다 (`pnpm test && git push`의 `git push`도 잡습니다) |
| 그 밖의 도구 | 판정하지 않습니다 |

`before_agent_start`에서 워크플로·보호 경로·"완료 선언은 완료 판정이 아니다"라는 안내를 시스템 프롬프트 뒤에 붙입니다.

한계:

- Pi 경로의 변경은 호스트 작업 폴더에서 일어나며 b-studio 샌드박스·검증 게이트·체크포인트를 거치지 않습니다. 이 확장은 개인 Pi 사용에서 팀 규칙을 먼저 적용하는 안내·조기 차단 계층입니다.
- bash 명령은 변수·인코딩·스크립트 파일로 얼마든지 숨길 수 있어 금지 명령 판정은 보안 경계가 아닙니다. `cat .env`나 `echo > .env`처럼 셸로 읽고 쓰는 파일도 막지 못합니다.
- Pi 0.73.1의 실제 확장 로더(`loadExtensions`)와 `ExtensionRunner`로 확장을 불러 도구 호출·시스템 프롬프트 이벤트 10개를 확인했습니다. 모델을 붙인 전체 Pi 세션에서의 확인은 아닙니다.
- 체크포인트와 배포가 필요하면 스튜디오 세션에서 실행해야 하며, 그때는 `review` 단계와 배포 조건이 다시 적용됩니다.
