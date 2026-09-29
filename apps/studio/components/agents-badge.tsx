"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/** 배지를 다시 읽는 간격. 관제 화면(3초)보다 느리게 둬서 헤더가 서버를 자주 두드리지 않게 한다 */
const REFRESH_MS = 15_000;

/**
 * 관제 화면으로 가는 버튼. 개입 필요 수를 배지로 보여 준다(0이면 숨김).
 * 홈 상단 버튼 줄과 세션 헤더가 같이 쓴다. 보이는 탭일 때만 다시 읽는다.
 */
export function AgentsBadge() {
  const [attention, setAttention] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // 처음 한 번은 탭이 보이지 않아도 읽는다(뒤 탭으로 연 페이지도 배지가 비어 있지 않게). 그 뒤 주기 갱신은 보이는 탭에서만
    const load = (force = false) => {
      if (!force && document.visibilityState !== "visible") return;
      fetch("/api/agents", { cache: "no-store" })
        .then((response) => (response.ok ? (response.json() as Promise<{ totals?: { attention?: number } }>) : undefined))
        .then((data) => {
          if (!cancelled && data?.totals) setAttention(data.totals.attention ?? 0);
        })
        .catch(() => {
          // 배지를 못 읽어도 화면은 그대로 둔다
        });
    };
    load(true);
    const timer = setInterval(() => load(), REFRESH_MS);
    // 탭이 다시 보이면 주기를 기다리지 않고 바로 읽는다
    const onVisible = () => load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <Link href="/agents" className="glass-soft inline-flex items-center rounded-control px-3 py-1.5 font-medium text-ink hover:bg-panel">
      관제
      {attention > 0 && (
        <span
          className="ml-1.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-fail px-1.5 text-xs font-semibold text-panel"
          aria-label={`개입 필요 ${attention}개`}
        >
          {attention > 99 ? "99+" : attention}
        </span>
      )}
    </Link>
  );
}
