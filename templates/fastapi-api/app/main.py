from fastapi import FastAPI

app = FastAPI(title="api")


@app.get("/health", include_in_schema=False)
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/ping")
def ping() -> dict[str, str]:
    return {"message": "pong"}
