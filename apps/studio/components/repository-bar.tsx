"use client";

import { useState } from "react";
import type { SessionView } from "@/lib/session-view";
import type { ExportResult } from "@/lib/studio-events";

/** 세션 브랜치를 원격에 올리고 PR을 만드는 영역. 원본 프로젝트가 Git 저장소인 세션에서만 쓸 수 있다 */
export function RepositoryBar({ view }: { view: SessionView }) {
  const { snapshot } = view;
  const repository = snapshot.repository;
  const [busy, setBusy] = useState<"push" | "pull-request">();
  const [error, setError] = useState<string>();

  if (!repository) {
    return (
      <p className="border-b border-line bg-panel px-4 py-3 text-sm leading-6 text-muted">
        원본 프로젝트가 Git 저장소가 아니어서 체크포인트는 이 세션 안에만 남습니다. 프로젝트 폴더가 Git 저장소면 세션 브랜치로 올리고 PR을 만들 수 있습니다.
      </p>
    );
  }

  const label = repository.kind === "gitlab" ? "MR" : "PR";
  const sessionCheckpoints = snapshot.checkpoints.length - 1;
  const pushedIndex = repository.pushedSha ? snapshot.checkpoints.findIndex((checkpoint) => checkpoint.sha === repository.pushedSha) : -1;
  const upToDate = pushedIndex === 0;
  const status = !repository.pushedSha
    ? sessionCheckpoints === 0
      ? "아직 올릴 체크포인트가 없습니다. 요청이 검증 게이트를 통과하면 생깁니다."
      : `아직 올리지 않았습니다. 올릴 체크포인트 ${sessionCheckpoints}개`
    : upToDate
      ? "원격 브랜치가 최신 체크포인트와 같습니다."
      : pushedIndex > 0
        ? `올리지 않은 체크포인트 ${pushedIndex}개`
        : "되돌리기 뒤 원격 브랜치와 기록이 다릅니다. 다시 올리면 원격 브랜치를 지금 기록으로 맞춥니다.";

  const idle = !snapshot.running && !busy;
  const canPush = idle && sessionCheckpoints > 0 && !upToDate;
  const showCreate = repository.canCreatePullRequest && !repository.pullRequestUrl;
  const showCompare = !repository.canCreatePullRequest && !repository.pullRequestUrl && repository.compareUrl && repository.pushedSha;

  async function upload(pullRequest: boolean) {
    setBusy(pullRequest ? "pull-request" : "push");
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${snapshot.id}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pullRequest }),
      });
      const data = await response.json();
      if (!response.ok) setError(data.error ?? "올리지 못했습니다");
      else if ((data as ExportResult).pullRequestError) setError(`브랜치는 올렸지만 ${label}을 만들지 못했습니다: ${data.pullRequestError}`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="border-b border-line bg-panel px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm">
            <span className="font-mono font-medium">{repository.branch}</span>
            <span className="text-muted"> 브랜치, 기준 {repository.base}</span>
          </p>
          <p className="mt-0.5 truncate text-xs text-muted" title={repository.remote}>
            {repository.remote}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {repository.pullRequestUrl && (
            <a
              href={repository.pullRequestUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:border-ink"
            >
              {label} 열기
            </a>
          )}
          {showCompare && (
            <a
              href={repository.compareUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:border-ink"
            >
              {label} 작성 페이지
            </a>
          )}
          <button
            type="button"
            onClick={() => void upload(false)}
            disabled={!canPush}
            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:border-ink disabled:opacity-50"
          >
            {busy === "push" ? "올리는 중" : "브랜치 올리기"}
          </button>
          {showCreate && (
            <button
              type="button"
              onClick={() => void upload(true)}
              disabled={!idle || sessionCheckpoints === 0}
              className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
            >
              {busy === "pull-request" ? "올리는 중" : `올리고 ${label} 만들기`}
            </button>
          )}
        </div>
      </div>

      <p className="mt-2 text-sm text-muted">{status}</p>
      {repository.sourceDirtyFiles > 0 && (
        <p className="mt-1 text-sm text-wait">원본 폴더에서 커밋하지 않은 변경 {repository.sourceDirtyFiles}개는 이 세션에 들어 있지 않습니다.</p>
      )}
      {error && <p className="mt-1 text-sm text-fail">{error}</p>}
    </div>
  );
}
