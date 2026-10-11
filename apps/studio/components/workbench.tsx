"use client";

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SessionSnapshot } from "@/lib/studio-events";
import { ChatDraftProvider, type ChatDraft } from "./chat-draft-context";
import { ChatPanel } from "./chat-panel";
import { CodeOpenProvider, type CodeOpen, type CodeOpenTarget } from "./code-open-context";
import { PreviewPanel } from "./preview-panel";
import { ElementSelectionProvider, type ElementSelection } from "./selection-context";
import { SessionAccessProvider, type SessionAccess } from "./session-access";
import { RequirementsImportProvider, type RequirementsImport, type RequirementsImportTarget } from "./requirements-import-context";
import { SessionHeader } from "./session-header";
import { TerminalPanel } from "./terminal-panel";
import { readAgentSurface, terminalGateStatus, writeAgentSurface, type AgentSurface } from "@/lib/terminal";
import { useSession } from "./use-session";

/** 브라우저에 기억해 둔 값은 이 화면이 떠 있는 동안 바깥에서 바뀌지 않는다. 처음 한 번 읽으려고만 구독한다 */
const subscribeToNothing = (): (() => void) => () => {};

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
  const fillRef = useRef<Parameters<ChatDraft["register"]>[0]>(undefined);
  const draft = useMemo<ChatDraft>(
    () => ({ fill: (text, mode) => fillRef.current?.(text, mode), register: (setter) => { fillRef.current = setter; } }),
    [],
  );
  // "테스트" 탭의 file:line 링크가 "코드" 탭을 연다(형제 패널이라 여기서 공유 상태로 든다 — 대화 채우기와 같은 자리)
  const [codeOpenTarget, setCodeOpenTarget] = useState<CodeOpenTarget>();
  const codeOpen = useMemo<CodeOpen>(
    () => ({ target: codeOpenTarget, open: (target) => setCodeOpenTarget(target), clear: () => setCodeOpenTarget(undefined) }),
    [codeOpenTarget],
  );
  // 대화의 "요구사항에 반영"이 "요구사항" 탭을 열고 진단 diff를 보여 준다(ADR-094, 코드 탭 열기와 같은 자리)
  const [requirementsImportTarget, setRequirementsImportTarget] = useState<RequirementsImportTarget>();
  const requirementsImport = useMemo<RequirementsImport>(
    () => ({
      target: requirementsImportTarget,
      open: (target) => setRequirementsImportTarget(target),
      clear: () => setRequirementsImportTarget(undefined),
    }),
    [requirementsImportTarget],
  );

  // 에이전트에게 일을 시키는 자리: 대화 패널이거나, 컨테이너 안의 CLI에 붙는 터미널(실험, 이슈 #673).
  // 고른 자리는 브라우저에 기억한다. 서버가 그린 첫 화면과 어긋나지 않게 붙은 뒤에 읽는다
  const terminalAvailable = view.snapshot.terminal === true;
  const remembered = useSyncExternalStore<AgentSurface>(subscribeToNothing, () => readAgentSurface(window.localStorage), () => "chat");
  const [chosen, setChosen] = useState<AgentSurface>();
  const surface = chosen ?? remembered;
  const chooseSurface = (next: AgentSurface): void => {
    setChosen(next);
    writeAgentSurface(window.localStorage, next);
  };
  const showTerminal = terminalAvailable && surface === "terminal";

  return (
    <SessionAccessProvider value={access}>
      <ElementSelectionProvider value={elements}>
        <ChatDraftProvider value={draft}>
          <CodeOpenProvider value={codeOpen}>
            <RequirementsImportProvider value={requirementsImport}>
              {/* 헤더·미리보기·대화를 바탕 위에 떠 있는 시트로 두어, 뒤의 빛이 유리 표면 사이로 보이게 한다 */}
              <div className="grid h-dvh grid-rows-[auto_minmax(0,1fr)] gap-3 p-3 text-ink">
                <SessionHeader snapshot={view.snapshot} />
                {/* 터미널은 글자 칸이 넉넉해야 해서 대화보다 넓게 준다 */}
                <div className={`grid min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3 lg:grid-rows-1 ${showTerminal ? "lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : "lg:grid-cols-[minmax(0,1fr)_27rem]"}`}>
                  <PreviewPanel view={view} />
                  <div className="flex min-h-0 flex-col gap-2">
                    {terminalAvailable && (
                      <div className="glass flex gap-1 self-start rounded-control p-1" role="tablist" aria-label="에이전트와 일하는 자리">
                        {(["chat", "terminal"] as const).map((option) => (
                          <button
                            key={option}
                            type="button"
                            role="tab"
                            aria-selected={surface === option}
                            onClick={() => chooseSurface(option)}
                            className={`rounded-control px-3 py-1 text-sm font-medium ${surface === option ? "bg-ink text-panel" : "text-muted hover:text-ink"}`}
                          >
                            {option === "chat" ? "대화" : "터미널"}
                          </button>
                        ))}
                      </div>
                    )}
                    {/* 대화 패널은 숨기기만 한다. 지우면 입력하던 글과 형제 패널이 등록해 둔 채우기 함수를 잃는다 */}
                    <div className={`min-h-0 flex-1 ${showTerminal ? "hidden" : "grid"}`}>
                      <ChatPanel view={view} />
                    </div>
                    {showTerminal && (
                      <div className="grid min-h-0 flex-1">
                        <TerminalPanel sessionId={view.snapshot.id} ready={view.snapshot.status !== "stopped" && view.snapshot.status !== "failed"} gate={terminalGateStatus(view.chat)} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </RequirementsImportProvider>
          </CodeOpenProvider>
        </ChatDraftProvider>
      </ElementSelectionProvider>
    </SessionAccessProvider>
  );
}
