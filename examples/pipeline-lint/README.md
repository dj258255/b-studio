# pipeline-lint 예제

웹 앱이 아닌 저장소에도 검증 게이트를 쓰는 예입니다. 데이터 파이프라인 정의를 고친 뒤 정적 검사를 통과해야 완료로 인정합니다. 코어는 바꾸지 않았고 `studio.yaml`의 `workflow.tests`만 씁니다.

| 정의 | 위치 | 게이트의 검사(test 단계) |
|---|---|---|
| Argo WorkflowTemplate | `workflows/` | `argo lint --offline` — 모르는 필드, 잘못된 형식, 템플릿·파라미터 참조 |
| Airflow DAG | `dags/` | `DagBag`으로 import — 없는 모듈, 문법 오류, 오퍼레이터의 잘못된 인자 |
| 쿠버네티스 매니페스트 | `manifests/` | `kubeconform -strict` — 스키마에 없는 필드와 틀린 형식 |
| Helm 차트 | `charts/report-api/` | `helm template` 결과를 `kubeconform -strict`로 |

검사는 `toolbox` 컨테이너(`toolbox/Dockerfile`) 안에서 네트워크 없이 돕니다. 도구 버전, 체크섬, 쿠버네티스 스키마(1.34.0)를 이미지에 고정해 넣었습니다. toolbox는 서버가 아니지만 managed 서비스에는 포트가 필요해, 빈 폴더를 내주는 HTTP 서버를 띄워 둡니다. 준비 판정은 컨테이너가 살아 있다는 것만 뜻합니다.

## 돌려 보기

저장소 루트에서:

```bash
# 정의 파일 하나를 고친 뒤(Git이 변경으로 보는 파일만 검증합니다)
pnpm studio verify examples/pipeline-lint
```

정상 정의면 `검증 게이트를 통과했습니다`(종료 코드 0), 필드 오류가 있으면 해당 검사가 `실패`로 나오고 종료 코드 1입니다. 변경이 없으면 게이트를 돌리지 않습니다(종료 코드 3). 첫 실행은 toolbox 이미지를 빌드합니다(Apple Silicon 기계에서 한 번 잰 값: 98초, 디스크 929MB).

## 하지 않는 것

- Airflow·Kafka·Flink를 샌드박스 안에서 실행하지 않습니다. DAG는 import만 합니다.
- 실제 클러스터에 적용하지 않습니다(`kubectl apply --dry-run=server` 없음). 클러스터에만 있는 조건(CRD, 승인 웹훅, 이름 충돌)은 잡지 못합니다.
- Argo WorkflowTemplate이 다른 클러스터 리소스(다른 WorkflowTemplate 등)를 참조하면 그 파일도 `workflows/`에 있어야 합니다(`--offline`은 넘긴 파일 안에서만 참조를 풉니다).
- 이미지에 넣지 않은 쿠버네티스 종류(kind)는 "스키마를 찾지 못함"으로 실패합니다. 쓰는 종류를 `toolbox/Dockerfile`의 `SCHEMA_KINDS`에 더하세요. CRD 스키마는 넣지 않았습니다.
