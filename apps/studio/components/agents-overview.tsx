"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { AgentAttention, AgentItem, AgentKind, AgentState, AgentTotals } from "@/lib/server/agents-overview";
import { ATTENTION_LABEL, readNotifyEnabled, writeNotifyEnabled } from "@/lib/attention-notify";
import { Dot, TONE_TEXT, type Tone } from "./status";

/** 관제 화면이 다시 읽는 간격. 보이는 탭일 때만 읽는다 */
const REFRESH_MS = 3_000;

const STATE: Record<AgentState, { label: string; tone: Tone }> = {
  working: { label: "작업 중", tone: "pass" },
  booting: { label: "준비 중", tone: "wait" },
  idle: { label: "대기", tone: "idle" },
  stopped: { label: "중지", tone: "idle" },
  error: { label: "오류", tone: "fail" },
};

/** 실패에 가까운 사유만 빨강, 나머지는 확인 중 색 */
const ATTENTION_TONE: Record<AgentAttention, string> = {
  question: "text-wait",
  approval: "text-wait",
  gate_failed: "text-fail",
  error: "text-fail",
  budget: "text-wait",
};

const KIND: Record<AgentKind, string> = { session: "세션", lane: "레인", fleet: "플릿" };

type TabId = "attention" | "working" | "all";

/**
 * 관제 화면: 세션·작업 분해 레인·플릿 구성원을 한 목록으로 보고, 개입이 필요한 것을 먼저 보여 준다.
 * 서버가 준 첫 목록으로 바로 그린 뒤, 3초마다(보이는 탭일 때만) 다시 읽는다.
 */
export function AgentsOverview({ initial }: { initial: { items: AgentItem[]; totals: AgentTotals } }) {
  const [data, setData] = useState(initial);
  const [updatedAt, setUpdatedAt] = useState<string>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<TabId>("attention");

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      // 숨은 탭에서는 서버를 두드리지 않는다. 다시 보이면 다음 주기에 읽는다
      if (document.visibilityState !== "visible") return;
      fetch("/api/agents", { cache: "no-store" })
        .then(async (response) => {
          const body = (await response.json().catch(() => ({}))) as { items?: AgentItem[]; totals?: AgentTotals; error?: string };
          if (cancelled) return;
          if (!response.ok || !body.items || !body.totals) {
            setError(body.error ?? "관제 목록을 불러오지 못했습니다");
            return;
          }
          setData({ items: body.items, totals: body.totals });
          setUpdatedAt(new Date().toISOString());
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

  const attention = useMemo(() => data.items.filter((item) => item.attention), [data.items]);
  const working = useMemo(() => data.items.filter((item) => item.state === "working"), [data.items]);
  const shown = tab === "attention" ? attention : tab === "working" ? working : data.items;

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "attention", label: `개입 필요(${attention.length})` },
    { id: "working", label: `작업 중(${working.length})` },
    { id: "all", label: `전체(${data.items.length})` },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="glass flex flex-wrap items-center gap-x-4 gap-y-1 rounded-panel px-4 py-3 text-sm">
        <span className="font-medium">작업 중 {data.totals.working}</span>
        <span className={data.totals.attention > 0 ? "font-medium text-fail" : "text-muted"}>개입 필요 {data.totals.attention}</span>
        <span className="text-muted">토큰 합 {formatCount(totalTokens(data.totals.tokens))}</span>
        <NotifyButton />
        <span className="ml-auto text-xs text-muted" aria-live="polite">
          {updatedAt ? `마지막 갱신 ${timeOf(updatedAt)}` : "…"}
        </span>
      </div>

      <div role="tablist" aria-label="관제 보기" className="glass flex max-w-full gap-1 self-start overflow-x-auto rounded-panel p-1">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            type="button"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
            className={`shrink-0 rounded-control px-3.5 py-1.5 text-sm font-medium whitespace-nowrap ${
              tab === entry.id ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="text-sm text-fail">
          {error}
        </p>
      )}

      {shown.length === 0 ? (
        <p className="rounded-panel border border-line bg-panel px-4 py-6 text-sm text-muted">
          {tab === "attention" ? "지금 볼 것이 없습니다." : tab === "working" ? "작업 중인 에이전트가 없습니다." : "표시할 에이전트가 없습니다."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((item) => (
            <AgentRow key={`${item.kind}:${item.id}`} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AgentRow({ item }: { item: AgentItem }) {
  const state = STATE[item.state];
  return (
    <li>
      <Link href={item.href} className="glass block rounded-panel px-4 py-3 hover:bg-panel">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="flex items-center gap-1.5">
            <Dot tone={state.tone} />
            <span className={`text-sm font-medium ${TONE_TEXT[state.tone]}`}>{state.label}</span>
          </span>
          <span className="glass-soft rounded-full px-2 py-0.5 text-xs font-medium text-muted">{KIND[item.kind]}</span>
          {item.attention && <span className={`text-sm font-medium ${ATTENTION_TONE[item.attention]}`}>{ATTENTION_LABEL[item.attention]}</span>}
          <span className="ml-auto text-xs text-muted">{timeOf(item.lastActivityAt)}</span>
        </div>
        <p className="mt-1.5 font-medium break-words">{item.title}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
          <span>{item.projectName}</span>
          {item.runningForMs !== undefined && <span>진행 {formatDuration(item.runningForMs)}</span>}
          {item.tokens && <span>토큰 {formatCount(totalTokens(item.tokens))}</span>}
          {item.activity && <span>{item.activity}</span>}
          {item.owner && <span>만든 사람 {item.owner}</span>}
        </p>
      </Link>
    </li>
  );
}

type NotifyState = "off" | "on" | "denied" | "unsupported";

// 권한·설정은 React 바깥 상태라 구독으로 읽는다(SSR에는 window가 없다). 설정을 바꾸면 emit으로 다시 읽게 한다
const notifyListeners = new Set<() => void>();
function emitNotifyChange(): void {
  for (const listener of notifyListeners) listener();
}
function snapshotNotify(): NotifyState {
  if (typeof Notification === "undefined") return "unsupported";
  if (readNotifyEnabled(window.localStorage) && Notification.permission === "granted") return "on";
  if (Notification.permission === "denied") return "denied";
  return "off";
}
function subscribeNotify(listener: () => void): () => void {
  notifyListeners.add(listener);
  return () => notifyListeners.delete(listener);
}

/** 브라우저 알림을 켜는 버튼. 거절·미지원이면 버튼 문구로 알린다 */
function NotifyButton() {
  const state = useSyncExternalStore(subscribeNotify, snapshotNotify, () => "off" as NotifyState);

  async function toggle() {
    if (typeof Notification === "undefined") return;
    if (state === "on") {
      writeNotifyEnabled(window.localStorage, false);
      emitNotifyChange();
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "granted") writeNotifyEnabled(window.localStorage, true);
    emitNotifyChange();
  }

  const label = state === "on" ? "알림 켜짐" : state === "denied" ? "알림이 차단됨" : state === "unsupported" ? "이 브라우저는 알림을 지원하지 않습니다" : "알림 켜기";
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={state === "unsupported"}
      title={state === "denied" ? "브라우저 설정에서 이 사이트의 알림을 허용하세요" : undefined}
      className={`glass-soft rounded-control px-3 py-1 text-xs font-medium ${state === "on" ? "text-ink" : "text-muted hover:text-ink"} disabled:opacity-70`}
    >
      {label}
    </button>
  );
}

function totalTokens(usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function formatCount(value: number): string {
  return value.toLocaleString("ko-KR");
}

/** 진행 시간을 사람이 읽는 한 줄로 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  return `${hours}시간 ${minutes % 60}분`;
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
