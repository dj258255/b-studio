"use client";

import { useEffect, useState } from "react";
import type { ExportPreview as ExportPreviewData } from "@/lib/studio-events";
import { Markdown } from "./markdown";

/** 이슈 번호 입력과 확인 목록, 본문 미리보기. 누락이 ✗로 보여도 사람이 판단해 PR을 만든다 */
export function ExportPreview({ sessionId, label, onClose }: { sessionId: string; label: string; onClose: () => void }) {
  const [issue, setIssue] = useState("");
  const [preview, setPreview] = useState<ExportPreviewData>();
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [showBody, setShowBody] = useState(false);
  const parsed = parseIssue(issue);
  const issueValue = parsed.ok ? parsed.value : undefined;

  // 이슈 번호 입력이 멈춘 뒤 한 번만 미리보기를 다시 부른다
  useEffect(() => {
    if (!parsed.ok) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setLoading(true);
        setError(undefined);
        try {
          const response = await fetch(`/api/sessions/${sessionId}/export/preview`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(issueValue === undefined ? {} : { issue: issueValue }),
          });
          const data = await response.json();
          if (cancelled) return;
          if (response.ok) setPreview(data as ExportPreviewData);
          else setError(data.error ?? "미리보기를 불러오지 못했습니다");
        } catch (reason) {
          if (!cancelled) setError(String(reason));
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [issue, sessionId, parsed.ok, issueValue]);

  /** 브랜치 올리기와 PR 만들기를 한 번에 한다. 누락이 있어도 막지 않는다 */
  async function create() {
    setCreating(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pullRequest: true, ...(issueValue === undefined ? {} : { issue: issueValue }) }),
      });
      const data = await response.json();
      if (!response.ok) setError(data.error ?? `${label}을 만들지 못했습니다`);
      else if (data.pullRequestError) setError(`브랜치는 올렸지만 ${label}을 만들지 못했습니다: ${data.pullRequestError}`);
      else onClose();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setCreating(false);
    }
  }

  const missing = preview?.checks.find((check) => check.id === "stages_passed" && check.ok === false);

  return (
    <section className="mt-3 rounded-panel border border-line bg-panel p-4" aria-label={`${label} 미리보기`}>
      <h3 className="font-medium">{label} 미리보기</h3>

      <div className="mt-3">
        <label htmlFor="export-issue" className="block text-sm font-medium">
          연결할 이슈 번호 (선택)
        </label>
        <input
          id="export-issue"
          type="number"
          inputMode="numeric"
          min={1}
          max={10_000_000}
          value={issue}
          onChange={(event) => setIssue(event.target.value)}
          placeholder="예: 57"
          className="mt-1 w-40 rounded-control border border-line bg-panel px-3 py-1.5 text-sm"
        />
        <p className="mt-1 text-xs text-muted">넣으면 PR 본문 첫 줄에 Closes #N을 넣어 이슈를 함께 닫습니다.</p>
      </div>

      {!parsed.ok && <p className="mt-3 text-sm text-fail">이슈 번호는 1 이상 10,000,000 이하의 정수여야 합니다</p>}

      {parsed.ok && loading && (
        <p className="mt-3 text-sm text-wait" role="status">
          미리보기를 불러오는 중
        </p>
      )}

      {parsed.ok && preview && (
        <>
          <ul className="mt-3 space-y-1 text-sm">
            {preview.checks.map((check) => (
              <li key={check.id} className="flex gap-2">
                <span aria-hidden="true" className={check.ok === true ? "text-pass" : check.ok === false ? "text-fail" : "text-wait"}>
                  {check.ok === true ? "✓" : check.ok === false ? "✗" : "?"}
                </span>
                <span className={check.ok === true ? "text-muted" : ""}>
                  <span className="sr-only">{check.ok === true ? "확인됨: " : check.ok === false ? "확인 필요: " : "확인하지 못함: "}</span>
                  {check.detail}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-3">
            <button
              type="button"
              aria-expanded={showBody}
              onClick={() => setShowBody((shown) => !shown)}
              className="rounded-control text-sm text-muted hover:text-ink"
            >
              {showBody ? "본문 미리보기 접기" : "본문 미리보기"}
            </button>
            {showBody && (
              <div className="mt-2 max-h-80 overflow-auto rounded-control border border-line bg-panel px-3 py-2">
                <p className="text-sm font-medium">{preview.title}</p>
                <div className="mt-1">
                  <Markdown text={preview.body} />
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {parsed.ok && error && <p className="mt-3 text-sm text-fail">{error}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void create()}
          disabled={creating || !parsed.ok}
          className="rounded-control bg-ink px-3.5 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
        >
          {creating ? "올리는 중" : `${label} 만들기`}
        </button>
        <button type="button" onClick={onClose} className="rounded-control border border-line px-3.5 py-1.5 text-sm font-medium hover:border-ink">
          취소
        </button>
        {parsed.ok && missing && <span className="text-sm text-wait">{missing.detail}</span>}
      </div>
    </section>
  );
}

/** 입력한 이슈 번호. 빈 값은 연결하지 않음, 범위 밖이거나 정수가 아니면 잘못된 값이다 */
function parseIssue(input: string): { ok: true; value?: number } | { ok: false } {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  if (!/^[0-9]{1,8}$/.test(trimmed)) return { ok: false };
  const value = Number(trimmed);
  if (value < 1 || value > 10_000_000) return { ok: false };
  return { ok: true, value };
}
