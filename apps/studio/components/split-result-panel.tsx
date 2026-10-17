"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Checkpoint } from "@b-studio/agent";
import type { SessionView } from "@/lib/session-view";
import type { SessionSnapshot, SessionStatus } from "@/lib/studio-events";
import { ActivityStrip } from "./activity-strip";
import { DiffView } from "./diff-view";
import { SERVICE_STATE_LABEL, TONE_TEXT, toneOfService } from "./status";

/**
 * 나란히 보기의 오른쪽 결과 칸(B4). 고른 칸의 결과를 넓은 화면에서만 오른쪽에 보인다 —
 * 마지막 요청의 상태·단계·체크포인트와 사용량(활동 줄), 바뀐 파일, 미리보기 링크, 세션 화면으로 가는 길.
 * 바뀐 파일과 미리보기는 칸이 그리던 것과 같은 컴포넌트를 그대로 쓴다(PaneFilesTab·PanePreviewTab)
 */
export function SplitResultPanel({ view }: { view: SessionView }) {
  const snapshot = view.snapshot;
  return (
    <aside className="glass flex min-h-0 w-[30%] shrink-0 flex-col overflow-hidden rounded-panel" aria-label="선택한 칸의 결과">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{snapshot.projectName}</span>
        <Link href={`/sessions/${snapshot.id}`} className="glass-soft shrink-0 rounded-control px-2.5 py-1 text-xs font-medium hover:bg-panel">
          세션 화면 열기
        </Link>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        <ActivityStrip view={view} open={false} />
        <section className="glass overflow-hidden rounded-panel" aria-label="바뀐 파일">
          <h3 className="border-b border-line px-3 py-1.5 text-xs font-medium text-muted">바뀐 파일</h3>
          <div className="max-h-72 overflow-y-auto">
            <PaneFilesTab sessionId={snapshot.id} checkpoint={snapshot.checkpoints[0]} />
          </div>
        </section>
        <section className="glass overflow-hidden rounded-panel" aria-label="미리보기">
          <h3 className="border-b border-line px-3 py-1.5 text-xs font-medium text-muted">미리보기</h3>
          <PanePreviewTab services={snapshot.services} status={snapshot.status} />
        </section>
      </div>
    </aside>
  );
}

/** [바뀐 파일] 탭. 가장 최근 체크포인트의 파일 목록과 diff를 보여 준다(기록 탭과 같은 API를 쓴다) */
export function PaneFilesTab({ sessionId, checkpoint }: { sessionId: string; checkpoint?: Checkpoint }) {
  const [patch, setPatch] = useState<{ sha: string; text?: string; error?: string }>();

  useEffect(() => {
    if (!checkpoint) return;
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/checkpoints/${checkpoint.sha}`)
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as { patch?: string; error?: string };
        if (!cancelled) setPatch(response.ok ? { sha: checkpoint.sha, text: data.patch } : { sha: checkpoint.sha, error: data.error ?? "바뀐 내용을 불러오지 못했습니다" });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setPatch({ sha: checkpoint.sha, error: String(reason) });
      });
    return () => {
      cancelled = true;
    };
    // sha가 같으면 같은 체크포인트다. sha만 보고 다시 부르면 된다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, checkpoint?.sha]);

  if (!checkpoint) return <p className="p-3 text-sm text-muted">아직 체크포인트가 없습니다.</p>;

  return (
    <div className="p-2">
      <p className="mb-2 px-1 text-xs text-muted">
        {checkpoint.message} · <span className="font-mono">{checkpoint.shortSha}</span> · 파일 {checkpoint.files.length}개
      </p>
      {checkpoint.files.length > 0 && (
        <ul className="mb-2 space-y-0.5 px-1">
          {checkpoint.files.map((file) => (
            <li key={file} className="truncate font-mono text-xs text-muted">
              {file}
            </li>
          ))}
        </ul>
      )}
      {patch?.sha !== checkpoint.sha ? (
        <p className="px-1 text-sm text-muted">불러오는 중</p>
      ) : patch.error ? (
        <p className="px-1 text-sm text-fail">{patch.error}</p>
      ) : (
        <DiffView patch={patch.text ?? ""} />
      )}
    </div>
  );
}

/** [미리보기] 탭. 게이트웨이 티켓 발급 등 내장 미리보기의 복잡함은 피하고, 화면 서비스마다 여는 링크만 준다 */
export function PanePreviewTab({ services, status }: { services: SessionSnapshot["services"]; status: SessionStatus }) {
  const previews = services.filter((service) => service.preview === "browser");
  if (previews.length === 0) return <p className="p-3 text-sm text-muted">이 세션에는 화면 미리보기가 없습니다.</p>;
  if (status === "idle") return <p className="p-3 text-sm text-muted">대기(샌드박스 꺼짐) 상태입니다. 요청을 보내면 켭니다.</p>;
  return (
    <ul className="space-y-2 p-3">
      {previews.map((service) => {
        const url = service.previewUrl ?? service.url;
        return (
          <li key={service.name} className="flex items-center justify-between gap-2 rounded-control border border-line px-3 py-2">
            <span className="min-w-0 truncate text-sm">
              <span className="font-medium">{service.name}</span> <span className={`text-xs ${TONE_TEXT[toneOfService(service.state)]}`}>{SERVICE_STATE_LABEL[service.state]}</span>
            </span>
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer" className="glass-soft shrink-0 rounded-control px-2.5 py-1 text-xs font-medium hover:bg-panel">
                열기
              </a>
            ) : (
              <span className="shrink-0 text-xs text-muted">준비되면 열립니다</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
