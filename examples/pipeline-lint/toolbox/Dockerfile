# 파이프라인 정의를 정적으로 검사하는 도구 모음 이미지.
# 샌드박스는 실행 중에 허용 목록 밖으로 나가는 요청을 막으므로, 검사에 필요한 것(도구, 쿠버네티스 스키마)을 빌드 때 모두 넣는다.
# 버전과 체크섬은 고정한다. 올릴 때는 아래 ARG를 함께 바꾼다.
FROM python:3.12.12-slim-bookworm

# 빌드 대상 아키텍처(amd64·arm64). BuildKit이 채우고, 채우지 않는 빌더에서는 베이스 이미지의 아키텍처를 쓴다
ARG TARGETARCH

ARG AIRFLOW_VERSION=3.3.2
ARG PYTHON_MINOR=3.12
ARG ARGO_VERSION=v4.1.3
ARG ARGO_SHA256_AMD64=f3cf6ae424e9d2b3139efd29f673e7efc47a68881352a26a4122f72c4fc0efd4
ARG ARGO_SHA256_ARM64=0d10a03a490bcfb2f5acb2bb6236357b2132159f5b37aa2ea54d6febb2c5ff57
ARG KUBECONFORM_VERSION=v0.8.0
ARG KUBECONFORM_SHA256_AMD64=9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883
ARG KUBECONFORM_SHA256_ARM64=1f53fc8e81258197a35e8603054162a5af1de8c5af13746c71ab680d9534ed87
ARG HELM_VERSION=v3.22.0
ARG HELM_SHA256_AMD64=1e4ab49e429626cf6c6958d914248b78c9730803c2751b87627e171dc800e7bb
ARG HELM_SHA256_ARM64=f14e804dfee240f55525b667488fe9adca349e63e00c9af634c0beb1421ac310
# kubeconform이 읽을 쿠버네티스 JSON 스키마(yannh/kubernetes-json-schema)의 커밋과 버전.
# 실행 중에는 스키마를 받을 수 없으므로 표본이 쓰는 종류만 넣는다. 다른 종류를 쓰면 SCHEMA_KINDS에 더한다
ARG SCHEMA_COMMIT=1360e239a56dcf2e5c7f99e61ccbaca1ea07036a
ARG K8S_VERSION=v1.34.0
ARG SCHEMA_KINDS="configmap-v1 secret-v1 service-v1 serviceaccount-v1 persistentvolumeclaim-v1 deployment-apps-v1 statefulset-apps-v1 job-batch-v1 cronjob-batch-v1 ingress-networking-v1 horizontalpodautoscaler-autoscaling-v2"

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates; \
    rm -rf /var/lib/apt/lists/*

# 도구 바이너리. 체크섬이 맞지 않으면 빌드가 멈춘다
RUN set -eux; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${arch}" in \
      amd64) argo_sha="${ARGO_SHA256_AMD64}"; kc_sha="${KUBECONFORM_SHA256_AMD64}"; helm_sha="${HELM_SHA256_AMD64}" ;; \
      arm64) argo_sha="${ARGO_SHA256_ARM64}"; kc_sha="${KUBECONFORM_SHA256_ARM64}"; helm_sha="${HELM_SHA256_ARM64}" ;; \
      *) echo "지원하지 않는 아키텍처: ${arch}" >&2; exit 1 ;; \
    esac; \
    tmp="$(mktemp -d)"; cd "${tmp}"; \
    curl -fsSLo argo.gz "https://github.com/argoproj/argo-workflows/releases/download/${ARGO_VERSION}/argo-linux-${arch}.gz"; \
    echo "${argo_sha}  argo.gz" | sha256sum -c -; \
    gunzip argo.gz; install -m 0755 argo /usr/local/bin/argo; \
    curl -fsSLo kc.tar.gz "https://github.com/yannh/kubeconform/releases/download/${KUBECONFORM_VERSION}/kubeconform-linux-${arch}.tar.gz"; \
    echo "${kc_sha}  kc.tar.gz" | sha256sum -c -; \
    tar -xzf kc.tar.gz kubeconform; install -m 0755 kubeconform /usr/local/bin/kubeconform; \
    curl -fsSLo helm.tar.gz "https://get.helm.sh/helm-${HELM_VERSION}-linux-${arch}.tar.gz"; \
    echo "${helm_sha}  helm.tar.gz" | sha256sum -c -; \
    tar -xzf helm.tar.gz "linux-${arch}/helm"; install -m 0755 "linux-${arch}/helm" /usr/local/bin/helm; \
    cd /; rm -rf "${tmp}"; \
    dir="/opt/k8s-schemas/${K8S_VERSION}-standalone-strict"; mkdir -p "${dir}"; \
    for kind in ${SCHEMA_KINDS}; do \
      curl -fsSLo "${dir}/${kind}.json" "https://raw.githubusercontent.com/yannh/kubernetes-json-schema/${SCHEMA_COMMIT}/${K8S_VERSION}-standalone-strict/${kind}.json"; \
    done

# Airflow는 DAG 파일을 import해 보는 데만 쓴다(스케줄러·웹 서버는 띄우지 않는다).
# 공식 constraints 파일로 의존성 버전을 고정한다
RUN pip install --no-cache-dir "apache-airflow==${AIRFLOW_VERSION}" \
      --constraint "https://raw.githubusercontent.com/apache/airflow/constraints-${AIRFLOW_VERSION}/constraints-${PYTHON_MINOR}.txt"

# AIRFLOW_HOME은 작업 폴더 밖 임시 경로에 둔다(설정 파일·sqlite가 저장소에 생기지 않게).
# DAG를 import할 때 __pycache__가 마운트된 작업 폴더에 생기지 않게 바이트코드를 쓰지 않는다
ENV AIRFLOW_HOME=/tmp/airflow \
    PYTHONDONTWRITEBYTECODE=1 \
    HELM_CACHE_HOME=/tmp/helm/cache \
    HELM_CONFIG_HOME=/tmp/helm/config \
    HELM_DATA_HOME=/tmp/helm/data

WORKDIR /work

# 이 이미지는 서버가 아니지만, b-studio의 managed 서비스는 포트와 준비 판정이 있어야 해서
# 빈 폴더를 내주는 작은 HTTP 서버를 계속 띄워 둔다. 준비 판정(GET /)은 "컨테이너가 살아 있다"만 뜻하고,
# 실제 검사는 게이트가 test 단계에서 이 컨테이너 안에 명령을 실행해 한다(studio.yaml의 workflow.tests)
RUN mkdir -p /srv/empty
EXPOSE 8080
CMD ["python", "-m", "http.server", "8080", "--bind", "0.0.0.0", "--directory", "/srv/empty"]
