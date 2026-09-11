"use client";

import { useState } from "react";
import type { SessionView } from "@/lib/session-view";
import type { ExternalApiView, ServiceView } from "@/lib/studio-events";
import { ApiExplorer } from "./api-explorer";
import { HistoryPanel } from "./history-panel";
import { LogPanel } from "./log-panel";
import { ResourcePanel } from "./resource-panel";
import { SERVICE_STATE_LABEL, TONE_TEXT, toneOfService } from "./status";

type Tab = { id: string; label: string; service?: ServiceView; external?: ExternalApiView };

const LOGS_TAB = "logs";
const HISTORY_TAB = "history";
const RESOURCES_TAB = "resources";

export function PreviewPanel({ view }: { view: SessionView }) {
  const tabs: Tab[] = [
    ...view.snapshot.services
      .filter((service) => service.preview !== "logs")
      .map((service) => ({ id: service.name, label: `${service.preview === "browser" ? "화면" : "API"} (${service.name})`, service })),
    ...(view.snapshot.externals ?? []).map((external) => ({ id: `external:${external.name}`, label: `사내 API (${external.name})`, external })),
    { id: HISTORY_TAB, label: "기록" },
    { id: LOGS_TAB, label: "로그" },
    { id: RESOURCES_TAB, label: "리소스" },
  ];
  const [activeId, setActiveId] = useState(tabs[0]!.id);
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]!;

  return (
    <section className="flex min-h-0 flex-col gap-2" aria-label="미리보기">
      <div role="tablist" aria-label="미리보기 대상" className="glass flex max-w-full gap-1 self-start overflow-x-auto rounded-full p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={tab.id === active.id}
            onClick={() => setActiveId(tab.id)}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium whitespace-nowrap ${
              tab.id === active.id ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-line bg-panel shadow-sm">
        {active.id === HISTORY_TAB ? (
          <HistoryPanel view={view} />
        ) : active.id === RESOURCES_TAB ? (
          <ResourcePanel view={view} />
        ) : active.external ? (
          <ExternalApiPanel sessionId={view.snapshot.id} external={active.external} ready={view.snapshot.status === "ready"} revision={view.completedRuns} />
        ) : active.id === LOGS_TAB || !active.service ? (
          <LogPanel logs={view.logs} services={view.snapshot.services.map((service) => service.name)} />
        ) : !active.service.url ? (
          <ServicePending service={active.service} />
        ) : (
          // 재시작 중에도 미리보기를 지우지 않아 입력한 경로와 요청이 유지된다. 준비되면 새 주소로 다시 불러온다
          <div className="flex h-full flex-col">
            {active.service.state !== "ready" && <RestartBanner service={active.service} />}
            <div className="min-h-0 flex-1">
              {active.service.preview === "browser" ? (
                <BrowserPreview key={active.service.name} service={active.service} revision={view.completedRuns} />
              ) : (
                <ApiExplorer
                  key={active.service.name}
                  target={{
                    name: active.service.name,
                    requestUrl: `/api/sessions/${view.snapshot.id}/services/${active.service.name}/request`,
                    contractUrl: active.service.hasContract ? `/api/sessions/${view.snapshot.id}/services/${active.service.name}/contract` : undefined,
                    ready: active.service.state === "ready",
                    address: active.service.url,
                    notice: active.service.hasContract ? undefined : "이 서비스는 API 계약을 제공하지 않습니다.",
                  }}
                  revision={view.completedRuns}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function BrowserPreview({ service, revision }: { service: ServiceView; revision: number }) {
  const [path, setPath] = useState("/");
  const [draft, setDraft] = useState("/");
  const [reloads, setReloads] = useState(0);
  const src = new URL(path, service.url).toString();

  return (
    <div className="flex h-full flex-col">
      <form
        className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          setPath(draft.startsWith("/") && !draft.startsWith("//") ? draft : `/${draft.replace(/^\/+/, "")}`);
          setReloads((count) => count + 1);
        }}
      >
        <span className="font-mono text-xs text-muted">{service.url}</span>
        <label htmlFor="preview-path" className="sr-only">
          경로
        </label>
        <input
          id="preview-path"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="min-w-0 flex-1 rounded border border-line bg-ground px-2 py-1 font-mono text-sm"
        />
        <button type="submit" className="rounded border border-line px-3 py-1 text-sm font-medium hover:border-ink">
          열기
        </button>
      </form>
      {/* 요청이 끝날 때마다, 그리고 재시작으로 주소가 바뀌면 새로 불러온다 */}
      <iframe key={`${src}|${reloads}|${revision}`} src={src} title={`${service.name} 미리보기`} className="min-h-0 w-full flex-1 bg-white" />
    </div>
  );
}

function ExternalApiPanel({ sessionId, external, ready, revision }: { sessionId: string; external: ExternalApiView; ready: boolean; revision: number }) {
  return (
    <div className="flex h-full flex-col">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 border-b border-line bg-panel px-4 py-3 text-sm">
        <dt className="text-muted">샌드박스 안의 주소</dt>
        <dd className="font-mono break-all">
          http://{external.name}/ → {external.baseUrl}
        </dd>
        <dt className="text-muted">허용</dt>
        <dd>{external.access.join(" / ")}</dd>
        {external.mask.length > 0 && (
          <>
            <dt className="text-muted">가리는 필드</dt>
            <dd className="font-mono">{external.mask.join(", ")}</dd>
          </>
        )}
        {external.authenticated && (
          <>
            <dt className="text-muted">인증</dt>
            <dd>b-studio가 인증 헤더를 붙입니다. 샌드박스 서비스는 값을 받지 않습니다</dd>
          </>
        )}
      </dl>
      <div className="min-h-0 flex-1">
        <ApiExplorer
          key={external.name}
          target={{
            name: external.name,
            requestUrl: `/api/sessions/${sessionId}/externals/${external.name}/request`,
            ready,
            notice: "여기서 보낸 요청은 studio 호출자로 정책을 거치고 감사 기록에 남습니다.",
          }}
          revision={revision}
        />
      </div>
    </div>
  );
}

function RestartBanner({ service }: { service: ServiceView }) {
  const failed = service.state === "failed";
  return (
    <p role="status" className={`border-b px-4 py-2 text-sm ${failed ? "border-fail/40 bg-fail/10 text-fail" : "border-wait/40 bg-wait/10 text-wait"}`}>
      {service.name} {SERVICE_STATE_LABEL[service.state]}
      {service.detail ? `: ${service.detail}` : ""}
      {failed ? ". 대화의 검증 게이트에서 원인을 확인하세요." : ". 준비되면 새 주소로 다시 불러옵니다."}
    </p>
  );
}

function ServicePending({ service }: { service: ServiceView }) {
  const tone = toneOfService(service.state);
  return (
    <div className="flex h-full flex-col justify-center px-10">
      <p className={`text-lg font-semibold ${TONE_TEXT[tone]}`}>
        {service.name} {SERVICE_STATE_LABEL[service.state]}
      </p>
      {service.detail && <p className="mt-2 max-w-[70ch] font-mono text-sm break-words text-muted">{service.detail}</p>}
      <p className="mt-4 max-w-[60ch] text-sm leading-6 text-muted">
        {service.state === "stopped"
          ? "샌드박스가 없어 미리보기를 열 수 없습니다. 이어서 작업하면 마지막 체크포인트로 서비스를 다시 띄웁니다."
          : "처음 시작할 때는 의존성을 내려받느라 몇 분 걸릴 수 있습니다. 로그 탭에서 진행 상황을 볼 수 있습니다."}
      </p>
    </div>
  );
}
