"use client";

import { useEffect, useRef, useState } from "react";

/** 서버가 프레임 채널로 보내는 한 장. 서버 형태(lib/server/live-frames.ts)와 맞춘다 */
export interface LiveFrame {
  source: "qa" | "remote";
  check?: string;
  mime: string;
  data: string;
  width: number;
  height: number;
  at: number;
}

/** 원격 브라우저가 허용하지 않은 출처로 나가려던 요청을 막은 수 */
export interface BlockedStatus {
  kind: "blocked";
  count: number;
}

/**
 * 세션의 실시간 프레임 채널을 구독한다. 화면 확인(QA)과 원격 브라우저 프레임이 같은 채널로 오므로 source별 마지막 한 장을 들고 있는다.
 * 원격 브라우저가 막은 요청 수(blocked)도 같은 채널로 온다.
 * EventSource가 끊기면 스스로 다시 연결하고, 서버가 마지막 상태를 곧바로 보내 화면이 빈 채로 뜨지 않는다.
 * onLiveFrame은 프레임이 올 때마다 불린다(화면 확인이 시작되면 QA 보기로 넘기는 데 쓴다)
 */
export function useLiveFrames(sessionId: string, onLiveFrame?: (frame: LiveFrame) => void): { qa?: LiveFrame; remote?: LiveFrame; blocked?: number } {
  const [frames, setFrames] = useState<{ qa?: LiveFrame; remote?: LiveFrame }>({});
  const [blocked, setBlocked] = useState<number>();
  const callback = useRef(onLiveFrame);

  useEffect(() => {
    callback.current = onLiveFrame;
  });

  useEffect(() => {
    const source = new EventSource(`/api/sessions/${sessionId}/frames`);
    source.onmessage = (message) => {
      const parsed = JSON.parse(message.data) as LiveFrame | BlockedStatus;
      if ("kind" in parsed) {
        setBlocked(parsed.count);
        return;
      }
      setFrames((previous) => ({ ...previous, [parsed.source]: parsed }));
      callback.current?.(parsed);
    };
    return () => source.close();
  }, [sessionId]);

  return { qa: frames.qa, remote: frames.remote, blocked };
}
