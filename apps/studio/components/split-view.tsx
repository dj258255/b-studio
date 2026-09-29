"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Checkpoint } from "@b-studio/agent";
import type { FleetView } from "@/lib/fleet-types";
import {
  broadcastTarget,
  defaultFocusId,
  effectiveLayoutMode,
  fleetForIds,
  formatElapsed,
  initialSplitLayout,
  lastOutcomeStatus,
  MAX_SPLIT,
  paneDisplay,
  paneSummary,
  splitGridClass,
  splitHref,
  splitKeyAction,
  splitLayoutReducer,
  splitLines,
  type PaneSummary,
  type SplitLine,
} from "@/lib/split";
import { answerRequest } from "@/lib/question-answer";
import { chatRequestBody, intentFor } from "@/lib/chat-request";
import type { SessionSnapshot, SessionStatus, SessionSummary } from "@/lib/studio-events";
import { describeTokens, formatTokenCount, hasTokens, totalTokens } from "@/lib/usage";
import { DiffView } from "./diff-view";
import { Dot, SERVICE_STATE_LABEL, SESSION_BACKEND_LABEL, SESSION_STATUS_LABEL, TONE_TEXT, toneOfService, type Tone } from "./status";
import { useLightVerify } from "./use-light-verify";
import { useNarrow } from "./use-narrow";
import { useReadOnly } from "./use-read-only";
import { useSession } from "./use-session";

export interface SplitPaneInit {
  id: string;
  /** 없으면 "세션을 찾을 수 없습니다" 칸을 그린다 */
  snapshot?: SessionSnapshot;
}

/** 여러 칸에 한꺼번에 보낼 신호. nonce가 바뀔 때마다 칸마다 한 번씩 받는다(칸은 각자 대기 중인지 보고 요청·지시를 고른다) */
interface Broadcast {
  text: string;
  nonce: number;
}

function fallbackSummary(pane: SplitPaneInit): PaneSummary {
  if (!pane.snapshot) return { projectName: pane.id, tone: "idle", label: "세션을 찾을 수 없습니다", attention: false };
  return paneSummary(pane.snapshot);
}

function samePaneSummary(a: PaneSummary | undefined, b: PaneSummary): boolean {
  return Boolean(a && a.projectName === b.projectName && a.tone === b.tone && a.label === b.label && a.attention === b.attention);
}

/** 강조(질문·실패)가 필요한 칸은 짙은 강조 테두리, 그 밖의 강조(답 기다림 등)는 옅은 강조 테두리 */
function attentionRing(summary: Pick<PaneSummary, "tone" | "attention">): string {
  if (!summary.attention) return "";
  return summary.tone === "fail" ? "ring-2 ring-fail/60" : "ring-2 ring-wait/60";
}

/**
 * 나란히 보기 화면. 칸마다 세션 화면과 같은 이벤트 스트림(SSE)을 하나 열고,
 * 그 이벤트를 세션 화면과 같은 변환(reduceSession)으로 접어 대화를 보여 준다.
 * 위쪽 머리에서 배치(그리드·집중)를 고르고, 모든 칸에 같은 요청을 한 번에 보낼 수 있다(ADR-071)
 */
export function SplitView({ panes }: { panes: SplitPaneInit[] }) {
  const router = useRouter();
  const ids = useMemo(() => panes.map((pane) => pane.id), [panes]);
  const idsKey = ids.join(",");
  const [layout, dispatchLayout] = useReducer(splitLayoutReducer, initialSplitLayout());
  const narrow = useNarrow();
  const mode = effectiveLayoutMode(layout.mode, narrow);
  // 칸마다 자기 상태를 보고한다(대화창 안 SessionPane이 useSession으로 실시간 값을 받는다). 처음에는 서버가 준 스냅샷으로 채운다
  const [summaries, setSummaries] = useState<Record<string, PaneSummary>>({});
  const [fleet, setFleet] = useState<FleetView>();
  const [broadcast, setBroadcast] = useState<Broadcast>();
  const [broadcastText, setBroadcastText] = useState("");

  const report = useCallback((id: string, summary: PaneSummary) => {
    setSummaries((prev) => (samePaneSummary(prev[id], summary) ? prev : { ...prev, [id]: summary }));
  }, []);

  const summaryFor = useCallback((pane: SplitPaneInit): PaneSummary => summaries[pane.id] ?? fallbackSummary(pane), [summaries]);
  const focusId = layout.focusId ?? defaultFocusId(panes.map((pane) => ({ id: pane.id, attention: summaryFor(pane).attention })));

  function close(id: string) {
    router.replace(splitHref(ids.filter((candidate) => candidate !== id)));
  }

  // 칸이 모두 같은 Agent Fleet 멤버인지 확인한다. 완료 등으로 상태가 바뀌면(toneKey) 최신 멤버 상태를 다시 받는다
  const toneKey = ids.map((id) => summaries[id]?.tone ?? "").join(",");
  useEffect(() => {
    let cancelled = false;
    fetch("/api/fleets")
      .then((response) => (response.ok ? (response.json() as Promise<FleetView[]>) : []))
      .then((fleets) => {
        if (!cancelled) setFleet(fleetForIds(fleets, ids));
      })
      .catch(() => {
        if (!cancelled) setFleet(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [idsKey, toneKey, ids]);

  // 전역 단축키: ⌘/Ctrl+1~4로 칸을 집중하고 Esc로 나간다. 입력 중에는 ⌘+숫자만 동작한다(lib/split.ts의 splitKeyAction)
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable));
      const action = splitKeyAction(event, { typing, paneCount: panes.length });
      if (!action) return;
      if (action.type === "exitFocus") {
        if (layout.mode !== "focus") return;
        event.preventDefault();
        dispatchLayout({ type: "exitFocus" });
        return;
      }
      const id = panes[action.index]?.id;
      if (!id) return;
      event.preventDefault();
      dispatchLayout({ type: "focus", id });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [panes, layout.mode]);

  function sendBroadcast(event: React.FormEvent) {
    event.preventDefault();
    const text = broadcastText.trim();
    if (!text) return;
    setBroadcast({ text, nonce: Date.now() });
    setBroadcastText("");
  }

  return (
    <div className="grid h-dvh grid-rows-[auto_minmax(0,1fr)] gap-3 p-3 text-ink">
      <header className="glass flex flex-col gap-2.5 rounded-panel px-5 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Link href="/" className="font-semibold tracking-tight hover:underline">
            b-studio
          </Link>
          <h1 className="text-lg font-semibold">나란히 보기</h1>
          <p className="text-sm text-muted">{panes.length}개 세션</p>
          <div className="glass-soft inline-flex rounded-control p-0.5 text-sm" role="group" aria-label="배치">
            <button
              type="button"
              aria-pressed={layout.mode === "grid"}
              onClick={() => dispatchLayout({ type: "exitFocus" })}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors ${layout.mode === "grid" ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"}`}
            >
              그리드
            </button>
            <button
              type="button"
              aria-pressed={layout.mode === "focus"}
              disabled={!focusId}
              onClick={() => focusId && dispatchLayout({ type: "focus", id: focusId })}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors disabled:opacity-50 ${layout.mode === "focus" ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"}`}
            >
              집중
            </button>
          </div>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <Link href="/split" className="glass-soft rounded-control px-3.5 py-1.5 font-medium hover:bg-panel">
              세션 고르기
            </Link>
          </div>
        </div>

        {/* 상태 칩. 눌러서 그 칸을 집중해서 본다(좁은 화면·집중 모드에서는 이 칩이 곧 칸 전환 탭이다) */}
        <div role="tablist" aria-label="세션" className="flex flex-wrap gap-1.5">
          {panes.map((pane) => {
            const summary = summaryFor(pane);
            const active = mode === "focus" && focusId === pane.id;
            return (
              <button
                key={pane.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => dispatchLayout({ type: "focus", id: pane.id })}
                title={summary.projectName}
                className={`flex max-w-[12rem] items-center gap-1.5 rounded-control px-2.5 py-1 text-xs font-medium transition-colors ${
                  active ? "bg-panel ring-1 ring-line" : "glass-soft hover:bg-panel"
                } ${attentionRing(summary)}`}
              >
                <Dot tone={summary.tone} />
                <span className="truncate">{summary.projectName}</span>
              </button>
            );
          })}
        </div>

        <form onSubmit={sendBroadcast} className="flex items-end gap-2">
          <label htmlFor="split-broadcast" className="sr-only">
            모두에게 보낼 요청
          </label>
          <textarea
            id="split-broadcast"
            value={broadcastText}
            onChange={(event) => setBroadcastText(event.target.value)}
            rows={1}
            placeholder="모두에게 보내기 — 대기 중인 칸은 요청으로, 작업 중인 칸은 진행 중 지시로 들어갑니다"
            className="min-w-0 flex-1 resize-none rounded-control border border-line bg-panel px-2 py-1.5 text-sm leading-5 placeholder:text-muted"
          />
          <button type="submit" disabled={!broadcastText.trim()} className="shrink-0 rounded-control bg-ink px-3 py-2 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50">
            모두에게 보내기
          </button>
        </form>
      </header>

      <div className={mode === "grid" ? splitGridClass(panes.length) : "flex min-h-0 flex-1 flex-col"}>
        {panes.map((pane) => {
          const display = paneDisplay(mode, pane.id, focusId);
          return (
            <div key={pane.id} className={display === "hidden" ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
              <SplitPane
                id={pane.id}
                snapshot={pane.snapshot}
                onClose={() => close(pane.id)}
                onFocus={() => dispatchLayout({ type: "focus", id: pane.id })}
                onReport={report}
                broadcast={broadcast}
                fleet={fleet}
                onWinnerChosen={(sessionId) => setFleet((prev) => (prev ? { ...prev, winnerSessionId: sessionId } : prev))}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SplitPane({
  id,
  snapshot,
  onClose,
  onFocus,
  onReport,
  broadcast,
  fleet,
  onWinnerChosen,
}: {
  id: string;
  snapshot?: SessionSnapshot;
  onClose: () => void;
  onFocus: () => void;
  onReport: (id: string, summary: PaneSummary) => void;
  broadcast?: Broadcast;
  fleet?: FleetView;
  onWinnerChosen: (sessionId: string) => void;
}) {
  if (!snapshot) return <MissingPane id={id} onClose={onClose} />;
  return <SessionPane snapshot={snapshot} onClose={onClose} onFocus={onFocus} onReport={onReport} broadcast={broadcast} fleet={fleet} onWinnerChosen={onWinnerChosen} />;
}

function MissingPane({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <section className="glass flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel" aria-label="세션을 찾을 수 없습니다">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">세션을 찾을 수 없습니다</p>
        <button type="button" onClick={onClose} className="glass-soft rounded-control px-2.5 py-1 text-xs font-medium hover:text-fail">
          빼기
        </button>
      </div>
      <p className="px-3 py-3 font-mono text-xs break-all text-muted">{id}</p>
    </section>
  );
}

type PaneTab = "chat" | "files" | "preview";

const PANE_TABS: Array<{ id: PaneTab; label: string }> = [
  { id: "chat", label: "대화" },
  { id: "files", label: "바뀐 파일" },
  { id: "preview", label: "미리보기" },
];

/** 칸 하나: 머리(상태·백엔드·토큰·경과 시간·집중·세션 화면·빼기) · 탭(대화·바뀐 파일·미리보기) · 입력창 */
function SessionPane({
  snapshot,
  onClose,
  onFocus,
  onReport,
  broadcast,
  fleet,
  onWinnerChosen,
}: {
  snapshot: SessionSnapshot;
  onClose: () => void;
  onFocus: () => void;
  onReport: (id: string, summary: PaneSummary) => void;
  broadcast?: Broadcast;
  fleet?: FleetView;
  onWinnerChosen: (sessionId: string) => void;
}) {
  const view = useSession(snapshot);
  const [tab, setTab] = useState<PaneTab>("chat");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [choosing, setChoosing] = useState(false);
  const [broadcastNote, setBroadcastNote] = useState<string>();
  const listRef = useRef<HTMLOListElement>(null);
  const lastBroadcastNonce = useRef<number | undefined>(undefined);
  const lines = splitLines(view.chat);
  const summary = paneSummary(view.snapshot, lastOutcomeStatus(view.chat));
  const elapsed = useElapsed(view.snapshot.running);
  const canSend = view.snapshot.status === "ready";
  // 실행 중이면 새 요청 대신 진행 중 지시로 보낸다(다음 모델 호출 직전에 들어간다, ADR-057)
  const steering = view.snapshot.running;
  /** 대화 화면과 같은 입력 규칙을 쓴다: "읽기만"이면 질문 경로, 아니면 만들기 경로(칸마다 기억한다) */
  const [readOnly, setReadOnly] = useReadOnly(snapshot.id);
  // 대화 화면과 같게, 읽기만이 켜지면 숨기되 값을 세션마다 기억한다
  const [lightVerify, setLightVerify] = useLightVerify(snapshot.id);
  const backendLabel = SESSION_BACKEND_LABEL[view.snapshot.backend ?? view.snapshot.mode];
  const fleetMember = fleet?.members.find((member) => member.sessionId === snapshot.id);
  const isWinner = fleet?.winnerSessionId === snapshot.id;

  // 위(SplitView)에 지금 상태를 알려 상태 칩·집중 기본값·좁은 화면 전환에 쓰게 한다
  useEffect(() => {
    onReport(snapshot.id, summary);
    // summary는 매 렌더 새 객체라 값 자체(칸 이름·상태)로만 다시 알린다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.id, summary.projectName, summary.tone, summary.label, summary.attention]);

  useEffect(() => {
    const list = listRef.current;
    if (list && tab === "chat") list.scrollTop = list.scrollHeight;
  }, [lines.length, tab]);

  async function send(override?: string) {
    const request = (override ?? text).trim();
    if (!request || !canSend || sending) return;
    setSending(true);
    setError(undefined);
    const response = await fetch(`/api/sessions/${snapshot.id}/${steering ? "steer" : "messages"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(steering ? { text: request } : chatRequestBody({ text: request, intent: intentFor(readOnly), lightVerify })),
    });
    if (response.ok && override === undefined) setText("");
    // 권한은 서버가 판단한다. 403이면 만든 사람이 아니라는 뜻이다
    else if (response.status === 403) setError("이 세션은 만든 사람만 바꿀 수 있습니다");
    else setError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "요청을 보내지 못했습니다");
    setSending(false);
  }

  // "모두에게 보내기": 대기 중이면 요청, 작업 중이면 지시로 보낸다. 그 밖(준비 중·실패·중지)은 건너뛰고 이유를 남긴다.
  // (별도 함수로 빼서 부른다 — 효과 몸통에 바로 setState를 두면 연쇄 렌더 경고가 뜬다)
  function applyBroadcast(requestText: string) {
    const target = broadcastTarget(view.snapshot);
    if (target === "skip") {
      setBroadcastNote("건너뜀 · 지금은 보낼 수 없습니다");
      return;
    }
    setBroadcastNote(target === "steer" ? "진행 중 지시로 보냈습니다" : "요청을 보냈습니다");
    void send(requestText);
  }

  useEffect(() => {
    if (!broadcast || broadcast.nonce === lastBroadcastNonce.current) return;
    lastBroadcastNonce.current = broadcast.nonce;
    applyBroadcast(broadcast.text);
    // applyBroadcast·view.snapshot은 매 렌더 새로 만들어진다. nonce로 한 번만 반응하고, 최신 값을 그대로 쓴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broadcast]);

  useEffect(() => {
    if (!broadcastNote) return;
    const timer = setTimeout(() => setBroadcastNote(undefined), 4_000);
    return () => clearTimeout(timer);
  }, [broadcastNote]);

  async function chooseWinner() {
    if (!fleet || choosing) return;
    setChoosing(true);
    setError(undefined);
    const response = await fetch(`/api/fleets/${fleet.id}/winner`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: snapshot.id }),
    });
    if (response.ok) onWinnerChosen(snapshot.id);
    else setError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "채택하지 못했습니다");
    setChoosing(false);
  }

  return (
    <section className={`glass flex min-h-0 flex-1 flex-col overflow-hidden rounded-panel ${attentionRing(summary)}`} aria-label={`${view.snapshot.projectName} 세션`}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line px-3 py-2" onDoubleClick={onFocus}>
        <Dot tone={summary.tone} />
        <span className="min-w-0 max-w-[14rem] truncate text-sm font-semibold">{view.snapshot.projectName}</span>
        <span className={`shrink-0 text-xs font-medium ${TONE_TEXT[summary.tone]}`}>{summary.label}</span>
        <span className="shrink-0 text-xs text-muted">{backendLabel}</span>
        {hasTokens(view.snapshot.tokens) && (
          <span className="shrink-0 text-xs text-muted" title={describeTokens(view.snapshot.tokens)}>
            {formatTokenCount(totalTokens(view.snapshot.tokens))} 토큰
          </span>
        )}
        {elapsed && <span className="shrink-0 font-mono text-xs text-muted">{elapsed}</span>}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {fleetMember &&
            (isWinner ? (
              <span className="rounded-control bg-pass/15 px-2 py-1 text-xs font-medium text-pass">채택됨</span>
            ) : fleetMember.status === "done" ? (
              <button
                type="button"
                onClick={() => void chooseWinner()}
                disabled={choosing}
                className="glass-soft rounded-control px-2 py-1 text-xs font-medium hover:bg-panel disabled:opacity-50"
              >
                이것으로 채택
              </button>
            ) : null)}
          <button
            type="button"
            onClick={onFocus}
            aria-label={`${view.snapshot.projectName} 집중해서 보기`}
            title="집중해서 보기"
            className="glass-soft rounded-control px-2 py-1 text-xs font-medium hover:bg-panel"
          >
            ⤢
          </button>
          <Link href={`/sessions/${snapshot.id}`} className="glass-soft shrink-0 rounded-control px-2.5 py-1 text-xs font-medium hover:bg-panel">
            세션 화면
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label={`${view.snapshot.projectName} 칸에서 빼기`}
            className="glass-soft shrink-0 rounded-control px-2 py-1 text-xs font-medium hover:text-fail"
          >
            빼기
          </button>
        </div>
      </div>

      <div role="tablist" aria-label="칸 보기" className="flex gap-1 border-b border-line bg-panel px-2 py-1">
        {PANE_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
            className={`rounded-control px-2.5 py-1 text-xs font-medium ${tab === entry.id ? "bg-ground text-ink" : "text-muted hover:text-ink"}`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
        {tab === "chat" ? (
          <ol ref={listRef} className="space-y-2.5 px-3 py-2.5" aria-live="polite">
            {lines.length === 0 && <li className="text-sm text-muted">아직 대화가 없습니다.</li>}
            {lines.map((line) => (
              <SplitLineView key={line.key} line={line} />
            ))}
          </ol>
        ) : tab === "files" ? (
          <PaneFilesTab sessionId={snapshot.id} checkpoint={view.snapshot.checkpoints[0]} />
        ) : (
          <PanePreviewTab services={view.snapshot.services} status={view.snapshot.status} />
        )}
      </div>

      <form
        className="border-t border-line px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {broadcastNote && (
          <p role="status" className="mb-1.5 text-xs text-muted">
            {broadcastNote}
          </p>
        )}
        {view.snapshot.pendingQuestion && !view.snapshot.running && (
          <div className="mb-2 rounded-control border border-line bg-panel px-2 py-1.5" role="group" aria-label="에이전트의 질문">
            <p className="text-xs font-medium">{view.snapshot.pendingQuestion.question}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {view.snapshot.pendingQuestion.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  disabled={sending || !canSend}
                  onClick={() => void send(answerRequest(view.snapshot.pendingQuestion!.question, option))}
                  className="glass-soft rounded-control px-2 py-1 text-xs hover:bg-panel disabled:opacity-50"
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        )}
        {view.snapshot.running && (
          <p role="status" className="mb-1.5 text-xs text-wait">
            작업 중입니다. 보내면 진행 중 지시로 다음 모델 호출 직전에 들어갑니다
          </p>
        )}
        <div className="flex items-end gap-2">
          <label htmlFor={`split-request-${snapshot.id}`} className="sr-only">
            {view.snapshot.projectName} 세션에 보낼 요청
          </label>
          <textarea
            id={`split-request-${snapshot.id}`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSend && text.trim()) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            disabled={!canSend}
            placeholder={!canSend ? "지금은 보낼 수 없습니다" : steering ? "진행 중 지시" : readOnly ? "이 세션에 보낼 질문" : "이 세션에 보낼 요청"}
            className="min-w-0 flex-1 resize-none rounded-control border border-line bg-panel px-2 py-1.5 text-sm leading-5 placeholder:text-muted disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!canSend || sending || !text.trim()}
            className="rounded-control bg-ink px-3 py-2 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
          >
            {sending ? "보내는 중" : steering ? "진행 중 지시" : "보내기"}
          </button>
        </div>
        {/* 실행 중에는 지시만 보내므로 스위치를 감춘다. 대화 화면과 같은 규칙(읽기만 → 질문 경로) */}
        {!steering && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              role="switch"
              aria-checked={readOnly}
              onClick={() => setReadOnly(!readOnly)}
              title="켜면 파일을 바꾸지 않고 답과 계획만 받습니다"
              className={`rounded-control px-2 py-0.5 font-medium transition-colors ${
                readOnly ? "bg-panel text-ink ring-1 ring-line" : "glass-soft text-muted hover:text-ink"
              }`}
            >
              읽기만
            </button>
            {/* 읽기만이 켜지면 숨긴다(질문은 게이트를 돌리지 않는다). 대화 화면과 같은 규칙 */}
            {!readOnly && (
              <button
                type="button"
                role="switch"
                aria-checked={lightVerify}
                onClick={() => setLightVerify(!lightVerify)}
                title="테스트·화면 확인·리뷰를 건너뛰고 서비스 재시작·계약만 확인합니다"
                className={`rounded-control px-2 py-0.5 font-medium transition-colors ${
                  lightVerify ? "bg-panel text-ink ring-1 ring-line" : "glass-soft text-muted hover:text-ink"
                }`}
              >
                가볍게 확인
              </button>
            )}
            <span className="min-w-0 text-muted">
              {readOnly ? "파일은 바꾸지 않습니다" : lightVerify ? "테스트·화면 확인·리뷰를 건너뜁니다" : "바꾸면 게이트를 통과해야 남습니다"}
            </span>
          </div>
        )}
        {error && <p className="mt-1.5 text-xs text-fail">{error}</p>}
      </form>
    </section>
  );
}

/** [바뀐 파일] 탭. 가장 최근 체크포인트의 파일 목록과 diff를 보여 준다(기록 탭과 같은 API를 쓴다) */
function PaneFilesTab({ sessionId, checkpoint }: { sessionId: string; checkpoint?: Checkpoint }) {
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
function PanePreviewTab({ services, status }: { services: SessionSnapshot["services"]; status: SessionStatus }) {
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

/** 대화 요약 한 줄. 도구는 호출 한 줄만 보여 주고 결과 본문은 넣지 않는다 */
function SplitLineView({ line }: { line: SplitLine }) {
  if (line.kind === "request") {
    return <li className="border-l-[3px] border-ink pl-2 text-sm leading-6 font-medium whitespace-pre-wrap">{line.text}</li>;
  }
  if (line.kind === "reply") {
    return <li className="text-sm leading-6 whitespace-pre-wrap">{line.text}</li>;
  }
  return <li className={`text-xs break-words ${line.tone ? TONE_TEXT[line.tone] : "text-muted"}`}>{line.text}</li>;
}

/** 실행 중일 때 경과 시간을 1초마다 다시 그린다. 시작 시각은 효과 안에서만 잡고, 렌더에서는 상태만 읽는다 */
function useElapsed(running: boolean): string | undefined {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const update = () => setElapsed(Date.now() - started);
    // 첫 값은 곧바로 채우고(0ms), 그 뒤 1초마다 갱신한다. 모두 콜백 안에서 setState한다
    const first = setTimeout(update, 0);
    const timer = setInterval(update, 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [running]);

  return running ? formatElapsed(elapsed) : undefined;
}

const STATUS_TONE: Record<SessionStatus, Tone> = { idle: "idle", starting: "wait", ready: "pass", failed: "fail", stopped: "idle" };

/** id가 없는 `/split`에서 세션을 고르는 화면. 최근 순 목록에서 최대 4개를 고른다 */
export function SplitPicker({ sessions }: { sessions: SessionSummary[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((candidate) => candidate !== id) : current.length >= MAX_SPLIT ? current : [...current, id]));
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-16">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold text-muted">b-studio</p>
        <Link href="/" className="glass-soft rounded-control px-3 py-1.5 text-sm font-medium text-ink hover:bg-panel">
          개발 화면으로
        </Link>
      </div>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">나란히 볼 세션을 고르세요</h1>
      <p className="mt-3 max-w-[60ch] leading-7 text-muted">최대 {MAX_SPLIT}개까지 한 화면에 띄웁니다. 칸마다 대화를 보고 요청을 보낼 수 있습니다.</p>

      <ul className="glass mt-8 divide-y divide-line overflow-hidden rounded-panel">
        {sessions.length === 0 && <li className="px-5 py-6 text-muted">열 수 있는 세션이 없습니다. 먼저 프로젝트를 열어 세션을 만드세요.</li>}
        {sessions.map((session) => {
          const checked = selected.includes(session.id);
          const atLimit = !checked && selected.length >= MAX_SPLIT;
          return (
            <li key={session.id}>
              <label className={`flex cursor-pointer items-center gap-3 px-5 py-4 ${atLimit ? "opacity-50" : ""}`}>
                <input type="checkbox" checked={checked} disabled={atLimit} onChange={() => toggle(session.id)} className="accent-ink" />
                <Dot tone={STATUS_TONE[session.status]} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="font-semibold">{session.projectName}</span>
                    <span className={`text-sm ${TONE_TEXT[STATUS_TONE[session.status]]}`}>{SESSION_STATUS_LABEL[session.status]}</span>
                  </span>
                  <span className="mt-1 block truncate text-sm text-muted">
                    {session.lastRequest ? `마지막 요청: ${session.lastRequest}` : "아직 보낸 요청이 없습니다"}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          disabled={selected.length === 0}
          onClick={() => router.push(splitHref(selected))}
          className="rounded-control bg-ink px-4 py-2 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
        >
          나란히 보기 ({selected.length})
        </button>
        {selected.length >= MAX_SPLIT && <span className="text-xs text-muted">최대 {MAX_SPLIT}개까지 고를 수 있습니다.</span>}
      </div>
    </main>
  );
}
