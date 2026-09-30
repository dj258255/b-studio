"use client";

import { useEffect, useState } from "react";
import type { BaseStatus } from "@b-studio/agent";
import type { SessionView } from "@/lib/session-view";
import { useChatDraft } from "./chat-draft-context";
import { ExportPreview } from "./export-preview";
import { ReviewCard } from "./review-card";
import { useSessionAccess } from "./session-access";

/** 세션 브랜치를 원격에 올리고 PR을 만드는 영역. 원본 프로젝트가 Git 저장소인 세션에서만 쓸 수 있다 */
export function RepositoryBar({ view }: { view: SessionView }) {
  const { snapshot } = view;
  const repository = snapshot.repository;
  const [busy, setBusy] = useState<"push" | "sync" | "catchup">();
  const [resolving, setResolving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string>();
  const [base, setBase] = useState<BaseStatus>();
  const access = useSessionAccess();
  const draft = useChatDraft();

  // main 따라잡기(ADR-076): 탭이 보일 때만 60초마다 가볍게 확인한다. 세션이 원격과 연결되지 않았으면 확인할 것이 없다
  const hasRepository = Boolean(snapshot.repository);
  useEffect(() => {
    if (!hasRepository) return;
    let cancelled = false;
    async function poll() {
      if (document.visibilityState !== "visible") return;
      try {
        const response = await fetch(`/api/sessions/${snapshot.id}/base`);
        if (!cancelled && response.ok) setBase((await response.json()) as BaseStatus);
      } catch {
        // 가볍게 확인하는 것이라 실패해도 무시하고 다음 간격에 다시 시도한다
      }
    }
    void poll();
    const interval = setInterval(() => void poll(), 60_000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [snapshot.id, hasRepository]);

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

  const idle = !snapshot.running && !busy && access.canManage;
  const canPush = idle && sessionCheckpoints > 0 && !upToDate;
  const showCreate = repository.canCreatePullRequest && !repository.pullRequestUrl;
  const showCompare = !repository.canCreatePullRequest && !repository.pullRequestUrl && repository.compareUrl && repository.pushedSha;

  async function upload() {
    setBusy("push");
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${snapshot.id}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pullRequest: false }),
      });
      if (!response.ok) setError((await response.json()).error ?? "올리지 못했습니다");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(undefined);
    }
  }

  /** 요청만 보내고, 가져오기와 검증 결과는 대화에 이벤트로 온다 */
  async function pullRemote() {
    setBusy("sync");
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${snapshot.id}/sync`, { method: "POST" });
      if (!response.ok) setError((await response.json()).error ?? "원격 변경을 가져오지 못했습니다");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(undefined);
    }
  }

  /** main 따라잡기(ADR-076). 요청만 보내고, 병합·검증 결과는 대화에 이벤트로 온다 */
  async function catchUp() {
    setBusy("catchup");
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${snapshot.id}/base`, { method: "POST" });
      if (!response.ok) setError((await response.json()).error ?? "기준 브랜치를 따라잡지 못했습니다");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(undefined);
    }
  }

  /**
   * "에이전트에게 충돌 해결 맡기기"(ADR-076). 충돌 없이 따라잡으면 catchUp과 같은 결과가 대화에 온다.
   * 충돌하면(병합은 시도 전으로 되돌린 뒤) 서버가 만들어 준 요청 문구를 대화 입력창에 바로 채운다(자동으로 보내지 않는다)
   */
  async function resolveWithAgent() {
    setResolving(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${snapshot.id}/base/resolve`, { method: "POST" });
      const data = (await response.json().catch(() => ({}))) as { request?: string; error?: string };
      if (!response.ok) setError(data.error ?? "충돌 해결을 맡기지 못했습니다");
      else if (data.request) draft.fill(data.request);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setResolving(false);
    }
  }

  return (
    <div className="border-b border-line bg-panel px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm">
            <span className="font-mono font-medium">{repository.branch}</span>
            <span className="text-muted">
              {" "}
              브랜치, 기준 {repository.base}
              {repository.subdir && (
                <>
                  , 폴더 <span className="font-mono">{repository.subdir}</span>
                </>
              )}
            </span>
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
              className="rounded-control border border-line px-3.5 py-1.5 text-sm font-medium hover:border-ink"
            >
              {label} 열기
            </a>
          )}
          {showCompare && (
            <a
              href={repository.compareUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-control border border-line px-3.5 py-1.5 text-sm font-medium hover:border-ink"
            >
              {label} 작성 페이지
            </a>
          )}
          <button
            type="button"
            onClick={() => void pullRemote()}
            disabled={!idle || snapshot.status !== "ready"}
            title="같은 브랜치에 다른 사람이 올린 커밋을 가져와 검증 게이트로 확인합니다"
            className="rounded-control border border-line px-3.5 py-1.5 text-sm font-medium hover:border-ink disabled:opacity-50"
          >
            {busy === "sync" ? "요청하는 중" : "원격 변경 가져오기"}
          </button>
          <button
            type="button"
            onClick={() => void upload()}
            disabled={!canPush}
            className="rounded-control border border-line px-3.5 py-1.5 text-sm font-medium hover:border-ink disabled:opacity-50"
          >
            {busy === "push" ? "올리는 중" : "브랜치 올리기"}
          </button>
          {showCreate && (
            <button
              type="button"
              onClick={() => setPreviewing(true)}
              disabled={!idle || sessionCheckpoints === 0}
              className="rounded-control bg-ink px-3.5 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
            >
              {`올리고 ${label} 만들기`}
            </button>
          )}
        </div>
      </div>

      {base && base.behind > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-wait/40 bg-wait/10 px-3 py-2 text-sm">
          <span>
            {repository.base}이 {base.behind}커밋 앞서 있습니다
          </span>
          <button
            type="button"
            onClick={() => void catchUp()}
            disabled={!idle}
            title="기준 브랜치를 병합으로 따라잡고 다시 검증합니다"
            className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink disabled:opacity-50"
          >
            {busy === "catchup" ? "따라잡는 중" : "따라잡기"}
          </button>
          <button
            type="button"
            onClick={() => void resolveWithAgent()}
            disabled={!idle || resolving}
            title="충돌하면 자동으로 고치지 않고, 사람이 보고 다듬어 보낼 요청을 대화 입력창에 채웁니다"
            className="rounded-control px-2.5 py-1 text-xs font-medium text-muted hover:text-ink disabled:opacity-50"
          >
            {resolving ? "맡기는 중" : "충돌 시 에이전트에게 맡기기"}
          </button>
        </div>
      )}

      <p className="mt-2 text-sm text-muted">{status}</p>
      {repository.sourceDirtyFiles > 0 && (
        <p className="mt-1 text-sm text-wait">원본 폴더에서 커밋하지 않은 변경 {repository.sourceDirtyFiles}개는 이 세션에 들어 있지 않습니다.</p>
      )}
      {error && <p className="mt-1 text-sm text-fail">{error}</p>}
      {previewing && showCreate && <ExportPreview sessionId={snapshot.id} label={label} onClose={() => setPreviewing(false)} />}
      <ReviewCard sessionId={snapshot.id} review={snapshot.review} canManage={access.canManage} hasPullRequest={Boolean(repository.pullRequestUrl)} />
    </div>
  );
}
