"use client";

import Link from "next/link";
import { useState } from "react";
import type { SessionMode, SessionSnapshot } from "@/lib/studio-events";
import { Dot, SERVICE_STATE_LABEL, SESSION_STATUS_LABEL, TONE_TEXT, toneOfService } from "./status";

const MODE_LABEL: Record<SessionMode, string> = {
  api: "Claude API",
  "claude-code": "로컬 Claude Agent",
  demo: "데모 모드",
};

export function SessionHeader({ snapshot }: { snapshot: SessionSnapshot }) {
  const [stopping, setStopping] = useState(false);

  async function stop() {
    setStopping(true);
    await fetch(`/api/sessions/${snapshot.id}`, { method: "DELETE" });
    setStopping(false);
  }

  const statusTone = snapshot.status === "ready" ? "pass" : snapshot.status === "failed" ? "fail" : snapshot.status === "stopped" ? "idle" : "wait";

  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-panel px-5 py-3">
      <Link href="/" className="font-semibold tracking-tight hover:underline">
        b-studio
      </Link>

      <div className="flex items-baseline gap-2">
        <h1 className="text-lg font-semibold">{snapshot.projectName}</h1>
        <span className={`text-sm ${TONE_TEXT[statusTone]}`}>{SESSION_STATUS_LABEL[snapshot.status]}</span>
      </div>

      <ul className="flex flex-wrap items-center gap-4 text-sm" aria-label="서비스 상태">
        {snapshot.services.map((service) => (
          <li key={service.name} className="flex items-center gap-1.5">
            <Dot tone={toneOfService(service.state)} />
            <span className="font-medium">{service.name}</span>
            <span className="text-muted">{SERVICE_STATE_LABEL[service.state]}</span>
          </li>
        ))}
      </ul>

      <div className="ml-auto flex items-center gap-3">
        <span
          className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
            snapshot.mode === "demo" ? "border-wait/50 text-wait" : "border-line text-muted"
          }`}
          title="에이전트 실행 방식"
        >
          {MODE_LABEL[snapshot.mode]}
        </span>
        {snapshot.status === "stopped" ? (
          <Link href="/" className="text-sm font-medium hover:underline">
            프로젝트 목록
          </Link>
        ) : (
          <button
            type="button"
            onClick={stop}
            disabled={stopping}
            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:border-fail hover:text-fail disabled:opacity-60"
          >
            {stopping ? "중지하는 중" : "샌드박스 중지"}
          </button>
        )}
      </div>

      {snapshot.error && <p className="basis-full text-sm text-fail">{snapshot.error}</p>}
    </header>
  );
}
