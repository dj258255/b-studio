"use client";

import { useState } from "react";
import { activeRun, type SessionView } from "@/lib/session-view";
import { terminalActivity, type TerminalGateStatus } from "@/lib/terminal";
import { stageLabel } from "./chat-panel";
import { useSessionAccess } from "./session-access";

const TONE: Record<TerminalGateStatus["tone"], string> = { working: "bg-wait motion-safe:animate-pulse", ok: "bg-pass", fail: "bg-fail", idle: "bg-line" };

/**
 * 터미널 아래의 활동 줄(이슈 #689). 터미널에는 "검증 통과 — 체크포인트" 한 줄만 찍히므로, 마지막 요청이 어디까지 왔는지와
 * 어느 단계가 통과·실패했는지, 가장 최근 체크포인트를 한 줄로 보여 준다. 자세한 것(실패 사유, 되살리기)은 펼친 기록에 있다
 */
export function ActivityStrip({ view, open, onToggle }: { view: SessionView; open: boolean; onToggle: () => void }) {
  const access = useSessionAccess();
  const { status, stages, checkpoint } = terminalActivity(view.chat, view.snapshot.checkpoints);
  const runId = activeRun(view);
  /** 되돌리는 동작이라 한 번 더 누르게 한다. 요청이 바뀌면 확인 상태도 사라지도록 요청 id로 둔다 */
  const [confirming, setConfirming] = useState<string>();
  const [error, setError] = useState<string>();

  async function cancel(target: string): Promise<void> {
    setConfirming(undefined);
    setError(undefined);
    const response = await fetch(`/api/sessions/${view.snapshot.id}/runs/${target}/cancel`, { method: "POST" }).catch(() => undefined);
    if (!response?.ok) setError(((await response?.json().catch(() => ({}))) as { error?: string } | undefined)?.error ?? "요청을 취소하지 못했습니다");
  }

  return (
    <section className="glass flex flex-col gap-1.5 rounded-panel px-4 py-2 text-xs" aria-label="활동">
      {/* 첫 줄: 지금 상태와 버튼. 둘째 줄: 단계별 결과와 체크포인트(있을 때만). 한 줄에 다 넣으면 좁은 칸에서 상태 글이 잘린다 */}
      <div className="flex items-center gap-3">
        <p className="flex min-w-0 flex-1 items-center gap-2" role="status" aria-label="검증 상태">
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${TONE[status?.tone ?? "idle"]}`} />
          <span className="min-w-0 truncate" title={status?.text}>
            {status?.text ?? "터미널에서 요청을 보내면 턴이 끝날 때 검증하고, 통과하면 체크포인트를 남깁니다"}
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {runId && access.canManage && !view.snapshot.cancelling &&
            (confirming === runId ? (
              <>
                <button type="button" onClick={() => void cancel(runId)} className="rounded-control bg-fail px-2.5 py-1 font-medium text-panel hover:bg-fail/85">
                  변경 되돌리고 취소
                </button>
                <button type="button" onClick={() => setConfirming(undefined)} className="rounded-control border border-line px-2.5 py-1 hover:border-ink">
                  계속 진행
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setConfirming(runId)} className="rounded-control border border-line px-2.5 py-1 hover:border-ink">
                요청 취소
              </button>
            ))}
          <button type="button" onClick={onToggle} aria-expanded={open} className="rounded-control border border-line px-2.5 py-1 font-medium hover:border-ink">
            {open ? "기록 접기" : "기록 펼치기"}
          </button>
        </div>
      </div>
      {(stages.length > 0 || checkpoint) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-4">
          {stages.length > 0 && (
            <ul className="flex flex-wrap items-center gap-x-2.5" aria-label="단계별 결과">
              {stages.map((entry) => (
                <li key={entry.stage} className={entry.ok ? "text-pass" : "font-medium text-fail"}>
                  <span aria-hidden>{entry.ok ? "✓" : "✗"}</span> {stageLabel(entry.stage)}
                  <span className="sr-only">{entry.ok ? " 통과" : " 실패"}</span>
                </li>
              ))}
            </ul>
          )}
          {checkpoint && (
            <p className="whitespace-nowrap text-muted">
              체크포인트 <span className="font-mono text-ink">{checkpoint.shortSha}</span>
              {checkpoint.incomplete && <span className="ml-1.5 rounded-full border border-wait/40 bg-wait/10 px-1.5 py-px text-[10px] text-wait">턴 상한</span>}
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-fail">
          {error}
        </p>
      )}
    </section>
  );
}
