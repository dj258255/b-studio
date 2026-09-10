"use client";

import { useEffect, useRef, useState } from "react";
import type { LogEntry } from "@/lib/session-view";

const ALL = "all";

export function LogPanel({ logs, services }: { logs: LogEntry[]; services: string[] }) {
  const [filter, setFilter] = useState(ALL);
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLPreElement>(null);
  const visible = filter === ALL ? logs : logs.filter((log) => log.service === filter);
  const names = [...new Set([...services, ...logs.map((log) => log.service)])];

  useEffect(() => {
    const element = scrollRef.current;
    if (follow && element) element.scrollTop = element.scrollHeight;
  }, [visible, follow]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-line bg-panel px-3 py-2" role="group" aria-label="서비스별 로그">
        {[ALL, ...names].map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={filter === name}
            onClick={() => setFilter(name)}
            className={`rounded px-2.5 py-1 text-sm ${filter === name ? "bg-ink text-panel" : "text-muted hover:text-ink"}`}
          >
            {name === ALL ? "전체" : name}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} className="accent-ink" />
          최신 로그 따라가기
        </label>
      </div>
      <pre ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-panel px-4 py-3 font-mono text-xs leading-5">
        {visible.length === 0 ? (
          <span className="text-muted">아직 로그가 없습니다.</span>
        ) : (
          visible.map((log, index) => (
            <div key={index} className="whitespace-pre-wrap break-all">
              <span className="text-muted">{log.service.padEnd(8)}</span>
              {log.text}
            </div>
          ))
        )}
      </pre>
    </div>
  );
}
