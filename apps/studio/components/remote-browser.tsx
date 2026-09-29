"use client";

import { useEffect, useRef, useState } from "react";
import { useElementSelections, type ElementSelection } from "./selection-context";
import type { LiveFrame } from "./live-frames";

type Preset = "mobile" | "tablet" | "desktop";

/** 값은 agent의 viewport preset과 맞춘다. 뷰포트를 정하지 않았을 때의 기본은 데스크톱이다 */
const VIEWPORTS: Record<Preset, { width: number; height: number }> = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
};
const LABEL: Record<Preset, string> = { mobile: "모바일", tablet: "태블릿", desktop: "데스크톱" };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function call(sessionId: string, body: unknown): Promise<Response> {
  return fetch(`/api/sessions/${sessionId}/remote-browser`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * 서버가 소유한 브라우저 화면을 프레임으로 그린다. 이미지 위 마우스 좌표를 이미지 크기에서 뷰포트 좌표로 환산해 되돌려 보낸다.
 * 보기를 여는 동안에만 시작하고, 떠나면 멈춘다(호스트 메모리를 계속 붙잡지 않게)
 */
export function RemoteBrowserView({ sessionId, service, frame, blocked }: { sessionId: string; service: string; frame?: LiveFrame; blocked?: number }) {
  const { add } = useElementSelections();
  const [preset, setPreset] = useState<Preset>("desktop");
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const imgRef = useRef<HTMLImageElement>(null);
  const dragging = useRef(false);
  const frameRef = useRef<LiveFrame | undefined>(frame);

  useEffect(() => {
    frameRef.current = frame;
  }, [frame]);

  // 보기를 여는 동안만 브라우저를 띄운다. 뷰포트를 바꿔도 다시 시작하지 않는다(리사이즈로 보낸다)
  useEffect(() => {
    let cancelled = false;
    void call(sessionId, { action: "start", service, viewport: VIEWPORTS.desktop }).then(async (response) => {
      if (!cancelled && !response.ok) setError((((await response.json().catch(() => ({}))) as { error?: string }).error) ?? "원격 브라우저를 열지 못했습니다");
    });
    return () => {
      cancelled = true;
      void call(sessionId, { action: "stop" });
    };
  }, [sessionId, service]);

  function toViewport(clientX: number, clientY: number): { x: number; y: number } | undefined {
    const image = imgRef.current;
    const current = frameRef.current;
    if (!image || !current) return undefined;
    const rect = image.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return undefined;
    return {
      x: clamp(((clientX - rect.left) / rect.width) * current.width, 0, current.width),
      y: clamp(((clientY - rect.top) / rect.height) * current.height, 0, current.height),
    };
  }

  function send(input: unknown): void {
    void call(sessionId, { action: "input", input }).catch(() => setError("입력을 보내지 못했습니다"));
  }

  function changePreset(next: Preset): void {
    setPreset(next);
    send({ type: "resize", viewport: VIEWPORTS[next] });
  }

  async function pick(x: number, y: number): Promise<void> {
    const response = await call(sessionId, { action: "pick", x, y });
    const body = (await response.json().catch(() => ({}))) as ElementSelection & { error?: string };
    if (!response.ok) {
      setError(body.error ?? "요소를 선택하지 못했습니다");
      return;
    }
    add({ selector: body.selector, html: body.html, css: body.css, screenshotArtifact: body.screenshotArtifact });
    setNotice(`요소를 대화 입력창에 첨부했습니다: ${body.selector}`);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <div className="glass-soft inline-flex rounded-control p-0.5 text-sm" role="group" aria-label="뷰포트">
          {(Object.keys(VIEWPORTS) as Preset[]).map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={preset === name}
              onClick={() => changePreset(name)}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors ${preset === name ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"}`}
            >
              {LABEL[name]}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => send({ type: "reload" })} className="rounded-control border border-line px-3 py-1 text-sm font-medium hover:border-ink">
          새로 고침
        </button>
        <button
          type="button"
          aria-pressed={picking}
          onClick={() => {
            setPicking((value) => !value);
            setNotice(undefined);
          }}
          className={`rounded-control px-3 py-1 text-sm font-medium ${picking ? "bg-ink text-panel" : "border border-line hover:border-ink"}`}
        >
          {picking ? "요소 선택 중" : "요소 선택"}
        </button>
      </div>

      {error && (
        <p role="alert" className="border-b border-fail/40 bg-fail/10 px-3 py-1.5 text-sm text-fail">
          {error}
        </p>
      )}
      {notice && !error && (
        <p role="status" className="border-b border-line bg-panel px-3 py-1.5 text-sm text-muted">
          {notice}
        </p>
      )}
      {blocked !== undefined && blocked > 0 && (
        <p role="status" className="border-b border-wait/40 bg-wait/10 px-3 py-1.5 text-sm text-wait">
          다른 출처 요청 {blocked}건을 막았습니다
        </p>
      )}

      {/* 표면에 포커스가 있을 때만 키보드가 전달된다 */}
      <div
        tabIndex={0}
        aria-label={`${service} 원격 브라우저`}
        className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-ground outline-none focus-visible:ring-2 focus-visible:ring-ink ${picking ? "cursor-crosshair" : "cursor-default"}`}
        onKeyDown={(event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) return;
          event.preventDefault();
          if (event.key.length === 1) send({ type: "type", text: event.key });
          else send({ type: "key", key: event.key });
        }}
        onWheel={(event) => {
          const point = toViewport(event.clientX, event.clientY);
          if (point) send({ type: "mouse", event: "wheel", x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY });
        }}
      >
        {frame ? (
          <img
            ref={imgRef}
            src={`data:${frame.mime};base64,${frame.data}`}
            alt=""
            draggable={false}
            className="max-h-full max-w-full select-none"
            onMouseDown={(event) => {
              if (picking) return;
              const point = toViewport(event.clientX, event.clientY);
              if (!point) return;
              dragging.current = true;
              send({ type: "mouse", event: "down", x: point.x, y: point.y });
            }}
            onMouseMove={(event) => {
              if (!dragging.current || picking) return;
              const point = toViewport(event.clientX, event.clientY);
              if (point) send({ type: "mouse", event: "move", x: point.x, y: point.y });
            }}
            onMouseUp={(event) => {
              if (!dragging.current) return;
              dragging.current = false;
              const point = toViewport(event.clientX, event.clientY);
              if (point) send({ type: "mouse", event: "up", x: point.x, y: point.y });
            }}
            onMouseLeave={() => {
              dragging.current = false;
            }}
            onClick={(event) => {
              if (!picking) return;
              const point = toViewport(event.clientX, event.clientY);
              if (point) void pick(point.x, point.y);
            }}
          />
        ) : (
          <p role="status" className="px-4 py-3 text-sm text-muted">
            원격 브라우저의 첫 화면을 기다리는 중입니다
          </p>
        )}
      </div>

      <p className="border-t border-line px-3 py-1.5 text-xs text-muted">화면을 클릭한 뒤에는 키보드 입력이 이 브라우저로 전달됩니다.</p>
    </div>
  );
}
