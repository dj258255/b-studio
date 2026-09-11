"use client";

import type { SessionView } from "@/lib/session-view";
import { currentPhase, endedReason, formatBytes, memoryRatio } from "@/lib/usage";

/** 컨테이너별 자원 사용량. 빌드 중인지 멈췄는지, 메모리가 모자라 죽었는지 구분하는 데 쓴다 */
export function ResourcePanel({ view }: { view: SessionView }) {
  const usage = view.snapshot.usage;

  if (!usage) {
    return <p className="p-6 text-sm text-muted">샌드박스가 준비되면 컨테이너별 CPU와 메모리를 몇 초마다 보여 줍니다.</p>;
  }

  const total = usage.services.reduce((sum, service) => sum + (service.memoryBytes ?? 0), 0);

  return (
    <div className="h-full overflow-auto p-4">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <caption className="pb-3 text-left text-muted">
            컨테이너 {usage.services.length}개, 메모리 합계 {formatBytes(total)}.{" "}
            {new Date(usage.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}에 잼
          </caption>
          <thead className="border-b border-line text-muted">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">서비스</th>
              <th scope="col" className="py-2 pr-4 font-medium">상태</th>
              <th scope="col" className="py-2 pr-4 font-medium">CPU</th>
              <th scope="col" className="py-2 pr-4 font-medium">메모리</th>
              <th scope="col" className="py-2 font-medium">최근 단계</th>
            </tr>
          </thead>
          <tbody>
            {usage.services.map((service) => {
              const ratio = memoryRatio(service);
              const ended = endedReason(service);
              const phase = currentPhase(view.logs, service.service);
              return (
                <tr key={service.service} className="border-b border-line/60 align-top">
                  <th scope="row" className="py-2.5 pr-4 font-medium">{service.service}</th>
                  <td className={`py-2.5 pr-4 ${ended ? "text-fail" : "text-muted"}`}>{ended ?? service.state}</td>
                  <td className="py-2.5 pr-4 font-mono text-xs">
                    {service.cpuPercent === undefined ? "-" : `${service.cpuPercent.toFixed(1)}%`}
                    {service.cpuLimit !== undefined && <span className="text-muted"> / {service.cpuLimit * 100}%</span>}
                  </td>
                  <td className="py-2.5 pr-4">
                    <span className="font-mono text-xs">
                      {formatBytes(service.memoryBytes)}
                      <span className="text-muted">{service.memoryLimitBytes ? ` / ${formatBytes(service.memoryLimitBytes)}` : ", 한도 없음"}</span>
                    </span>
                    {ratio !== undefined && (
                      <span
                        role="meter"
                        aria-label={`${service.service} 메모리 한도 대비 사용률`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(ratio * 100)}
                        className="mt-1 block h-1.5 w-32 rounded-full bg-line"
                      >
                        <span className={`block h-full rounded-full ${ratio >= 0.9 ? "bg-fail" : ratio >= 0.7 ? "bg-wait" : "bg-pass"}`} style={{ width: `${ratio * 100}%` }} />
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 text-muted">{phase ?? "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
