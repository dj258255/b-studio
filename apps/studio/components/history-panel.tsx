"use client";

import { useEffect, useState } from "react";
import type { SessionView } from "@/lib/session-view";
import { DiffView } from "./diff-view";
import { RepositoryBar } from "./repository-bar";

/** 체크포인트 기록. 게이트를 통과한 요청마다 하나씩 쌓이고, 이전 시점으로 되돌릴 수 있다 */
export function HistoryPanel({ view }: { view: SessionView }) {
  const { snapshot } = view;
  const [selectedSha, setSelectedSha] = useState<string>();
  const [patch, setPatch] = useState<{ sha: string; text?: string; error?: string }>();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();

  const checkpoints = snapshot.checkpoints;
  const active = checkpoints.find((checkpoint) => checkpoint.sha === selectedSha) ?? checkpoints[0];
  const activeSha = active?.sha;
  const newerCount = active ? checkpoints.indexOf(active) : 0;

  useEffect(() => {
    if (!activeSha) return;
    let cancelled = false;
    fetch(`/api/sessions/${snapshot.id}/checkpoints/${activeSha}`)
      .then(async (response) => {
        const data = await response.json();
        if (!cancelled) setPatch(response.ok ? { sha: activeSha, text: data.patch } : { sha: activeSha, error: data.error });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setPatch({ sha: activeSha, error: String(reason) });
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot.id, activeSha]);

  async function restore() {
    if (!active) return;
    setError(undefined);
    const response = await fetch(`/api/sessions/${snapshot.id}/checkpoints/${active.sha}/restore`, { method: "POST" });
    if (!response.ok) setError((await response.json()).error ?? "되돌리지 못했습니다");
    setConfirming(false);
  }

  if (!active) return <p className="p-6 text-sm text-muted">아직 체크포인트가 없습니다.</p>;

  const canRestore = newerCount > 0 && snapshot.status === "ready" && !snapshot.running;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RepositoryBar view={view} />
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-b border-line bg-panel md:border-r md:border-b-0">
          <h3 className="px-4 pt-4 text-sm font-semibold">체크포인트</h3>
          <p className="px-4 pt-1 text-xs leading-5 text-muted">검증 게이트를 통과한 요청만 남습니다.</p>
          <ol className="px-2 py-2">
            {checkpoints.map((checkpoint, index) => (
              <li key={checkpoint.sha}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedSha(checkpoint.sha);
                    setConfirming(false);
                    setError(undefined);
                  }}
                  aria-current={checkpoint.sha === active.sha}
                  className={`w-full rounded px-2 py-2 text-left ${checkpoint.sha === active.sha ? "bg-ground" : "hover:bg-ground"}`}
                >
                  <span className="block text-sm font-medium">{checkpoint.message}</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    <span className="font-mono">{checkpoint.shortSha}</span>, 파일 {checkpoint.files.length}개{index === 0 && ", 현재"}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </aside>

        <div className="flex min-h-0 flex-col overflow-y-auto p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">{active.message}</h3>
              <p className="mt-0.5 text-sm text-muted">
                <span className="font-mono">{active.shortSha}</span>
                {active.createdAt && `, ${new Date(active.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`}
              </p>
            </div>

            {newerCount > 0 &&
              (confirming ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-fail/40 bg-fail/10 px-3 py-2">
                  <p className="text-sm text-fail">이후 체크포인트 {newerCount}개와 그 변경이 사라집니다.</p>
                  <button type="button" onClick={() => void restore()} disabled={!canRestore} className="rounded bg-fail px-3 py-1 text-sm font-medium text-panel disabled:opacity-50">
                    되돌리기
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className="rounded px-2 py-1 text-sm text-muted hover:text-ink">
                    취소
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={!canRestore}
                  className="rounded-full border border-line px-3.5 py-1.5 text-sm font-medium hover:border-ink disabled:opacity-50"
                >
                  이 시점으로 되돌리기
                </button>
              ))}
          </div>
          {error && <p className="mt-2 text-sm text-fail">{error}</p>}

          <div className="mt-4 min-h-0">
            {patch?.sha !== active.sha ? (
              <p className="text-sm text-muted">변경 내용을 불러오는 중</p>
            ) : patch.error ? (
              <p className="text-sm text-fail">{patch.error}</p>
            ) : (
              <DiffView patch={patch.text ?? ""} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
