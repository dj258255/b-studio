"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { describeFailedResponse } from "@/lib/fetch-error";
import { DiffView } from "./diff-view";

interface GeneratedFileDiff {
  path: string;
  oldContent?: string;
  newContent: string;
  handEdited: boolean;
  changed: boolean;
  diff: string;
}

interface RegenerationProposal {
  files: GeneratedFileDiff[];
  eligible: boolean;
  reason?: string;
}

interface RunningSession {
  id: string;
  label: string;
}

/**
 * 프로젝트 메뉴(ADR-070)의 "생성 파일 다시 만들기"(ADR-0XX). 폴더를 다시 훑어 studio.yaml·compose.b-studio.yaml·
 * Dockerfile.b-studio를 지금 코드에 맞게 새로 만들 수 있는지 보여 주고, 파일마다 옛 내용과 새 내용의 diff를 보여준다.
 * 사람이 손으로 고친 파일(해시가 b-studio가 마지막으로 쓴 값과 다르다)은 기본으로 "유지"에 두고 경고한다 —
 * 그래도 "덮어쓰기"로 바꾸면 사라진다는 것을 미리 알린다.
 */
export function RegenerateFilesModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [proposal, setProposal] = useState<RegenerationProposal>();
  const [overwrite, setOverwrite] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [written, setWritten] = useState<string[]>();
  const [sessions, setSessions] = useState<RunningSession[]>();
  const [sessionResult, setSessionResult] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${encodeURIComponent(projectId)}/regenerate`, { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as RegenerationProposal & { error?: string };
        if (cancelled) return;
        if (!response.ok) {
          setError(body.error ?? describeFailedResponse(response, "다시 만들 내용을 살펴보지 못했습니다"));
          return;
        }
        setProposal(body);
        setOverwrite(new Set(body.files.filter((file) => file.changed && !file.handEdited).map((file) => file.path)));
      })
      .catch(() => !cancelled && setError("다시 만들 내용을 살펴보지 못했습니다"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!written) return;
    let cancelled = false;
    fetch(`/api/sessions?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : []))
      .then((list: Array<{ id: string; status: string; lastRequest?: string }>) => {
        if (cancelled) return;
        setSessions(list.filter((session) => session.status === "ready").map((session) => ({ id: session.id, label: session.lastRequest ?? session.id.slice(0, 8) })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [written, projectId]);

  function toggle(path: string, on: boolean): void {
    setOverwrite((current) => {
      const next = new Set(current);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  async function apply(): Promise<void> {
    setBusy(true);
    setError(undefined);
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ overwrite: [...overwrite] }),
    }).catch(() => undefined);
    const body = response ? ((await response.json().catch(() => ({}))) as { written?: string[]; error?: string }) : {};
    setBusy(false);
    if (!response?.ok) {
      setError(body.error ?? describeFailedResponse(response, "파일을 다시 쓰지 못했습니다"));
      return;
    }
    setWritten(body.written ?? []);
  }

  async function applyToSession(sessionId: string): Promise<void> {
    setSessionResult((current) => ({ ...current, [sessionId]: "적용하는 중" }));
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: written ?? [] }),
    }).catch(() => undefined);
    const body = response ? ((await response.json().catch(() => ({}))) as { restarted?: Array<{ service: string; ready: boolean }>; error?: string }) : {};
    if (!response?.ok) {
      setSessionResult((current) => ({ ...current, [sessionId]: body.error ?? describeFailedResponse(response, "이 세션에 적용하지 못했습니다") }));
      return;
    }
    const names = (body.restarted ?? []).map((check) => check.service);
    setSessionResult((current) => ({ ...current, [sessionId]: names.length > 0 ? `${names.join(", ")} 다시 띄움` : "적용했습니다" }));
  }

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="regenerate-files">
      <button type="button" aria-label="닫기" onClick={onClose} className="absolute inset-0 bg-ink/15" />
      <div className="glass absolute left-1/2 top-[6vh] max-h-[88vh] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto rounded-panel p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <h2 id="regenerate-files" className="text-lg font-semibold">
            생성 파일 다시 만들기
          </h2>
          <button type="button" onClick={onClose} className="glass-soft shrink-0 rounded-control px-3 py-1 text-sm font-medium hover:bg-panel">
            닫기
          </button>
        </div>
        <p className="mt-1 text-sm leading-6 text-muted">
          폴더를 다시 훑어 studio.yaml·compose.b-studio.yaml·Dockerfile.b-studio를 지금 b-studio 버전에 맞게 새로 만듭니다. 바뀐 파일만 고를 수 있습니다.
        </p>

        <div className="mt-4 text-sm">
          {loading ? (
            <p className="text-muted">살펴보는 중</p>
          ) : !proposal?.eligible ? (
            <p className="text-wait">{proposal?.reason ?? "다시 만들 파일이 없습니다"}</p>
          ) : proposal.files.filter((file) => file.changed).length === 0 ? (
            <p className="text-muted">지금 디스크의 생성 파일이 이미 최신입니다. 다시 쓸 내용이 없습니다.</p>
          ) : (
            <ul className="space-y-3">
              {proposal.files
                .filter((file) => file.changed)
                .map((file) => (
                  <li key={file.path} className="glass-soft rounded-control p-3">
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={overwrite.has(file.path)}
                        onChange={(event) => toggle(file.path, event.target.checked)}
                        disabled={busy || written !== undefined}
                        className="mt-0.5 accent-ink"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="break-all font-mono text-xs font-medium">{file.path}</span>
                        {file.oldContent === undefined && <span className="ml-1.5 text-xs text-pass">새로 생김</span>}
                        {file.handEdited && <p className="mt-0.5 text-xs text-fail">직접 고친 내용이 있습니다 — 덮어쓰면 사라집니다</p>}
                      </span>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          setShown(shown === file.path ? undefined : file.path);
                        }}
                        aria-expanded={shown === file.path}
                        className="shrink-0 rounded-control px-2 py-1 text-xs hover:bg-panel"
                      >
                        {shown === file.path ? "숨기기" : "보기"}
                      </button>
                    </label>
                    {shown === file.path && (
                      <div className="mt-2">
                        {file.oldContent === undefined ? (
                          <pre className="max-h-64 overflow-auto rounded-control border border-line bg-panel p-3 font-mono text-xs leading-5">{file.newContent}</pre>
                        ) : (
                          <DiffView patch={file.diff} />
                        )}
                      </div>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-3 text-sm text-fail">
            {error}
          </p>
        )}

        {proposal?.eligible && proposal.files.filter((file) => file.changed).length > 0 && written === undefined && (
          <button
            type="button"
            onClick={() => void apply()}
            disabled={busy || overwrite.size === 0}
            className="mt-4 rounded-control bg-ink px-4 py-2 text-sm font-semibold text-panel hover:bg-ink/85 disabled:opacity-50"
          >
            {busy ? "다시 쓰는 중" : `고른 파일 다시 쓰기 (${overwrite.size})`}
          </button>
        )}

        {written !== undefined && (
          <div className="mt-4 border-t border-line pt-3 text-sm">
            <p>{written.length > 0 ? `${written.join(", ")}을 다시 썼습니다.` : "아무 파일도 다시 쓰지 않았습니다."}</p>
            {written.length > 0 && (
              <>
                <p className="mt-2 text-muted">
                  이미 떠 있는 세션은 저마다 작업 복사본을 쓰므로 자동으로 바뀌지 않습니다. 세션마다 적용하고 샌드박스를 다시 띄우려면 아래에서 고르세요.
                </p>
                {!sessions ? (
                  <p className="mt-1 text-muted">세션을 살펴보는 중</p>
                ) : sessions.length === 0 ? (
                  <p className="mt-1 text-muted">떠 있는 세션이 없습니다(새 세션은 자동으로 최신 파일을 받습니다).</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {sessions.map((session) => (
                      <li key={session.id} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate">{session.label}</span>
                        <span className="flex items-center gap-2">
                          {sessionResult[session.id] && <span className="text-xs text-muted">{sessionResult[session.id]}</span>}
                          <button type="button" onClick={() => void applyToSession(session.id)} className="glass-soft shrink-0 rounded-control px-2 py-1 text-xs hover:bg-panel">
                            이 세션에도 적용
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
