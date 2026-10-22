"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  describeWhen,
  draftToRule,
  ruleToDraft,
  type BackendRulesView,
  type RuleDraft,
} from "@/lib/backend-rules";
import { taskKindLabel, type TaskKind } from "@/lib/routing-types";
import type { SessionMode } from "@/lib/studio-events";
import { SESSION_BACKEND_LABEL } from "./status";

interface Preview {
  backend: string;
  model?: string;
  rule: number | "fallback" | "default";
  matched: string;
  kind: TaskKind;
}

const PREVIEW_DELAY_MS = 400;
const COMPLEXITY_OPTIONS: Array<{ id: TaskKind["complexity"]; label: string }> = [
  { id: "simple", label: "단순" },
  { id: "normal", label: "보통" },
  { id: "complex", label: "복잡" },
];

function backendLabel(backend: string): string {
  return SESSION_BACKEND_LABEL[backend as SessionMode] ?? backend;
}

/** 미리보기 한 줄: 어느 AI로, 왜 */
export function previewLine(preview: Preview): string {
  const target = `${backendLabel(preview.backend)}${preview.model ? ` (${preview.model})` : ""}`;
  const why =
    preview.rule === "default"
      ? "맞는 규칙이 없어 서버 기본 AI"
      : preview.rule === "fallback"
        ? "맞는 규칙이 없어 기본값"
        : `규칙 ${preview.rule + 1}(${preview.matched})`;
  return `${target}로 보냅니다 · ${why} · 작업 종류 ${taskKindLabel(preview.kind)}`;
}

const emptyDraft = (backend: string): RuleDraft => ({ intent: "", complexity: [], risk: "", keywords: "", backend, model: "" });

/**
 * 작업 화면 맨 위의 요청 입력(#822). 요청을 쓰면 내가 정한 규칙으로 어느 AI로 갈지 미리 보이고, 보내면 그 AI로 새 세션을 만들어
 * 첫 요청까지 보낸 뒤 그 세션으로 간다. 로그인은 보낼 때 확인하고, 로그인 전이면 다음 후보로 간다.
 */
export function RoutingLauncher({ projects, initial }: { projects: Array<{ id: string; name: string }>; initial: BackendRulesView }) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [request, setRequest] = useState("");
  const [ask, setAsk] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState(initial);
  const intent = ask ? "ask" : "build";

  // 쓰는 동안 잠시 멈추면 어느 AI로 갈지 다시 묻는다. 규칙을 저장하면(view가 바뀌면) 다시 묻는다
  useEffect(() => {
    const text = request.trim();
    if (!text) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch("/api/routing/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: text, intent }),
        signal: controller.signal,
      })
        .then(async (response) => (response.ok ? setPreview((await response.json()) as Preview) : setPreview(undefined)))
        .catch(() => {});
    }, PREVIEW_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [request, intent, view]);

  async function send() {
    if (!projectId || !request.trim()) return;
    setSending(true);
    setError(undefined);
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, route: "rules", request, intent }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; session?: { id: string }; sendError?: string };
      if (!response.ok || !body.session) {
        setError(body.error ?? "요청을 보내지 못했습니다");
        setSending(false);
        return;
      }
      if (body.sendError) {
        setError(`세션은 만들었지만 요청을 보내지 못했습니다: ${body.sendError}`);
        setSending(false);
        return;
      }
      router.push(`/sessions/${body.session.id}`);
    } catch {
      setError("요청을 보내지 못했습니다");
      setSending(false);
    }
  }

  if (projects.length === 0) {
    return <p className="glass rounded-panel px-4 py-3 text-sm text-muted">프로젝트를 먼저 열면 여기서 요청을 바로 보낼 수 있습니다.</p>;
  }

  return (
    <section aria-labelledby="routing-launcher-title" className="glass rounded-panel px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="routing-launcher-title" className="text-base font-semibold">
          새 요청
        </h2>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">프로젝트</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className="glass-soft rounded-control px-2 py-1">
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-sm text-muted">
          <input type="checkbox" checked={ask} onChange={(event) => setAsk(event.target.checked)} className="accent-ink" />
          읽기만(질문)
        </label>
        <button type="button" onClick={() => setEditing((open) => !open)} aria-expanded={editing} className="ml-auto text-sm text-muted underline underline-offset-2 hover:text-ink">
          {editing ? "규칙 닫기" : `규칙 고치기(${view.rules.rules.length}개)`}
        </button>
      </div>
      <textarea
        value={request}
        onChange={(event) => setRequest(event.target.value)}
        rows={3}
        placeholder="무엇을 만들거나 고칠지 적으세요. 정한 규칙대로 AI를 골라 새 세션으로 보냅니다"
        className="mt-3 w-full rounded-control border border-line bg-panel px-3 py-2 text-sm"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-xs text-muted" aria-live="polite">
          {request.trim() && preview ? previewLine(preview) : "요청을 쓰면 어느 AI로 갈지 여기 보입니다"}
        </p>
        <button
          type="button"
          disabled={sending || !request.trim() || !projectId}
          onClick={() => void send()}
          className="rounded-control bg-ink px-4 py-2 text-sm font-semibold text-panel hover:bg-ink/85 disabled:opacity-50"
        >
          {sending ? "보내는 중…" : "보내기"}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-fail">
          {error}
        </p>
      )}
      {view.error && <p className="mt-2 text-sm text-wait">{view.error}</p>}
      {editing && <RulesEditor view={view} onSaved={setView} />}
    </section>
  );
}

function RulesEditor({ view, onSaved }: { view: BackendRulesView; onSaved: (view: BackendRulesView) => void }) {
  const [drafts, setDrafts] = useState<RuleDraft[]>(() => view.rules.rules.map(ruleToDraft));
  const [fallback, setFallback] = useState(view.rules.fallback?.backend ?? "");
  const [fallbackModel, setFallbackModel] = useState(view.rules.fallback?.model ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const change = (index: number, patch: Partial<RuleDraft>) => {
    setSaved(false);
    setDrafts((rows) => rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  };
  const move = (index: number, by: -1 | 1) => {
    setSaved(false);
    setDrafts((rows) => {
      const next = [...rows];
      const target = index + by;
      if (target < 0 || target >= next.length) return rows;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  };

  async function save() {
    setSaving(true);
    setError(undefined);
    const body = {
      rules: drafts.map(draftToRule),
      ...(fallback ? { fallback: { backend: fallback, ...(fallbackModel.trim() ? { model: fallbackModel.trim() } : {}) } } : {}),
    };
    try {
      const response = await fetch("/api/routing/rules", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = (await response.json().catch(() => ({}))) as { error?: string; rules?: BackendRulesView["rules"] };
      if (!response.ok || !result.rules) {
        setError(result.error ?? "규칙을 저장하지 못했습니다");
      } else {
        onSaved({ ...view, rules: result.rules, error: undefined });
        setSaved(true);
      }
    } catch {
      setError("규칙을 저장하지 못했습니다");
    }
    setSaving(false);
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <p className="text-xs leading-5 text-muted">
        위에서부터 보고 조건이 모두 맞는 첫 규칙의 AI로 보냅니다. 비운 조건은 상관없음입니다. 그 AI에 로그인돼 있지 않으면 다음 규칙으로 갑니다. 모델을 비우면 그 AI에서 이 프로젝트에 마지막으로 고른 모델을 씁니다.
      </p>
      <ol className="mt-3 flex flex-col gap-2">
        {drafts.map((draft, index) => (
          <li key={index} className="glass-soft flex flex-wrap items-center gap-2 rounded-control px-3 py-2 text-sm">
            <span className="w-14 shrink-0 text-xs text-muted">규칙 {index + 1}</span>
            <select aria-label={`규칙 ${index + 1} 요청 종류`} value={draft.intent} onChange={(event) => change(index, { intent: event.target.value as RuleDraft["intent"] })} className="rounded-control border border-line bg-panel px-1.5 py-1">
              <option value="">만들기·질문</option>
              <option value="build">만들기</option>
              <option value="ask">질문</option>
            </select>
            <span className="flex items-center gap-1.5" role="group" aria-label={`규칙 ${index + 1} 복잡도`}>
              {COMPLEXITY_OPTIONS.map((option) => (
                <label key={option.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={draft.complexity.includes(option.id)}
                    onChange={(event) =>
                      change(index, { complexity: event.target.checked ? COMPLEXITY_OPTIONS.map((item) => item.id).filter((id) => id === option.id || draft.complexity.includes(id)) : draft.complexity.filter((id) => id !== option.id) })
                    }
                    className="accent-ink"
                  />
                  {option.label}
                </label>
              ))}
            </span>
            <select aria-label={`규칙 ${index + 1} 위험도`} value={draft.risk} onChange={(event) => change(index, { risk: event.target.value as RuleDraft["risk"] })} className="rounded-control border border-line bg-panel px-1.5 py-1">
              <option value="">위험 상관없음</option>
              <option value="high">위험</option>
              <option value="normal">위험 아님</option>
            </select>
            <input
              aria-label={`규칙 ${index + 1} 낱말`}
              value={draft.keywords}
              onChange={(event) => change(index, { keywords: event.target.value })}
              placeholder="낱말(쉼표로)"
              className="w-36 rounded-control border border-line bg-panel px-2 py-1"
            />
            <span className="text-muted">→</span>
            <select aria-label={`규칙 ${index + 1} AI`} value={draft.backend} onChange={(event) => change(index, { backend: event.target.value })} className="rounded-control border border-line bg-panel px-1.5 py-1">
              {view.allowed.map((backend) => (
                <option key={backend} value={backend}>
                  {backendLabel(backend)}
                </option>
              ))}
            </select>
            <input aria-label={`규칙 ${index + 1} 모델`} value={draft.model} onChange={(event) => change(index, { model: event.target.value })} placeholder="모델(비우면 기본)" className="w-32 rounded-control border border-line bg-panel px-2 py-1" />
            <span className="ml-auto flex items-center gap-1 text-xs">
              <button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`규칙 ${index + 1} 위로`} className="rounded-control px-1.5 py-0.5 hover:bg-panel disabled:opacity-30">
                ↑
              </button>
              <button type="button" onClick={() => move(index, 1)} disabled={index === drafts.length - 1} aria-label={`규칙 ${index + 1} 아래로`} className="rounded-control px-1.5 py-0.5 hover:bg-panel disabled:opacity-30">
                ↓
              </button>
              <button
                type="button"
                onClick={() => {
                  setSaved(false);
                  setDrafts((rows) => rows.filter((_, at) => at !== index));
                }}
                className="rounded-control px-1.5 py-0.5 text-fail hover:bg-fail/10"
              >
                지우기
              </button>
            </span>
            <span className="basis-full pl-16 text-xs text-muted">{describeWhen(draftToRule(draft).when)}</span>
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <button
          type="button"
          onClick={() => {
            setSaved(false);
            setDrafts((rows) => [...rows, emptyDraft(view.allowed[0] ?? view.defaultBackend)]);
          }}
          className="glass-soft rounded-control px-3 py-1.5 font-medium hover:bg-panel"
        >
          + 규칙 더하기
        </button>
        <label className="ml-4 flex items-center gap-2">
          <span className="text-muted">맞는 규칙이 없으면</span>
          <select value={fallback} onChange={(event) => setFallback(event.target.value)} className="rounded-control border border-line bg-panel px-1.5 py-1">
            <option value="">서버 기본({backendLabel(view.defaultBackend)})</option>
            {view.allowed.map((backend) => (
              <option key={backend} value={backend}>
                {backendLabel(backend)}
              </option>
            ))}
          </select>
        </label>
        {fallback && <input aria-label="기본값 모델" value={fallbackModel} onChange={(event) => setFallbackModel(event.target.value)} placeholder="모델(비우면 기본)" className="w-32 rounded-control border border-line bg-panel px-2 py-1" />}
        <button type="button" disabled={saving} onClick={() => void save()} className="ml-auto rounded-control bg-ink px-4 py-1.5 font-semibold text-panel hover:bg-ink/85 disabled:opacity-50">
          {saving ? "저장하는 중…" : "규칙 저장"}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-fail">
          {error}
        </p>
      )}
      {saved && <p className="mt-2 text-sm text-pass">저장했습니다. 다음 요청부터 이 규칙으로 고릅니다.</p>}
    </div>
  );
}
