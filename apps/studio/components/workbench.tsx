"use client";

import { useMemo, useRef, useState } from "react";
import type { SessionSnapshot } from "@/lib/studio-events";
import { ChatDraftProvider, type ChatDraft } from "./chat-draft-context";
import { ChatPanel } from "./chat-panel";
import { CodeOpenProvider, type CodeOpen, type CodeOpenTarget } from "./code-open-context";
import { PreviewPanel } from "./preview-panel";
import { ElementSelectionProvider, type ElementSelection } from "./selection-context";
import { SessionAccessProvider, type SessionAccess } from "./session-access";
import { SessionHeader } from "./session-header";
import { useSession } from "./use-session";

export function Workbench({ initial, access }: { initial: SessionSnapshot; access: SessionAccess }) {
  const view = useSession(initial);
  // 미리보기에서 고른 요소를 대화 입력창까지 나른다(두 패널이 형제라 여기서 들고 있는다)
  const [selections, setSelections] = useState<ElementSelection[]>([]);
  const elements = useMemo(
    () => ({
      selections,
      add: (selection: ElementSelection) => setSelections((current) => [...current, selection]),
      remove: (index: number) => setSelections((current) => current.filter((_, i) => i !== index)),
      clear: () => setSelections([]),
    }),
    [selections],
  );
  // 저장소 탭의 "이 이슈로 작업"도 같은 자리에서 대화 입력창까지 글을 나른다.
  // 대화 입력창(ChatPanel)이 자신의 채우기 함수를 등록해 두면, 형제 패널은 그 함수를 직접 부른다(state를 effect에서 동기화하지 않는다)
  const fillRef = useRef<((text: string) => void) | undefined>(undefined);
  const draft = useMemo<ChatDraft>(
    () => ({ fill: (text) => fillRef.current?.(text), register: (setter) => { fillRef.current = setter; } }),
    [],
  );
  // "테스트" 탭의 file:line 링크가 "코드" 탭을 연다(형제 패널이라 여기서 공유 상태로 든다 — 대화 채우기와 같은 자리)
  const [codeOpenTarget, setCodeOpenTarget] = useState<CodeOpenTarget>();
  const codeOpen = useMemo<CodeOpen>(
    () => ({ target: codeOpenTarget, open: (target) => setCodeOpenTarget(target), clear: () => setCodeOpenTarget(undefined) }),
    [codeOpenTarget],
  );

  return (
    <SessionAccessProvider value={access}>
      <ElementSelectionProvider value={elements}>
        <ChatDraftProvider value={draft}>
          <CodeOpenProvider value={codeOpen}>
            {/* 헤더·미리보기·대화를 바탕 위에 떠 있는 시트로 두어, 뒤의 빛이 유리 표면 사이로 보이게 한다 */}
            <div className="grid h-dvh grid-rows-[auto_minmax(0,1fr)] gap-3 p-3 text-ink">
              <SessionHeader snapshot={view.snapshot} />
              <div className="grid min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,1fr)_27rem] lg:grid-rows-1">
                <PreviewPanel view={view} />
                <ChatPanel view={view} />
              </div>
            </div>
          </CodeOpenProvider>
        </ChatDraftProvider>
      </ElementSelectionProvider>
    </SessionAccessProvider>
  );
}
