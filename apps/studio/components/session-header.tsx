"use client";

import Link from "next/link";
import { useState } from "react";
import type { SessionMode, SessionSnapshot } from "@/lib/studio-events";
import { endedReason, formatBytes } from "@/lib/usage";
import { LogoutButton } from "./logout-button";
import { useSessionAccess } from "./session-access";
import { Dot, SERVICE_STATE_LABEL, SESSION_STATUS_LABEL, TONE_TEXT, toneOfService } from "./status";

const MODE_LABEL: Record<SessionMode, string> = {
  api: "Claude API",
  "claude-code": "로컬 Claude Agent",
  demo: "데모 모드",
};

/** Docker 런타임 이름(runsc)과 Kubernetes RuntimeClass 이름(gvisor) */
const GVISOR_RUNTIMES = new Set(["runsc", "gvisor"]);

export function SessionHeader({ snapshot }: { snapshot: SessionSnapshot }) {
  const [stopping, setStopping] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string>();
  const access = useSessionAccess();

  async function stop() {
    setStopping(true);
    await fetch(`/api/sessions/${snapshot.id}`, { method: "DELETE" });
    setStopping(false);
  }

  /** 새 상태는 이벤트 스트림으로 온다 */
  async function resume() {
    setResuming(true);
    setResumeError(undefined);
    const response = await fetch(`/api/sessions/${snapshot.id}/resume`, { method: "POST" });
    if (!response.ok) setResumeError((await response.json()).error ?? "이어서 작업하지 못했습니다");
    setResuming(false);
  }

  const statusTone = snapshot.status === "ready" ? "pass" : snapshot.status === "failed" ? "fail" : snapshot.status === "stopped" ? "idle" : "wait";

  return (
    <header className="glass flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl px-5 py-3">
      <Link href="/" className="font-semibold tracking-tight hover:underline">
        b-studio
      </Link>

      <div className="flex items-baseline gap-2">
        <h1 className="text-lg font-semibold">{snapshot.projectName}</h1>
        <span className={`text-sm ${TONE_TEXT[statusTone]}`}>{SESSION_STATUS_LABEL[snapshot.status]}</span>
      </div>

      <ul className="flex flex-wrap items-center gap-4 text-sm" aria-label="서비스 상태">
        {snapshot.services.map((service) => {
          const usage = snapshot.usage?.services.find((candidate) => candidate.service === service.name);
          const ended = usage && endedReason(usage);
          return (
            <li key={service.name} className="flex items-center gap-1.5">
              <Dot tone={toneOfService(service.state)} />
              <span className="font-medium">{service.name}</span>
              <span className="text-muted">{SERVICE_STATE_LABEL[service.state]}</span>
              {/* 중지된 서비스에 마지막으로 잰 사용량을 남기면 아직 자원을 쓰는 것처럼 보인다 */}
              {service.state !== "stopped" && usage?.memoryBytes !== undefined && (
                <span className="font-mono text-xs text-muted" title="메모리 사용량 / 한도">
                  {formatBytes(usage.memoryBytes)}
                  {usage.memoryLimitBytes ? ` / ${formatBytes(usage.memoryLimitBytes)}` : ""}
                </span>
              )}
              {ended && usage?.oomKilled && <span className="text-xs text-fail">메모리 부족으로 종료</span>}
            </li>
          );
        })}
      </ul>

      <div className="ml-auto flex items-center gap-3">
        {access.viewer && (
          <span className="text-xs text-muted">
            {access.viewer}
            {!access.canManage && <span className="ml-1.5 text-wait">읽기 전용, 만든 사람 {access.owner ?? "기록 없음"}</span>}
          </span>
        )}
        {access.canLogout && <LogoutButton />}
        {snapshot.runtime && (
          <span
            className="glass-soft rounded-full px-2.5 py-0.5 text-xs font-medium text-muted"
            title={
              GVISOR_RUNTIMES.has(snapshot.runtime)
                ? "gVisor로 격리했습니다. 파일 변경 알림이 오지 않아 미리보기는 요청이 끝나고 서비스를 다시 띄울 때 바뀝니다"
                : `컨테이너 런타임: ${snapshot.runtime}`
            }
          >
            {GVISOR_RUNTIMES.has(snapshot.runtime) ? "gVisor 격리" : `런타임 ${snapshot.runtime}`}
          </span>
        )}
        <span
          className={`glass-soft rounded-full px-2.5 py-0.5 text-xs font-medium ${snapshot.mode === "demo" ? "text-wait" : "text-muted"}`}
          title="에이전트 실행 방식"
        >
          {MODE_LABEL[snapshot.mode]}
        </span>
        {snapshot.status === "stopped" ? (
          <>
            <Link href="/" className="text-sm font-medium hover:underline">
              프로젝트 목록
            </Link>
            <button
              type="button"
              onClick={resume}
              disabled={resuming || !access.canManage}
              className="rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-panel shadow-sm hover:bg-ink/85 disabled:opacity-60"
            >
              {resuming ? "새 샌드박스 만드는 중" : "이어서 작업"}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={stop}
            disabled={stopping || !access.canManage}
            className="glass-soft rounded-full px-4 py-1.5 text-sm font-medium hover:text-fail disabled:opacity-60"
          >
            {stopping ? "중지하는 중" : "샌드박스 중지"}
          </button>
        )}
      </div>

      {snapshot.error && (
        <p className={`basis-full text-sm ${snapshot.status === "stopped" ? "text-muted" : "text-fail"}`}>{snapshot.error}</p>
      )}
      {resumeError && <p className="basis-full text-sm text-fail">{resumeError}</p>}
    </header>
  );
}
