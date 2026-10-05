"use client";

import { useEffect, useState } from "react";
import { buildNoteSummaryRequest, buildScriptRequest, type RepeatedActionCandidate, type RepeatedActionKind } from "@/lib/repeated-actions";
import { formatTokenCount } from "@/lib/usage";
import type { RepeatedActionsReport } from "@/lib/server/repeated-actions";
import { useChatDraft } from "./chat-draft-context";

const KIND_LABEL: Record<RepeatedActionKind, string> = {
  command: "반복 명령",
  sequence: "반복 순서",
  big_read: "반복해서 크게 읽은 파일",
};

/**
 * "반복 작업" 구역(토큰 탭, ADR-077). 프로젝트의 최근 세션 기록에서 되풀이된 명령·탐색 순서·큰 파일 읽기를 찾아
 * 스크립트로 굳히거나 노트에 요약을 남기자고 제안한다. 어느 버튼도 대화를 바로 보내지 않고, 입력창에 채우기만 한다.
 */
export function RepeatedActionsSection({ projectId }: { projectId: string }) {
  const [loaded, setLoaded] = useState<{ report?: RepeatedActionsReport; error?: string }>({});
  // 무시한 후보를 화면에서 바로 지우기 위한 목록(서버는 별도 요청으로 남긴다)
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${encodeURIComponent(projectId)}/repeated-actions`, { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as { report?: RepeatedActionsReport; error?: string };
        if (cancelled) return;
        setLoaded(response.ok && data.report ? { report: data.report } : { error: data.error ?? "반복 작업을 분석하지 못했습니다" });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ error: "반복 작업을 분석하지 못했습니다" });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function ignore(candidateId: string) {
    setDismissed((current) => new Set(current).add(candidateId));
    try {
      await fetch(`/api/projects/${encodeURIComponent(projectId)}/repeated-actions/ignore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateId }),
      });
    } catch {
      // 서버에 남기지 못해도 이번 화면에서는 계속 숨긴다. 새로고침하면 다시 보일 수 있다
    }
  }

  if (loaded.error) return null; // 부가 정보라 실패해도 토큰 탭 자체를 막지 않는다
  if (!loaded.report) return <p className="px-3 py-2 text-xs text-muted">반복 작업을 분석하는 중</p>;

  const candidates = loaded.report.candidates.filter((candidate) => !dismissed.has(candidate.id));
  if (candidates.length === 0) return null;

  return (
    <section aria-labelledby="repeated-actions" className="border-b border-line bg-panel px-3 py-3">
      <h2 id="repeated-actions" className="text-sm font-semibold">
        반복 작업 {candidates.length}개
      </h2>
      <p className="mt-1 text-xs text-muted">
        최근 세션 {loaded.report.sessionsAnalyzed}개에서 되풀이된 행동입니다. 스크립트나 노트로 굳히면 다음부터는 토큰을 쓰지 않습니다.
      </p>
      <ul className="mt-2 flex flex-col gap-2">
        {candidates.map((candidate) => (
          <CandidateCard key={candidate.id} candidate={candidate} onIgnore={() => void ignore(candidate.id)} />
        ))}
      </ul>
    </section>
  );
}

export function CandidateCard({ candidate, onIgnore }: { candidate: RepeatedActionCandidate; onIgnore: () => void }) {
  const draft = useChatDraft();
  const isBigRead = candidate.kind === "big_read";

  return (
    <li className="rounded-control border border-line p-3 text-sm">
      <p className="text-xs font-medium text-muted">{KIND_LABEL[candidate.kind]}</p>
      <p className="mt-0.5">{candidate.title}</p>
      <p className="mt-1 text-xs text-muted">
        {candidate.occurrences}회 · 실행 {candidate.runCount}개 · 세션 {candidate.sessionCount}개 · 다시 읽힌 글자 {formatTokenCount(candidate.totalChars)}자
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {isBigRead ? (
          <button
            type="button"
            onClick={() => draft.fill(buildNoteSummaryRequest(candidate))}
            className="glass-soft rounded-control px-3 py-1 text-xs font-medium hover:bg-panel"
          >
            노트에 요약 남기기
          </button>
        ) : (
          <button
            type="button"
            onClick={() => draft.fill(buildScriptRequest(candidate))}
            className="glass-soft rounded-control px-3 py-1 text-xs font-medium hover:bg-panel"
          >
            스크립트로 만들기
          </button>
        )}
        <button type="button" onClick={onIgnore} className="rounded-control border border-line px-3 py-1 text-xs font-medium text-muted hover:text-ink">
          무시
        </button>
      </div>
    </li>
  );
}
