"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { WorkspaceKind } from "@/lib/studio-events";

/** GET /api/commandcode/models 응답. 서버 러너의 모델 파서 결과를 그대로 받는다 */
interface CommandCodeModel {
  id: string;
  description: string;
  group: string;
  free: boolean;
  isDefault: boolean;
}
interface CommandCodeModels {
  models: CommandCodeModel[];
  freeOnly: boolean;
  error?: string;
}

/** folder가 있으면 복사본과 내 폴더 중에서 고른다. 인증을 켠 서버에서는 folder를 넘기지 않아 복사본만 쓴다 */
export function StartSessionButton({ projectId, folder, commandCode = false }: { projectId: string; folder?: string; commandCode?: boolean }) {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<WorkspaceKind>("copy");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const [models, setModels] = useState<CommandCodeModel[]>([]);
  const [modelId, setModelId] = useState("");
  /** 서버가 B_STUDIO_CMD_FREE_ONLY로 강제한 값. 켜져 있으면 화면에서 끌 수 없다 */
  const [freeOnlyForced, setFreeOnlyForced] = useState(false);
  /** 화면에서만 거르는 "무료 모델만" 체크박스 */
  const [freeFilter, setFreeFilter] = useState(false);
  const [modelsError, setModelsError] = useState<string>();

  useEffect(() => {
    if (!commandCode) return;
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/commandcode/models", { cache: "no-store" });
        const data = (await response.json().catch(() => ({}))) as Partial<CommandCodeModels> & { error?: string };
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
        const first = list.find((model) => model.isDefault) ?? list[0];
        if (first) setModelId(first.id);
      } catch {
        if (active) setModelsError("모델 목록을 불러오지 못했습니다");
      }
    })();
    return () => {
      active = false;
    };
  }, [commandCode]);

  const shown = useMemo(() => (freeFilter ? models.filter((model) => model.free) : models), [models, freeFilter]);

  async function start() {
    setStarting(true);
    setError(undefined);
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, workspace, ...(commandCode && modelId ? { modelId } : {}) }),
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
        {commandCode && (
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
                        <option key={model.id} value={model.id}>
                          {model.id}
                          {model.isDefault ? " (기본)" : ""}
                          {model.free ? " · 무료" : ""}
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
              </div>
            ) : (
              <p className="max-w-[24rem] text-right text-xs leading-5 text-muted">
                {modelsError ?? "모델 목록을 불러오는 중"}
                {modelsError ? ". 계정 기본 모델로 실행합니다." : ""}
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
function groupBy(models: CommandCodeModel[]): Array<[string, CommandCodeModel[]]> {
  const groups = new Map<string, CommandCodeModel[]>();
  for (const model of models) {
    const list = groups.get(model.group);
    if (list) list.push(model);
    else groups.set(model.group, [model]);
  }
  return [...groups.entries()];
}
