# 스튜디오 서버 이미지. 저장소 루트에서 빌드한다: docker build -f apps/studio/Dockerfile .
# 샌드박스와 운영 배포는 호스트의 Docker 데몬이 만들므로, 실행할 때 Docker 소켓을 넘기고 세션·배포 폴더를 호스트와 같은 경로로 마운트한다 (README)
FROM node:22-bookworm-slim AS build

RUN corepack enable
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_update_notifier=false \
    npm_config_store_dir=/pnpm/store

# 잠금 파일과 패키지 목록이 같으면 의존성 층을 다시 쓴다
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/studio/package.json apps/studio/
COPY apps/cli/package.json apps/cli/
COPY packages/agent/package.json packages/agent/
COPY packages/sandbox/package.json packages/sandbox/
COPY packages/spec/package.json packages/spec/
RUN --mount=type=cache,id=b-studio-pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter "@b-studio/studio..."
COPY packages ./packages
COPY apps/studio ./apps/studio
RUN pnpm --filter @b-studio/studio build

# 정적 링크된 docker CLI와 compose·buildx 플러그인만 가져온다. 운영 배포 빌드는 BuildKit 캐시 마운트를 쓰므로 buildx가 필요하다
FROM docker:28-cli AS docker-cli

FROM node:22-bookworm-slim

# 마운트한 세션·프로젝트 폴더는 호스트 사용자 소유라, root로 도는 git이 dubious ownership으로 저장소를 거부한다.
# 세션 폴더는 실행 중에 새로 생기므로 경로를 하나씩 등록할 수 없어 전체를 허용한다 (docs/troubleshooting.md 33)
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client tar \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory '*'
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins

WORKDIR /app
# --network host로 띄우므로 기본은 호스트 루프백에만 연다. 다른 PC에 공개할 때는 인증을 켜고 HOSTNAME을 바꾼다
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=127.0.0.1 \
    PORT=3000 \
    B_STUDIO_PROJECTS_DIR=/projects

COPY --from=build /repo/apps/studio/.next/standalone ./
COPY --from=build /repo/apps/studio/.next/static ./apps/studio/.next/static

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/studio/server.js"]
