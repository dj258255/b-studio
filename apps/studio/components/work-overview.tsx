"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { AgentAttention, AgentItem, AgentState, AgentTotals } from "@/lib/server/agents-overview";
import { ATTENTION_LABEL, readNotifyEnabled, writeNotifyEnabled } from "@/lib/attention-notify";
import { MAX_SPLIT, splitHref } from "@/lib/split";
import {
  deleteBlockReason,
  deleteHref,
  filterWork,
  groupWork,
  initialWorkTab,
  membersSummary,
  splitSelection,
  WORK_MODE_LABEL,
  workCounts,
  type WorkItem,
  type WorkTab,
} from "@/lib/work-list";
import { Dot, TONE_TEXT, type Tone } from "./status";

/** 작업 화면이 다시 읽는 간격. 보이는 탭일 때만 읽는다 */
const REFRESH_MS = 3_000;

const STATE: Record<AgentState, { label: string; tone: Tone }> = {
  working: { label: "작업 중", tone: "pass" },
  booting: { label: "준비 중", tone: "wait" },
  idle: { label: "대기", tone: "idle" },
  dormant: { label: "대기(샌드박스 꺼짐)", tone: "idle" },
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

const TABS: Array<{ id: WorkTab; label: string }> = [
  { id: "attention", label: "개입 필요" },
  { id: "working", label: "작업 중" },
  { id: "all", label: "전체" },
];

/**
 * 작업 화면: 보낸 요청을 요청 단위로 한 목록에 보여 준다(방식으로 나누지 않고, 비교·병렬은 줄 안의 표시로만 보인다).
 * 비교 참가자·병렬 레인은 한 줄로 묶고, 개입이 필요한 것을 먼저 세운다. 줄을 골라 그 세션들을 나란히 볼 수 있다.
 * 서버가 준 첫 목록으로 바로 그린 뒤, 3초마다(보이는 탭일 때만) 다시 읽는다.
 */
export function WorkOverview({
  initial,
  variant = "page",
}: {
  initial: { items: AgentItem[]; totals: AgentTotals };
  /** drawer면 개발 화면 옆 패널 안에 그린다(선택 막대가 패널 바닥에 붙는다, ADR-069) */
  variant?: "page" | "drawer";
}) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [updatedAt, setUpdatedAt] = useState<string>();
  const [error, setError] = useState<string>();
  const works = useMemo(() => groupWork(data.items), [data.items]);
  const [tab, setTab] = useState<WorkTab>(() => initialWorkTab(groupWork(initial.items)));
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkError, setBulkError] = useState<string>();

  const load = useCallback((force = false) => {
    // 숨은 탭에서는 서버를 두드리지 않는다. 다시 보이면 다음 주기에 읽는다(강제로 다시 읽을 때는 예외)
    if (!force && document.visibilityState !== "visible") return;
    return fetch("/api/agents", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { items?: AgentItem[]; totals?: AgentTotals; error?: string };
        if (!response.ok || !body.items || !body.totals) {
          setError(body.error ?? "작업 목록을 불러오지 못했습니다");
          return;
        }
        setData({ items: body.items, totals: body.totals });
        setUpdatedAt(new Date().toISOString());
        setError(undefined);
      })
      .catch(() => {
        setError("작업 목록을 불러오지 못했습니다");
      });
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const counts = workCounts(works);
  const shown = filterWork(works, tab);
  // 목록이 바뀌어 사라진 작업은 고른 것에서 뺀다
  const liveSelected = selected.filter((key) => works.some((work) => work.key === key));
  const selection = splitSelection(works, liveSelected);
  const deletableSelected = liveSelected.filter((key) => {
    const work = works.find((candidate) => candidate.key === key);
    return work && !deleteBlockReason(work);
  });

  function toggle(key: string) {
    setSelected((current) => (current.includes(key) ? current.filter((candidate) => candidate !== key) : [...current, key]));
  }

  /** 지운 뒤 목록을 다시 받고 고른 것에서도 뺀다(사라진 줄은 고를 수 없다) */
  function onDeleted(key: string) {
    setSelected((current) => current.filter((candidate) => candidate !== key));
    void load(true);
  }

  async function deleteSelected() {
    setBulkDeleting(true);
    setBulkError(undefined);
    const results = await Promise.all(
      deletableSelected.map((key) =>
        fetch(deleteHref(key), { method: "POST" })
          .then(async (response) => ({ key, ok: response.ok, error: response.ok ? undefined : ((await response.json().catch(() => ({}))) as { error?: string }).error }))
          .catch(() => ({ key, ok: false, error: undefined })),
      ),
    );
    const failed = results.filter((result) => !result.ok);
    setSelected((current) => current.filter((key) => !results.some((result) => result.key === key && result.ok)));
    setBulkDeleting(false);
    if (failed.length > 0) setBulkError(`${failed.length}개를 지우지 못했습니다${failed[0]?.error ? `: ${failed[0].error}` : ""}`);
    void load(true);
  }

  return (
    <div className={`flex flex-col gap-4 ${variant === "page" ? "pb-20" : ""}`}>
      <div className="glass flex flex-wrap items-center gap-x-4 gap-y-1 rounded-panel px-4 py-3 text-sm">
        <span className="font-medium">작업 중 {data.totals.working}</span>
        <span className={data.totals.attention > 0 ? "font-medium text-fail" : "text-muted"}>개입 필요 {data.totals.attention}</span>
        <span className="text-muted">토큰 합 {formatCount(totalTokens(data.totals.tokens))}</span>
        <NotifyButton />
        <span className="ml-auto text-xs text-muted" aria-live="polite">
          {updatedAt ? `마지막 갱신 ${timeOf(updatedAt)}` : "…"}
        </span>
      </div>

      <div role="tablist" aria-label="작업 보기" className="glass flex max-w-full gap-1 self-start overflow-x-auto rounded-panel p-1">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            role="tab"
            type="button"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
            className={`shrink-0 rounded-control px-3.5 py-1.5 text-sm font-medium whitespace-nowrap ${
              tab === entry.id ? "bg-panel text-ink ring-1 ring-line" : entry.id === "attention" && counts.attention > 0 ? "text-fail hover:text-ink" : "text-muted hover:text-ink"
            }`}
          >
            {entry.label}({counts[entry.id]})
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
          {tab === "attention" ? "지금 볼 것이 없습니다." : tab === "working" ? "지금 작업 중인 요청이 없습니다." : "아직 보낸 요청이 없습니다. 대화에서 요청을 보내면 여기에 나옵니다."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((work) => (
            <WorkRow key={work.key} work={work} checked={liveSelected.includes(work.key)} onToggle={() => toggle(work.key)} onDeleted={() => onDeleted(work.key)} />
          ))}
        </ul>
      )}

      {liveSelected.length > 0 && (
        <div
          className={`glass flex flex-wrap items-center gap-3 rounded-panel px-4 py-3 text-sm shadow-lg ${
            variant === "page" ? "fixed inset-x-4 bottom-4 z-10 mx-auto max-w-[72rem]" : "sticky bottom-0 z-10"
          }`}
        >
          <span>
            작업 {liveSelected.length}개 · 세션 {selection.ids.length + selection.dropped}개
            {selection.dropped > 0 && <span className="text-muted"> (한 화면에 {MAX_SPLIT}개까지라 {selection.dropped}개는 빼고 엽니다)</span>}
          </span>
          <button type="button" onClick={() => setSelected([])} className="text-muted underline underline-offset-2 hover:text-ink">
            선택 해제
          </button>
          {bulkError && <span className="text-fail text-xs">{bulkError}</span>}
          <button
            type="button"
            disabled={bulkDeleting || deletableSelected.length === 0}
            onClick={() => void deleteSelected()}
            title={deletableSelected.length === 0 ? "고른 것 중 지금 지울 수 있는 것이 없습니다" : undefined}
            className="rounded-control px-3 py-2 font-medium text-fail hover:bg-fail/10 disabled:opacity-40"
          >
            {bulkDeleting ? "지우는 중…" : `선택한 것 지우기${deletableSelected.length > 0 ? ` (${deletableSelected.length})` : ""}`}
          </button>
          <button
            type="button"
            disabled={selection.ids.length === 0}
            onClick={() => router.push(splitHref(selection.ids))}
            className="ml-auto rounded-control bg-ink px-4 py-2 font-semibold text-panel hover:bg-ink/85 disabled:opacity-50"
          >
            선택한 것 나란히 보기
          </button>
        </div>
      )}
    </div>
  );
}

function WorkRow({ work, checked, onToggle, onDeleted }: { work: WorkItem; checked: boolean; onToggle: () => void; onDeleted: () => void }) {
  const state = STATE[work.state];
  const summary = membersSummary(work);
  const selectable = work.sessionIds.length > 0;
  const blockReason = deleteBlockReason(work);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();

  async function confirmDelete() {
    setDeleting(true);
    setDeleteError(undefined);
    try {
      const response = await fetch(deleteHref(work.key), { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setDeleteError(body.error ?? "지우지 못했습니다");
        setDeleting(false);
        setConfirming(false);
        return;
      }
      onDeleted();
    } catch {
      setDeleteError("지우지 못했습니다");
      setDeleting(false);
      setConfirming(false);
    }
  }

  return (
    <li className="glass flex gap-3 rounded-panel px-4 py-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={!selectable}
        onChange={onToggle}
        aria-label={`${work.title} 나란히 보기에 고르기`}
        title={selectable ? "나란히 보기에 고르기" : "세션이 아직 없어 나란히 볼 수 없습니다"}
        className="mt-1 size-4 shrink-0 accent-ink disabled:opacity-40"
      />
      <div className="min-w-0 flex-1">
        <Link href={work.href} className="block hover:underline">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="flex items-center gap-1.5">
              <Dot tone={state.tone} />
              <span className={`text-sm font-medium ${TONE_TEXT[state.tone]}`}>{state.label}</span>
            </span>
            <span className="glass-soft rounded-full px-2 py-0.5 text-xs font-medium text-muted">{WORK_MODE_LABEL[work.mode]}</span>
            {work.attention && <span className={`text-sm font-medium ${ATTENTION_TONE[work.attention]}`}>{ATTENTION_LABEL[work.attention]}</span>}
            <span className="ml-auto text-xs text-muted">{timeOf(work.lastActivityAt)}</span>
          </div>
          <p className="mt-1.5 font-medium break-words">{work.title}</p>
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
            <span>{work.projectName}</span>
            {summary && <span>{summary}</span>}
            {work.mode === "single" && work.members[0]?.backend && <span>백엔드 {work.members[0].backend}</span>}
            {work.mode === "single" && work.members[0]?.runningForMs !== undefined && <span>진행 {formatDuration(work.members[0].runningForMs)}</span>}
            {work.tokens && <span>토큰 {formatCount(totalTokens(work.tokens))}</span>}
            {work.mode === "single" && work.members[0]?.activity && <span>{work.members[0].activity}</span>}
            {work.owner && <span>만든 사람 {work.owner}</span>}
          </p>
          <span className="ml-auto flex items-center gap-2 text-xs">
            {deleteError && <span className="text-fail">{deleteError}</span>}
            {confirming ? (
              <span className="flex items-center gap-1.5">
                <span className="text-muted">삭제할까요?</span>
                <button type="button" disabled={deleting} onClick={() => void confirmDelete()} className="font-medium text-fail hover:underline disabled:opacity-50">
                  삭제
                </button>
                <button type="button" disabled={deleting} onClick={() => setConfirming(false)} className="text-muted hover:underline disabled:opacity-50">
                  취소
                </button>
              </span>
            ) : (
              <button
                type="button"
                disabled={Boolean(blockReason)}
                onClick={() => setConfirming(true)}
                title={blockReason ?? "이 기록을 지웁니다"}
                className="glass-soft rounded-control px-2 py-1 font-medium text-muted hover:text-fail disabled:opacity-40"
              >
                지우기
              </button>
            )}
          </span>
        </div>
        {work.mode !== "single" && work.sessionIds.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={work.mode === "fleet" ? "참가자" : "레인"}>
            {work.members
              .filter((member) => !member.id.startsWith("plan:"))
              .map((member, index) => {
                const memberState = STATE[member.state];
                return (
                  <li key={member.id}>
                    <Link href={member.href} className="glass-soft inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-xs hover:bg-panel">
                      <Dot tone={memberState.tone} />
                      <span>{member.backend ?? (work.mode === "fleet" ? `참가자 ${index + 1}` : `레인 ${index + 1}`)}</span>
                      <span className={member.attention ? ATTENTION_TONE[member.attention] : "text-muted"}>
                        {member.attention ? ATTENTION_LABEL[member.attention] : memberState.label}
                      </span>
                    </Link>
                  </li>
                );
              })}
          </ul>
        )}
      </div>
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
