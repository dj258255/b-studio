"use client";

import { useEffect, useRef, useState } from "react";
import type { ServiceUsage } from "@b-studio/sandbox";
import type { SessionView } from "@/lib/session-view";
import { appendUsageSample, groupByRole, sparklinePath, type ResourceHistory } from "@/lib/resource-history";
import { currentPhase, endedReason, formatBytes, formatUptime, healthLabel, memoryRatio } from "@/lib/usage";

/** 컨테이너 상태를 점 색으로. 색만으로 상태를 전하지 않도록 옆에 항상 글자를 같이 둔다 */
const STATE_DOT: Record<ServiceUsage["state"], string> = {
  running: "bg-pass",
  restarting: "border-2 border-wait bg-panel motion-safe:animate-pulse",
  created: "border-2 border-wait bg-panel motion-safe:animate-pulse",
  paused: "bg-line",
  removing: "bg-line",
  exited: "bg-line",
  dead: "bg-fail",
  unknown: "bg-line",
};

const HEALTH_TONE: Record<NonNullable<ServiceUsage["health"]>, string> = {
  healthy: "text-pass",
  unhealthy: "text-fail",
  starting: "text-wait",
};

/** 컨테이너별 자원 사용량. 빌드 중인지 멈췄는지, 메모리가 모자라 죽었는지 구분하는 데 쓴다 */
export function ResourcePanel({ view }: { view: SessionView }) {
  const usage = view.snapshot.usage;

  // 최근 N개 샘플을 화면에서만 쌓는다(새로고침하면 비워진다). 첫 렌더에서 바로 한 점이라도 보이도록 초기값을 usage로 채운다
  const [history, setHistory] = useState<ResourceHistory>(() => (usage ? appendUsageSample({}, usage.services, Date.parse(usage.at)) : {}));
  const lastAt = useRef(usage?.at);

  useEffect(() => {
    if (!usage || usage.at === lastAt.current) return;
    lastAt.current = usage.at;
    setHistory((prev) => appendUsageSample(prev, usage.services, Date.parse(usage.at)));
  }, [usage]);

  const off = view.snapshot.status === "stopped" || view.snapshot.status === "idle";
  if (off) {
    return <p className="p-6 text-sm text-muted">샌드박스가 꺼져 있습니다. 켜면 몇 초 안에 컨테이너별 CPU·메모리·네트워크를 보여 줍니다.</p>;
  }
  if (!usage) {
    return <p className="p-6 text-sm text-muted">샌드박스가 준비되면 컨테이너별 CPU와 메모리를 몇 초마다 보여 줍니다.</p>;
  }

  const groups = groupByRole(usage.services);
  const total = usage.services.reduce((sum, service) => sum + (service.memoryBytes ?? 0), 0);

  return (
    <div className="h-full overflow-auto p-4">
      <p className="pb-3 text-sm text-muted">
        컨테이너 {usage.services.length}개, 메모리 합계 {formatBytes(total)}.{" "}
        {new Date(usage.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}에 잼
      </p>
      <div className="flex flex-col gap-6">
        {groups.map((group) => (
          <section key={group.role} aria-label={group.label}>
            <h3 className="pb-2 text-xs font-medium tracking-wide text-muted">
              {group.label} · {group.services.length}개
            </h3>
            <ul className="flex flex-col gap-2">
              {group.services.map((service) => (
                <ContainerRow key={service.service} usage={service} history={history[service.service] ?? []} logs={view.logs} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function ContainerRow({ usage, history, logs }: { usage: ServiceUsage; history: ResourceHistory[string]; logs: SessionView["logs"] }) {
  const ratio = memoryRatio(usage);
  const ended = endedReason(usage);
  const phase = currentPhase(logs, usage.service);
  const health = healthLabel(usage.health);
  const uptime = formatUptime(usage.startedAt);

  return (
    <li className="glass-soft flex flex-wrap items-start gap-x-6 gap-y-2 rounded-control px-3 py-2.5 text-sm">
      <div className="min-w-[9rem]">
        <p className="font-medium">{usage.service}</p>
        {usage.containerName && usage.containerName !== usage.service && <p className="font-mono text-xs text-muted">{usage.containerName}</p>}
      </div>

      <div className="flex min-w-[8rem] items-center gap-1.5">
        <span aria-hidden className={`inline-block size-2.5 shrink-0 rounded-full ${STATE_DOT[usage.state]}`} />
        <span className={ended ? "text-fail" : "text-muted"}>{ended ?? usage.state}</span>
      </div>

      {health && <span className={`min-w-[3.5rem] ${HEALTH_TONE[usage.health!]}`}>{health}</span>}

      <div className="min-w-[7rem]">
        <p className="font-mono text-xs">
          CPU {usage.cpuPercent === undefined ? "-" : `${usage.cpuPercent.toFixed(1)}%`}
          {usage.cpuLimit !== undefined && <span className="text-muted"> / {usage.cpuLimit * 100}%</span>}
        </p>
        <MetricSparkline values={history.map((sample) => sample.cpuPercent)} />
      </div>

      <div className="min-w-[9rem]">
        <p className="font-mono text-xs">
          {formatBytes(usage.memoryBytes)}
          <span className="text-muted">{usage.memoryLimitBytes ? ` / ${formatBytes(usage.memoryLimitBytes)}` : ", 한도 없음"}</span>
        </p>
        {ratio !== undefined && (
          <span
            role="meter"
            aria-label={`${usage.service} 메모리 한도 대비 사용률`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(ratio * 100)}
            className="mt-1 block h-1.5 w-28 rounded-full bg-line"
          >
            <span className={`block h-full rounded-full ${ratio >= 0.9 ? "bg-fail" : ratio >= 0.7 ? "bg-wait" : "bg-pass"}`} style={{ width: `${ratio * 100}%` }} />
          </span>
        )}
        <MetricSparkline values={history.map((sample) => sample.memoryBytes)} />
      </div>

      <div className="min-w-[8rem] font-mono text-xs text-muted" title="컨테이너가 받은/보낸 누적 바이트">
        받음 {formatBytes(usage.networkRxBytes)} · 보냄 {formatBytes(usage.networkTxBytes)}
      </div>

      <div className="min-w-[7rem] text-xs text-muted">
        {uptime && <p>가동 {uptime}</p>}
        {usage.restartCount !== undefined && usage.restartCount > 0 && <p>재시작 {usage.restartCount}회</p>}
      </div>

      {phase && <p className="min-w-[8rem] text-xs text-muted">{phase}</p>}
    </li>
  );
}

/** CPU·메모리를 최근 샘플 기준의 작은 꺾은선으로 보여 준다. 값이 없거나 한 개뿐이면 점으로 보인다 */
function MetricSparkline({ values }: { values: readonly (number | undefined)[] }) {
  const width = 64;
  const height = 20;
  const path = sparklinePath(values, { width, height });
  if (!path) return null;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden className="mt-1 text-muted">
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
