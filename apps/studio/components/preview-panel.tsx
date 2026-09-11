"use client";

import { useState } from "react";
import type { SessionView } from "@/lib/session-view";
import type { ServiceView } from "@/lib/studio-events";
import { ApiExplorer } from "./api-explorer";
import { HistoryPanel } from "./history-panel";
import { LogPanel } from "./log-panel";
import { ResourcePanel } from "./resource-panel";
import { SERVICE_STATE_LABEL, TONE_TEXT, toneOfService } from "./status";

type Tab = { id: string; label: string; service?: ServiceView };

const LOGS_TAB = "logs";
const HISTORY_TAB = "history";
const RESOURCES_TAB = "resources";

export function PreviewPanel({ view }: { view: SessionView }) {
  const tabs: Tab[] = [
    ...view.snapshot.services
      .filter((service) => service.preview !== "logs")
      .map((service) => ({ id: service.name, label: `${service.preview === "browser" ? "화면" : "API"} (${service.name})`, service })),
    { id: HISTORY_TAB, label: "기록" },
    { id: LOGS_TAB, label: "로그" },
    { id: RESOURCES_TAB, label: "리소스" },
  ];
  const [activeId, setActiveId] = useState(tabs[0]!.id);
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]!;

  return (
    <section className="flex min-h-0 flex-col lg:border-r lg:border-line" aria-label="미리보기">
      <div role="tablist" aria-label="미리보기 대상" className="flex gap-1 border-b border-line bg-panel px-3">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={tab.id === active.id}
            onClick={() => setActiveId(tab.id)}
            className={`-mb-px border-b-2 px-3 py-2.5 text-sm font-medium ${
              tab.id === active.id ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="min-h-0 flex-1">
        {active.id === HISTORY_TAB ? (
          <HistoryPanel view={view} />
        ) : active.id === RESOURCES_TAB ? (
          <ResourcePanel view={view} />
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
                <ApiExplorer key={active.service.name} sessionId={view.snapshot.id} service={active.service} revision={view.completedRuns} />
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
        처음 시작할 때는 의존성을 내려받느라 몇 분 걸릴 수 있습니다. 로그 탭에서 진행 상황을 볼 수 있습니다.
      </p>
    </div>
  );
}
