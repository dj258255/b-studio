"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { TerminalMessage } from "@/lib/server/session-terminal";

/**
 * 나란히 보기의 터미널 출력 공급자(B4). 칸마다 통로를 열면 브라우저의 연결 한도(HTTP/1.1에서 주소당 6개)에
 * 걸리므로, 출력용 연결을 하나 열고 받은 메시지를 id별 구독자에게 나눈다. 입력·크기·열기·닫기는 지금처럼 세션별 POST로 보낸다.
 *
 * 묶음 통로는 연결되자마자 최근 출력·상태·cli를 보내는데, 칸의 터미널이 준비되어 구독하기 전에 오면 사라진다.
 * 그래서 id마다 "되보내 줄 몫"을 들고 있다가 새 구독자에게 먼저 준다(서버의 다시 보내기와 같은 규칙·상한)
 */

/** 공급자가 나눠 주는 한 조각. `reset`은 다시 연결했으니 화면을 비우라는 뜻이다(서버가 최근 출력을 다시 보낸다) */
export type TerminalStreamMessage = TerminalMessage | { kind: "reset" };

/** 되보내 줄 출력의 상한. 서버의 REPLAY_BYTES(512KB)와 같은 값 */
const REPLAY_BYTES = 512 * 1024;

type Listener = (message: TerminalStreamMessage) => void;

interface SessionBuffer {
  listeners: Set<Listener>;
  /** 새 구독자에게 먼저 줄 최근 출력(base64)과 그 합(바이트). 서버의 다시 보내기와 같은 상한까지 든다 */
  chunks: Array<{ data: string; bytes: number }>;
  bytes: number;
  /** 새 구독자에게 먼저 줄 마지막 상태·cli. 서버가 구독 직후 보내는 순서와 맞춘다 */
  status?: TerminalMessage;
  cli?: TerminalMessage;
}

const TerminalStreamContext = createContext<TerminalStream | undefined>(undefined);

interface TerminalStream {
  subscribe(sessionId: string, listener: Listener): () => void;
}

function bufferOf(map: Map<string, SessionBuffer>, id: string): SessionBuffer {
  let buffer = map.get(id);
  if (!buffer) {
    buffer = { listeners: new Set(), chunks: [], bytes: 0 };
    map.set(id, buffer);
  }
  return buffer;
}

/** base64 출력의 바이트 수. 서버가 raw 바이트로 세는 것과 맞춘다(정확하지 않아도 상한 판단에는 충분하다) */
function base64Bytes(data: string): number {
  return Math.floor((data.length * 3) / 4);
}

export function TerminalStreamProvider({ ids, children }: { ids: readonly string[]; children: ReactNode }) {
  const registry = useRef(new Map<string, SessionBuffer>());
  const idsKey = ids.join(",");

  const subscribe = useCallback((sessionId: string, listener: Listener) => {
    const buffer = bufferOf(registry.current, sessionId);
    buffer.listeners.add(listener);
    // 서버가 다시 보내는 순서(출력 → 상태 → cli)와 같게, 붙기 전에 온 것을 먼저 준다
    for (const chunk of buffer.chunks) listener({ kind: "data", data: chunk.data });
    if (buffer.status) listener(buffer.status);
    if (buffer.cli) listener(buffer.cli);
    return () => {
      registry.current.get(sessionId)?.listeners.delete(listener);
    };
  }, []);

  const value = useMemo<TerminalStream>(() => ({ subscribe }), [subscribe]);

  useEffect(() => {
    const map = registry.current;
    // 이 통로가 다루지 않는 id의 되보내기 몫은 버린다
    const wanted = new Set(idsKey ? idsKey.split(",") : []);
    for (const id of [...map.keys()]) if (!wanted.has(id)) map.delete(id);
    if (!idsKey) return;

    const deliverAll = (message: TerminalStreamMessage) => {
      for (const buffer of map.values()) for (const listener of buffer.listeners) listener(message);
    };
    const source = new EventSource(`/api/terminals/stream?ids=${encodeURIComponent(idsKey)}`);
    // 처음 열거나 다시 열면 서버가 최근 출력을 처음부터 다시 보낸다. 되보내기 몫을 비우고(reset 뒤 것만 남긴다)
    // 칸의 화면을 비우라는 신호를 보낸다
    source.onopen = () => {
      for (const buffer of map.values()) {
        buffer.chunks = [];
        buffer.bytes = 0;
        buffer.status = undefined;
        buffer.cli = undefined;
      }
      deliverAll({ kind: "reset" });
    };
    source.onmessage = (event) => {
      const parsed = JSON.parse(event.data as string) as { id: string; message: TerminalMessage };
      const buffer = bufferOf(map, parsed.id);
      if (parsed.message.kind === "data") {
        const bytes = base64Bytes(parsed.message.data);
        buffer.chunks.push({ data: parsed.message.data, bytes });
        buffer.bytes += bytes;
        while (buffer.bytes > REPLAY_BYTES && buffer.chunks.length > 1) buffer.bytes -= buffer.chunks.shift()!.bytes;
      } else if (parsed.message.kind === "status") {
        buffer.status = parsed.message;
      } else if (parsed.message.kind === "cli") {
        buffer.cli = parsed.message;
      }
      for (const listener of buffer.listeners) listener(parsed.message);
    };
    // 통로가 영구 실패(403 등)로 닫히면 칸이 "닫힘"을 보이게 한다(열기 POST가 같은 사유로 안내를 채운다)
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) deliverAll({ kind: "status", state: "closed" });
    };
    return () => source.close();
  }, [idsKey]);

  return <TerminalStreamContext.Provider value={value}>{children}</TerminalStreamContext.Provider>;
}

/**
 * 이 세션의 터미널 메시지를 구독하는 함수. 공급자 밖이면 undefined를 돌려주고, 그때는 패널이 자기 통로를 연다.
 * 돌려준 함수는 공급자·세션 id가 그대로면 같은 것이라, 패널을 다시 만들지 않는다
 */
export function useTerminalStream(sessionId: string): ((listener: Listener) => () => void) | undefined {
  const stream = useContext(TerminalStreamContext);
  return useMemo(() => (stream ? (listener: Listener) => stream.subscribe(sessionId, listener) : undefined), [stream, sessionId]);
}
