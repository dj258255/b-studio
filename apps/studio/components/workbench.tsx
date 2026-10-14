"use client";

import { useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from "react";
import type { SessionSnapshot } from "@/lib/studio-events";
import { ChatDraftProvider, type ChatDraft } from "./chat-draft-context";
import { ChatPanel } from "./chat-panel";
import { CodeOpenProvider, type CodeOpen, type CodeOpenTarget } from "./code-open-context";
import { PreviewPanel } from "./preview-panel";
import { ElementSelectionProvider, formatElementSelections, type ElementSelection } from "./selection-context";
import { SessionAccessProvider, type SessionAccess } from "./session-access";
import { RequirementsImportProvider, type RequirementsImport, type RequirementsImportTarget } from "./requirements-import-context";
import { SessionHeader } from "./session-header";
import { TerminalPanel } from "./terminal-panel";
import { clampSplit, readRecordOpen, readSplit, SPLIT_DEFAULT, SPLIT_MAX, SPLIT_MIN, writeRecordOpen, writeSplit } from "@/lib/terminal";
import { ActivityStrip } from "./activity-strip";
import { useSession } from "./use-session";

/** 브라우저에 기억해 둔 값은 이 화면이 떠 있는 동안 바깥에서 바뀌지 않는다. 처음 한 번 읽으려고만 구독한다 */
const subscribeToNothing = (): (() => void) => () => {};

export function Workbench({ initial, access }: { initial: SessionSnapshot; access: SessionAccess }) {
  const view = useSession(initial);
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

  // 에이전트에게 일을 시키는 자리(이슈 #689). 터미널을 쓸 수 있는 세션은 터미널이 화면의 중심이고 대화 패널은 입력창 없는
  // 활동 기록이다. 대화 입력으로 되돌아가는 길은 두지 않는다 — 요청은 터미널로만 보낸다. 터미널을 쓸 수 없는 스튜디오
  // (서버 모드 등)에서만 대화 창을 그린다
  const terminalFirst = view.snapshot.terminal === true;

  // 미리보기에서 고른 요소를 일을 시키는 자리까지 나른다(두 패널이 형제라 여기서 들고 있는다).
  // 대화 입력창은 고른 요소를 목록으로 모았다가 요청과 함께 보낸다. 터미널에는 모아 둘 자리가 없으므로 고르는 즉시 입력 줄에 붙여 넣는다
  const [selections, setSelections] = useState<ElementSelection[]>([]);
  const sessionId = view.snapshot.id;
  const elements = useMemo(
    () => ({
      selections: terminalFirst ? [] : selections,
      add: (selection: ElementSelection) => {
        if (terminalFirst) draft.fill(formatElementSelections(sessionId, [selection]));
        else setSelections((current) => [...current, selection]);
      },
      remove: (index: number) => setSelections((current) => current.filter((_, i) => i !== index)),
      clear: () => setSelections([]),
    }),
    [selections, terminalFirst, draft, sessionId],
  );

  // 활동 기록을 펼쳐 뒀는지와 경계의 자리도 브라우저에 기억한다
  const rememberedRecord = useSyncExternalStore<boolean>(subscribeToNothing, () => readRecordOpen(window.localStorage), () => false);
  const [recordChoice, setRecordChoice] = useState<boolean>();
  const recordOpen = recordChoice ?? rememberedRecord;
  const toggleRecord = (): void => {
    setRecordChoice(!recordOpen);
    writeRecordOpen(window.localStorage, !recordOpen);
  };
  const rememberedSplit = useSyncExternalStore<number>(subscribeToNothing, () => readSplit(window.localStorage), () => SPLIT_DEFAULT);
  const [splitChoice, setSplitChoice] = useState<number>();
  const split = splitChoice ?? rememberedSplit;
  const splitArea = useRef<HTMLDivElement>(null);
  const moveSplit = (next: number, remember: boolean): void => {
    const value = clampSplit(next);
    setSplitChoice(value);
    if (remember) writeSplit(window.localStorage, value);
  };

  return (
    <SessionAccessProvider value={access}>
      <ElementSelectionProvider value={elements}>
        <ChatDraftProvider value={draft}>
          <CodeOpenProvider value={codeOpen}>
            <RequirementsImportProvider value={requirementsImport}>
              {/* 헤더·미리보기·대화를 바탕 위에 떠 있는 시트로 두어, 뒤의 빛이 유리 표면 사이로 보이게 한다 */}
              <div className="grid h-dvh grid-rows-[auto_minmax(0,1fr)] gap-3 p-3 text-ink">
                <SessionHeader snapshot={view.snapshot} />
                {terminalFirst ? (
                  // 터미널이 왼쪽에 크게, 작업 패널이 오른쪽에. 좁은 화면에서는 위아래로 쌓는다
                  <div
                    ref={splitArea}
                    className="grid min-h-0 grid-cols-1 grid-rows-[minmax(0,1.2fr)_minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,var(--left))_0.5rem_minmax(0,var(--right))] lg:grid-rows-1 lg:gap-x-1"
                    style={{ "--left": `${split}fr`, "--right": `${1 - split}fr` } as CSSProperties}
                  >
                    <div className="flex min-h-0 flex-col gap-2">
                      <div className={`grid min-h-0 ${recordOpen ? "flex-[3]" : "flex-1"}`}>
                        <TerminalPanel sessionId={view.snapshot.id} mode={view.snapshot.terminalMode} ready={view.snapshot.status !== "stopped" && view.snapshot.status !== "failed"} acceptDraft />
                      </div>
                      <ActivityStrip view={view} open={recordOpen} onToggle={toggleRecord} />
                      {recordOpen && (
                        <div className="grid min-h-0 flex-[2]">
                          <ChatPanel view={view} mode="record" />
                        </div>
                      )}
                    </div>
                    <SplitHandle area={splitArea} value={split} onMove={moveSplit} />
                    <PreviewPanel view={view} />
                  </div>
                ) : (
                  <div className="grid min-h-0 grid-cols-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3 lg:grid-cols-[minmax(0,1fr)_27rem] lg:grid-rows-1">
                    <PreviewPanel view={view} />
                    <div className="flex min-h-0 flex-col gap-2">
                      <div className="grid min-h-0 flex-1">
                        <ChatPanel view={view} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </RequirementsImportProvider>
          </CodeOpenProvider>
        </ChatDraftProvider>
      </ElementSelectionProvider>
    </SessionAccessProvider>
  );
}

/**
 * 터미널과 작업 패널 사이의 경계. 끌거나 화살표 키로 옮긴다. 끄는 동안 포인터를 붙잡아 두어, 미리보기(iframe) 위를 지나가도
 * 움직임을 놓치지 않는다. 좁은 화면(위아래로 쌓일 때)에서는 보이지 않는다
 */
function SplitHandle({ area, value, onMove }: { area: RefObject<HTMLDivElement | null>; value: number; onMove: (next: number, remember: boolean) => void }) {
  const ratioAt = (clientX: number): number | undefined => {
    const box = area.current?.getBoundingClientRect();
    return box && box.width > 0 ? (clientX - box.left) / box.width : undefined;
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="터미널과 작업 패널 사이의 경계"
      aria-valuemin={Math.round(SPLIT_MIN * 100)}
      aria-valuemax={Math.round(SPLIT_MAX * 100)}
      aria-valuenow={Math.round(value * 100)}
      tabIndex={0}
      className="group hidden cursor-col-resize touch-none items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ink lg:flex"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const next = ratioAt(event.clientX);
        if (next !== undefined) onMove(next, false);
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        const next = ratioAt(event.clientX);
        if (next !== undefined) onMove(next, true);
      }}
      onDoubleClick={() => onMove(SPLIT_DEFAULT, true)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onMove(value - 0.02, true);
        else if (event.key === "ArrowRight") onMove(value + 0.02, true);
        else if (event.key === "Home") onMove(SPLIT_DEFAULT, true);
        else return;
        event.preventDefault();
      }}
    >
      <span aria-hidden className="h-12 w-1 rounded-full bg-line transition-colors group-hover:bg-ink/50 group-focus-visible:bg-ink/50" />
    </div>
  );
}

