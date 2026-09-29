"use client";

import { useEffect, useRef, useState } from "react";
import { clampRect, isRectStale, normalizeRect, scaleRect, type Rect } from "@/lib/element-pick-geometry";
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

/** 드래그 거리가 이보다 작으면 드래그가 아니라 클릭으로 본다(손이 살짝 떨려도 클릭 선택이 되게) */
const CLICK_THRESHOLD_PX = 4;

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

/** rect를 프레임(뷰포트 픽셀) 기준의 퍼센트 위치로 바꾼다. 이미지가 원본 비율 그대로 늘어나므로 퍼센트가 곧 표시 위치다 */
function toPercent(rect: Rect, viewport: { width: number; height: number }): Rect {
  return scaleRect(rect, viewport, { width: 100, height: 100 });
}

/** 미리보기 위에 그리는 사각형 하나(선택 오버레이·마우스 오버·드래그 중 상자가 모두 이 모양을 쓴다) */
function OverlayBox({ rect, viewport, tone, label }: { rect: Rect; viewport: { width: number; height: number }; tone: "selected" | "hover" | "dragging"; label?: string }) {
  const percent = toPercent(rect, viewport);
  const toneClass =
    tone === "selected" ? "border-ink bg-ink/10" : tone === "hover" ? "border-wait bg-wait/10" : "border-ink border-dashed bg-ink/5";
  return (
    <div
      className={`absolute border-2 ${toneClass}`}
      style={{ left: `${percent.x}%`, top: `${percent.y}%`, width: `${percent.width}%`, height: `${percent.height}%` }}
    >
      {label && <span className="absolute -top-5 left-0 truncate rounded-sm bg-ink px-1 py-0.5 text-[10px] leading-tight text-panel">{label}</span>}
    </div>
  );
}

/**
 * 서버가 소유한 브라우저 화면을 프레임으로 그린다. 이미지 위 마우스 좌표를 이미지 크기에서 뷰포트 좌표로 환산해 되돌려 보낸다.
 * 보기를 여는 동안에만 시작하고, 떠나면 멈춘다(호스트 메모리를 계속 붙잡지 않게)
 */
export function RemoteBrowserView({ sessionId, service, frame, blocked }: { sessionId: string; service: string; frame?: LiveFrame; blocked?: number }) {
  const { selections, add } = useElementSelections();
  const [preset, setPreset] = useState<Preset>("desktop");
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [dragRect, setDragRect] = useState<Rect>();
  const [hoverRect, setHoverRect] = useState<Rect>();
  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // 이미지는 max-h-full/max-w-full로 원본 비율을 지키며 줄어들어, 가운데 정렬 탓에 컨테이너 안에 여백이 생길 수 있다.
  // 오버레이를 이미지에 정확히 겹치려면 CSS 퍼센트만으로는 안 되고(그러면 여백까지 포함해 어긋난다),
  // 이미지가 실제로 그려진 위치·크기를 픽셀로 재서 오버레이 상자를 그 위에 직접 앉힌다
  const [imgBox, setImgBox] = useState<{ left: number; top: number; width: number; height: number }>();
  const dragging = useRef(false);
  const pickDragStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const frameRef = useRef<LiveFrame | undefined>(frame);
  // hover는 마우스가 움직일 때마다 부르고 싶지만, 응답을 기다리는 동안 또 부르면 요청이 쌓인다.
  // 그래서 진행 중이면 마지막 좌표만 큐에 두고, 끝나면 그 좌표로 한 번 더 부른다(중간 프레임은 건너뛴다)
  const hoverBusy = useRef(false);
  const hoverQueued = useRef<{ x: number; y: number } | undefined>(undefined);

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

  // 이미지가 실제로 그려진 위치·크기를 재서 오버레이 기준으로 쓴다. 창 크기나 뷰포트 프리셋이 바뀌면 다시 잰다
  useEffect(() => {
    const image = imgRef.current;
    const container = containerRef.current;
    if (!image || !container) {
      setImgBox(undefined);
      return;
    }
    const update = () => {
      const imageRect = image.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      if (imageRect.width === 0 || imageRect.height === 0) return;
      setImgBox({ left: imageRect.left - containerRect.left, top: imageRect.top - containerRect.top, width: imageRect.width, height: imageRect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(image);
    observer.observe(container);
    return () => observer.disconnect();
  }, [frame?.width, frame?.height]);

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

  function applySelection(body: ElementSelection & { error?: string }, response: Response, noticePrefix: string): void {
    if (!response.ok) {
      setError(body.error ?? "요소를 선택하지 못했습니다");
      return;
    }
    add({ selector: body.selector, html: body.html, css: body.css, screenshotArtifact: body.screenshotArtifact, rect: body.rect, viewport: body.viewport });
    setNotice(`${noticePrefix}: ${body.selector}`);
  }

  async function pick(x: number, y: number): Promise<void> {
    const response = await call(sessionId, { action: "pick", x, y });
    const body = (await response.json().catch(() => ({}))) as ElementSelection & { error?: string };
    applySelection(body, response, "요소를 대화 입력창에 첨부했습니다");
  }

  async function pickRect(rect: Rect): Promise<void> {
    const response = await call(sessionId, { action: "pickRect", rect });
    const body = (await response.json().catch(() => ({}))) as ElementSelection & { error?: string };
    applySelection(body, response, "드래그한 영역의 요소를 대화 입력창에 첨부했습니다");
  }

  /** 드래그가 끝났을 때: 너무 작으면 클릭으로, 아니면 영역 선택으로 처리한다 */
  async function finishPick(start: { x: number; y: number }, end: { x: number; y: number }): Promise<void> {
    const current = frameRef.current;
    if (!current) return;
    const normalized = clampRect(normalizeRect(start, end), current);
    if (normalized.width < CLICK_THRESHOLD_PX || normalized.height < CLICK_THRESHOLD_PX) {
      await pick(Math.round(start.x), Math.round(start.y));
      return;
    }
    await pickRect(normalized);
  }

  /** 고르기 모드에서 마우스를 올린 자리 아래 요소를 가볍게 물어 강조 상자를 그린다(진행 중인 요청 위에 겹쳐 보내지 않는다) */
  function scheduleHover(point: { x: number; y: number }): void {
    if (hoverBusy.current) {
      hoverQueued.current = point;
      return;
    }
    hoverBusy.current = true;
    void call(sessionId, { action: "hover", x: point.x, y: point.y })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { rect?: Rect | null };
        setHoverRect(response.ok && body.rect ? body.rect : undefined);
      })
      .catch(() => setHoverRect(undefined))
      .finally(() => {
        hoverBusy.current = false;
        const queued = hoverQueued.current;
        hoverQueued.current = undefined;
        if (queued) scheduleHover(queued);
      });
  }

  const liveViewport = frame ? { width: frame.width, height: frame.height } : undefined;

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
            // 고르기 모드를 끌 때 마우스 오버 강조와 드래그 중 상자도 함께 지운다
            setHoverRect(undefined);
            setDragRect(undefined);
            pickDragStart.current = undefined;
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
        ref={containerRef}
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
          <>
            <img
              ref={imgRef}
              src={`data:${frame.mime};base64,${frame.data}`}
              alt=""
              draggable={false}
              className="max-h-full max-w-full select-none"
              onMouseDown={(event) => {
                const point = toViewport(event.clientX, event.clientY);
                if (!point) return;
                if (picking) {
                  pickDragStart.current = point;
                  setDragRect({ x: point.x, y: point.y, width: 0, height: 0 });
                  return;
                }
                dragging.current = true;
                send({ type: "mouse", event: "down", x: point.x, y: point.y });
              }}
              onMouseMove={(event) => {
                const point = toViewport(event.clientX, event.clientY);
                if (!point) return;
                if (picking) {
                  if (pickDragStart.current) setDragRect(normalizeRect(pickDragStart.current, point));
                  else scheduleHover(point);
                  return;
                }
                if (dragging.current) send({ type: "mouse", event: "move", x: point.x, y: point.y });
              }}
              onMouseUp={(event) => {
                const point = toViewport(event.clientX, event.clientY);
                if (picking) {
                  const start = pickDragStart.current;
                  pickDragStart.current = undefined;
                  setDragRect(undefined);
                  if (start && point) void finishPick(start, point);
                  return;
                }
                if (!dragging.current) return;
                dragging.current = false;
                if (point) send({ type: "mouse", event: "up", x: point.x, y: point.y });
              }}
              onMouseLeave={() => {
                dragging.current = false;
                pickDragStart.current = undefined;
                setDragRect(undefined);
                setHoverRect(undefined);
              }}
            />

            {/* 고른 요소들의 오버레이. 이미지가 실제로 그려진 자리(imgBox) 위에만 얹는다. 프리셋이 바뀌어 뷰포트
                크기가 달라지면(오버레이가 안 맞으므로) 낡은 선택은 숨긴다 */}
            {liveViewport && imgBox && (
              <div className="pointer-events-none absolute" style={{ left: imgBox.left, top: imgBox.top, width: imgBox.width, height: imgBox.height }}>
                {selections.map((selection, index) => {
                  if (!selection.rect || !selection.viewport || isRectStale(selection.viewport, liveViewport)) return null;
                  const short = selection.selector.length > 18 ? `${selection.selector.slice(0, 18)}…` : selection.selector;
                  return <OverlayBox key={index} rect={selection.rect} viewport={selection.viewport} tone="selected" label={`#${index + 1} ${short}`} />;
                })}
                {picking && hoverRect && !dragRect && <OverlayBox rect={hoverRect} viewport={liveViewport} tone="hover" />}
                {picking && dragRect && <OverlayBox rect={dragRect} viewport={liveViewport} tone="dragging" />}
              </div>
            )}
          </>
        ) : (
          <p role="status" className="px-4 py-3 text-sm text-muted">
            원격 브라우저의 첫 화면을 기다리는 중입니다
          </p>
        )}
      </div>

      <p className="border-t border-line px-3 py-1.5 text-xs text-muted">
        {picking ? "화면을 클릭하면 그 요소를, 드래그하면 그 영역의 요소를 첨부합니다." : "화면을 클릭한 뒤에는 키보드 입력이 이 브라우저로 전달됩니다."}
      </p>
    </div>
  );
}
