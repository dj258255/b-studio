"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { AgentItem, AgentTotals } from "@/lib/server/agents-overview";
import { inboxPreview } from "@/lib/home-entry";

/** 관제 화면(3초)보다 느리게 — 홈은 개입이 필요해진 것을 알아채면 충분하다 */
const REFRESH_MS = 15_000;
const PREVIEW_LIMIT = 5;

/**
 * 홈 오른쪽(좁으면 아래)의 진행 중 목록. 관제 데이터(`/api/agents`)로 개입이 필요한 것부터 몇 개만 보여 주고,
 * "전체 보기"와 각 목록 화면 링크를 아래에 작게 둔다(예전 상단 버튼을 대신한다).
 */
export function HomeInbox() {
  const [items, setItems] = useState<AgentItem[]>();
  const [attention, setAttention] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/agents", { cache: "no-store" })
        .then(async (response) => (response.ok ? ((await response.json()) as { items?: AgentItem[]; totals?: AgentTotals }) : undefined))
        .then((data) => {
          if (cancelled) return;
          if (!data?.items) {
            setError("관제 목록을 불러오지 못했습니다");
            return;
          }
          setItems(data.items);
          setAttention(data.totals?.attention ?? 0);
          setError(undefined);
        })
        .catch(() => {
          if (!cancelled) setError("관제 목록을 불러오지 못했습니다");
        });
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const preview = inboxPreview(items ?? [], PREVIEW_LIMIT);

  return (
    <section className="glass rounded-panel p-5" aria-labelledby="home-inbox">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="home-inbox" className="text-lg font-semibold">
          진행 중 {attention > 0 && <span className="text-fail">· 개입 필요 {attention}</span>}
        </h2>
        <Link href="/agents" className="glass-soft rounded-control px-3 py-1 text-sm font-medium text-ink hover:bg-panel">
          전체 보기
        </Link>
      </div>

      {items === undefined ? (
        <p className="mt-3 text-sm text-muted">{error ?? "불러오는 중"}</p>
      ) : preview.length === 0 ? (
        <p className="mt-3 text-sm text-muted">지금 진행 중이거나 개입이 필요한 에이전트가 없습니다.</p>
      ) : (
        <ul className="mt-3 space-y-1">
          {preview.map((item) => (
            <li key={`${item.kind}:${item.id}`}>
              <Link href={item.href} className="block rounded-control px-2 py-1.5 hover:bg-panel/60">
                <p className="flex items-baseline gap-2">
                  <span className={`shrink-0 text-xs font-medium ${item.attention ? "text-fail" : item.state === "working" ? "text-wait" : "text-muted"}`}>
                    {item.attention ? "개입 필요" : item.state === "working" ? "작업 중" : "대기"}
                  </span>
                  <span className="min-w-0 truncate text-sm text-ink">{item.title}</span>
                </p>
                <p className="truncate text-xs text-muted">{item.projectName}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
        <Link href="/agents" className="text-muted underline underline-offset-2 hover:text-ink">관제</Link>
        <Link href="/fleets" className="text-muted underline underline-offset-2 hover:text-ink">Agent Fleet</Link>
        <Link href="/task-plans" className="text-muted underline underline-offset-2 hover:text-ink">작업 분해</Link>
        <Link href="/split" className="text-muted underline underline-offset-2 hover:text-ink">나란히 보기</Link>
      </p>
    </section>
  );
}
