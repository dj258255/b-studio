"use client";

import { useEffect, useRef, useState } from "react";
import { cleanSessionLabel, SESSION_LABEL_MAX, sessionLabelProblem } from "@/lib/session-label";

/**
 * 세션 화면 머리의 세션 이름(#875). 이름은 studio desk 사이드바·작업 화면·나란히 보기에서도 제목이 된다.
 * 멈춘 세션은 서버가 이름을 받지 않으므로(이어서 작업한 뒤에 된다) 단추를 두지 않는다
 */
export function SessionLabel({ sessionId, label, stopped, canManage }: { sessionId: string; label?: string; stopped: boolean; canManage: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // 저장한 뒤 이벤트(label)가 오기 전까지 받은 이름을 보인다. 스냅샷의 이름이 바뀌면 그쪽을 따른다
  const [saved, setSaved] = useState<{ label?: string; from?: string }>();
  const field = useRef<HTMLInputElement>(null);
  const shown = saved && saved.from === label ? saved.label : label;

  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);

  function start() {
    setDraft(shown ?? "");
    setError(undefined);
    setEditing(true);
  }

  async function save() {
    const problem = sessionLabelProblem(draft);
    if (problem) {
      setError(problem);
      return;
    }
    const next = cleanSessionLabel(draft);
    if (next === (shown ?? "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: next }),
      });
      const body = (await response.json().catch(() => ({}))) as { label?: string; error?: string };
      if (!response.ok) {
        setError(body.error ?? "이름을 바꾸지 못했습니다");
        return;
      }
      setSaved({ label: body.label, from: label });
      setEditing(false);
    } catch {
      setError("이름을 바꾸지 못했습니다");
    } finally {
      setSaving(false);
    }
  }

  const canEdit = canManage && !stopped;

  if (editing) {
    const length = [...cleanSessionLabel(draft)].length;
    return (
      <span className="flex flex-col gap-0.5">
        <span className="flex items-center gap-2">
          <input
            ref={field}
            aria-label="세션 이름"
            value={draft}
            disabled={saving}
            placeholder="이 세션에서 하는 일"
            onChange={(event) => {
              setDraft(event.target.value);
              setError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
                setError(undefined);
              }
            }}
            className="w-56 rounded-control border border-line bg-panel px-2 py-0.5 text-sm"
          />
          <span className={`font-mono text-xs ${length > SESSION_LABEL_MAX ? "text-fail" : "text-muted"}`} aria-live="polite">
            {length}/{SESSION_LABEL_MAX}
          </span>
        </span>
        <span className={`text-xs ${error ? "text-fail" : "text-muted"}`} role={error ? "alert" : undefined}>
          {error ?? "Enter로 저장, Esc로 취소. 비우면 이름을 지웁니다"}
        </span>
      </span>
    );
  }

  return (
    <span className="flex items-baseline gap-1.5">
      {shown && (
        <span className="max-w-[16rem] truncate text-sm font-medium" title={stopped ? "이어서 작업한 뒤 바꿀 수 있습니다" : shown}>
          {shown}
        </span>
      )}
      {canEdit && (
        <button
          type="button"
          onClick={start}
          aria-label={shown ? "세션 이름 바꾸기" : "세션 이름 붙이기"}
          className="text-xs font-medium text-muted underline underline-offset-2 hover:text-ink"
        >
          {shown ? "바꾸기" : "이름 붙이기"}
        </button>
      )}
    </span>
  );
}
