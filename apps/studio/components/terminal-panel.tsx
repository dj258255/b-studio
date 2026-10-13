"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import type { TerminalMessage } from "@/lib/server/session-terminal";
import { decodeTerminalData, terminalPasteText, terminalStatusLabel, type TerminalGateStatus, type TerminalStatus } from "@/lib/terminal";
import { useChatDraft } from "./chat-draft-context";
import { useSessionAccess } from "./session-access";

/**
 * 세션 터미널(이슈 #673). 세션의 에이전트 컨테이너 안에서 도는 CLI에 붙는 진짜 터미널이다.
 * 출력은 SSE로 받고 입력·크기는 POST로 보낸다. 이 화면을 닫아도 터미널은 살아 있고, 다시 열면 최근 출력부터 이어진다.
 */
const GATE_TONE: Record<TerminalGateStatus["tone"], string> = { working: "bg-wait", ok: "bg-pass", fail: "bg-fail", idle: "bg-line" };

export function TerminalPanel({
  sessionId,
  ready,
  gate,
  acceptDraft = false,
  mode = "container",
}: {
  sessionId: string;
  ready: boolean;
  /** 터미널에서 보낸 마지막 요청의 검증 상태. 터미널 중심 화면에서는 아래의 활동 줄이 보여 주므로 넘기지 않는다 */
  gate?: TerminalGateStatus;
  /**
   * 다른 패널의 "입력창에 채우기"(이 이슈로 작업, 요구사항에서 묻기, 리뷰 지적 고치기)를 이 터미널이 받는다(이슈 #689).
   * 글은 CLI의 입력 줄에 붙여 넣기만 하고 보내지 않는다. 사람이 보고 고친 뒤 직접 Enter를 누른다
   */
  acceptDraft?: boolean;
  /** 터미널을 여는 방식. host면 이 컴퓨터의 CLI를 띄운다고 안내한다 */
  mode?: "container" | "host";
}) {
  const access = useSessionAccess();
  const draft = useChatDraft();
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TerminalStatus>({ state: "idle" });
  /** 다른 패널이 넘긴 글을 붙여 넣지 않았을 때 그 까닭. 조용히 버리지 않는다 */
  const [pasteNotice, setPasteNotice] = useState<string>();
  // "다시 열기"가 부를 함수. 터미널을 만든 효과가 채워 둔다
  const reopen = useRef<() => void>(() => {});

  const post = useCallback(
    async (body: Record<string, unknown>): Promise<void> => {
      const response = await fetch(`/api/sessions/${sessionId}/terminal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) {
        const reason = await response.json().then((data: { error?: string }) => data.error, () => undefined);
        throw new Error(reason ?? `요청이 실패했습니다 (${response.status})`);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    const element = container.current;
    if (!element || !ready || !access.canManage) return;
    let disposed = false;
    let dispose = () => {};

    void (async () => {
      // xterm은 브라우저에서만 불러온다(모듈을 읽는 순간 창을 본다)
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed) return;
      const terminal = new Terminal({
        cursorBlink: true,
        // 한글은 영문 글꼴에 없어 대체 글꼴로 그려진다. 고정 폭 한글 글꼴이 깔려 있으면 그것을 먼저 쓴다(칸 너비에 맞아 글자 사이가 벌어지지 않는다)
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", "D2Coding", "Sarasa Mono K", "NanumGothicCoding", "Nanum Gothic Coding", monospace',
        fontSize: 13,
        scrollback: 5000,
        theme: { background: "#0d1117", foreground: "#e6edf3", cursor: "#e6edf3", selectionBackground: "#264f78" },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.open(element);
      fit.fit();

      // 입력은 친 순서대로 가야 한다. 요청을 하나씩 이어 보내고, 기다리는 동안 친 글자는 모아서 한 번에 보낸다
      let pending = "";
      let sending = false;
      const flush = async (): Promise<void> => {
        if (sending) return;
        sending = true;
        try {
          while (pending && !disposed) {
            const data = pending;
            pending = "";
            await post({ action: "input", data });
          }
        } catch (error) {
          pending = "";
          setStatus({ state: "closed", message: error instanceof Error ? error.message : String(error) });
        } finally {
          sending = false;
        }
      };
      const input = terminal.onData((data) => {
        pending += data;
        void flush();
      });

      const open = (): void => {
        setStatus({ state: "opening" });
        post({ action: "open", cols: terminal.cols, rows: terminal.rows }).catch((error: unknown) => {
          if (!disposed) setStatus({ state: "closed", message: error instanceof Error ? error.message : String(error) });
        });
      };
      reopen.current = open;

      // 터미널 안에 에이전트 CLI가 떠 있는가(서버가 CLI의 세션 시작·끝 훅으로 알려 준다)
      let cliAlive = false;
      const events = new EventSource(`/api/sessions/${sessionId}/terminal`);
      // 연결이 끊겼다 다시 붙으면 서버가 최근 출력을 처음부터 다시 준다. 겹쳐 그리지 않게 화면을 비우고 받는다
      events.onopen = () => terminal.reset();
      events.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as TerminalMessage;
        if (message.kind === "data") terminal.write(decodeTerminalData(message.data));
        else if (message.kind === "exit") setStatus({ state: "exited", code: message.code });
        else if (message.kind === "cli") {
          cliAlive = message.alive;
          if (message.alive) setPasteNotice(undefined);
        } else setStatus({ state: message.state, message: message.message });
      };

      // 패널 크기가 바뀌면 글자 칸 수를 다시 맞추고 컨테이너 쪽 터미널에도 알린다
      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      const observer = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (disposed) return;
          fit.fit();
          void post({ action: "resize", cols: terminal.cols, rows: terminal.rows }).catch(() => {});
        }, 120);
      });
      observer.observe(element);

      open();
      terminal.focus();
      if (acceptDraft) {
        draft.register((text, mode) => {
          // 남이 쓴 글이 들어온다(이슈 본문, 리뷰 지적, 미리보기의 HTML). 제어 문자를 지우고, CLI가 붙여 넣기 모드를 켜 두지
          // 않았으면(셸 프롬프트일 수 있다) 한 줄로 만든다 — 그 상태의 줄바꿈은 Enter다
          const value = terminalPasteText(text, { readOnly: mode?.readOnly, multiline: terminal.modes.bracketedPasteMode });
          if (!value) return;
          // CLI가 떠 있을 때만 붙여 넣는다. 셸 프롬프트에 붙여 넣으면 요청인 줄 알고 누른 Enter가 그 글을 명령으로 실행한다
          if (!cliAlive) {
            setPasteNotice("터미널에 에이전트 CLI가 떠 있지 않아 글을 붙여 넣지 않았습니다. claude를 실행한 뒤 다시 누르세요");
            terminal.focus();
            return;
          }
          setPasteNotice(undefined);
          // 붙여 넣기만 하고 Enter는 누르지 않는다. 사람이 보고 고친 뒤 직접 보낸다
          terminal.paste(value);
          terminal.focus();
        });
      }
      dispose = () => {
        if (acceptDraft) draft.register(undefined);
        clearTimeout(resizeTimer);
        observer.disconnect();
        events.close();
        input.dispose();
        terminal.dispose();
      };
    })();

    return () => {
      disposed = true;
      dispose();
    };
  }, [sessionId, ready, access.canManage, post, acceptDraft, draft]);

  const label = !access.canManage ? "이 세션을 바꿀 수 있는 사람만 터미널을 씁니다" : !ready ? "멈춘 세션입니다. 이어서 작업을 누르면 다시 열 수 있습니다" : terminalStatusLabel(status, mode);
  const stopped = status.state === "closed" || status.state === "exited";

  return (
    <section className="glass relative flex min-h-0 flex-col overflow-hidden rounded-panel" aria-label="터미널">
      <div className="flex flex-wrap items-baseline gap-x-3 border-b border-line px-5 py-2.5">
        <h2 className="font-semibold">터미널</h2>
        <p className="text-xs text-muted" role="status">
          {label}
        </p>
        {stopped && access.canManage && ready && (
          <button type="button" onClick={() => reopen.current()} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
            다시 열기
          </button>
        )}
        {pasteNotice && (
          <p role="alert" className="text-xs text-wait">
            {pasteNotice}
          </p>
        )}
        {/* 안내는 접어 둔다. 터미널의 글자 칸을 아끼고, 처음 쓰는 사람은 펼쳐 읽는다 */}
        <details className="group ml-auto text-xs text-muted">
          <summary className="cursor-pointer list-none rounded-control px-1.5 py-0.5 hover:text-ink [&::-webkit-details-marker]:hidden">안내</summary>
          <p className="absolute right-3 z-10 mt-1 w-80 rounded-panel border border-line bg-panel p-3 leading-relaxed shadow-lg">
            {mode === "host" ? (
              "이 컴퓨터에서 도는 claude입니다. 작업 폴더는 이 세션의 작업 복사본이고, 로그인과 설정은 평소 쓰던 그대로입니다. 요청을 보내면 턴이 끝날 때 검증하고, 통과하면 체크포인트를 남깁니다. 끝내 통과하지 못하면 변경을 되돌립니다(기록에서 되살릴 수 있습니다)."
            ) : (
              <>
                이 세션의 에이전트 컨테이너 안입니다. 작업 폴더는 <code>/workspace</code>이고 이 컴퓨터의 다른 파일은 보이지 않습니다. 로그인은 프로젝트마다 한 번 합니다. 요청을 보내면 턴이 끝날 때
                검증하고, 통과하면 체크포인트를 남깁니다. 끝내 통과하지 못하면 변경을 되돌립니다(기록에서 되살릴 수 있습니다).
              </>
            )}
          </p>
        </details>
      </div>
      {gate && (
        <p className="flex items-center gap-2 border-b border-line px-5 py-2 text-xs" role="status" aria-label="검증 상태">
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${GATE_TONE[gate.tone]}`} />
          {gate.text}
        </p>
      )}
      <div className="min-h-0 flex-1 bg-[#0d1117] p-2">
        <div ref={container} className="h-full w-full" />
      </div>
    </section>
  );
}
