"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  formatElapsed,
  MAX_SPLIT,
  paneState,
  splitGridClass,
  splitHref,
  splitLines,
  type SplitLine,
} from "@/lib/split";
import type { SessionSnapshot, SessionStatus, SessionSummary } from "@/lib/studio-events";
import { Dot, SESSION_STATUS_LABEL, TONE_TEXT, type Tone } from "./status";
import { useSession } from "./use-session";

export interface SplitPaneInit {
  id: string;
  /** 없으면 "세션을 찾을 수 없습니다" 칸을 그린다 */
  snapshot?: SessionSnapshot;
}

/**
 * 나란히 보기 화면. 칸마다 세션 화면과 같은 이벤트 스트림(SSE)을 하나 열고,
 * 그 이벤트를 세션 화면과 같은 변환(reduceSession)으로 접어 대화를 보여 준다. 칸이 사라지면 연결도 끊는다.
 */
export function SplitView({ panes }: { panes: SplitPaneInit[] }) {
  const router = useRouter();
  const ids = panes.map((pane) => pane.id);

  function close(id: string) {
    router.replace(splitHref(ids.filter((candidate) => candidate !== id)));
  }

  return (
    <div className="grid h-dvh grid-rows-[auto_minmax(0,1fr)] gap-3 p-3 text-ink">
      <header className="glass flex flex-wrap items-center gap-x-4 gap-y-2 rounded-panel px-5 py-3">
        <Link href="/" className="font-semibold tracking-tight hover:underline">
          b-studio
        </Link>
        <h1 className="text-lg font-semibold">나란히 보기</h1>
        <p className="text-sm text-muted">{panes.length}개 세션 · 요청은 각 칸에서 보냅니다</p>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <Link href="/split" className="glass-soft rounded-control px-3.5 py-1.5 font-medium hover:bg-panel">
            세션 고르기
          </Link>
        </div>
      </header>
      <div className={splitGridClass(panes.length)}>
        {panes.map((pane) => (
          <SplitPane key={pane.id} id={pane.id} snapshot={pane.snapshot} onClose={() => close(pane.id)} />
        ))}
      </div>
    </div>
  );
}

function SplitPane({ id, snapshot, onClose }: { id: string; snapshot?: SessionSnapshot; onClose: () => void }) {
  if (!snapshot) return <MissingPane id={id} onClose={onClose} />;
  return <SessionPane snapshot={snapshot} onClose={onClose} />;
}

function MissingPane({ id, onClose }: { id: string; onClose: () => void }) {
  return (
    <section className="glass flex min-h-0 flex-col overflow-hidden rounded-panel" aria-label="세션을 찾을 수 없습니다">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">세션을 찾을 수 없습니다</p>
        <button type="button" onClick={onClose} className="glass-soft rounded-control px-2.5 py-1 text-xs font-medium hover:text-fail">
          닫기
        </button>
      </div>
      <p className="px-3 py-3 font-mono text-xs break-all text-muted">{id}</p>
    </section>
  );
}

/** 칸 하나: 머리(상태·경과 시간·크게 보기·닫기) · 대화 요약 · 입력창 */
function SessionPane({ snapshot, onClose }: { snapshot: SessionSnapshot; onClose: () => void }) {
  const view = useSession(snapshot);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [collapsed, setCollapsed] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const lines = splitLines(view.chat);
  const state = paneState(view.snapshot);
  const elapsed = useElapsed(view.snapshot.running);
  const canSend = view.snapshot.status === "ready" && !view.snapshot.running;

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [lines.length]);

  async function send() {
    const request = text.trim();
    if (!request || !canSend || sending) return;
    setSending(true);
    setError(undefined);
    const response = await fetch(`/api/sessions/${snapshot.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: request, allowBreaking: false, intent: "build" }),
    });
    if (response.ok) setText("");
    // 권한은 서버가 판단한다. 403이면 만든 사람이 아니라는 뜻이다
    else if (response.status === 403) setError("이 세션은 만든 사람만 바꿀 수 있습니다");
    else setError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "요청을 보내지 못했습니다");
    setSending(false);
  }

  return (
    <section className="glass flex min-h-0 flex-col overflow-hidden rounded-panel" aria-label={`${view.snapshot.projectName} 세션`}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Dot tone={state.tone} />
          <span className="min-w-0 truncate text-sm font-semibold">{view.snapshot.projectName}</span>
          <span className={`shrink-0 text-xs ${TONE_TEXT[state.tone]}`}>{state.label}</span>
          {elapsed && <span className="shrink-0 font-mono text-xs text-muted">{elapsed}</span>}
          <span aria-hidden className="ml-auto shrink-0 text-xs text-muted min-[900px]:hidden">
            {collapsed ? "펴기" : "접기"}
          </span>
        </button>
        <Link href={`/sessions/${snapshot.id}`} className="glass-soft shrink-0 rounded-control px-2.5 py-1 text-xs font-medium hover:bg-panel">
          크게 보기
        </Link>
        <button type="button" onClick={onClose} aria-label={`${view.snapshot.projectName} 칸 닫기`} className="glass-soft shrink-0 rounded-control px-2 py-1 text-xs font-medium hover:text-fail">
          ✕
        </button>
      </div>

      {!collapsed && (
        <>
          <ol ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2" aria-live="polite">
            {lines.length === 0 && <li className="text-sm text-muted">아직 대화가 없습니다.</li>}
            {lines.map((line) => (
              <SplitLineView key={line.key} line={line} />
            ))}
          </ol>

          <form
            className="border-t border-line px-3 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            {view.snapshot.running && (
              <p role="status" className="mb-1.5 text-xs text-wait">
                실행이 끝나면 보낼 수 있습니다
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
                placeholder={canSend ? "이 세션에 보낼 요청" : "지금은 보낼 수 없습니다"}
                className="min-w-0 flex-1 resize-none rounded-control border border-line bg-panel px-2 py-1.5 text-sm leading-5 placeholder:text-muted disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={!canSend || sending || !text.trim()}
                className="rounded-control bg-ink px-3 py-2 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
              >
                {sending ? "보내는 중" : "보내기"}
              </button>
            </div>
            {error && <p className="mt-1.5 text-xs text-fail">{error}</p>}
          </form>
        </>
      )}
    </section>
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

const STATUS_TONE: Record<SessionStatus, Tone> = { starting: "wait", ready: "pass", failed: "fail", stopped: "idle" };

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
          홈으로
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
