"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SessionView, ChatItem } from "@/lib/session-view";
import { previewPathFromHref, readPreviewLocationMessage } from "@/lib/preview-message";
import type { ExternalApiView, ServiceView } from "@/lib/studio-events";
import { buildTopTabs, CODE_SUB_TABS, mapLegacyTab, REPOSITORY_SUB_TABS, REQUIREMENTS_SUB_TABS, runSubTabs, type SubTabOption } from "@/lib/tab-model";
import { ApiExplorer } from "./api-explorer";
import { useCodeOpen } from "./code-open-context";
import { CodePanel } from "./code-panel";
import { DeployPanel } from "./deploy-panel";
import { DesignPanel } from "./design-panel";
import { DocsPanel } from "./docs-panel";
import { HistoryPanel } from "./history-panel";
import { useLiveFrames } from "./live-frames";
import { LogPanel } from "./log-panel";
import { MyEnvPanel } from "./my-env-panel";
import { QaView } from "./qa-view";
import { RemoteBrowserView } from "./remote-browser";
import { RepositoryPanel } from "./repository-panel";
import { useRequirementsImport } from "./requirements-import-context";
import { RequirementsPanel } from "./requirements-panel";
import { ResourcePanel } from "./resource-panel";
import { SERVICE_STATE_LABEL, TONE_TEXT, toneOfService } from "./status";
import { StatusPanel } from "./status-panel";
import { SubmissionPanel } from "./submission-panel";
import { TestsPanel } from "./tests-panel";
import { TokenView } from "./token-view";
import { useSubTab } from "./use-sub-tab";

/**
 * 개발 화면의 위 탭(ADR-087). 화면·API는 서비스마다, 나머지는 코드(파일/변경 기록)·요구사항(명세/테스트)·
 * 실행(로그/리소스/배포)·저장소(이슈·PR/올리기 전 점검)·토큰 다섯 자리로 묶었다(예전엔 열 개가 넘는 낱개 탭이었다).
 * 탭 목록은 순수 함수(buildTopTabs)로 만들어 렌더링 없이 테스트하고, 묶음마다 마지막으로 본 하위 탭은
 * localStorage에 기억한다(use-sub-tab.ts).
 */
export function PreviewPanel({ view }: { view: SessionView }) {
  const tabs = buildTopTabs(view.snapshot.services, view.snapshot.externals ?? []);
  const [activeId, setActiveId] = useState(tabs[0]!.id);
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]!;

  const [codeSubTab, setCodeSubTab] = useSubTab("code");
  const [requirementsSubTab, setRequirementsSubTab] = useSubTab("requirements");
  const runOptions = runSubTabs(view.snapshot.hasDeploy ?? false);
  const [runSubTab, setRunSubTab] = useSubTab("run", runOptions);
  const [repositorySubTab, setRepositorySubTab] = useSubTab("repository");

  // "테스트" 하위 탭의 file:line 링크가 codeOpen.open()을 부르면 "코드" 탭의 "파일" 하위 탭으로 전환한다
  // (코드 탭 자신은 그 자리에서 파일·줄을 연다). useEffect 안에서 자기 상태를 바로 바꾸지 않도록, 코드 탭의
  // appliedReveal과 같은 방식으로 렌더 중 비교해 반영한다
  const codeOpen = useCodeOpen();
  const [appliedCodeOpenTarget, setAppliedCodeOpenTarget] = useState(codeOpen.target);
  if (codeOpen.target && codeOpen.target !== appliedCodeOpenTarget) {
    setAppliedCodeOpenTarget(codeOpen.target);
    const target = mapLegacyTab("code");
    setActiveId(target.group);
    if (target.subTab) setCodeSubTab(target.subTab);
  }

  // 대화의 "요구사항에 반영"이 부르면 "요구사항" 탭(명세 하위 탭)으로 전환한다(ADR-094, 코드 열기와 같은 규칙)
  const requirementsImport = useRequirementsImport();
  const [appliedRequirementsImportTarget, setAppliedRequirementsImportTarget] = useState(requirementsImport.target);
  if (requirementsImport.target && requirementsImport.target !== appliedRequirementsImportTarget) {
    setAppliedRequirementsImportTarget(requirementsImport.target);
    setActiveId("requirements");
    setRequirementsSubTab("spec");
  }

  return (
    <section className="flex min-h-0 flex-col gap-2" aria-label="미리보기">
      <div role="tablist" aria-label="미리보기 대상" className="glass flex max-w-full gap-1 self-start overflow-x-auto rounded-panel p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={tab.id === active.id}
            onClick={() => setActiveId(tab.id)}
            className={`shrink-0 rounded-control px-3.5 py-1.5 text-sm font-medium whitespace-nowrap ${
              tab.id === active.id ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" className="min-h-0 flex-1 overflow-hidden rounded-panel border border-line bg-panel">
        {active.kind === "group" && active.id === "code" ? (
          <GroupPanel label="코드" options={CODE_SUB_TABS} active={codeSubTab} onChange={setCodeSubTab}>
            {codeSubTab === "history" ? <HistoryPanel view={view} /> : <CodePanel view={view} />}
          </GroupPanel>
        ) : active.kind === "group" && active.id === "requirements" ? (
          <GroupPanel label="요구사항" options={REQUIREMENTS_SUB_TABS} active={requirementsSubTab} onChange={setRequirementsSubTab}>
            {requirementsSubTab === "tests" ? <TestsPanel view={view} /> : <RequirementsPanel view={view} />}
          </GroupPanel>
        ) : active.kind === "group" && active.id === "run" ? (
          <GroupPanel label="실행" options={runOptions} active={runSubTab} onChange={setRunSubTab}>
            {runSubTab === "resources" ? (
              <ResourcePanel view={view} />
            ) : runSubTab === "myenv" ? (
              <MyEnvPanel view={view} />
            ) : runSubTab === "deploy" ? (
              <DeployPanel view={view} />
            ) : (
              <LogPanel logs={view.logs} services={view.snapshot.services.map((service) => service.name)} />
            )}
          </GroupPanel>
        ) : active.kind === "group" && active.id === "repository" ? (
          <GroupPanel label="저장소" options={REPOSITORY_SUB_TABS} active={repositorySubTab} onChange={setRepositorySubTab}>
            {repositorySubTab === "presubmit" ? <SubmissionPanel view={view} /> : <RepositoryPanel view={view} />}
          </GroupPanel>
        ) : active.kind === "docs" ? (
          <DocsPanel view={view} />
        ) : active.kind === "status" ? (
          <StatusPanel view={view} />
        ) : active.kind === "tokens" ? (
          <TokenView view={view} />
        ) : active.kind === "external" ? (
          <ExternalApiPanel sessionId={view.snapshot.id} external={active.external} ready={view.snapshot.status === "ready"} revision={view.completedRuns} />
        ) : active.kind !== "service" ? (
          // 도달할 일 없는 안전망(위에서 group·docs·status·tokens·external·service 여섯 kind를 모두 다뤘다)
          <LogPanel logs={view.logs} services={view.snapshot.services.map((service) => service.name)} />
        ) : view.snapshot.status === "idle" ? (
          // 지연 기동 세션은 아직 샌드박스를 켜지 않았다. 빈 화면 대신 켜는 방법을 보여 준다
          <IdleServicePanel sessionId={view.snapshot.id} service={active.service} />
        ) : !active.service.url ? (
          <ServicePending sessionId={view.snapshot.id} service={active.service} />
        ) : (
          // 재시작 중에도 미리보기를 지우지 않아 입력한 경로와 요청이 유지된다. 준비되면 새 주소로 다시 불러온다
          <div className="flex h-full flex-col">
            {active.service.state !== "ready" && <RestartBanner service={active.service} />}
            <div className="min-h-0 flex-1">
              {active.service.preview === "browser" ? (
                <BrowserServicePanel key={active.service.name} view={view} service={active.service} />
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

/** 코드·요구사항·실행·저장소 탭의 공통 틀: 위에 하위 탭 줄, 아래에 그 하위 탭의 내용 */
function GroupPanel({
  label,
  options,
  active,
  onChange,
  children,
}: {
  label: string;
  options: readonly SubTabOption[];
  active: string;
  onChange: (id: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <SubTabBar label={`${label} 하위 탭`} options={options} active={active} onChange={onChange} />
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/** 하위 탭 한 줄(role=tablist). 화면 탭의 보기 전환(BrowserServicePanel)도 같은 모양을 쓴다 */
function SubTabBar({ label, options, active, onChange }: { label: string; options: readonly SubTabOption[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="glass-soft inline-flex shrink-0 rounded-control p-0.5 text-sm" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="tab"
          aria-selected={active === option.id}
          onClick={() => onChange(option.id)}
          className={`rounded-md px-2.5 py-1 font-medium transition-colors ${active === option.id ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** "화면" 탭(서비스별)의 하위 탭. 앱은 기존 iframe, 원격 브라우저와 QA는 서버가 중계하는 프레임을, 디자인 비교는 Figma 프레임을 그린다 */
const SCREEN_SUB_TABS = [
  { id: "app", label: "앱 미리보기" },
  { id: "remote", label: "원격 브라우저" },
  { id: "qa", label: "QA" },
  { id: "design", label: "디자인 비교" },
] as const;

type ScreenSubTab = (typeof SCREEN_SUB_TABS)[number]["id"];

/**
 * 화면 확인 중 QA 보기로 자동 전환하는 설정. 새로 고쳐도 남도록 localStorage에 둔다.
 * useSyncExternalStore로 읽어, 효과 안에서 setState하지 않고도 저장값을 반영한다(서버 렌더는 기본 켬)
 */
const AUTO_QA_KEY = "b-studio:auto-qa";
let autoQaCache: boolean | undefined;
const autoQaListeners = new Set<() => void>();
function readAutoQa(): boolean {
  autoQaCache ??= typeof window === "undefined" ? true : window.localStorage.getItem(AUTO_QA_KEY) !== "off";
  return autoQaCache;
}
function writeAutoQa(next: boolean): void {
  autoQaCache = next;
  window.localStorage.setItem(AUTO_QA_KEY, next ? "on" : "off");
  for (const listener of autoQaListeners) listener();
}
function subscribeAutoQa(listener: () => void): () => void {
  autoQaListeners.add(listener);
  return () => autoQaListeners.delete(listener);
}

/**
 * 브라우저 서비스의 "화면" 탭. 하위 탭(앱 미리보기/원격 브라우저/QA/디자인 비교)을 보여 주고, 화면 확인(QA)이
 * 시작되면 자동으로 QA 보기로 넘어간다. 자동 전환은 설정(기본 켬)으로 끌 수 있고, 끄면 사람이 고른 보기를 유지한다.
 * 이 서비스를 벗어나면(다른 서비스 탭·다른 상위 탭) 보기는 기억하지 않고 "앱 미리보기"로 되돌아간다(예전과 같다)
 */
function BrowserServicePanel({ view, service }: { view: SessionView; service: ServiceView }) {
  const [mode, setMode] = useState<ScreenSubTab>("app");
  const autoQa = useSyncExternalStore(subscribeAutoQa, readAutoQa, () => true);
  // 화면 확인 프레임이 오면 QA 보기로 넘어간다. 설정을 읽어 그때그때 판단한다
  const { qa, remote, blocked } = useLiveFrames(view.snapshot.id, (frame) => {
    if (frame.source === "qa" && readAutoQa()) setMode("qa");
  });

  const browserCheck = view.chat.findLast((item): item is Extract<ChatItem, { kind: "check" }> => item.kind === "check" && item.stage === "browser_check");

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <SubTabBar label="화면 하위 탭" options={SCREEN_SUB_TABS} active={mode} onChange={(id) => setMode(id as ScreenSubTab)} />
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={autoQa} onChange={(event) => writeAutoQa(event.target.checked)} className="accent-ink" />
          화면 확인 중 QA 보기로 자동 전환
        </label>
      </div>
      <div className="min-h-0 flex-1">
        {mode === "app" ? (
          <AppPreview sessionId={view.snapshot.id} service={service} revision={view.completedRuns} />
        ) : mode === "remote" ? (
          <RemoteBrowserView sessionId={view.snapshot.id} service={service.name} frame={remote} blocked={blocked} />
        ) : mode === "qa" ? (
          <QaView key={`${browserCheck?.name ?? ""}:${browserCheck?.steps?.length ?? 0}`} sessionId={view.snapshot.id} frame={qa} check={browserCheck} />
        ) : (
          <DesignPanel key={view.snapshot.design?.fileUrl ?? ""} sessionId={view.snapshot.id} design={view.snapshot.design} ready={view.snapshot.status === "ready"} />
        )}
      </div>
    </div>
  );
}

function AppPreview({ sessionId, service, revision }: { sessionId: string; service: ServiceView; revision: number }) {
  const [path, setPath] = useState("/");
  const [draft, setDraft] = useState("/");
  const [reloads, setReloads] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // 원격 미리보기 게이트웨이를 켰으면 다른 PC에서도 열리는 주소를 쓴다
  const base = service.previewUrl ?? service.url;
  const load = `${base}|${path}|${reloads}|${revision}`;
  // 게이트웨이 주소는 스튜디오 인증을 켜면 1회용 티켓을 붙여야 열리므로, 불러올 때마다 스튜디오에서 주소를 받는다
  const [access, setAccess] = useState<{ load: string; src?: string; error?: string }>();
  useEffect(() => {
    if (!service.previewUrl) return;
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/preview-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: service.name, path }),
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!cancelled) setAccess(response.ok && body.url ? { load, src: body.url } : { load, error: body.error ?? "미리보기 주소를 받지 못했습니다" });
      })
      .catch(() => {
        if (!cancelled) setAccess({ load, error: "미리보기 주소를 받지 못했습니다" });
      });
    return () => {
      cancelled = true;
    };
  }, [load, path, service.name, service.previewUrl, sessionId]);
  const current = access?.load === load ? access : undefined;

  // 게이트웨이를 안 쓰면(기본값) studio가 같은 PC에 띄운 로컬 프록시 주소를 받아 쓴다(ADR-113).
  // 이 프록시가 지나가는 HTML에 위치 알림 스크립트를 심어 줘서, 앱 안의 클라이언트 쪽 이동(pushState)을
  // 아래 message 수신으로 따라갈 수 있다. 못 받아 오면 예전처럼 서비스 주소를 직접 연다
  const [proxy, setProxy] = useState<{ load: string; src: string }>();
  useEffect(() => {
    if (service.previewUrl || !service.url) return;
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/services/${service.name}/preview-proxy`, { method: "POST" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { url?: string };
        if (!cancelled && response.ok && body.url) setProxy({ load, src: body.url });
      })
      .catch(() => {
        // 로컬 프록시를 못 받아도 아래 base 그대로 직접 여는 쪽으로 빠진다
      });
    return () => {
      cancelled = true;
    };
  }, [load, service.name, service.previewUrl, service.url, sessionId]);
  const currentProxy = proxy?.load === load ? proxy : undefined;

  const src = service.previewUrl ? current?.src : new URL(path, currentProxy?.src ?? base).toString();

  // 샌드박스 앱이 postMessage로 알려온 지금 위치로 주소 입력칸만 갱신한다. path(=iframe의 key)는 바꾸지 않아
  // iframe을 다시 불러오지 않는다 — "열기"로 직접 이동할 때만 path가 바뀌어 다시 불러온다
  useEffect(() => {
    if (!src) return;
    let expectedOrigin: string | undefined;
    try {
      expectedOrigin = new URL(src).origin;
    } catch {
      return;
    }
    const handle = (event: MessageEvent) => {
      const href = readPreviewLocationMessage(event, { origin: expectedOrigin, source: iframeRef.current?.contentWindow });
      if (href === undefined) return;
      const next = previewPathFromHref(href);
      if (next !== undefined) setDraft(next);
    };
    window.addEventListener("message", handle);
    return () => window.removeEventListener("message", handle);
  }, [src]);

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
        <span className="max-w-[40%] truncate font-mono text-xs text-muted" title={base}>
          {base}
        </span>
        <label htmlFor="preview-path" className="sr-only">
          경로
        </label>
        <input
          id="preview-path"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="min-w-0 flex-1 rounded-control border border-line bg-ground px-2 py-1 font-mono text-sm"
        />
        <button type="submit" className="rounded-control border border-line px-3 py-1 text-sm font-medium hover:border-ink">
          열기
        </button>
      </form>
      {/* 요청이 끝날 때마다, 그리고 재시작으로 주소가 바뀌면 새로 불러온다 */}
      {src ? (
        <iframe ref={iframeRef} key={load} src={src} title={`${service.name} 미리보기`} className="min-h-0 w-full flex-1 bg-white" />
      ) : (
        <p role={current?.error ? "alert" : "status"} className={`px-4 py-3 text-sm ${current?.error ? "text-fail" : "text-muted"}`}>
          {current?.error ?? "미리보기를 여는 중"}
        </p>
      )}
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
        {external.maskPatterns.length > 0 && (
          <>
            <dt className="text-muted">가리는 값 형태</dt>
            <dd className="font-mono">{external.maskPatterns.join(", ")}</dd>
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

/**
 * 지연 기동 세션의 미리보기. 아직 샌드박스를 켜지 않았으므로 빈 화면 대신 켜는 방법을 보여 준다.
 * "지금 켜기"는 boot API를 부르고, 진행 상태는 SSE 이벤트로 스냅샷에 반영된다
 */
function IdleServicePanel({ sessionId, service }: { sessionId: string; service: ServiceView }) {
  const [booting, setBooting] = useState(false);
  const [error, setError] = useState<string>();

  async function boot() {
    setBooting(true);
    setError(undefined);
    const response = await fetch(`/api/sessions/${sessionId}/boot`, { method: "POST" });
    if (!response.ok) setError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "샌드박스를 켜지 못했습니다");
    setBooting(false);
  }

  return (
    <div className="flex h-full flex-col justify-center px-10">
      <p className="text-lg font-semibold text-muted">대기(샌드박스 꺼짐)</p>
      <p className="mt-2 max-w-[60ch] text-sm leading-6 text-muted">
        {service.name}는 아직 켜지 않았습니다. 첫 만들기 요청 때 켭니다. 질문만 하면 켜지 않습니다.
      </p>
      <button
        type="button"
        onClick={boot}
        disabled={booting}
        className="mt-4 self-start rounded-control bg-ink px-4 py-2 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-60"
      >
        {booting ? "켜는 중" : "지금 켜기"}
      </button>
      {error && <p className="mt-2 text-sm text-fail">{error}</p>}
    </div>
  );
}

function ServicePending({ sessionId, service }: { sessionId: string; service: ServiceView }) {
  const tone = toneOfService(service.state);
  const [turningOn, setTurningOn] = useState(false);
  const [error, setError] = useState<string>();

  async function turnOn() {
    setTurningOn(true);
    setError(undefined);
    const response = await fetch(`/api/sessions/${sessionId}/services/${service.name}/selection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on: true }),
    });
    if (!response.ok) setError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "서비스를 켜지 못했습니다");
    setTurningOn(false);
  }

  return (
    <div className="flex h-full flex-col justify-center px-10">
      <p className={`text-lg font-semibold ${TONE_TEXT[tone]}`}>
        {service.name} {service.state === "off" ? "꺼 둔 서비스입니다" : SERVICE_STATE_LABEL[service.state]}
      </p>
      {service.detail && <p className="mt-2 max-w-[70ch] font-mono text-sm break-words text-muted">{service.detail}</p>}
      <p className="mt-4 max-w-[60ch] text-sm leading-6 text-muted">
        {service.state === "off"
          ? "서비스 선택에서 이 서비스를 꺼 뒀습니다. 켜면 이미지를 다시 빌드하고 준비될 때까지 기다립니다."
          : service.state === "stopped"
            ? "샌드박스가 없어 미리보기를 열 수 없습니다. 이어서 작업하면 마지막 체크포인트로 서비스를 다시 띄웁니다."
            : "처음 시작할 때는 의존성을 내려받느라 몇 분 걸릴 수 있습니다. 실행 탭의 로그에서 진행 상황을 볼 수 있습니다."}
      </p>
      {service.state === "off" && (
        <button
          type="button"
          onClick={turnOn}
          disabled={turningOn}
          className="mt-4 self-start rounded-control bg-ink px-4 py-2 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-60"
        >
          {turningOn ? "켜는 중" : "켜기"}
        </button>
      )}
      {error && <p className="mt-2 text-sm text-fail">{error}</p>}
    </div>
  );
}
