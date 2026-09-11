# 운영용 이미지: 의존성 설치와 next build를 이미지 안에서 끝내고, standalone 서버만 실행한다
FROM node:22-bookworm-slim AS build

RUN corepack enable
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_update_notifier=false \
    npm_config_store_dir=/pnpm/store

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=b-studio-pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
# next.config의 rewrites는 빌드할 때 정해진다. 배포기가 compose environment의 같은 이름 값을 빌드 인자로 넘긴다
ARG API_BASE_URL
RUN pnpm build

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

USER node
EXPOSE 3000
CMD ["node", "server.js"]
