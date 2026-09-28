"use client";

import { useEffect, useState } from "react";
import type { DesignView } from "@/lib/studio-events";

interface DesignFrame {
  id: string;
  name: string;
  page: string;
  width: number;
  height: number;
}

interface ImportResult {
  files: Array<{ frameId: string; name: string; path: string; width: number; height: number }>;
  examples: string[];
  note?: string;
}

/**
 * Figma URL을 세션 단위로 저장하고, 파일의 프레임을 골라 `design/`으로 가져온다.
 * 저장한 이미지는 시각 비교(pageChecks.compare)의 기준이 되므로, 붙여 넣을 예시 줄도 함께 보여 준다.
 * 토큰 값은 화면에 절대 보여 주지 않고 설정 여부만 알린다
 */
export function DesignPanel({ sessionId, design, ready }: { sessionId: string; design?: DesignView; ready: boolean }) {
  const [url, setUrl] = useState(design?.fileUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [frames, setFrames] = useState<DesignFrame[]>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult>();

  const canFetch = Boolean(design?.fileUrl) && Boolean(design?.hasToken);
  // 설정·토큰이 준비됐을 때만 프레임을 읽는다. setState는 모두 비동기 콜백 안에서만 일어난다
  useEffect(() => {
    if (!canFetch) return;
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/design`)
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { frames?: DesignFrame[]; error?: string };
        if (cancelled) return;
        if (response.ok) {
          setFrames(body.frames ?? []);
          setError(undefined);
        } else setError(body.error ?? "디자인 목록을 불러오지 못했습니다");
      })
      .catch(() => {
        if (!cancelled) setError("디자인 목록을 불러오지 못했습니다");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, canFetch, design?.fileUrl]);

  const visibleFrames = canFetch ? frames : undefined;

  async function save(): Promise<void> {
    setSaving(true);
    setError(undefined);
    setStatus(undefined);
    setResult(undefined);
    setSelected(new Set());
    const response = await fetch(`/api/sessions/${sessionId}/design`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileUrl: url }),
    });
    const body = (await response.json().catch(() => ({}))) as { design?: DesignView; error?: string };
    if (response.ok) setStatus(body.design ? "세션에 저장했습니다" : "세션 설정을 지웠습니다");
    else setError(body.error ?? "저장하지 못했습니다");
    setSaving(false);
  }

  async function importSelected(): Promise<void> {
    setImporting(true);
    setError(undefined);
    setStatus(undefined);
    const response = await fetch(`/api/sessions/${sessionId}/design/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frameIds: [...selected], scale: 1 }),
    });
    const body = (await response.json().catch(() => ({}))) as ImportResult & { error?: string };
    if (response.ok) {
      setResult(body);
      setStatus(`프레임 ${body.files.length}개를 design/에 저장했습니다`);
    } else setError(body.error ?? "가져오지 못했습니다");
    setImporting(false);
  }

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto p-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label htmlFor="figma-url" className="min-w-0 flex-1 text-sm">
          <span className="block text-muted">Figma 파일 URL (세션 설정)</span>
          <input
            id="figma-url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://www.figma.com/design/<key>/..."
            className="mt-1 w-full rounded-control border border-line bg-panel px-2 py-1.5 font-mono text-sm"
          />
        </label>
        <button type="submit" disabled={saving} className="rounded-control bg-ink px-4 py-2 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50">
          저장
        </button>
      </form>

      {design && design.from === "studio.yaml" && <p className="mt-2 text-xs text-muted">지금은 studio.yaml의 design.figma 설정을 쓰고 있습니다. 여기에 저장하면 세션 설정이 우선합니다.</p>}
      {design && !design.hasToken && (
        <p role="status" className="mt-2 rounded-control border border-wait/40 bg-wait/10 px-3 py-2 text-sm text-wait">
          서버에 FIGMA_TOKEN이 설정되지 않았습니다. 운영 문서의 “Figma 연동”을 보고 토큰을 설정하세요(값은 화면에 표시하지 않습니다).
        </p>
      )}
      {status && (
        <p role="status" className="mt-2 text-sm text-pass">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-fail">
          {error}
        </p>
      )}

      {canFetch && (
        <section className="mt-4 min-h-0" aria-label="디자인 프레임">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">프레임</h3>
            <button
              type="button"
              disabled={selected.size === 0 || importing || !ready}
              onClick={() => void importSelected()}
              className="rounded-control bg-ink px-3.5 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
            >
              {importing ? "가져오는 중" : `선택한 ${selected.size}개 가져오기`}
            </button>
          </div>
          {!ready && <p className="mt-1 text-xs text-muted">샌드박스가 준비된 뒤에 design/으로 가져올 수 있습니다.</p>}
          {visibleFrames === undefined ? (
            <p role="status" className="mt-2 text-sm text-muted">
              프레임을 불러오는 중입니다
            </p>
          ) : visibleFrames.length === 0 ? (
            <p className="mt-2 text-sm text-muted">이 파일에서 프레임을 찾지 못했습니다.</p>
          ) : (
            <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {visibleFrames.map((frame) => (
                <li key={frame.id}>
                  <label className={`flex h-full cursor-pointer flex-col overflow-hidden rounded-control border ${selected.has(frame.id) ? "border-ink ring-1 ring-ink" : "border-line"}`}>
                    <img
                      src={`/api/sessions/${encodeURIComponent(sessionId)}/design/thumbnail?frame=${encodeURIComponent(frame.id)}`}
                      alt=""
                      className="h-24 w-full bg-ground object-contain"
                      loading="lazy"
                    />
                    <span className="flex items-start gap-1.5 border-t border-line bg-panel p-1.5 text-xs">
                      <input type="checkbox" checked={selected.has(frame.id)} onChange={() => toggle(frame.id)} className="mt-0.5 accent-ink" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium" title={`${frame.page} / ${frame.name}`}>
                          {frame.name}
                        </span>
                        <span className="block text-muted">
                          {frame.width}×{frame.height}
                        </span>
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {result && (
        <section className="mt-4" aria-label="시각 비교 예시">
          <h3 className="text-sm font-semibold">시각 비교에 쓰기</h3>
          <p className="mt-1 text-xs text-muted">가져온 이미지는 pageChecks.compare의 reference로 쓰면 QA 보기의 시각 비교 기준이 됩니다. studio.yaml에 붙여 넣으세요.</p>
          {result.note && <p className="mt-1 text-xs text-wait">{result.note}</p>}
          <ul className="mt-2 space-y-1 text-xs">
            {result.files.map((file) => (
              <li key={file.frameId} className="font-mono text-muted">
                {file.name} → {file.path}
              </li>
            ))}
          </ul>
          {result.examples.length > 0 && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(result.examples.join("\n"))}
                className="rounded-control border border-line px-3 py-1 text-xs font-medium hover:border-ink"
              >
                예시 줄 복사
              </button>
              <pre className="mt-2 max-h-72 overflow-auto rounded-control border border-line bg-ground p-2 font-mono text-xs whitespace-pre-wrap">{result.examples.join("\n")}</pre>
            </div>
          )}
        </section>
      )}

      {!design && (
        <p className="mt-3 text-sm text-muted">Figma 파일 URL을 저장하면 프레임 목록이 나타납니다. URL을 나중에 studio.yaml에 넣어 팀과 공유할 수도 있습니다.</p>
      )}
    </div>
  );
}
