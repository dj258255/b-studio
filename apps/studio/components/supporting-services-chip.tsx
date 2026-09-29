"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ContainerState } from "@b-studio/sandbox";
import type { SupportingContainerSummary } from "@/lib/header-services";
import { Dot, type Tone } from "./status";

const ROLE_LABEL: Record<SupportingContainerSummary["role"], string> = { managed: "서비스", supporting: "부가 서비스", platform: "플랫폼" };

function toneOfContainer(state: ContainerState): Tone {
  if (state === "running") return "pass";
  if (state === "dead") return "fail";
  if (state === "exited" || state === "paused" || state === "removing") return "idle";
  return "wait";
}

/**
 * 관리형이 아닌 컨테이너(DB 등 부가 서비스, edge 플랫폼)를 개발 화면 머리에 "+N" 칩 하나로 압축해 보여준다.
 * 누르면 이름·갈래·상태를 나열한 팝오버가 열린다. 머리에 backdrop-filter(유리 효과)가 있어 body에 포털로 그린다(work-drawer와 같은 이유)
 */
export function SupportingServicesChip({ services }: { services: SupportingContainerSummary[] }) {
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
        title="부가 서비스·플랫폼 컨테이너"
        className="glass-soft rounded-full px-2.5 py-0.5 text-xs font-medium text-muted hover:bg-panel"
      >
        +{services.length}
      </button>
      {open && <SupportingServicesPopover anchor={buttonRef} services={services} onClose={() => setOpen(false)} />}
    </>
  );
}

function SupportingServicesPopover({
  anchor,
  services,
  onClose,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  services: SupportingContainerSummary[];
  onClose: () => void;
}) {
  // project-menu와 같은 방식: 여는 순간 버튼 자리를 한 번만 읽는다(구독이 아니라 여는 자리를 정하는 것이라 effect가 아니다)
  const [position] = useState<{ top: number; left: number }>(() => {
    const box = anchor.current?.getBoundingClientRect();
    return box ? { top: box.bottom + 8, left: box.left } : { top: 0, left: 0 };
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-40">
      <button type="button" aria-label="닫기" onClick={onClose} className="absolute inset-0 cursor-default bg-transparent" />
      <ul
        role="menu"
        aria-label="부가 서비스·플랫폼 컨테이너"
        style={{ top: position.top, left: position.left }}
        className="glass fixed max-h-[calc(100vh-2rem)] w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-panel p-2 text-sm shadow-xl"
      >
        {services.map((service) => (
          <li key={service.service} className="flex items-center gap-1.5 rounded-control px-2 py-1.5">
            <Dot tone={toneOfContainer(service.state)} />
            <span className="font-medium">{service.service}</span>
            <span className="text-xs text-muted">{ROLE_LABEL[service.role]}</span>
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  );
}
