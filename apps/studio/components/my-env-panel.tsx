"use client";

import { useEffect, useRef, useState } from "react";
import type { SessionView } from "@/lib/session-view";
import { formatBytes } from "@/lib/usage";

interface MyEnvComposeService {
  containerId: string;
  service: string;
  containerName: string;
  state: string;
  health?: "healthy" | "unhealthy" | "starting";
  ports: Array<{ containerPort: number; protocol: string; hostPort?: number; url?: string }>;
  cpuPercent?: number;
  memoryBytes?: number;
}

interface MyEnvComposeGroup {
  project: string;
  workingDir: string;
  matchReason: string;
  services: MyEnvComposeService[];
}

interface MyEnvHostProcess {
  port: number;
  pid: number;
  command: string;
  cpuPercent?: number;
  rssBytes?: number;
  actuator?: { connected: boolean; logfileAvailable: boolean; guidance?: string; logExcerpt?: string };
}

interface MyEnvSnapshot {
  generatedAt: string;
  projectRoot: string;
  dockerAvailable: boolean;
  composeGroups: MyEnvComposeGroup[];
  hostProcesses: MyEnvHostProcess[];
}

const POLL_MS = 4_000;

const STATE_DOT: Record<string, string> = {
  running: "bg-pass",
  restarting: "border-2 border-wait bg-panel motion-safe:animate-pulse",
  created: "border-2 border-wait bg-panel motion-safe:animate-pulse",
  paused: "bg-line",
  removing: "bg-line",
  exited: "bg-line",
  dead: "bg-fail",
  unknown: "bg-line",
};

const HEALTH_TONE: Record<string, string> = { healthy: "text-pass", unhealthy: "text-fail", starting: "text-wait" };
const HEALTH_LABEL: Record<string, string> = { healthy: "정상", unhealthy: "불량", starting: "점검 중" };

/**
 * "내 환경" 하위 탭(실행 탭, 읽기 전용 관찰). 사용자가 이 프로젝트 폴더에서 직접 docker compose up으로 띄운
 * 컨테이너와, studio.yaml이 선언한 포트에서 듣고 있는 호스트 프로세스를 보여 준다. b-studio의 검증 게이트·
 * 체크포인트와는 무관하다 — 여기서는 아무것도 재시작하거나 검증하지 않는다(조사 보고서의 "관찰은 하되 제어는
 * 안 한다" 원칙, .claude/research/reports/에이전트 검증 화면과 컨테이너 자동 감지.md).
 */
export function MyEnvPanel({ view }: { view: SessionView }) {
  const [state, setState] = useState<{ data?: MyEnvSnapshot; error?: string }>();

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const response = await fetch(`/api/sessions/${view.snapshot.id}/my-env`);
        const data = await response.json();
        if (!cancelled) setState(response.ok ? { data } : { error: data.error ?? "불러오지 못했습니다" });
      } catch (reason) {
        if (!cancelled) setState({ error: String(reason) });
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [view.snapshot.id]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="border-b border-line px-4 py-3">
        <h3 className="font-semibold">내 환경</h3>
        <p className="mt-0.5 max-w-[70ch] text-sm leading-6 text-muted">
          이 PC에서 직접 띄운 서비스입니다. b-studio는 보기만 하고 재시작·검증하지 않습니다 — 검증 게이트·체크포인트와는 무관합니다.
        </p>
      </div>

      {state?.error && <p className="px-4 py-3 text-sm text-fail">{state.error}</p>}
      {!state && <p className="px-4 py-3 text-sm text-muted">둘러보는 중</p>}

      {state?.data && (
        <div className="flex flex-col gap-6 px-4 py-3">
          <section aria-label="직접 띄운 compose 프로젝트">
            <h4 className="pb-2 text-xs font-medium tracking-wide text-muted">도커 compose 프로젝트</h4>
            {!state.data.dockerAvailable && <p className="text-sm text-muted">Docker에 닿지 못했습니다(Colima·Docker Desktop이 꺼져 있을 수 있습니다).</p>}
            {state.data.dockerAvailable && state.data.composeGroups.length === 0 && (
              <p className="text-sm text-muted">이 프로젝트 폴더에서 직접 띄운 compose 프로젝트를 찾지 못했습니다.</p>
            )}
            <div className="flex flex-col gap-4">
              {state.data.composeGroups.map((group) => (
                <ComposeGroupCard key={group.project} group={group} sessionId={view.snapshot.id} />
              ))}
            </div>
          </section>

          <section aria-label="호스트에서 직접 뜬 프로세스">
            <h4 className="pb-2 text-xs font-medium tracking-wide text-muted">도커 밖에서 도는 서비스</h4>
            {state.data.hostProcesses.length === 0 && (
              <p className="text-sm text-muted">studio.yaml이 선언한 포트에서 듣고 있는 호스트 프로세스를 찾지 못했습니다.</p>
            )}
            <ul className="flex flex-col gap-2">
              {state.data.hostProcesses.map((process) => (
                <HostProcessRow key={process.port} process={process} sessionId={view.snapshot.id} />
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

function ComposeGroupCard({ group, sessionId }: { group: MyEnvComposeGroup; sessionId: string }) {
  return (
    <div className="glass-soft rounded-control px-3 py-2.5">
      <p className="text-sm font-medium">{group.project}</p>
      <p className="text-xs text-muted">{group.matchReason}</p>
      <ul className="mt-2 flex flex-col gap-2">
        {group.services.map((service) => (
          <ComposeServiceRow key={service.containerId} sessionId={sessionId} service={service} />
        ))}
      </ul>
    </div>
  );
}

function ComposeServiceRow({ sessionId, service }: { sessionId: string; service: MyEnvComposeService }) {
  const [following, setFollowing] = useState(false);
  return (
    <li className="flex flex-col gap-1.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="min-w-[8rem] font-medium">{service.service}</span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className={`inline-block size-2.5 shrink-0 rounded-full ${STATE_DOT[service.state] ?? STATE_DOT.unknown}`} />
          <span className="text-muted">{service.state}</span>
        </span>
        {service.health && <span className={HEALTH_TONE[service.health]}>{HEALTH_LABEL[service.health]}</span>}
        <span className="font-mono text-xs">
          CPU {service.cpuPercent === undefined ? "-" : `${service.cpuPercent.toFixed(1)}%`} · 메모리 {formatBytes(service.memoryBytes)}
        </span>
        {service.ports.map((port) => (
          <a key={port.containerPort} href={port.url} target="_blank" rel="noreferrer" className="font-mono text-xs underline underline-offset-2">
            {port.url}
          </a>
        ))}
        <button type="button" onClick={() => setFollowing((value) => !value)} className="ml-auto rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
          {following ? "로그 닫기" : "로그 보기"}
        </button>
      </div>
      {following && <ContainerLogTail sessionId={sessionId} containerId={service.containerId} />}
    </li>
  );
}

/** 선택한 컨테이너 하나의 로그를 tail 200 + follow로 받는다(SSE) */
function ContainerLogTail({ sessionId, containerId }: { sessionId: string; containerId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const source = new EventSource(`/api/sessions/${sessionId}/my-env/logs?container=${encodeURIComponent(containerId)}`);
    source.onmessage = (event) => {
      try {
        const { text } = JSON.parse(event.data) as { text: string };
        setLines((prev) => [...prev.slice(-500), text]);
      } catch {
        // 핑(heartbeat) 줄 등은 조용히 무시한다
      }
    };
    return () => source.close();
  }, [sessionId, containerId]);

  useEffect(() => {
    const element = ref.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines]);

  return (
    <pre ref={ref} className="max-h-48 overflow-auto rounded-md border border-line bg-ground px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
      {lines.length === 0 ? "로그를 기다리는 중" : lines.join("\n")}
    </pre>
  );
}

function HostProcessRow({ process, sessionId }: { process: MyEnvHostProcess; sessionId: string }) {
  const [showLog, setShowLog] = useState(false);
  const [excerpt, setExcerpt] = useState<string>();

  async function loadLog() {
    setShowLog(true);
    if (process.actuator?.logfileAvailable) {
      const response = await fetch(`/api/sessions/${sessionId}/my-env/host-log?port=${process.port}`);
      const data = (await response.json().catch(() => ({}))) as { logExcerpt?: string };
      setExcerpt(data.logExcerpt);
    }
  }

  return (
    <li className="glass-soft flex flex-col gap-1.5 rounded-control px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="min-w-[4rem] font-mono">:{process.port}</span>
        <span className="min-w-[4rem] text-muted">pid {process.pid}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={process.command}>
          {process.command}
        </span>
        <span className="font-mono text-xs text-muted">
          CPU {process.cpuPercent === undefined ? "-" : `${process.cpuPercent.toFixed(1)}%`} · 메모리 {formatBytes(process.rssBytes)}
        </span>
        {process.actuator?.connected && <span className="text-pass">Actuator 연결됨</span>}
        <button type="button" onClick={() => void loadLog()} className="ml-auto rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
          {showLog ? "닫기" : "로그 보기"}
        </button>
      </div>
      {showLog && (
        <div className="rounded-md border border-line bg-ground px-3 py-2 text-xs leading-5">
          {process.actuator?.logfileAvailable ? (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono">{excerpt ?? "불러오는 중"}</pre>
          ) : (
            <p className="text-muted">{process.actuator?.guidance ?? "로그를 자동으로 가져올 수 없습니다."}</p>
          )}
        </div>
      )}
    </li>
  );
}
