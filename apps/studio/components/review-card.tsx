"use client";

import { useState } from "react";
import type { ReviewStateView } from "@/lib/studio-events";

const SEVERITY_LABEL: Record<string, string> = { blocker: "차단", major: "주요", minor: "경미", nit: "사소" };
const STATE_LABEL: Record<string, string> = { running: "진행 중", passed: "사람 검토 대기(리뷰 통과)", capped: "사람 검토 대기(라운드 상한)", stopped: "멈춤" };
const STATE_CLASS: Record<string, string> = { running: "text-wait", passed: "text-pass", capped: "text-wait", stopped: "text-fail" };
const ROUND_STATUS_LABEL: Record<string, string> = {
  running: "리뷰 중",
  passed: "통과",
  blocked_continue: "차단·주요 지적, 고침 대기",
  blocked_capped: "라운드 상한",
  fixing: "고치는 중",
  fix_failed: "고침 실패",
  error: "오류",
};

/**
 * PR 자동 리뷰 라운드(ADR-074) 카드. 라운드별 지적 건수·토큰·코멘트 링크를 보여주고,
 * "AI 리뷰 돌리기"(처음)·"다시 돌리기"(끝난 뒤 처음부터)로 사람이 직접 부른다.
 */
export function ReviewCard({
  sessionId,
  review,
  canManage,
  hasPullRequest,
}: {
  sessionId: string;
  review?: ReviewStateView;
  canManage: boolean;
  hasPullRequest: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<number>();

  if (!hasPullRequest) return null;

  async function run(restart: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ restart }),
      });
      if (!response.ok) setError((await response.json()).error ?? "AI 리뷰를 돌리지 못했습니다");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  const running = review?.state === "running";
  const canRun = canManage && !running && !busy;
  const finished = review !== undefined && review.state !== "running";

  return (
    <div className="mt-3 rounded-panel border border-line bg-panel p-3" aria-label="AI 리뷰">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">AI 리뷰</p>
        {review ? (
          <span className={`text-sm ${STATE_CLASS[review.state] ?? "text-muted"}`}>{STATE_LABEL[review.state] ?? review.state}</span>
        ) : (
          <span className="text-sm text-muted">아직 돌리지 않았습니다</span>
        )}
      </div>

      {review && review.rounds.length > 0 && (
        <ul className="mt-2 space-y-2">
          {review.rounds.map((round) => {
            const counts = { blocker: 0, major: 0, minor: 0, nit: 0 } as Record<string, number>;
            for (const finding of round.findings ?? []) counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
            const isOpen = expanded === round.round;
            const tokenTotal = round.tokens ? round.tokens.inputTokens + round.tokens.outputTokens + round.tokens.cacheReadTokens + round.tokens.cacheWriteTokens : undefined;
            return (
              <li key={round.round} className="rounded-control border border-line px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    라운드 {round.round}/{review.maxRounds} · 차단 {counts.blocker} · 주요 {counts.major} · 경미 {counts.minor} · 사소 {counts.nit}
                  </span>
                  <span className="text-xs text-muted">{ROUND_STATUS_LABEL[round.status] ?? round.status}</span>
                </div>
                {tokenTotal !== undefined && <p className="mt-1 text-xs text-muted">리뷰어 토큰 {tokenTotal.toLocaleString()}</p>}
                {round.commentUrl && (
                  <a href={round.commentUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-muted hover:text-ink">
                    PR 코멘트 보기
                  </a>
                )}
                {round.commentError && <p className="mt-1 text-xs text-fail">코멘트를 남기지 못했습니다: {round.commentError}</p>}
                {round.error && <p className="mt-1 text-xs text-fail">{round.error}</p>}
                {(round.findings?.length ?? 0) > 0 && (
                  <>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => setExpanded(isOpen ? undefined : round.round)}
                      className="mt-1 rounded-control text-xs text-muted hover:text-ink"
                    >
                      {isOpen ? "지적 접기" : "지적 펼치기"}
                    </button>
                    {isOpen && (
                      <ul className="mt-1 space-y-1">
                        {round.findings!.map((finding, index) => (
                          <li key={index} className="rounded-control border border-line px-2 py-1">
                            <span className="font-medium">{SEVERITY_LABEL[finding.severity] ?? finding.severity}</span>{" "}
                            <span className="font-mono text-xs">
                              {finding.file}
                              {finding.line ? `:${finding.line}` : ""}
                            </span>
                            <p>{finding.title}</p>
                            <p className="text-xs text-muted">{finding.detail}</p>
                            {finding.suggestion && <p className="text-xs text-muted">제안: {finding.suggestion}</p>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void run(finished)}
          disabled={!canRun}
          className="rounded-control border border-line px-3.5 py-1.5 text-sm font-medium hover:border-ink disabled:opacity-50"
        >
          {running || busy ? "돌리는 중" : finished ? "다시 돌리기" : "AI 리뷰 돌리기"}
        </button>
        {error && <span className="text-sm text-fail">{error}</span>}
      </div>
    </div>
  );
}
