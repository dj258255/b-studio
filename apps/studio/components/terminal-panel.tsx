"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import type { TerminalMessage } from "@/lib/server/session-terminal";
import { decodeTerminalData, terminalPasteText, terminalStatusLabel, type TerminalGateStatus, type TerminalStatus } from "@/lib/terminal";
import { useChatDraft } from "./chat-draft-context";
import { useSessionAccess } from "./session-access";
import { useTerminalStream, type TerminalStreamMessage } from "./terminal-stream";

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
  stoppedLabel,
}: {
  sessionId: string;
  ready: boolean;
  /** 멈춘 세션(ready가 false)의 안내. 까닭을 아는 곳(끝난 레인 등)이 넘긴다. 없으면 이어서 작업 안내다(#868) */
  stoppedLabel?: string;
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
  // 나란히 보기에서는 공급자가 연 하나의 통로에서 받는다(없으면 undefined — 이 패널이 자기 통로를 연다)
  const stream = useTerminalStream(sessionId);
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TerminalStatus>({ state: "idle" });
  /** 다른 패널이 넘긴 글을 붙여 넣지 않았을 때 그 까닭. 조용히 버리지 않는다 */
  const [pasteNotice, setPasteNotice] = useState<string>();
  /** 감시가 찾은 위반(관문 파일 변조, 훅 없이 뜬 CLI). 터미널 위에 바로 보이고, 사용자가 닫을 수 있다 */
  const [warning, setWarning] = useState<string>();
  /**
   * 로컬 토큰 없이 부른 403을 받았을 때 터미널 자리에 보이는 안내(ADR-173 덧붙임).
   * `pnpm studio launch`가 연 창(쿠키가 심어진 창)에서만 터미널을 쓸 수 있다는 뜻이다
   */
  const [notice, setNotice] = useState<string>();
  // "다시 열기"가 부를 함수. 터미널을 만든 효과가 채워 둔다
  const reopen = useRef<() => void>(() => {});

  const post = useCallback(
    async (body: Record<string, unknown>): Promise<void> => {
      const response = await fetch(`/api/sessions/${sessionId}/terminal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) {
        const reason = await response.json().then((data: { error?: string }) => data.error, () => undefined);
        // 로컬 토큰이 없어 거절당했으면 그 안내를 터미널 자리에 보인다(열기·입력이 여기로 온다)
        if (response.status === 403) setNotice(reason ?? "터미널은 `pnpm studio launch`가 연 창에서 씁니다. 다른 창이면 launch가 찍은 주소로 여세요");
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

      // 다시 보낸 출력(재연결·구독 직후 처음 받는 출력 묶음)을 그리는 동안에는 xterm의 자동 응답을 입력으로 보내지 않는다.
      // 다시 보낸 질의(장치 속성·커서 위치 등)에 xterm이 답하고 그 답이 입력으로 POST되어 셸에 글자로 들어가는 것을 막는다(실측).
      // 실시간 출력의 질의 응답은 지금처럼 보낸다(CLI가 실제로 묻는 질의에는 답해야 한다)
      let replaying = false;
      let replayWrites = 0;
      let replayBurstEnded = false;
      const endReplayIfDrained = (): void => {
        if (replayBurstEnded && replayWrites === 0) replaying = false;
      };
      /** 다시 보내기를 그리기 시작한다. 출력 묶음 뒤에 오는 상태·cli가 오면 묶음이 끝난 것으로 보고, 그리기가 다 끝나면 실시간으로 돌아간다 */
      const beginReplay = (): void => {
        replaying = true;
        replayWrites = 0;
        replayBurstEnded = false;
      };

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
        // 다시 보내기를 그리는 동안 온 것은 xterm이 다시 보낸 질의에 답한 자동 응답이다(사람이 친 키가 아니다). 입력으로 보내지 않는다
        if (replaying) return;
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
      const onMessage = (message: TerminalStreamMessage): void => {
        // 다시 연결했으니 화면을 비우고 받는다(서버가 최근 출력을 다시 보낸다)
        if (message.kind === "reset") {
          terminal.reset();
          beginReplay();
          return;
        }
        if (message.kind === "data") {
          const bytes = decodeTerminalData(message.data);
          if (replaying) {
            // 다시 보낸 출력은 그리기가 끝난 뒤에 실시간으로 돌아가게, write 콜백으로 그리기 끝을 센다(묶음이 여러 개면 마지막까지)
            replayWrites += 1;
            terminal.write(bytes, () => {
              replayWrites -= 1;
              endReplayIfDrained();
            });
          } else {
            terminal.write(bytes);
          }
          return;
        }
        // 출력 묶음 뒤에 오는 상태·cli 등이 오면 다시 보내기가 끝난 것으로 본다(그리기가 다 끝나면 자동 응답을 다시 보낸다)
        if (replaying) {
          replayBurstEnded = true;
          endReplayIfDrained();
        }
        if (message.kind === "exit") setStatus({ state: "exited", code: message.code });
        else if (message.kind === "cli") {
          cliAlive = message.alive;
          if (message.alive) setPasteNotice(undefined);
        } else if (message.kind === "warning") setWarning(message.message);
        else setStatus({ state: message.state, message: message.message });
      };
      // 공급자가 있으면 그 하나의 통로에서 받는다. 없으면 이 패널이 자기 통로를 연다
      let closeEvents: () => void = () => {};
      if (stream) {
        // 공급자는 구독하는 순간 되보내기 몫(출력·상태·cli)을 먼저 준다. 그것을 다시 보내기로 보고 그리는 동안 응답을 막는다
        beginReplay();
        closeEvents = stream(onMessage);
      } else {
        const events = new EventSource(`/api/sessions/${sessionId}/terminal`);
        // 연결이 끊겼다 다시 붙으면 서버가 최근 출력을 처음부터 다시 준다. 겹쳐 그리지 않게 화면을 비우고 받고, 그리는 동안 응답을 막는다
        events.onopen = () => {
          terminal.reset();
          beginReplay();
        };
        events.onmessage = (event) => onMessage(JSON.parse(event.data as string) as TerminalMessage);
        // 출력 통로도 같은 쿠키가 있어야 열린다. 403 같은 영구 실패면 연결이 곧 닫히고, 바로 뒤의 열기 POST가 같은 사유로 안내를 채운다
        events.onerror = () => {
          if (disposed || events.readyState !== EventSource.CLOSED) return;
          setStatus((current) => (current.state === "open" ? current : { state: "closed" }));
        };
        closeEvents = () => events.close();
      }

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
        closeEvents();
        input.dispose();
        terminal.dispose();
      };
    })();

    return () => {
      disposed = true;
      dispose();
    };
  }, [sessionId, ready, access.canManage, post, acceptDraft, draft, stream]);

  const label = !access.canManage ? "이 세션을 바꿀 수 있는 사람만 터미널을 씁니다" : !ready ? (stoppedLabel ?? "멈춘 세션입니다. 이어서 작업을 누르면 다시 열 수 있습니다") : terminalStatusLabel(status, mode);
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
        {/* 감시가 찾은 위반은 터미널 위에 바로 보이고, 사용자가 닫을 수 있다 */}
        {warning && (
          <p role="alert" className="flex flex-wrap items-center gap-x-2 text-xs text-fail">
            <span>{warning}</span>
            <button type="button" onClick={() => setWarning(undefined)} className="rounded-control border border-line px-1.5 hover:border-ink" aria-label="경고 닫기">
              닫기
            </button>
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
      <div className="relative min-h-0 flex-1 bg-[#0d1117] p-2">
        <div ref={container} className="h-full w-full" />
        {/* 로컬 토큰이 없어 터미널 통로가 403을 돌려줬을 때 그 안내를 터미널 자리에 보인다 */}
        {notice && (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <p role="alert" className="max-w-md rounded-panel border border-line bg-[#0d1117]/95 p-4 text-sm leading-relaxed text-[#e6edf3] shadow-lg">
              {notice}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
