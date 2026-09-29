"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { AgentItem, AgentTotals } from "@/lib/server/agents-overview";
import { attentionNotices, diffAttention, readNotifyEnabled, shouldNotify, titleWithCount } from "@/lib/attention-notify";

/** 배지를 다시 읽는 간격. 작업 화면(3초)보다 느리게 둬서 헤더가 서버를 자주 두드리지 않게 한다 */
const REFRESH_MS = 15_000;

/**
 * 작업 화면(/work)으로 가는 버튼. 개입 필요 수를 배지로 보여 준다(0이면 숨김).
 * 홈 상단 버튼 줄과 세션 헤더가 같이 쓴다.
 *
 * 실행 중 지시(#103)와 달리 이 알림은 다른 탭에서 일하다가도 놓치지 않게 하는 것이 목적이라,
 * 사용자가 알림을 켰으면 숨은 탭에서도 목록을 다시 읽어 알림을 띄운다. 켜지 않았으면 서버를 아끼려고
 * 보이는 탭일 때만 읽는다. 개입 필요 수는 탭 제목 앞 `(N)`으로도 보여 준다.
 */
export function AgentsBadge() {
  const [attention, setAttention] = useState(0);
  /** 처음 불러온 목록. 여기서 새로 늘어난 항목만 알린다(첫 로드는 알리지 않음) */
  const prevItems = useRef<AgentItem[] | undefined>(undefined);
  /** 배지가 붙기 전의 원래 제목. 페이지를 떠나면 되돌린다 */
  const baseTitle = useRef<string>("");

  useEffect(() => {
    baseTitle.current = document.title;
    let cancelled = false;

    /** 새로 개입이 필요해진 항목만 브라우저 알림으로 띄운다(탭이 보이면 제목 배지로 충분) */
    const notify = (fresh: AgentItem[]) => {
      if (fresh.length === 0) return;
      const supported = typeof Notification !== "undefined";
      const enabled = readNotifyEnabled(window.localStorage);
      if (!shouldNotify({ enabled, supported, visible: document.visibilityState === "visible", permission: supported ? Notification.permission : "denied" })) return;
      for (const notice of attentionNotices(fresh)) {
        const notification = new Notification(notice.title);
        notification.onclick = () => {
          window.focus();
          window.location.href = notice.href;
        };
      }
    };

    // 처음 한 번은 탭이 보이지 않아도 읽는다(뒤 탭으로 연 페이지도 배지가 비어 있지 않게).
    // 그 뒤에는 알림을 켰으면 숨은 탭에서도 읽고, 아니면 보이는 탭일 때만 서버를 두드린다
    const load = (force = false) => {
      if (!force && !readNotifyEnabled(window.localStorage) && document.visibilityState !== "visible") return;
      fetch("/api/agents", { cache: "no-store" })
        .then((response) => (response.ok ? (response.json() as Promise<{ items?: AgentItem[]; totals?: AgentTotals }>) : undefined))
        .then((data) => {
          if (cancelled || !data?.items || !data.totals) return;
          const fresh = diffAttention(prevItems.current, data.items);
          prevItems.current = data.items;
          const count = data.totals.attention ?? 0;
          setAttention(count);
          document.title = titleWithCount(baseTitle.current, count);
          notify(fresh);
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
      // 페이지를 떠나면 제목을 원래대로 돌린다
      document.title = baseTitle.current;
    };
  }, []);

  return (
    <Link href="/work" className="glass-soft inline-flex items-center rounded-control px-3 py-1.5 font-medium text-ink hover:bg-panel">
      작업
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
