"use client";

import type { SessionSnapshot } from "@/lib/studio-events";
import { ChatPanel } from "./chat-panel";
import { PreviewPanel } from "./preview-panel";
import { SessionAccessProvider, type SessionAccess } from "./session-access";
import { SessionHeader } from "./session-header";
import { useSession } from "./use-session";

export function Workbench({ initial, access }: { initial: SessionSnapshot; access: SessionAccess }) {
  const view = useSession(initial);

  return (
    <SessionAccessProvider value={access}>
      {/* 헤더·미리보기·대화를 바탕 위에 떠 있는 시트로 두어, 뒤의 빛이 유리 표면 사이로 보이게 한다 */}
      <div className="grid h-dvh grid-rows-[auto_minmax(0,1fr)] gap-3 p-3 text-ink">
        <SessionHeader snapshot={view.snapshot} />
        <div className="grid min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,1fr)_27rem] lg:grid-rows-1">
          <PreviewPanel view={view} />
          <ChatPanel view={view} />
        </div>
      </div>
    </SessionAccessProvider>
  );
}
