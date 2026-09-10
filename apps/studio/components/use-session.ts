"use client";

import { useEffect, useReducer } from "react";
import { createView, reduceSession, type SessionView } from "@/lib/session-view";
import type { SessionSnapshot, StudioEvent } from "@/lib/studio-events";

/** 세션 이벤트 스트림을 구독한다. EventSource가 끊기면 스스로 다시 연결하고, 서버가 snapshot부터 다시 보낸다 */
export function useSession(initial: SessionSnapshot): SessionView {
  const [view, dispatch] = useReducer(reduceSession, initial, createView);

  useEffect(() => {
    const source = new EventSource(`/api/sessions/${initial.id}/events`);
    source.onmessage = (message) => dispatch(JSON.parse(message.data) as StudioEvent);
    return () => source.close();
  }, [initial.id]);

  return view;
}
