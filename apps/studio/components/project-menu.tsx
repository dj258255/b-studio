"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { recentSessionsFor, selectableProjects } from "@/lib/project-menu";
import type { ProjectSummary, SessionSummary } from "@/lib/studio-events";
import { OpenFolderModal } from "./open-folder-modal";

const RECENT_LIMIT = 5;

interface MenuCapabilities {
  openFolder?: boolean;
}

/**
 * 개발 화면 머리의 프로젝트 메뉴(ADR-070). 프로젝트 이름을 누르면 팝오버가 열려 다른 프로젝트로 바꾸거나, 폴더를 열거나,
 * 이 프로젝트로 새 대화를 시작하거나, 최근 세션·토큰 보고서로 간다. 새로 시작 화면(`/start`)이 하던 일을 여기 하나로
 * 모았다 — 화면을 옮기지 않고 개발 화면 머리에서 고른다.
 */
export function ProjectMenu({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [open, setOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-baseline gap-1 rounded-control hover:text-ink/75"
      >
        {projectName}
        <span aria-hidden className="text-xs text-muted">▾</span>
      </button>
      {open && (
        <ProjectMenuPopover
          anchor={buttonRef}
          projectId={projectId}
          onClose={() => setOpen(false)}
          onOpenFolder={() => {
            setOpen(false);
            setFolderOpen(true);
          }}
        />
      )}
      {folderOpen && <OpenFolderModal onClose={() => setFolderOpen(false)} />}
    </>
  );
}

function ProjectMenuPopover({
  anchor,
  projectId,
  onClose,
  onOpenFolder,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  projectId: string;
  onClose: () => void;
  onOpenFolder: () => void;
}) {
  const router = useRouter();
  // 여는 자리는 눌린 버튼 바로 아래. body로 포털하므로 화면 좌표(fixed)로 잡는다. 버튼은 이미 그려져 있어(눌러야 여니까)
  // 처음 그릴 때 한 번 읽으면 된다 — 나중에 바뀌는 값을 구독하는 것이 아니라 여는 자리를 한 번 정하는 것이라 effect가 아니다
  const [position] = useState<{ top: number; left: number }>(() => {
    const box = anchor.current?.getBoundingClientRect();
    return box ? { top: box.bottom + 8, left: box.left } : { top: 0, left: 0 };
  });
  const [projects, setProjects] = useState<ProjectSummary[]>();
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const [capabilities, setCapabilities] = useState<MenuCapabilities>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 여는 순간 한 번만 받는다. 목록이 자주 안 바뀌는 데다, 열 때마다 다시 여니 오래 들고 있을 일이 없다
  useEffect(() => {
    let cancelled = false;
    const getJson = (url: string) => fetch(url, { cache: "no-store" }).then((response) => (response.ok ? response.json() : undefined));
    Promise.all([
      getJson("/api/projects"),
      getJson(`/api/sessions?projectId=${encodeURIComponent(projectId)}&limit=${RECENT_LIMIT}`),
      getJson("/api/capabilities"),
    ])
      .then(([projectList, sessionList, caps]: [ProjectSummary[] | undefined, SessionSummary[] | undefined, MenuCapabilities | undefined]) => {
        if (cancelled) return;
        setProjects(projectList ?? []);
        setSessions(sessionList ?? []);
        setCapabilities(caps);
      })
      .catch(() => {
        if (!cancelled) setError("프로젝트 목록을 불러오지 못했습니다");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function startNewChat() {
    setCreating(true);
    setError(undefined);
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, workspace: "copy" }),
    }).catch(() => undefined);
    const body = response ? ((await response.json().catch(() => ({}))) as { id?: string; error?: string }) : {};
    if (!response?.ok || typeof body.id !== "string") {
      setCreating(false);
      setError(body.error ?? "세션을 만들지 못했습니다");
      return;
    }
    router.push(`/sessions/${body.id}`);
  }

  const usable = projects && selectableProjects(projects, projectId);
  const recent = sessions && recentSessionsFor(sessions, projectId, RECENT_LIMIT);

  return createPortal(
    <div className="fixed inset-0 z-40">
      {/* 바깥을 누르면 닫는다. 팝오버 자신은 이 뒤(DOM 순서상 위)에 그려 클릭이 여기로 새지 않는다 */}
      <button type="button" aria-label="메뉴 닫기" onClick={onClose} className="absolute inset-0 cursor-default bg-transparent" />
      <div
        role="menu"
        aria-label="프로젝트 메뉴"
        style={{ top: position.top, left: position.left }}
        className="glass fixed max-h-[calc(100vh-2rem)] w-72 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-panel p-2 text-sm shadow-xl"
      >
        <p className="px-2 pb-1 pt-1 text-xs font-medium text-muted">프로젝트</p>
        {!usable ? (
          <p className="px-2 py-1.5 text-muted">불러오는 중</p>
        ) : usable.length === 0 ? (
          <p className="px-2 py-1.5 text-muted">열 수 있는 프로젝트가 없습니다</p>
        ) : (
          <ul>
            {usable.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/?project=${encodeURIComponent(project.id)}`}
                  role="menuitem"
                  onClick={onClose}
                  className={`flex items-center gap-1.5 rounded-control px-2 py-1.5 hover:bg-panel ${project.id === projectId ? "font-semibold text-ink" : ""}`}
                >
                  <span aria-hidden className="w-3 shrink-0 text-center">
                    {project.id === projectId ? "✓" : ""}
                  </span>
                  <span className="min-w-0 truncate">{project.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        <div className="my-2 border-t border-line" />

        <div className="flex flex-col">
          {capabilities?.openFolder && (
            <button type="button" role="menuitem" onClick={onOpenFolder} className="rounded-control px-2 py-1.5 text-left hover:bg-panel">
              폴더 열기…
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={creating}
            onClick={() => void startNewChat()}
            className="rounded-control px-2 py-1.5 text-left hover:bg-panel disabled:opacity-50"
          >
            {creating ? "만드는 중" : "새 대화로 시작"}
          </button>
          <Link
            href={`/projects/${encodeURIComponent(projectId)}/tokens`}
            role="menuitem"
            onClick={onClose}
            className="rounded-control px-2 py-1.5 hover:bg-panel"
          >
            토큰 보고서
          </Link>
        </div>

        {error && (
          <p role="alert" className="mt-1 px-2 text-xs text-fail">
            {error}
          </p>
        )}

        {recent && recent.length > 0 && (
          <>
            <div className="my-2 border-t border-line" />
            <p className="px-2 pb-1 text-xs font-medium text-muted">최근 세션</p>
            <ul>
              {recent.map((session) => (
                <li key={session.id}>
                  <Link href={`/sessions/${session.id}`} role="menuitem" onClick={onClose} className="block truncate rounded-control px-2 py-1.5 hover:bg-panel">
                    {session.lastRequest ?? "아직 보낸 요청이 없습니다"}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
