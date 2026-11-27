# 세션 터미널(컨테이너 방식)의 에이전트 이미지. 기본 이미지(node:22-bookworm-slim, EDGE_IMAGE와 같다)에 codex CLI를 **에이전트가 쓸 수 없는 자리**에 더한다.
# 빌드는 `pnpm agent-image:build`(packages/sandbox/agent-image/build.sh)가 한다. 이 파일을 바꾸면 이미지 이름의 판(AGENT_CODEX_IMAGE)도 올린다.
#
# 왜 이미지에 넣는가: 홈 볼륨(/home/node)은 에이전트가 쓸 수 있다. 거기에 설치한 CLI는 에이전트가 바꿔 둘 수 있고, 그 CLI가 다음 세션의 로그인을 읽는다.
# 이미지의 /opt/b-studio는 root 소유·쓰기 불가이고, 컨테이너의 루트 파일 시스템은 읽기 전용이며 node 사용자로 돈다(agentRunArgs: --read-only, --user node, --cap-drop ALL).
# 자체 CLI(API 모드)는 넣지 않는다: 모델 키를 에이전트가 읽을 수 있는 자리에 둘 수밖에 없고 컨테이너 안에서 OS 샌드박스를 만들 수 없다(ADR-245).
FROM node:22-bookworm-slim

# 고정한 판. 올릴 때는 가두기와 훅(ADR-168, ADR-180)을 다시 확인한다. 호스트의 이 컴퓨터 방식 훅을 실측한 판과 같다
ARG CODEX_VERSION=0.160.1

USER root
RUN npm install --global --prefix /opt/b-studio/codex --no-fund --no-audit "@openai/codex@${CODEX_VERSION}" \
 && chown -R root:root /opt/b-studio \
 && chmod -R go-w,a-s /opt/b-studio \
 && test -x /opt/b-studio/codex/bin/codex
USER node
