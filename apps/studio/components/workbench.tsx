"use client";

import type { SessionSnapshot } from "@/lib/studio-events";
import { ChatPanel } from "./chat-panel";
import { PreviewPanel } from "./preview-panel";
import { SessionHeader } from "./session-header";
import { useSession } from "./use-session";

export function Workbench({ initial }: { initial: SessionSnapshot }) {
  const view = useSession(initial);

  return (
    <div className="grid h-dvh grid-rows-[auto_minmax(0,1fr)] bg-ground text-ink">
      <SessionHeader snapshot={view.snapshot} />
      <div className="grid min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_27rem] lg:grid-rows-1">
        <PreviewPanel view={view} />
        <ChatPanel view={view} />
      </div>
    </div>
  );
}
