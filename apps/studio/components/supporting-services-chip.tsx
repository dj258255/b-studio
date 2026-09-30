"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ContainerState } from "@b-studio/sandbox";
import type { SupportingContainerSummary } from "@/lib/header-services";
import { Dot, type Tone } from "./status";

const ROLE_LABEL: Record<SupportingContainerSummary["role"], string> = { managed: "서비스", supporting: "부가 서비스", platform: "플랫폼" };

/** 목록 한 줄. GET /api/sessions/[id]/services가 돌려주는 모양과 같다(관리형·부가 서비스 모두 담는다, 플랫폼은 빠진다) */
interface ServiceSelectionRow {
  name: string;
  role: "managed" | "supporting";
  selected: boolean;
  dependsOn: string[];
  dependents: string[];
}

function toneOfContainer(state: ContainerState): Tone {
  if (state === "running") return "pass";
  if (state === "dead") return "fail";
  if (state === "exited" || state === "paused" || state === "removing") return "idle";
  return "wait";
}

/**
 * 헤더의 서비스 메뉴(ADR-083). 관리형이 아닌 컨테이너(DB 등 부가 서비스, edge 플랫폼)를 "+N" 칩으로 압축해 보여주던
 * 것을, 누르면 관리형·부가 서비스를 모두 켜고 끌 수 있는 목록으로 바꿨다. 다른 선택된 서비스가 기대는 서비스를
 * 끄려 하면 경고 문구를 보여주되 막지는 않는다. 팝오버는 body에 포털로 그린다(머리의 backdrop-filter 때문에
 * work-drawer·SupportingServicesPopover와 같은 이유로 잘림을 피한다)
 */
export function SupportingServicesChip({ sessionId, services }: { sessionId: string; services: SupportingContainerSummary[] }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="서비스 켜고 끄기"
        className="glass-soft rounded-full px-2.5 py-0.5 text-xs font-medium text-muted hover:bg-panel"
      >
        서비스{services.length > 0 ? ` +${services.length}` : ""}
      </button>
      {open && <ServicesPopover sessionId={sessionId} anchor={buttonRef} services={services} onClose={() => setOpen(false)} />}
    </>
  );
}

function ServicesPopover({
  sessionId,
  anchor,
  services,
  onClose,
}: {
  sessionId: string;
  anchor: RefObject<HTMLButtonElement | null>;
  services: SupportingContainerSummary[];
  onClose: () => void;
}) {
  // project-menu와 같은 방식: 여는 순간 버튼 자리를 한 번만 읽는다(구독이 아니라 여는 자리를 정하는 것이라 effect가 아니다)
  const [position] = useState<{ top: number; left: number }>(() => {
    const box = anchor.current?.getBoundingClientRect();
    return box ? { top: box.bottom + 8, left: box.left } : { top: 0, left: 0 };
  });
  const [rows, setRows] = useState<ServiceSelectionRow[]>();
  const [error, setError] = useState<string>();
  const [warning, setWarning] = useState<string>();
  const [pending, setPending] = useState(false);
  const live = new Map(services.map((service) => [service.service, service]));

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/services`)
      .then((response) => response.json() as Promise<ServiceSelectionRow[]>)
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch(() => {
        if (!cancelled) setError("서비스 목록을 불러오지 못했습니다");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function toggle(name: string, on: boolean) {
    setPending(true);
    setError(undefined);
    setWarning(undefined);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/services/${name}/selection`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on }),
      });
      const body = (await response.json().catch(() => ({}))) as { selection?: ServiceSelectionRow[]; warning?: string; error?: string };
      if (!response.ok) {
        setError(body.error ?? "서비스를 바꾸지 못했습니다");
        return;
      }
      if (body.selection) setRows(body.selection);
      if (body.warning) setWarning(body.warning);
    } finally {
      setPending(false);
    }
  }

  /** 개발만: 지금 켜진 부가 서비스(DB 등)를 모두 끈다. 프론트만으로도 돌아가는 프로젝트에서 인프라 없이 빠르게 켜고 싶을 때 쓴다 */
  async function devOnly() {
    if (!rows) return;
    setPending(true);
    setError(undefined);
    setWarning(undefined);
    try {
      for (const row of rows.filter((row) => row.role === "supporting" && row.selected)) {
        const response = await fetch(`/api/sessions/${sessionId}/services/${row.name}/selection`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ on: false }),
        });
        const body = (await response.json().catch(() => ({}))) as { selection?: ServiceSelectionRow[]; error?: string };
        if (!response.ok) {
          setError(body.error ?? "서비스를 끄지 못했습니다");
          return;
        }
        if (body.selection) setRows(body.selection);
      }
    } finally {
      setPending(false);
    }
  }

  const hasSupporting = rows?.some((row) => row.role === "supporting") ?? false;

  return createPortal(
    <div className="fixed inset-0 z-40">
      <button type="button" aria-label="닫기" onClick={onClose} className="absolute inset-0 cursor-default bg-transparent" />
      <div
        role="menu"
        aria-label="서비스 켜고 끄기"
        style={{ top: position.top, left: position.left }}
        className="glass fixed max-h-[calc(100vh-2rem)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-panel p-2 text-sm shadow-xl"
      >
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          <p className="text-xs font-medium text-muted">띄울 서비스를 고르세요. 끈 서비스는 다음에 켤 때까지 띄우지 않습니다</p>
          {hasSupporting && (
            <button
              type="button"
              onClick={devOnly}
              disabled={pending}
              className="shrink-0 rounded-control border border-line px-2 py-1 text-xs font-medium hover:border-ink disabled:opacity-60"
              title="부가 서비스(DB 등)를 모두 끕니다"
            >
              개발만
            </button>
          )}
        </div>
        {rows === undefined && !error && <p className="px-2 py-2 text-xs text-muted">불러오는 중</p>}
        <ul className="mt-1">
          {rows?.map((row) => {
            const container = live.get(row.name);
            const tone: Tone = !row.selected ? "idle" : container ? toneOfContainer(container.state) : "wait";
            return (
              <li key={row.name} className="flex flex-col gap-0.5 rounded-control px-2 py-1.5 hover:bg-panel">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={row.selected}
                    disabled={pending}
                    onChange={(event) => toggle(row.name, event.target.checked)}
                    className="accent-ink"
                  />
                  <Dot tone={tone} />
                  <span className="font-medium">{row.name}</span>
                  <span className="text-xs text-muted">{ROLE_LABEL[row.role]}</span>
                </label>
                {row.dependsOn.length > 0 && <p className="ml-6 text-xs text-muted">→ {row.dependsOn.join(", ")}에 기댑니다</p>}
              </li>
            );
          })}
        </ul>
        {warning && (
          <p role="alert" className="mt-1 rounded-control bg-wait/10 px-2 py-1.5 text-xs text-wait">
            {warning}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-1 rounded-control bg-fail/10 px-2 py-1.5 text-xs text-fail">
            {error}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
