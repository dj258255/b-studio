"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { WorkspaceKind } from "@/lib/studio-events";

/** folder가 있으면 복사본과 내 폴더 중에서 고른다. 인증을 켠 서버에서는 folder를 넘기지 않아 복사본만 쓴다 */
export function StartSessionButton({ projectId, folder }: { projectId: string; folder?: string }) {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<WorkspaceKind>("copy");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();

  async function start() {
    setStarting(true);
    setError(undefined);
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, workspace }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error ?? "샌드박스를 시작하지 못했습니다");
      setStarting(false);
      return;
    }
    router.push(`/sessions/${data.id}`);
  }

  const local = workspace === "local";

  return (
    <>
      <div className="flex flex-col items-end gap-2">
        {folder && (
          <div className="glass-soft inline-flex rounded-full p-0.5 text-sm" role="group" aria-label="작업할 위치">
            {(["copy", "local"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={workspace === kind}
                disabled={starting}
                onClick={() => setWorkspace(kind)}
                className={`rounded-full px-3 py-1 font-medium transition-colors ${
                  workspace === kind ? "bg-panel text-ink shadow-sm ring-1 ring-line" : "text-muted hover:text-ink"
                }`}
              >
                {kind === "copy" ? "복사본" : "내 폴더"}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={start}
          disabled={starting}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-panel shadow-sm hover:bg-ink/85 disabled:opacity-60"
        >
          {starting ? (local ? "내 폴더로 준비하는 중" : "복사본 만드는 중") : local ? "내 폴더에서 시작" : "샌드박스 시작"}
        </button>
      </div>
      {folder && (
        <p className="basis-full text-sm leading-6 text-muted">
          {local ? (
            <>
              에이전트가 <span className="break-all font-mono text-xs text-ink">{folder}</span>의 파일을 바로 고칩니다. IDE에서 고친 파일도 미리보기에 바로
              반영됩니다.
            </>
          ) : (
            "프로젝트를 복사해 시험합니다. 원본 폴더는 바뀌지 않습니다."
          )}
        </p>
      )}
      {error && <p className="basis-full text-sm text-fail">{error}</p>}
    </>
  );
}
