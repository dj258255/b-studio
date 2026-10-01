"use client";

import { useEffect, useState } from "react";
import type { SessionView } from "@/lib/session-view";

interface ProjectStatusViewData {
  currentWork: { summary: string; items: string[] };
  purpose: { items: Array<{ id: string; title: string; issue?: number }> };
  eta: { hasEstimate: boolean; summary: string };
  deliverables: { checkpoints: Array<{ shortSha: string; message: string; createdAt: string }>; pullRequestUrl?: string };
  risks: { items: string[] };
  verification: { summary: string; byStatus: Record<string, number> };
  estimateVsActual: Array<{ id: string; label: string; estimateMinutes?: number; actualMinutes?: number; deltaMinutes?: number; note?: string }>;
  links: { roadmap: string; changelog: string; docsIndex: string };
}

/**
 * "현황" 탭(ADR-0XX). 세션·요구사항·체크포인트를 새로 재지 않고 있는 그대로 다시 모아 "지금 어디까지
 * 왔는가"를 한 화면에서 읽을 수 있게 한다 — 범수 님이 쓴 평가 기준의 "지금 하는 일/목적/예상 완료/결과물/
 * 위험·불확실성/검증 기록/예상 vs 실제"를 그대로 절로 나눈다. 쓰기는 하지 않는다(읽기 전용 집계).
 */
export function StatusPanel({ view }: { view: SessionView }) {
  const sessionId = view.snapshot.id;
  const [status, setStatus] = useState<{ data?: ProjectStatusViewData; error?: string }>();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/status`)
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as Partial<ProjectStatusViewData> & { error?: string };
        if (cancelled) return;
        if (!response.ok) {
          setStatus({ error: data.error ?? "현황을 불러오지 못했습니다" });
          return;
        }
        setStatus({ data: data as ProjectStatusViewData });
      })
      .catch(() => {
        if (!cancelled) setStatus({ error: "현황을 불러오지 못했습니다" });
      });
    return () => {
      cancelled = true;
    };
    // view.completedRuns가 늘어나면(요청이 끝날 때마다) 다시 불러온다 — 지금 하는 일·결과물이 바뀔 수 있다
  }, [sessionId, view.completedRuns]);

  if (!status) return <p className="px-4 py-3 text-sm text-muted">불러오는 중</p>;
  if (status.error) return <p className="px-4 py-3 text-sm text-fail">{status.error}</p>;
  const data = status.data!;

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Section title="지금 하는 일">
          <p className="text-sm">{data.currentWork.summary}</p>
          {data.currentWork.items.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-sm text-muted">
              {data.currentWork.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="목적(요구사항)">
          {data.purpose.items.length === 0 ? (
            <p className="text-sm text-muted">연결된 필수·권장 요구사항이 없습니다.</p>
          ) : (
            <ul className="space-y-0.5 text-sm">
              {data.purpose.items.map((item) => (
                <li key={item.id}>
                  [{item.id}] {item.title}
                  {item.issue !== undefined && <span className="text-muted"> (#{item.issue})</span>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="예상 완료">
          <p className={`text-sm ${data.eta.hasEstimate ? "" : "text-muted"}`}>{data.eta.summary}</p>
        </Section>

        <Section title="결과물">
          {data.deliverables.pullRequestUrl && (
            <p className="text-sm">
              PR:{" "}
              <a href={data.deliverables.pullRequestUrl} target="_blank" rel="noreferrer" className="underline">
                {data.deliverables.pullRequestUrl}
              </a>
            </p>
          )}
          {data.deliverables.checkpoints.length === 0 ? (
            <p className="text-sm text-muted">아직 체크포인트가 없습니다.</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-sm">
              {data.deliverables.checkpoints.map((checkpoint) => (
                <li key={checkpoint.shortSha} className="truncate">
                  <span className="font-mono text-xs text-muted">{checkpoint.shortSha}</span> {checkpoint.message}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="위험·불확실성">
          {data.risks.items.length === 0 ? (
            <p className="text-sm text-muted">지금까지 알려진 위험이 없습니다.</p>
          ) : (
            <ul className="list-inside list-disc space-y-0.5 text-sm text-wait">
              {data.risks.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="검증 기록">
          <p className="text-sm">{data.verification.summary}</p>
          {Object.keys(data.verification.byStatus).length > 0 && (
            <ul className="mt-1 text-sm text-muted">
              {Object.entries(data.verification.byStatus).map(([key, count]) => (
                <li key={key}>
                  {key}: {count}개
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="예상 vs 실제">
        {data.estimateVsActual.length === 0 ? (
          <p className="text-sm text-muted">예상 시간을 적은 작업이 없습니다. 작업마다 예상 시간을 적으면 여기서 실제와 비교할 수 있습니다.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1 pr-3">작업</th>
                <th className="py-1 pr-3">예상(분)</th>
                <th className="py-1 pr-3">실제(분)</th>
                <th className="py-1 pr-3">차이</th>
                <th className="py-1">왜 달랐는지</th>
              </tr>
            </thead>
            <tbody>
              {data.estimateVsActual.map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className="py-1 pr-3">{row.label}</td>
                  <td className="py-1 pr-3">{row.estimateMinutes ?? "—"}</td>
                  <td className="py-1 pr-3">{row.actualMinutes ?? "—"}</td>
                  <td className="py-1 pr-3">{row.deltaMinutes !== undefined ? (row.deltaMinutes > 0 ? `+${row.deltaMinutes}` : row.deltaMinutes) : "—"}</td>
                  <td className="py-1 text-muted">{row.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="문서">
        <ul className="text-sm">
          <li>로드맵: {data.links.roadmap}</li>
          <li>변경 기록: {data.links.changelog}</li>
          <li>문서 색인: {data.links.docsIndex}</li>
        </ul>
        <p className="mt-1 text-xs text-muted">&ldquo;문서&rdquo; 탭에서 위 경로를 열어 볼 수 있습니다.</p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-panel border border-line bg-panel p-3">
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}
