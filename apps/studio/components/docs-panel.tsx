"use client";

import { useEffect, useState } from "react";
import type { SessionView } from "@/lib/session-view";
import { Markdown } from "./markdown";
import { useSessionAccess } from "./session-access";

interface DocEntry {
  path: string;
  title: string;
}

interface DocsTree {
  docs: DocEntry[];
}

interface DocContent {
  path: string;
  content: string;
}

type NewDocKind = "design" | "adr" | "troubleshooting" | "roadmap";

const NEW_DOC_LABEL: Record<NewDocKind, string> = {
  design: "설계 문서",
  adr: "ADR(아키텍처 결정 기록)",
  troubleshooting: "트러블슈팅 항목",
  roadmap: "로드맵·트레이드오프",
};

async function readJson<T>(response: Response): Promise<T & { error?: string }> {
  return (await response.json().catch(() => ({}))) as T & { error?: string };
}

/**
 * "문서" 탭(ADR-0XX). 세션 작업 복사본의 docs/**\/*.md·README.md·CHANGELOG.md·CONTRIBUTING.md를 트리로 보여 주고,
 * 미리보기·그 자리 편집(저장 즉시 작업 복사본에 반영 — 다음 체크포인트·PR에 그대로 실린다)을 지원한다.
 * "새 문서"는 템플릿으로 설계 문서·ADR을 만들거나 트러블슈팅·로드맵 항목을 이어 붙이고, "색인 갱신"은
 * docs/README.md의 관리 구간만 문서들의 첫 H1·첫 문단으로 다시 만든다(그 밖의 손으로 쓴 글은 그대로 둔다).
 */
export function DocsPanel({ view }: { view: SessionView }) {
  const sessionId = view.snapshot.id;
  const access = useSessionAccess();
  const [tree, setTree] = useState<{ data?: DocsTree; error?: string }>();
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [reindexNotice, setReindexNotice] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/docs`)
      .then(async (response) => {
        const data = await readJson<DocsTree>(response);
        if (cancelled) return;
        if (!response.ok) {
          setTree({ error: data.error ?? "문서 목록을 불러오지 못했습니다" });
          return;
        }
        setTree({ data });
        setSelected((current) => current ?? data.docs[0]?.path);
      })
      .catch(() => {
        if (!cancelled) setTree({ error: "문서 목록을 불러오지 못했습니다" });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, revision]);

  async function reindex() {
    setReindexing(true);
    setReindexNotice(undefined);
    const response = await fetch(`/api/sessions/${sessionId}/docs/reindex`, { method: "POST" });
    const data = await readJson<DocContent>(response);
    setReindexing(false);
    if (!response.ok) {
      setReindexNotice(data.error ?? "색인을 갱신하지 못했습니다");
      return;
    }
    setReindexNotice("docs/README.md 색인을 갱신했습니다");
    setRevision((value) => value + 1);
    setSelected(data.path);
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-56 shrink-0 flex-col border-r border-line bg-panel">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <p className="text-sm font-medium text-ink">문서</p>
          {access.canManage && (
            <button type="button" onClick={() => setCreating(true)} className="ml-auto shrink-0 rounded-control border border-line px-2 py-0.5 text-xs font-medium hover:border-ink">
              새 문서
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!tree ? (
            <p className="px-3 py-2 text-sm text-muted">불러오는 중</p>
          ) : tree.error ? (
            <p className="px-3 py-2 text-sm text-fail">{tree.error}</p>
          ) : tree.data!.docs.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted">아직 문서가 없습니다.</p>
          ) : (
            <ul className="py-1">
              {tree.data!.docs.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    onClick={() => setSelected(entry.path)}
                    title={entry.path}
                    className={`block w-full truncate px-3 py-1.5 text-left text-sm ${
                      selected === entry.path ? "bg-ground font-medium text-ink" : "text-muted hover:text-ink"
                    }`}
                  >
                    {entry.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {access.canManage && (
          <div className="border-t border-line px-3 py-2">
            <button type="button" onClick={() => void reindex()} disabled={reindexing} className="text-xs font-medium text-muted hover:text-ink disabled:opacity-50">
              {reindexing ? "갱신하는 중" : "색인 갱신"}
            </button>
            {reindexNotice && <p className="mt-1 text-xs text-muted">{reindexNotice}</p>}
          </div>
        )}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {!selected ? (
          <p className="px-4 py-3 text-sm text-muted">왼쪽에서 문서를 고르세요.</p>
        ) : (
          <DocViewer
            // selected가 바뀌면 통째로 다시 마운트해, 이전 문서의 내용·편집 상태를 그대로 들고 있지 않게 한다
            // (useEffect 안에서 직접 setState로 비우는 대신 React의 리마운트로 상태를 자연스럽게 초기화한다)
            key={selected}
            sessionId={sessionId}
            path={selected}
            canManage={access.canManage}
            onSaved={() => setRevision((value) => value + 1)}
          />
        )}
      </div>
      {creating && (
        <NewDocDialog
          sessionId={sessionId}
          onCreated={(path) => {
            setCreating(false);
            setRevision((value) => value + 1);
            setSelected(path);
          }}
          onCancel={() => setCreating(false)}
        />
      )}
    </div>
  );
}

/**
 * 문서 하나의 미리보기·편집. DocsPanel이 `key={path}`로 그려 path가 바뀔 때마다 통째로 다시 마운트한다 —
 * 그래서 이 컴포넌트 자신은 "이전 문서" 상태를 지울 일이 없다(마운트 때 한 번만 불러온다).
 */
function DocViewer({ sessionId, path, canManage, onSaved }: { sessionId: string; path: string; canManage: boolean; onSaved: () => void }) {
  const [doc, setDoc] = useState<{ data?: DocContent; error?: string }>();
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/docs/content?path=${encodeURIComponent(path)}`)
      .then(async (response) => {
        const data = await readJson<DocContent>(response);
        if (cancelled) return;
        if (!response.ok) {
          setDoc({ error: data.error ?? "문서를 불러오지 못했습니다" });
          return;
        }
        setDoc({ data });
        setDraft(data.content);
      })
      .catch(() => {
        if (!cancelled) setDoc({ error: "문서를 불러오지 못했습니다" });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, path]);

  async function save() {
    setSaving(true);
    setSaveError(undefined);
    const response = await fetch(`/api/sessions/${sessionId}/docs/content`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, content: draft }),
    });
    const data = await readJson<DocContent>(response);
    if (!response.ok) {
      setSaveError(data.error ?? "저장하지 못했습니다");
    } else {
      setDoc({ data });
      setMode("preview");
      onSaved();
    }
    setSaving(false);
  }

  if (!doc) return <p className="px-4 py-3 text-sm text-muted">불러오는 중</p>;
  if (doc.error) return <p className="px-4 py-3 text-sm text-fail">{doc.error}</p>;

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <p className="truncate font-mono text-xs text-muted" title={doc.data!.path}>
          {doc.data!.path}
        </p>
        {canManage && (
          <div className="glass-soft ml-auto inline-flex shrink-0 rounded-control p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setMode("preview")}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors ${mode === "preview" ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"}`}
            >
              미리보기
            </button>
            <button
              type="button"
              onClick={() => setMode("edit")}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors ${mode === "edit" ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"}`}
            >
              편집
            </button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {mode === "edit" ? (
          <div className="flex h-full flex-col gap-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-0 flex-1 resize-none rounded-control border border-line bg-ground p-3 font-mono text-sm leading-6"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving}
                className="rounded-control bg-ink px-3 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
              >
                {saving ? "저장하는 중" : "저장"}
              </button>
              {saveError && <p className="text-sm text-fail">{saveError}</p>}
            </div>
          </div>
        ) : (
          <Markdown text={doc.data!.content} />
        )}
      </div>
    </>
  );
}

/** "새 문서" 작은 다이얼로그: 템플릿 종류와 제목을 고르면 다음 번호의 설계 문서·ADR을 만들거나 트러블슈팅·로드맵 항목을 이어 붙인다 */
export function NewDocDialog({
  sessionId,
  initialKind = "design",
  initialTitle = "",
  initialBody,
  onCreated,
  onCancel,
}: {
  sessionId: string;
  initialKind?: NewDocKind;
  initialTitle?: string;
  initialBody?: string;
  onCreated: (path: string) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<NewDocKind>(initialKind);
  const [title, setTitle] = useState(initialTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function create() {
    if (!title.trim()) {
      setError("제목이 필요합니다");
      return;
    }
    setBusy(true);
    setError(undefined);
    const response = await fetch(`/api/sessions/${sessionId}/docs/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, title: title.trim(), ...(initialBody ? { body: initialBody } : {}) }),
    });
    const data = await readJson<DocContent>(response);
    setBusy(false);
    if (!response.ok) {
      setError(data.error ?? "문서를 만들지 못했습니다");
      return;
    }
    onCreated(data.path);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4">
      <div className="glass w-full max-w-md rounded-panel border border-line bg-panel p-4">
        <p className="text-sm font-medium text-ink">새 문서</p>
        <div className="mt-3 flex flex-col gap-2">
          <label className="text-xs font-medium text-muted" htmlFor="new-doc-kind">
            종류
          </label>
          <select
            id="new-doc-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as NewDocKind)}
            className="rounded-control border border-line bg-ground px-2 py-1.5 text-sm"
          >
            {(Object.keys(NEW_DOC_LABEL) as NewDocKind[]).map((option) => (
              <option key={option} value={option}>
                {NEW_DOC_LABEL[option]}
              </option>
            ))}
          </select>
          <label className="mt-1 text-xs font-medium text-muted" htmlFor="new-doc-title">
            제목
          </label>
          <input
            id="new-doc-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="rounded-control border border-line bg-ground px-2 py-1.5 text-sm"
            placeholder="예: 결제 재시도 정책"
          />
        </div>
        {error && <p className="mt-2 text-sm text-fail">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-control border border-line px-3 py-1.5 text-sm font-medium hover:border-ink">
            취소
          </button>
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy}
            className="rounded-control bg-ink px-3 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
          >
            {busy ? "만드는 중" : "만들기"}
          </button>
        </div>
      </div>
    </div>
  );
}
