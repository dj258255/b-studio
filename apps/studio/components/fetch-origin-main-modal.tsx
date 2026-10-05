"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { describeFailedResponse } from "@/lib/fetch-error";

interface RemoteMainCommit {
  shortSha: string;
  subject: string;
  author: string;
}

interface FetchOriginMainResult {
  branch: string;
  status: "up-to-date" | "fast-forwarded";
  commits: RemoteMainCommit[];
  previousShortSha: string;
  shortSha: string;
}

/**
 * 프로젝트 메뉴(ADR-070)의 "원격 main 받아오기"(ADR-101). 누르면 바로 받아온다(미리보기 단계 없음) —
 * fast-forward만 하므로 성공하면 항상 안전하고, 안 되면(갈라짐·작업 중) 이유를 그대로 보여 준다.
 */
export function FetchOriginMainModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string>();
  // 원인이 된 git 오류 원문. 화면에는 접어 두고 "자세히" 토글을 펼쳤을 때만 보여준다
  const [errorDetail, setErrorDetail] = useState<string>();
  const [result, setResult] = useState<FetchOriginMainResult>();
  // 다시 시도를 누르면 바뀌어 아래 effect를 다시 돈다
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${encodeURIComponent(projectId)}/fetch-main`, { method: "POST" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as FetchOriginMainResult & { error?: string; details?: string };
        if (cancelled) return;
        if (!response.ok) {
          setError(body.error ?? describeFailedResponse(response, "원격을 받아오지 못했습니다"));
          setErrorDetail(body.details);
          return;
        }
        setResult(body);
      })
      .catch(() => !cancelled && setError("원격을 받아오지 못했습니다"))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [projectId, attempt]);

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="fetch-origin-main">
      <button type="button" aria-label="닫기" onClick={onClose} className="absolute inset-0 bg-ink/15" />
      <div className="glass absolute left-1/2 top-[14vh] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 rounded-panel p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <h2 id="fetch-origin-main" className="text-lg font-semibold">
            원격 main 받아오기
          </h2>
          <button type="button" onClick={onClose} className="glass-soft shrink-0 rounded-control px-3 py-1 text-sm font-medium hover:bg-panel">
            닫기
          </button>
        </div>
        <div className="mt-3 text-sm">
          {busy ? (
            <p className="text-muted">받아오는 중</p>
          ) : error ? (
            <>
              <p role="alert" className="text-fail">
                {error}
              </p>
              {errorDetail && (
                <details className="mt-1 text-xs">
                  <summary className="cursor-pointer text-muted">자세히</summary>
                  <pre className="mt-1 max-h-48 overflow-auto rounded-md border border-line bg-ground px-3 py-2 font-mono leading-5 whitespace-pre-wrap break-all">
                    {errorDetail}
                  </pre>
                </details>
              )}
              <button
                type="button"
                onClick={() => {
                  // 다음 effect 실행 전에 바로 "받아오는 중"으로 보이게 한다(effect 안에서 동기로 setState하지 않는다)
                  setBusy(true);
                  setError(undefined);
                  setErrorDetail(undefined);
                  setAttempt((value) => value + 1);
                }}
                className="glass-soft mt-3 rounded-control px-3 py-1.5 text-sm font-medium hover:bg-panel"
              >
                다시 시도
              </button>
            </>
          ) : result?.status === "up-to-date" ? (
            <p>{result.branch} 브랜치가 이미 최신입니다. 받아올 커밋이 없습니다.</p>
          ) : result ? (
            <>
              <p>
                {result.branch}을(를) {result.previousShortSha}→{result.shortSha}로 받아왔습니다({result.commits.length}개 커밋).
              </p>
              <ul className="mt-2 space-y-1 font-mono text-xs leading-5 text-muted">
                {result.commits.map((commit) => (
                  <li key={commit.shortSha} className="truncate">
                    {commit.shortSha} {commit.subject} · {commit.author}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
