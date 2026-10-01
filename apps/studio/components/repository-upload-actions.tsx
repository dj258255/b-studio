"use client";

import { useState } from "react";
import type { SessionView } from "@/lib/session-view";
import { ExportPreview } from "./export-preview";
import { useSessionAccess } from "./session-access";

/**
 * 세션 브랜치를 올리는 버튼("브랜치 올리기")과, 올릴 수 있으면 PR(MR) 만들기 버튼·미리보기.
 * RepositoryBar(코드 탭 > 변경 기록)와 SubmissionPanel(저장소 탭 > 올리기 전 점검)이 같은 버튼을 보여 준다(ADR-107) —
 * 로직을 두 곳에 나눠 두지 않으려고 여기 하나로 뺐다. 저장소가 없는 세션은 올릴 곳이 없어 아무것도 그리지 않는다
 */
export function RepositoryUploadActions({ view }: { view: SessionView }) {
  const { snapshot } = view;
  const repository = snapshot.repository;
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string>();
  const access = useSessionAccess();

  if (!repository) return null;

  const label = repository.kind === "gitlab" ? "MR" : "PR";
  const sessionCheckpoints = snapshot.checkpoints.length - 1;
  const pushedIndex = repository.pushedSha ? snapshot.checkpoints.findIndex((checkpoint) => checkpoint.sha === repository.pushedSha) : -1;
  const upToDate = pushedIndex === 0;
  const idle = !snapshot.running && !busy && access.canManage;
  const canPush = idle && sessionCheckpoints > 0 && !upToDate;
  const showCreate = repository.canCreatePullRequest && !repository.pullRequestUrl;

  async function upload() {
    setBusy(true);
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
      setBusy(false);
    }
  }

  // display: contents — 바깥 틀이 끼워지는 자리(RepositoryBar의 버튼 줄, SubmissionPanel의 점검표 아래)가
  // 저마다 다른 레이아웃이라, 이 컴포넌트는 자기만의 상자를 두지 않고 버튼·오류·미리보기를 그 자리에 그대로 섞어 넣는다
  return (
    <div className="contents">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void upload()}
          disabled={!canPush}
          className="rounded-control border border-line px-3.5 py-1.5 text-sm font-medium hover:border-ink disabled:opacity-50"
        >
          {busy ? "올리는 중" : "브랜치 올리기"}
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
      {error && <p className="mt-1 text-sm text-fail">{error}</p>}
      {previewing && showCreate && <ExportPreview sessionId={snapshot.id} label={label} onClose={() => setPreviewing(false)} />}
    </div>
  );
}
