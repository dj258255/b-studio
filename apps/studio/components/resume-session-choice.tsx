"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { describeFailedResponse } from "@/lib/fetch-error";
import { relativeTime } from "@/lib/project-menu";
import type { ProjectSummary } from "@/lib/studio-events";

interface Opened {
  id: string;
}

/**
 * 첫 화면(`/`)에서 마지막 프로젝트의 세션이 지연 기동이거나 중지돼 있을 때 보여준다(ADR-103). 서버를 막
 * 재시작하면 켜져 있던 세션도 모두 중지로 보이는데, 예전처럼 화면을 열자마자 곧바로 되살려 샌드박스를 켜면
 * 사실은 다른 프로젝트로 시작하려던 사람에게 헛된 기동이다 — 여기서는 "이어서 열기"를 눌러야만 켠다.
 * "다른 프로젝트로 시작"을 누르면 프로젝트 목록에서 골라 그 프로젝트의 첫 화면(`/?project=`)으로 다시 간다.
 */
export function ResumeSessionChoice({ projectId, projectName, updatedAt }: { projectId: string; projectName: string; updatedAt: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pickingProject, setPickingProject] = useState(false);
  const [projects, setProjects] = useState<ProjectSummary[]>();

  async function resume() {
    setBusy(true);
    setError(undefined);
    const response = await fetch("/api/workspace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    }).catch(() => undefined);
    const body = response ? ((await response.json().catch(() => ({}))) as Partial<Opened> & { error?: string }) : {};
    if (!response?.ok || !body.id) {
      setBusy(false);
      setError(body.error ?? describeFailedResponse(response, "개발 화면을 열지 못했습니다"));
      return;
    }
    router.push(`/sessions/${body.id}`);
  }

  // 누를 때 한 번만 받는다 — 목록이 자주 바뀌지 않는다
  function openProjectPicker() {
    setPickingProject(true);
    if (projects) return;
    fetch("/api/projects", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : []))
      .then((list: ProjectSummary[]) => setProjects(list))
      .catch(() => setProjects([]));
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-semibold text-muted">b-studio</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">이어서 여시겠어요?</h1>
      <p className="mt-3 text-sm leading-6 text-muted" aria-live="polite">
        마지막으로 쓰던 프로젝트 <span className="font-medium text-ink">{projectName}</span>의 세션이 꺼져 있습니다 ({relativeTime(updatedAt)}). 이어서 열면 그 자리에서 샌드박스를 다시
        켭니다.
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-fail">
          {error}
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => void resume()}
          className="rounded-control bg-ink px-4 py-2 text-sm font-semibold text-panel hover:bg-ink/85 disabled:opacity-60"
        >
          {busy ? "여는 중" : "이어서 열기"}
        </button>
        <button type="button" onClick={openProjectPicker} className="glass-soft rounded-control px-4 py-2 text-sm font-medium hover:bg-panel">
          다른 프로젝트로 시작
        </button>
      </div>
      {pickingProject && (
        <div className="glass-soft mt-4 rounded-panel p-2">
          {!projects ? (
            <p className="px-2 py-1.5 text-sm text-muted">불러오는 중</p>
          ) : projects.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted">열 수 있는 프로젝트가 없습니다</p>
          ) : (
            <ul>
              {projects.map((project) => (
                <li key={project.id}>
                  <Link href={`/?project=${encodeURIComponent(project.id)}`} className="block truncate rounded-control px-2 py-1.5 text-sm hover:bg-panel">
                    {project.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </main>
  );
}
