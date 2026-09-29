"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentItem, AgentTotals } from "@/lib/server/agents-overview";
import { WorkOverview } from "./work-overview";

/**
 * 개발 화면 옆에서 여는 작업 목록(ADR-069). 페이지를 옮기지 않고 보낸 요청·개입이 필요한 것을 보고, 줄을 눌러 그 세션으로 간다.
 * 여는 순간 목록을 한 번 받고, 그 뒤는 작업 목록 컴포넌트가 스스로 다시 읽는다. Esc나 바깥을 누르면 닫는다.
 * body에 포털로 그린다 — 머리의 유리 효과(backdrop-filter)가 안쪽 fixed 요소의 기준을 머리로 바꿔 패널이 머리 안에 갇혔다
 */
export function WorkDrawer({ onClose }: { onClose: () => void }) {
  const [initial, setInitial] = useState<{ items: AgentItem[]; totals: AgentTotals }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agents", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { items?: AgentItem[]; totals?: AgentTotals; error?: string };
        if (cancelled) return;
        if (!response.ok || !body.items || !body.totals) setError(body.error ?? "작업 목록을 불러오지 못했습니다");
        else setInitial({ items: body.items, totals: body.totals });
      })
      .catch(() => {
        if (!cancelled) setError("작업 목록을 불러오지 못했습니다");
      });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-labelledby="work-drawer-title">
      <button type="button" aria-label="작업 목록 닫기" onClick={onClose} className="absolute inset-0 bg-ink/15" />
      <aside className="glass absolute inset-y-2 right-2 flex w-[min(34rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-panel shadow-xl">
        <header className="flex items-center gap-3 border-b border-line px-5 py-3">
          <h2 id="work-drawer-title" className="text-lg font-semibold">
            작업
          </h2>
          <Link href="/work" className="ml-auto text-xs text-muted underline underline-offset-2 hover:text-ink">
            전체 화면
          </Link>
          <button type="button" onClick={onClose} className="glass-soft rounded-control px-3 py-1 text-sm font-medium hover:bg-panel">
            닫기
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4">
          {initial ? <WorkOverview initial={initial} variant="drawer" /> : <p className="text-sm text-muted">{error ?? "불러오는 중"}</p>}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
