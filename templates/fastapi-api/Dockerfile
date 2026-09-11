# 운영용 이미지: 잠금 파일대로 개발 의존성 없이 설치하고, 코드 변경 감지 없이 실행한다
FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim

WORKDIR /app
ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/venv

# 잠금 파일이 같으면 의존성 층을 다시 쓴다
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,id=b-studio-uv,target=/root/.cache/uv uv sync --frozen --no-dev --no-install-project
COPY . .
RUN --mount=type=cache,id=b-studio-uv,target=/root/.cache/uv uv sync --frozen --no-dev

RUN useradd --system --uid 10001 app
USER app
EXPOSE 8000
CMD ["/venv/bin/fastapi", "run", "app/main.py", "--host", "0.0.0.0", "--port", "8000"]
