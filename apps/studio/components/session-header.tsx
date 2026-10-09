"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { supportingContainers } from "@/lib/header-services";
import type { SessionSnapshot } from "@/lib/studio-events";
import { nextSplitIds, readStoredSplitIds, splitHref, storeSplitIds } from "@/lib/split";
import { endedReason, formatBytes } from "@/lib/usage";
import { AgentsBadge } from "./agents-badge";
import { LogoutButton } from "./logout-button";
import { ProjectMenu } from "./project-menu";
import { useSessionAccess } from "./session-access";
import { describeSandboxLink } from "@/lib/sandbox-link";
import { Dot, SERVICE_STATE_LABEL, SESSION_BACKEND_LABEL, SESSION_STATUS_LABEL, TONE_TEXT, toneOfService } from "./status";
import { SupportingServicesChip } from "./supporting-services-chip";

/** 연결이 끊긴 시각을 시:분으로 보여 준다. 해석할 수 없으면 원문 그대로 */
function sinceLabel(since: string): string {
  const at = new Date(since);
  return Number.isNaN(at.getTime()) ? since : at.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Docker 런타임 이름(runsc)과 Kubernetes RuntimeClass 이름(gvisor) */
const GVISOR_RUNTIMES = new Set(["runsc", "gvisor"]);

export function SessionHeader({ snapshot }: { snapshot: SessionSnapshot }) {
  const [stopping, setStopping] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string>();
  const access = useSessionAccess();
  const router = useRouter();

  /** 최근에 나란히 본 세션들(localStorage)에 이 세션을 붙여 /split으로 간다. 저장소 접근은 실패해도 무시한다 */
  function addToSplit() {
    const storage = typeof window === "undefined" ? undefined : window.localStorage;
    const ids = nextSplitIds(readStoredSplitIds(storage), snapshot.id);
    storeSplitIds(storage, ids);
    router.push(splitHref(ids));
  }

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

  // 샌드박스에 닿지 않거나 컨테이너가 사라졌으면 "준비됨"이라고 하지 않는다. 서비스 상태도 마지막으로 본 값일 뿐이다(트러블슈팅 123)
  const link = snapshot.status === "ready" ? snapshot.sandboxLink : undefined;
  /**
   * 컨테이너가 사라진 세션을 다시 올린다. 서버는 중지한 세션만 이어서 작업하게 하므로(남은 샌드박스를 먼저 정리해야 한다)
   * 중지한 뒤에 이어서 작업을 부른다. 중지가 끝나야 다음으로 간다
   */
  async function reboot() {
    setResuming(true);
    setResumeError(undefined);
    const stopped = await fetch(`/api/sessions/${snapshot.id}`, { method: "DELETE" });
    if (!stopped.ok) {
      setResumeError((await stopped.json().catch(() => ({}))).error ?? "샌드박스를 정리하지 못했습니다");
      setResuming(false);
      return;
    }
    const response = await fetch(`/api/sessions/${snapshot.id}/resume`, { method: "POST" });
    if (!response.ok) setResumeError((await response.json().catch(() => ({}))).error ?? "샌드박스를 다시 올리지 못했습니다");
    setResuming(false);
  }

  const statusTone = link ? "fail" : snapshot.status === "ready" ? "pass" : snapshot.status === "failed" ? "fail" : snapshot.status === "stopped" ? "idle" : "wait";
  // 관리형 서비스(studio.yaml)는 줄로 하나하나 보여주고, 그 밖의 컨테이너(DB 등 부가 서비스·edge 플랫폼, ADR-073)는 칩 하나로 압축한다
  const managedNames = new Set(snapshot.services.map((service) => service.name));
  const supporting = supportingContainers(managedNames, snapshot.usage?.services);

  return (
    <header className="glass flex flex-wrap items-center gap-x-6 gap-y-2 rounded-panel px-5 py-3">
      {/* 이 화면이 곧 첫 화면(개발 화면)이다(ADR-066). 로고는 그 첫 화면(마지막 프로젝트)으로 간다 */}
      <Link href="/" className="font-semibold tracking-tight hover:underline" title="첫 화면(마지막 프로젝트의 개발 화면)">
        b-studio
      </Link>

      <div className="flex items-baseline gap-2">
        {/* 프로젝트 이름을 누르면 다른 프로젝트로 바꾸거나 폴더를 열거나 새 대화를 시작하는 메뉴가 열린다(ADR-070) */}
        <h1 className="text-lg font-semibold">
          <ProjectMenu projectId={snapshot.projectId} projectName={snapshot.projectName} />
        </h1>
        <span className={`text-sm ${TONE_TEXT[statusTone]}`}>{link ? describeSandboxLink(link) : SESSION_STATUS_LABEL[snapshot.status]}</span>
      </div>

      <ul className="flex flex-wrap items-center gap-4 text-sm" aria-label="서비스 상태">
        {snapshot.services.map((service) => {
          const usage = snapshot.usage?.services.find((candidate) => candidate.service === service.name);
          const ended = usage && endedReason(usage);
          return (
            <li key={service.name} className="flex items-center gap-1.5">
              {/* 꺼 둔 서비스는 컨테이너가 없는 것이 정상이라 그대로 "꺼 둠"이다 */}
              <Dot tone={link && service.state !== "off" ? "idle" : toneOfService(service.state)} />
              <span className="font-medium">{service.name}</span>
              <span className="text-muted">{link && service.state !== "off" ? "확인 불가" : SERVICE_STATE_LABEL[service.state]}</span>
              {/* 중지된 서비스에 마지막으로 잰 사용량을 남기면 아직 자원을 쓰는 것처럼 보인다 */}
              {!link && service.state !== "stopped" && usage?.memoryBytes !== undefined && (
                <span className="font-mono text-xs text-muted" title="메모리 사용량 / 한도">
                  {formatBytes(usage.memoryBytes)}
                  {usage.memoryLimitBytes ? ` / ${formatBytes(usage.memoryLimitBytes)}` : ""}
                </span>
              )}
              {ended && usage?.oomKilled && <span className="text-xs text-fail">메모리 부족으로 종료</span>}
            </li>
          );
        })}
        <li>
          <SupportingServicesChip sessionId={snapshot.id} services={supporting} />
        </li>
      </ul>

      <div className="ml-auto flex items-center gap-3">
        <AgentsBadge />
        {access.viewer && (
          <span className="text-xs text-muted">
            {access.viewer}
            {!access.canManage && <span className="ml-1.5 text-wait">읽기 전용, 만든 사람 {access.owner ?? "기록 없음"}</span>}
          </span>
        )}
        {access.canLogout && <LogoutButton />}
        {snapshot.workspace === "local" && (
          <span className="glass-soft rounded-full px-2.5 py-0.5 text-xs font-medium text-muted" title={`${snapshot.workDir}에서 바로 작업합니다`}>
            내 폴더
          </span>
        )}
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
          className={`glass-soft rounded-full px-2.5 py-0.5 text-xs font-medium ${(snapshot.backend ?? snapshot.mode) === "demo" ? "text-wait" : "text-muted"}`}
          title="에이전트 실행 방식"
        >
          {SESSION_BACKEND_LABEL[snapshot.backend ?? snapshot.mode]}
        </span>
        <button type="button" onClick={addToSplit} className="glass-soft rounded-control px-4 py-1.5 text-sm font-medium hover:bg-panel">
          나란히 보기에 추가
        </button>
        {/* 닿지 않을 때는 다시 올릴 수도 없다. 도커가 돌아오면 저절로 풀린다 */}
        {link?.state === "missing" && (
          <button
            type="button"
            onClick={reboot}
            disabled={resuming || !access.canManage}
            className="rounded-control bg-ink px-4 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-60"
          >
            {resuming ? "샌드박스 다시 올리는 중" : "샌드박스 다시 올리기"}
          </button>
        )}
        {snapshot.status === "stopped" ? (
          <button
            type="button"
            onClick={resume}
            disabled={resuming || !access.canManage}
            className="rounded-control bg-ink px-4 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-60"
          >
            {resuming ? "새 샌드박스 만드는 중" : "이어서 작업"}
          </button>
        ) : (
          <button
            type="button"
            onClick={stop}
            disabled={stopping || !access.canManage}
            className="glass-soft rounded-control px-4 py-1.5 text-sm font-medium hover:text-fail disabled:opacity-60"
          >
            {stopping ? "중지하는 중" : "샌드박스 중지"}
          </button>
        )}
      </div>

      {link && (
        <p role="status" className="basis-full text-sm text-fail">
          {link.state === "unreachable"
            ? `도커에 물어도 답을 받지 못하고 있습니다(${sinceLabel(link.since)}부터). 아래 서비스 상태와 사용량은 마지막으로 본 값입니다. 도커가 돌아오면 저절로 풀립니다.`
            : `도커는 답하는데 이 세션의 컨테이너가 하나도 없습니다(${sinceLabel(link.since)}부터). 도커를 다시 띄웠다면 "샌드박스 다시 올리기"를 누르세요. 작업 복사본과 체크포인트는 그대로입니다.`}
          {link.state === "unreachable" && <span className="ml-1 text-muted">사유: {link.reason}</span>}
        </p>
      )}
      {snapshot.error && (
        <p className={`basis-full text-sm ${snapshot.status === "stopped" ? "text-muted" : "text-fail"}`}>{snapshot.error}</p>
      )}
      {resumeError && <p className="basis-full text-sm text-fail">{resumeError}</p>}
    </header>
  );
}
