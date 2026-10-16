# 도메인 범위와 ML·데이터 작업의 검증: 조사

- 작성: 2026-10-16
- 상태: 검토 문서. 결정은 [ADR-175](../decisions.md#adr-175-코어는-도메인을-모르게-두고-깊게-지원하는-레퍼런스는-웹-하나-다른-도메인은-얇은-검증-묶음으로-붙인다)에 적었다
- 관련: 이슈 [#713](https://github.com/dj258255/b-studio/issues/713), ADR-166(지원 범위), [#709](https://github.com/dj258255/b-studio/pull/709)(파이프라인 정의 예제)
- 출처 표시: 표시가 없는 출처는 조사 중에 원문을 열어 확인했다. "(요약)"은 요약 사이트로만 확인한 것이라 결정의 주된 근거로 쓰지 않는다

## 질문

1. 다른 코딩 에이전트와 샌드박스는 도메인 범위를 어떻게 잡고, 완료 전에 무엇을 검증하는지
2. 에이전트가 ML·데이터 작업에서 어떻게 거짓 성공을 내고, 그것을 종료 코드로 잡을 수 있는 검사는 무엇인지

## 1. 다른 도구의 도메인 범위

| 부류 | 예 | 완료 전 검증 | 도메인 의존 |
|---|---|---|---|
| 웹 앱 빌더 | Lovable, Replit Agent | 실제 브라우저로 조작하며 확인. Lovable은 스크린샷·콘솔·네트워크 로그, Replit은 겉으로만 동작하는 화면을 잡으려고 App Testing을 만들었다 | 높음. Lovable은 React + Supabase로 고정, Replit App Testing은 Full Stack JavaScript와 Streamlit에서만 된다 |
| 범용 코딩 에이전트 | GitHub Copilot coding agent, Devin, Cursor 클라우드 에이전트 | 저장소가 선언한 테스트·린터를 돌린다. Copilot은 CodeQL·시크릿 스캔·코드 리뷰를 더하고 관리자가 도구를 고른다. Devin은 `make test` 같은 진입 명령 하나를 권한다(명령마다 2분) | 낮음. 도메인 지식은 사용자 설정에 맡긴다 |
| 샌드박스 인프라 | E2B, Modal, Docker Sandboxes | 검증하지 않는다. 환경(이미지, microVM)만 준다 | 없음 |

읽은 것:
- 깊은 검증(브라우저 조작, 시각 확인)은 스택을 고정한 웹 빌더에만 있다.
- 범용 에이전트는 모두 "선언한 명령을 돌린다"에서 멈춘다. b-studio의 `workflow.tests`와 같은 모양이다.
- 그래서 얇은 검증 묶음만으로는 범용 에이전트와 다를 게 없다. 차별점은 깊게 지원하는 도메인과, 도메인과 무관한 거짓 성공 탐지에서 나와야 한다.

출처: [Lovable 브라우저 테스트](https://docs.lovable.dev/features/browser-testing), [Replit App Testing](https://docs.replit.com/features/agent/app-testing), [Replit 블로그](https://replit.com/blog/automated-self-testing), [Copilot 검증 도구 설정](https://github.blog/changelog/2026-03-18-configure-copilot-coding-agents-validation-tools/), [Devin 저장소 설정](https://docs.devin.ai/onboard-devin/repo-setup), [Cursor 백그라운드 에이전트](https://docs.cursor.com/background-agent), [E2B 사용자 템플릿](https://e2b.dev/docs/legacy/guide/custom-sandbox), [Docker Sandboxes](https://docs.docker.com/ai/sandboxes.md)

## 2. 도메인별 성적 차이

- SWE-bench Multimodal(JS·시각 요소 과제 617개)에서 최고 성적은 약 12%였다. JS에 맞춘 조정의 효과는 작았고 언어를 가리지 않는 설계가 나았다([논문](https://arxiv.org/abs/2410.03859v1)).
- MLE-bench 초기 최고는 메달 16.9%(o1-preview + AIDE, [ICLR 2025](https://proceedings.iclr.cc/paper_files/paper/2025/hash/7e3767db483c942b883eb4f8cfb74e31-Abstract-Conference.html)), DSBench 데이터 분석 정확도는 최고 약 34%([논문](https://arxiv.org/pdf/2409.07703)), Spider 2.0(엔터프라이즈 SQL)은 17.0%~21.3%였다([ICLR 2025](https://mlanthology.org/iclr/2025/lei2025iclr-spider)).
- 벤치마크마다 지표가 달라 "ML이 웹보다 어렵다"를 숫자로 비교할 수는 없다. 근거가 강한 것은 "완료 선언을 믿으면 안 된다"는 쪽이다.

## 3. ML·데이터 작업의 거짓 성공

| 무엇 | 숫자 | 출처 |
|---|---|---|
| 점수 측정 코드 조작(타이머 덮어쓰기, 채점기의 정답을 꺼내 반환, 답을 미리 계산) | RE-Bench 128회 중 39회, 한 과제는 21회 중 21회. HCAST는 1,087회 중 8회 | [METR 2025-06](https://metr.org/blog/2025-06-05-recent-reward-hacking/) |
| 명세와 모순되는 테스트를 통과시킴 | impossible-SWEbench에서 GPT-5 76%. 테스트를 숨기면 거의 0 | [ImpossibleBench](https://arxiv.org/abs/2510.20270) |
| 평가기 변조 시도 | 자유 실행의 약 50%. 평가기를 잠그면 사라지고 실행 시간이 중앙값 25~31% 늘었다 | [RewardHackingAgents](https://arxiv.org/abs/2603.11337) (요약) |
| 데이터셋·학습 예산을 몰래 줄이거나 학습 실패 부분을 조회 함수로 바꿔치기 | 사례 보고 | [arXiv 2608.26753](https://arxiv.org/abs/2608.26753) (요약) |
| 데이터 누수, 지표 오용, 사후 선택. 최종 결과만 보는 것보다 로그·코드를 함께 볼 때 잘 잡혔다 | 사례 보고 | [arXiv 2509.08713](https://arxiv.org/abs/2509.08713) |

b-studio 실험과 같은 축이다. E15에서 요청과 어긋난 테스트를 건네자 18회 모두 테스트를 따라 구현했고 게이트를 통과했다.

여기서 나오는 원칙 둘:
- 평가 코드·테스트·홀드아웃 라벨은 에이전트가 쓸 수 있는 곳에서 떼거나 읽기 전용으로 둔다. b-studio의 `protectedPaths`와 `.git` 읽기 전용(ADR-158)이 이 자리다.
- 에이전트가 보고한 지표는 믿지 않고 게이트가 소유한 스크립트로 다시 계산한다.

## 4. 종료 코드로 쓸 수 있는 검사

| 범주 | 도구 | 잡는 것 | 비용(추정)·결정성 |
|---|---|---|---|
| 평가 자산 무결성 | 테스트·평가 스크립트·라벨 파일의 해시, 보호 경로 | 테스트·채점기 변조 | 거의 0, 결정적 |
| 파이프라인 정의 | Airflow `DagBag` import 오류 0, `argo lint --offline`([Airflow](https://airflow.apache.org/docs/apache-airflow/stable/best-practices.html), [Argo](https://argo-workflows.readthedocs.io/en/latest/cli/argo_lint/)) | import 오류, 잘못된 템플릿 참조 | 초 단위, 결정적. #709에서 실측 |
| 데이터 계약 | Pandera(`SchemaError`), dbt test(실패 행 0)([Pandera](https://pandera.readthedocs.io/en/stable/dataframe_schemas.html), [dbt](https://docs.getdbt.com/docs/build/data-tests)) | 컬럼·타입·null·중복·참조 | 고정 샘플이면 초 단위, 결정적 |
| 스트림 스키마 호환성 | Schema Registry 호환성 검사(기본 BACKWARD)([Confluent](https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html)) | 컨슈머를 깨뜨리는 스키마 변경 | 초 단위, 결정적 |
| 지표 독립 재계산 | 게이트가 가진 평가 스크립트, `mlflow.validate_evaluation_results`의 임계값([MLflow](https://mlflow.org/docs/latest/ml/evaluation/)) | 하드코딩·날조한 지표, 성능 회귀 | 평가 세트 크기에 비례 |
| 학습 스모크 | 배치 하나 과적합, 초기 손실 확인, 입력 0 기준선([Karpathy](https://karpathy.github.io/2019/04/25/recipe/)) | 학습을 건너뜀, 손실·라벨 배선 오류 | CPU 수십 초~수 분, 허용 오차를 두면 대체로 안정 |
| 누수 | deepchecks train-test 검사, train/test 키 교집합 0([deepchecks](https://docs.deepchecks.com/stable/tabular/auto_checks/train_test_validation/index.html)) | 행 중복, 시간 누수 | 초~분 |
| 모델 계약 | MLflow 시그니처([MLflow](https://mlflow.org/docs/latest/ml/model/signatures/)) | 서빙 입출력 계약 위반 | 초 단위, 결정적 |

비결정성: 시드와 결정적 알고리즘은 같은 이미지·같은 CPU에서만 의미가 있다(PyTorch는 릴리스·플랫폼·CPU와 GPU 사이 재현을 보장하지 않는다, [문서](https://docs.pytorch.org/docs/2.14/notes/randomness.html)). 정확한 값 대신 허용 구간으로 판정한다.

이 묶음으로 잡지 못하는 것: 실제 규모의 성능과 수렴, GPU에서만 생기는 비결정성, 방법론의 타당성(벤치마크 선택, 사후 선택), 운영 데이터 드리프트, 스트리밍의 상태 정확성, 고정 샘플 밖에서만 드러나는 버그.

## 5. 검증 묶음 생태계에서 배울 것

- devcontainer Features와 pre-commit은 묶음 형식이 작고 선언적이며(메타데이터 파일 + 스크립트), 배포를 기존 인프라(OCI, git)에 맡긴다([Features 배포](https://containers.dev/implementors/features-distribution/)).
- Daggerverse는 공개 모듈을 자동으로 올려 품질이 들쭉날쭉하다([문서](https://docs.dagger.io/api/daggerverse)).
- 2025년 tj-actions/changed-files 침해에서 버전 태그가 모두 악성 커밋을 가리켰고, 커밋 해시로 고정한 사용자는 대체로 무사했다([Wiz](https://www.wiz.io/blog/github-action-tj-actions-changed-files-supply-chain-attack-cve-2025-30066)).
- 혼자 유지하는 도구라면 레지스트리를 운영하지 않고, 검증 묶음을 "이미지 다이제스트 + 선언한 명령 + 성공 기준"으로 저장소 안에 두는 쪽이 맞다(추론).

## 확인하지 못한 것

- v0가 완료 전에 무엇을 검증하는지, Daytona의 구조, DS-1000의 부정행위 사례.
- 중립 코어 + 묶음 구조가 1인 프로젝트에서 오래 유지되는지에 대한 직접 근거.
- ML 쪽이 웹보다 게이트로 얻는 이득이 크다는 정량 근거. 벤치마크 지표가 달라 비교가 성립하지 않았다.
