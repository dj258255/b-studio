"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { WorkspaceKind } from "@/lib/studio-events";

/** 모델 목록을 내려주는 로컬 CLI 백엔드. commandcode·opencode가 같은 화면을 쓴다 */
export type ModelsBackend = "commandcode" | "opencode";

/** GET /api/<backend>/models 응답. 서버 러너의 모델 파서 결과를 그대로 받는다 */
interface CliModel {
  id: string;
  description?: string;
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

/** folder가 있으면 복사본과 내 폴더 중에서 고른다. 인증을 켠 서버에서는 folder를 넘기지 않아 복사본만 쓴다 */
export function StartSessionButton({ projectId, folder, modelsBackend }: { projectId: string; folder?: string; modelsBackend?: ModelsBackend }) {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<WorkspaceKind>("copy");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const [models, setModels] = useState<CliModel[]>([]);
  const [modelId, setModelId] = useState("");
  /** 서버가 무료만 모드로 강제한 값. 켜져 있으면 화면에서 끌 수 없다 */
  const [freeOnlyForced, setFreeOnlyForced] = useState(false);
  /** 화면에서만 거르는 "무료 모델만" 체크박스 */
  const [freeFilter, setFreeFilter] = useState(false);
  const [modelsError, setModelsError] = useState<string>();

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
        setModels(list);
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

  const shown = useMemo(() => (freeFilter ? models.filter((model) => model.free) : models), [models, freeFilter]);
  const hasUsable = useMemo(() => shown.some((model) => model.usable !== false), [shown]);

  async function start() {
    setStarting(true);
    setError(undefined);
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, workspace, ...(modelsBackend && modelId ? { modelId } : {}) }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error ?? "샌드박스를 시작하지 못했습니다");
      setStarting(false);
      return;
    }
    router.push(`/sessions/${data.id}`);
  }

  const local = workspace === "local";

  return (
    <>
      <div className="flex flex-col items-end gap-2">
        {modelsBackend && (
          <div className="flex flex-col items-end gap-2">
            {models.length > 0 ? (
              <div className="flex flex-col items-end gap-1">
                <label className="text-xs font-medium text-muted" htmlFor={`session-model-${projectId}`}>
                  모델
                </label>
                <select
                  id={`session-model-${projectId}`}
                  value={modelId}
                  disabled={starting}
                  onChange={(event) => setModelId(event.target.value)}
                  className="rounded-control border border-line bg-panel px-3 py-1.5 text-sm"
                >
                  {groupBy(shown).map(([group, options]) => (
                    <optgroup key={group} label={group}>
                      {options.map((model) => (
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
                <label className="flex items-center gap-1.5 text-xs text-muted" htmlFor={`session-free-only-${projectId}`}>
                  <input
                    id={`session-free-only-${projectId}`}
                    type="checkbox"
                    checked={freeFilter}
                    disabled={freeOnlyForced || starting}
                    onChange={(event) => setFreeFilter(event.target.checked)}
                  />
                  무료 모델만{freeOnlyForced ? " (서버 설정으로 켜짐)" : ""}
                </label>
                {!hasUsable && <p className="max-w-[24rem] text-right text-xs leading-5 text-wait">{LOGIN_HINT}</p>}
              </div>
            ) : (
              <p className="max-w-[24rem] text-right text-xs leading-5 text-muted">
                {modelsError ?? "모델 목록을 불러오는 중"}
                {modelsError ? `. ${LOGIN_HINT}` : ""}
              </p>
            )}
          </div>
        )}
        {folder && (
          <div className="glass-soft inline-flex rounded-control p-0.5 text-sm" role="group" aria-label="작업할 위치">
            {(["copy", "local"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={workspace === kind}
                disabled={starting}
                onClick={() => setWorkspace(kind)}
                className={`rounded-md px-3 py-1 font-medium transition-colors ${
                  workspace === kind ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"
                }`}
              >
                {kind === "copy" ? "복사본" : "내 폴더"}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={start}
          disabled={starting}
          className="rounded-control bg-ink px-4 py-2 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-60"
        >
          {starting ? (local ? "내 폴더로 준비하는 중" : "복사본 만드는 중") : local ? "내 폴더에서 시작" : "샌드박스 시작"}
        </button>
      </div>
      {folder && (
        <p className="basis-full text-sm leading-6 text-muted">
          {local ? (
            <>
              에이전트가 <span className="break-all font-mono text-xs text-ink">{folder}</span>의 파일을 바로 고칩니다. IDE에서 고친 파일도 미리보기에 바로
              반영됩니다.
            </>
          ) : (
            "프로젝트를 복사해 시험합니다. 원본 폴더는 바뀌지 않습니다."
          )}
        </p>
      )}
      {error && <p className="basis-full text-sm text-fail">{error}</p>}
    </>
  );
}

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
