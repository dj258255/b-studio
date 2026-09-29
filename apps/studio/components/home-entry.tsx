"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ProjectSummary } from "@/lib/studio-events";
import {
  backendLabel,
  backendOptions,
  defaultFleetModels,
  defaultPlanModel,
  initialProjectId,
  methodOptions,
  modelsBackendFor,
  submitEntry,
  type Capabilities,
  type EntryMethod,
  type ModelOptionLike,
} from "@/lib/home-entry";

/** 모델 목록에서 화면이 쓰는 부분 */
export type HomeModelOption = ModelOptionLike & { label: string };

/** 홈이 아는 프로젝트: 목록 정보에 "내 폴더"를 고를 때 보여 줄 실제 경로를 더한다 */
export type HomeProject = ProjectSummary & { folder?: string };

/** `GET /api/<backend>/models` 응답. 서버 러너의 모델 파서 결과를 그대로 받는다 */
interface CliModel {
  id: string;
  group: string;
  free: boolean;
  isDefault?: boolean;
  /** 서버가 쓸 수 있다고 본 모델인지. false면 비활성으로 두고 reason을 보여준다(opencode 무료 Zen 등) */
  usable?: boolean;
  reason?: string;
}
interface CliModels {
  models: CliModel[];
  freeOnly: boolean;
  error?: string;
}

/** 쓸 수 있는 모델이 하나도 없을 때의 안내. 서버(`OPENCODE_LOGIN_HINT`)와 같은 문구를 클라이언트에서도 쓴다 */
const LOGIN_HINT = "쓸 수 있는 모델이 없습니다. 터미널에서 `opencode auth login`으로 제공자에 로그인한 뒤 세션을 시작하세요.";

/** 선택 상자의 그룹(optgroup) 순서를 유지하며 모델을 묶는다 */
function groupBy(models: CliModel[]): Array<[string, CliModel[]]> {
  const groups = new Map<string, CliModel[]>();
  for (const model of models) {
    const list = groups.get(model.group);
    if (list) list.push(model);
    else groups.set(model.group, [model]);
  }
  return [...groups.entries()];
}

/**
 * 홈의 입구. 프로젝트 고르기 + 입력창 + 방식 선택(한 명/여러 명 비교/나눠서 병렬)을 한 곳에 모은다.
 * 방식별로 기존 API(세션·Fleet·작업 분해)를 그대로 부르고 해당 화면으로 이동한다.
 * 쓸 수 있는 방식은 `GET /api/capabilities`로 확인하고, 없으면 한 명만 켠다.
 */
export function HomeEntry({ projects, models, localAllowed }: { projects: HomeProject[]; models: HomeModelOption[]; localAllowed: boolean }) {
  const router = useRouter();
  const usable = useMemo(() => projects.filter((project) => !project.error), [projects]);
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [method, setMethod] = useState<EntryMethod>("single");
  const [projectId, setProjectId] = useState(() => initialProjectId(projects));
  const [text, setText] = useState("");
  const [workspace, setWorkspace] = useState<"copy" | "local">("copy");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  /** 한 명 흐름에서 세션은 만들었는데 요청 보내기가 실패했을 때 그 세션으로 갈 수 있게 남긴다 */
  const [createdSessionId, setCreatedSessionId] = useState<string>();
  /** "자세히"의 백엔드 선택. capabilities가 오면 서버 모드로 채운다 */
  const [backend, setBackend] = useState("");
  const [cliModels, setCliModels] = useState<CliModel[]>([]);
  const [modelId, setModelId] = useState("");
  /** 서버가 무료만 모드로 강제한 값. 켜져 있으면 화면에서 끌 수 없다 */
  const [freeOnlyForced, setFreeOnlyForced] = useState(false);
  /** 화면에서만 거르는 "무료 모델만" 체크박스 */
  const [freeFilter, setFreeFilter] = useState(false);
  const [modelsError, setModelsError] = useState<string>();

  useEffect(() => {
    let active = true;
    fetch("/api/capabilities", { cache: "no-store" })
      .then(async (response) => (response.ok ? ((await response.json()) as Capabilities) : undefined))
      .then((data) => {
        if (!active) return;
        setCapabilities(data);
        // 백엔드는 둘 이상일 때만 고를 수 있다(선택 칸은 그때만 보인다). 기본은 서버 모드.
        // 하나뿐이어도 값은 서버 모드로 채운다 — 그래야 Command Code·OpenCode 모드 서버에서 모델 고르기가 보인다
        const list = backendOptions(data);
        if (list.length >= 2) setBackend((current) => current || (data?.mode && list.includes(data.mode) ? data.mode : list[0]!));
        else if (data?.mode) {
          const mode = data.mode;
          setBackend((current) => current || mode);
        }
      })
      .catch(() => {
        // API가 없거나 실패하면 한 명만 켠다(초기 상태 그대로)
      });
    return () => {
      active = false;
    };
  }, []);

  const backends = useMemo(() => backendOptions(capabilities), [capabilities]);
  const modelsBackend = modelsBackendFor(backend);

  useEffect(() => {
    if (!modelsBackend) return;
    let active = true;
    void (async () => {
      try {
        const response = await fetch(`/api/${modelsBackend}/models`, { cache: "no-store" });
        const data = (await response.json().catch(() => ({}))) as Partial<CliModels> & { error?: string };
        if (!active) return;
        if (!response.ok) {
          setModelsError(typeof data.error === "string" ? data.error : "모델 목록을 불러오지 못했습니다");
          return;
        }
        const list = Array.isArray(data.models) ? data.models : [];
        setCliModels(list);
        setFreeOnlyForced(data.freeOnly === true);
        if (data.freeOnly === true) setFreeFilter(true);
        if (typeof data.error === "string") setModelsError(data.error);
        // 쓸 수 있는 모델만 기본으로 고른다(무료 Zen 모델은 비활성이다)
        const first = list.find((model) => model.usable !== false && model.isDefault) ?? list.find((model) => model.usable !== false);
        if (first) setModelId(first.id);
      } catch {
        if (active) setModelsError("모델 목록을 불러오지 못했습니다");
      }
    })();
    return () => {
      active = false;
    };
  }, [modelsBackend]);

  const options = useMemo(() => methodOptions(capabilities), [capabilities]);
  const selected = options.find((option) => option.id === method) ?? options[0]!;
  const fleetModelIds = useMemo(() => defaultFleetModels(models), [models]);
  const planModelId = useMemo(() => defaultPlanModel(models), [models]);
  const shownModels = useMemo(() => (freeFilter ? cliModels.filter((model) => model.free) : cliModels), [cliModels, freeFilter]);
  const hasUsableModel = useMemo(() => shownModels.some((model) => model.usable !== false), [shownModels]);
  const canSend = Boolean(projectId) && text.trim().length > 0 && selected.enabled && !sending;
  const singleProject = usable.length === 1 ? usable[0] : undefined;
  const selectedProject = usable.find((project) => project.id === projectId);
  // 백엔드를 고를 수 없으면 보내지 않는다(서버 기본). 모델은 CLI 백엔드에서만 싣는다
  const sendBackend = backends.length >= 2 ? backend : undefined;
  const sendModel = modelsBackend && modelId ? modelId : undefined;

  function chooseBackend(value: string) {
    setBackend(value);
    setModelId("");
    setCliModels([]);
    setModelsError(undefined);
    setFreeFilter(false);
    setFreeOnlyForced(false);
  }

  async function send() {
    if (!canSend) return;
    setSending(true);
    setError(undefined);
    setCreatedSessionId(undefined);
    const result = await submitEntry(fetch, { method, projectId, text, workspace, backend: sendBackend, model: sendModel, fleetModelIds, planModelId, mode: capabilities?.mode });
    if (result.ok) {
      router.push(result.href);
      return;
    }
    setSending(false);
    setError(result.error);
    setCreatedSessionId(result.sessionId);
  }

  return (
    <section className="glass rounded-panel p-5" aria-labelledby="home-entry">
      <h2 id="home-entry" className="text-lg font-semibold">요청 보내기</h2>

      <div className="mt-4">
        <label htmlFor="home-project" className="block text-sm font-medium">프로젝트</label>
        {singleProject ? (
          <p className="mt-1 text-sm text-muted">
            <span className="font-medium text-ink">{singleProject.name}</span> · {singleProject.services.map((service) => service.name).join(", ")}
          </p>
        ) : (
          <select
            id="home-project"
            value={projectId}
            disabled={sending}
            onChange={(event) => setProjectId(event.target.value)}
            className="mt-1 w-full rounded-control border border-line bg-panel px-3 py-2 text-sm"
          >
            <option value="">프로젝트를 고르세요</option>
            {usable.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        )}
      </div>

      <label htmlFor="home-request" className="mt-4 block text-sm font-medium">무엇을 만들까요?</label>
      <textarea
        id="home-request"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
        rows={4}
        placeholder="만들거나 바꾸고 싶은 내용을 적어 주세요 (Cmd/Ctrl+Enter로 보내기)"
        className="mt-1 w-full resize-y rounded-control border border-line bg-panel px-3 py-2 text-sm leading-6 placeholder:text-muted"
      />

      <fieldset className="mt-4">
        <legend className="text-sm font-medium">어떻게 시킬까요?</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {options.map((option) => {
            const active = option.id === method;
            return (
              <label
                key={option.id}
                className={`glass-soft flex items-start gap-2 rounded-control px-3 py-2.5 text-sm ${
                  option.enabled ? "cursor-pointer" : "opacity-60"
                } ${active ? "ring-1 ring-line" : ""}`}
              >
                <input
                  type="radio"
                  name="home-method"
                  value={option.id}
                  checked={active}
                  disabled={!option.enabled || sending}
                  onChange={() => setMethod(option.id)}
                  className="mt-0.5 accent-ink"
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium text-ink">{option.label}</span>
                  <span className="block text-xs leading-5 text-muted">{option.enabled ? option.description : option.reason}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <details className="mt-3">
        <summary className="cursor-pointer text-sm text-muted">자세히</summary>
        {method === "single" ? (
          <div className="mt-2 space-y-3">
            {backends.length >= 2 && (
              <div>
                <label htmlFor="home-backend" className="block text-sm font-medium">백엔드</label>
                <select
                  id="home-backend"
                  value={backend}
                  disabled={sending}
                  onChange={(event) => chooseBackend(event.target.value)}
                  className="mt-1 w-full rounded-control border border-line bg-panel px-3 py-2 text-sm"
                >
                  {backends.map((id) => (
                    <option key={id} value={id}>{backendLabel(id)}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs leading-5 text-muted">고른 백엔드로 이 세션을 만듭니다.</p>
              </div>
            )}

            {modelsBackend && (
              <div>
                {cliModels.length > 0 ? (
                  <>
                    <label htmlFor="home-model" className="block text-sm font-medium">모델</label>
                    <select
                      id="home-model"
                      value={modelId}
                      disabled={sending}
                      onChange={(event) => setModelId(event.target.value)}
                      className="mt-1 w-full rounded-control border border-line bg-panel px-3 py-2 text-sm"
                    >
                      {groupBy(shownModels).map(([group, entries]) => (
                        <optgroup key={group} label={group}>
                          {entries.map((model) => (
                            <option key={model.id} value={model.id} disabled={model.usable === false}>
                              {model.id}
                              {model.isDefault ? " (기본)" : ""}
                              {model.free ? " · 무료" : ""}
                              {model.usable === false ? ` · 쓸 수 없음 (${model.reason ?? "지금은 쓸 수 없습니다"})` : ""}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <label className="mt-1 flex items-center gap-1.5 text-xs text-muted" htmlFor="home-free-only">
                      <input
                        id="home-free-only"
                        type="checkbox"
                        checked={freeFilter}
                        disabled={freeOnlyForced || sending}
                        onChange={(event) => setFreeFilter(event.target.checked)}
                      />
                      무료 모델만{freeOnlyForced ? " (서버 설정으로 켜짐)" : ""}
                    </label>
                    {!hasUsableModel && <p className="mt-1 text-xs leading-5 text-wait">{LOGIN_HINT}</p>}
                  </>
                ) : (
                  <p className="text-xs leading-5 text-muted">
                    {modelsError ?? "모델 목록을 불러오는 중"}
                    {modelsError ? `. ${LOGIN_HINT}` : ""}
                  </p>
                )}
              </div>
            )}

            {localAllowed ? (
              <div>
                <span className="text-sm font-medium">작업할 위치</span>
                <div className="glass-soft mt-1 inline-flex rounded-control p-0.5 text-sm" role="group" aria-label="작업할 위치">
                  {(["copy", "local"] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      aria-pressed={workspace === kind}
                      disabled={sending}
                      onClick={() => setWorkspace(kind)}
                      className={`rounded-md px-3 py-1 font-medium transition-colors ${
                        workspace === kind ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"
                      }`}
                    >
                      {kind === "copy" ? "복사본" : "내 폴더"}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs leading-5 text-muted">
                  {workspace === "local" ? (
                    <>
                      에이전트가 {selectedProject?.folder ? <span className="break-all font-mono text-xs text-ink">{selectedProject.folder}</span> : "내 폴더"}의 파일을 바로
                      고칩니다(되돌릴 수 있습니다).
                    </>
                  ) : (
                    "프로젝트를 복사해 시험합니다. 원본은 바뀌지 않습니다."
                  )}
                </p>
              </div>
            ) : (
              <p className="text-xs leading-5 text-muted">세션마다 프로젝트 복사본에서 작업합니다. 원본 폴더는 바뀌지 않습니다.</p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-xs leading-5 text-muted">여러 명 비교·나눠서 병렬은 서버 기본 백엔드로 돕니다.</p>
        )}
      </details>

      <button
        type="button"
        onClick={() => void send()}
        disabled={!canSend}
        className="mt-4 w-full rounded-control bg-ink px-4 py-2.5 text-sm font-semibold text-panel hover:bg-ink/85 disabled:opacity-50"
      >
        {sending ? "보내는 중" : "보내기"}
      </button>

      {error && (
        <p role="alert" className="mt-3 text-sm text-fail">
          {error}
          {createdSessionId && (
            <>
              {" "}
              <a href={`/sessions/${createdSessionId}`} className="font-medium underline underline-offset-2">세션 열기</a>
            </>
          )}
        </p>
      )}
    </section>
  );
}
