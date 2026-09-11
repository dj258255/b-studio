"use client";

import { useEffect, useRef, useState } from "react";
import type { DeployRelease, DeployStatus } from "@b-studio/sandbox";
import type { SessionView } from "@/lib/session-view";
import { useSessionAccess } from "./session-access";

const STATUS_LABEL: Record<DeployRelease["status"], string> = {
  active: "운영 중",
  previous: "이전",
  retired: "정리됨",
  failed: "실패",
};

const STATUS_TONE: Record<DeployRelease["status"], string> = {
  active: "text-pass",
  previous: "text-muted",
  retired: "text-muted",
  failed: "text-fail",
};

const TIME = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" });

/** 프로젝트의 운영 배포. 최신 체크포인트를 운영 이미지로 배포하고, 이전 릴리스로 되돌린다 */
export function DeployPanel({ view }: { view: SessionView }) {
  const { snapshot } = view;
  const access = useSessionAccess();
  const [status, setStatus] = useState<{ data?: DeployStatus; error?: string }>();
  const [actionError, setActionError] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const logRef = useRef<HTMLPreElement>(null);
  const deploying = snapshot.deploying;
  const head = snapshot.checkpoints[0];

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${snapshot.id}/deploys`)
      .then(async (response) => {
        const data = await response.json();
        if (!cancelled) setStatus(response.ok ? { data } : { error: data.error ?? "배포 상태를 불러오지 못했습니다" });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setStatus({ error: String(reason) });
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot.id, view.deployRevision]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [deploying?.lines.length]);

  async function post(url: string, body: unknown) {
    setActionError(undefined);
    setConfirming(undefined);
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) setActionError((await response.json().catch(() => ({}))).error ?? "시작하지 못했습니다");
  }

  const state = status?.data?.state;
  const active = state?.releases.find((release) => release.id === state.active);
  const canDeploy = access.canManage && snapshot.status === "ready" && !deploying && Boolean(head);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-semibold">운영 배포</h3>
            <p className="mt-0.5 max-w-[65ch] text-sm leading-6 text-muted">
              체크포인트를 운영 이미지로 빌드해 같은 Docker 호스트에 띄우고, 준비되면 고정 주소를 새 릴리스로 바꿉니다. DB 데이터는 배포를 바꿔도 남습니다.
            </p>
          </div>
          <button
            type="button"
            onClick={() => head && void post(`/api/sessions/${snapshot.id}/deploys`, { sha: head.sha })}
            disabled={!canDeploy}
            className="shrink-0 rounded-full bg-ink px-4 py-2 text-sm font-medium text-panel shadow-sm hover:bg-ink/85 disabled:opacity-50"
          >
            {deploying?.action === "deploy" ? "배포하는 중" : `최신 체크포인트 배포${head ? ` (${head.shortSha})` : ""}`}
          </button>
        </div>
        {actionError && <p className="mt-2 text-sm text-fail">{actionError}</p>}

        {state?.active && status?.data && (
          <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">운영 주소</dt>
            <dd className="flex flex-wrap gap-x-4 gap-y-1">
              {Object.entries(status.data.urls).map(([service, url]) => (
                <a key={service} href={url} target="_blank" rel="noreferrer" className="font-mono underline underline-offset-2">
                  {service} {url}
                </a>
              ))}
            </dd>
            <dt className="text-muted">운영 중</dt>
            <dd>
              <span className="font-mono">{state.active}</span>
              {active && <span className="text-muted">, {active.source.label}</span>}
            </dd>
            <dt className="text-muted">컨테이너</dt>
            <dd className="text-muted">
              {status.data.containers.map((container) => (
                <span key={container.name} className={`mr-3 inline-block ${container.state === "running" ? "" : "text-fail"}`}>
                  {container.name.replace(`bsd-${snapshot.projectName}-`, "")} {container.state}
                </span>
              ))}
            </dd>
          </dl>
        )}
      </div>

      {deploying && (
        <div className="border-b border-line px-4 py-3" role="status">
          <p className="text-sm text-wait motion-safe:animate-pulse">
            {deploying.action === "deploy" ? `체크포인트 ${deploying.target}를 배포하는 중` : `릴리스 ${deploying.target}로 되돌리는 중`}
          </p>
          <pre ref={logRef} className="mt-2 max-h-48 overflow-auto rounded-md border border-line bg-ground px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
            {deploying.lines.slice(-60).join("\n") || "준비하는 중"}
          </pre>
        </div>
      )}

      <div className="px-4 py-3">
        <h4 className="text-sm font-semibold">릴리스</h4>
        {status?.error && <p className="mt-2 text-sm text-fail">{status.error}</p>}
        {!status && <p className="mt-2 text-sm text-muted">배포 상태를 불러오는 중</p>}
        {state && state.releases.length === 0 && (
          <p className="mt-2 max-w-[60ch] text-sm leading-6 text-muted">
            아직 배포하지 않았습니다. 서비스 폴더마다 운영용 Dockerfile이 있어야 하고, 첫 배포는 의존성을 받느라 몇 분 걸릴 수 있습니다.
          </p>
        )}
        <ol className="mt-2 divide-y divide-line">
          {state?.releases.map((release) => (
            <li key={release.id} className="py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="min-w-0 text-sm">
                  <span className={`mr-2 font-medium ${STATUS_TONE[release.status]}`}>{STATUS_LABEL[release.status]}</span>
                  <span className="font-mono text-xs">{release.id}</span>
                  <span className="ml-2 break-words">{release.source.label}</span>
                </p>
                {release.status === "previous" &&
                  access.canManage &&
                  (confirming === release.id ? (
                    <span className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-muted">DB 마이그레이션은 되돌리지 않습니다.</span>
                      <button
                        type="button"
                        onClick={() => void post(`/api/sessions/${snapshot.id}/deploys/rollback`, { releaseId: release.id })}
                        disabled={Boolean(deploying)}
                        className="rounded-full bg-ink px-3 py-1 font-medium text-panel disabled:opacity-50"
                      >
                        되돌리기
                      </button>
                      <button type="button" onClick={() => setConfirming(undefined)} className="text-muted hover:text-ink">
                        취소
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirming(release.id)}
                      disabled={Boolean(deploying)}
                      className="rounded-full border border-line px-3 py-1 text-sm font-medium hover:border-ink disabled:opacity-50"
                    >
                      이 릴리스로 되돌리기
                    </button>
                  ))}
              </div>
              <p className="mt-0.5 text-xs text-muted">
                {TIME.format(new Date(release.createdAt))}
                {release.by && `, ${release.by}`}
              </p>
              {release.error && (
                <details className="mt-1 text-sm">
                  <summary className="cursor-pointer text-fail">{release.error}</summary>
                  {release.errorDetail && (
                    <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-line bg-ground px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
                      {release.errorDetail}
                    </pre>
                  )}
                </details>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
