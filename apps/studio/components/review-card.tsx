"use client";

import { useState } from "react";
import type { PrReviewFinding } from "@b-studio/agent";
import type { ReviewStateView } from "@/lib/studio-events";
import { useChatDraft } from "./chat-draft-context";

const SEVERITY_LABEL: Record<string, string> = { blocker: "차단", major: "주요", minor: "경미", nit: "사소" };
const STATE_LABEL: Record<string, string> = {
  running: "진행 중",
  passed: "사람 검토 대기(리뷰 통과)",
  capped: "사람 검토 대기(라운드 상한)",
  resolved: "사람이 확인함",
  stopped: "멈춤",
};
const STATE_CLASS: Record<string, string> = { running: "text-wait", passed: "text-pass", capped: "text-wait", resolved: "text-pass", stopped: "text-fail" };
const ROUND_STATUS_LABEL: Record<string, string> = {
  running: "리뷰 중",
  passed: "통과",
  blocked_continue: "차단·주요 지적, 고침 대기",
  blocked_capped: "라운드 상한",
  resolved_by_human: "사람이 확인함",
  fixing: "고치는 중",
  fix_failed: "고침 실패",
  error: "오류",
};
/** 차단 사유로 보는 심각도. packages/agent의 isBlockingFinding과 같은 기준(차단·주요만 오탐 닫기·자동 해소 대상) */
const BLOCKING_SEVERITIES = new Set(["blocker", "major"]);

/** "다음 요청으로 고치기"가 채울 글. buildPrReviewFixRequest(packages/agent)와 같은 문체지만, 모델 호출 패키지를
 * 클라이언트 번들에 끌어오지 않도록 이 컴포넌트 안에서 짧게 다시 쓴다(지적 하나만 다루므로 번호 매김이 없다) */
export function fixRequestDraft(finding: PrReviewFinding): string {
  const location = `${finding.file}${finding.line ? `:${finding.line}` : ""}`;
  const suggestion = finding.suggestion ? ` 제안: ${finding.suggestion}` : "";
  return `[b-studio AI 리뷰] 이 지적을 고쳐 주세요.\n\n\`${location}\` — ${finding.title}: ${finding.detail}${suggestion}`;
}

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
  // 저장소 상세(repository-detail.tsx)는 세션을 한 번만 fetch해 review를 들고 있어, 오탐 닫기 응답이 SSE 없이도
  // 바로 반영되도록 로컬로 덮어쓴다. 실시간 구독이 있는 화면(repository-bar.tsx)은 새 prop이 오면 그대로 따라간다.
  // prop이 바뀌면 렌더 중에 바로 맞춘다(리액트가 권하는 "프롭이 바뀌면 상태를 조정" 패턴 — useEffect로 하면 한 번 더
  // 그리고 나서 고쳐 그리므로 렌더 중 setState로 그 왕복을 없앤다)
  const [localReview, setLocalReview] = useState(review);
  const [prevReviewProp, setPrevReviewProp] = useState(review);
  if (review !== prevReviewProp) {
    setPrevReviewProp(review);
    setLocalReview(review);
  }
  const [resolving, setResolving] = useState<string>(); // `${round}-${index}` — 오탐 닫기 이유 입력창이 열린 지적
  const [reason, setReason] = useState("");
  const draft = useChatDraft();

  if (!hasPullRequest) return null;
  const effectiveReview = localReview;

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

  async function resolveFinding(round: number, findingIndex: number) {
    const trimmed = reason.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/review/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ round, findingIndex, reason: trimmed }),
      });
      if (!response.ok) {
        setError((await response.json()).error ?? "오탐으로 닫지 못했습니다");
        return;
      }
      const data = (await response.json()) as { review?: ReviewStateView };
      if (data.review) setLocalReview(data.review);
      setResolving(undefined);
      setReason("");
    } catch (thrown) {
      setError(String(thrown));
    } finally {
      setBusy(false);
    }
  }

  const running = effectiveReview?.state === "running";
  const canRun = canManage && !running && !busy;
  const finished = effectiveReview !== undefined && effectiveReview.state !== "running";

  return (
    <div className="mt-3 rounded-panel border border-line bg-panel p-3" aria-label="AI 리뷰">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">AI 리뷰</p>
        {effectiveReview ? (
          <span className={`text-sm ${STATE_CLASS[effectiveReview.state] ?? "text-muted"}`}>{STATE_LABEL[effectiveReview.state] ?? effectiveReview.state}</span>
        ) : (
          <span className="text-sm text-muted">아직 돌리지 않았습니다</span>
        )}
      </div>

      {effectiveReview && effectiveReview.rounds.length > 0 && (
        <ul className="mt-2 space-y-2">
          {effectiveReview.rounds.map((round) => {
            const counts = { blocker: 0, major: 0, minor: 0, nit: 0 } as Record<string, number>;
            for (const finding of round.findings ?? []) counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
            const isOpen = expanded === round.round;
            const tokenTotal = round.tokens ? round.tokens.inputTokens + round.tokens.outputTokens + round.tokens.cacheReadTokens + round.tokens.cacheWriteTokens : undefined;
            return (
              <li key={round.round} className="rounded-control border border-line px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    라운드 {round.round}/{effectiveReview.maxRounds} · 차단 {counts.blocker} · 주요 {counts.major} · 경미 {counts.minor} · 사소 {counts.nit}
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
                        {round.findings!.map((finding, index) => {
                          const key = `${round.round}-${index}`;
                          const resolution = round.humanResolutions?.[index];
                          const blocking = BLOCKING_SEVERITIES.has(finding.severity);
                          return (
                            <li key={index} className="rounded-control border border-line px-2 py-1">
                              <span className="font-medium">{SEVERITY_LABEL[finding.severity] ?? finding.severity}</span>{" "}
                              <span className="font-mono text-xs">
                                {finding.file}
                                {finding.line ? `:${finding.line}` : ""}
                              </span>
                              <p>{finding.title}</p>
                              <p className="text-xs text-muted">{finding.detail}</p>
                              {finding.suggestion && <p className="text-xs text-muted">제안: {finding.suggestion}</p>}
                              {resolution ? (
                                <p className="mt-1 text-xs text-pass">사람이 확인함: {resolution.reason}</p>
                              ) : (
                                canManage && (
                                  <div className="mt-1 flex flex-wrap items-center gap-2">
                                    <button
                                      type="button"
                                      onClick={() => draft.fill(fixRequestDraft(finding))}
                                      className="rounded-control border border-line px-2 py-0.5 text-xs hover:border-ink"
                                    >
                                      다음 요청으로 고치기
                                    </button>
                                    {blocking && (
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setResolving(resolving === key ? undefined : key);
                                          setReason("");
                                        }}
                                        className="rounded-control border border-line px-2 py-0.5 text-xs hover:border-ink"
                                      >
                                        오탐으로 닫기
                                      </button>
                                    )}
                                  </div>
                                )
                              )}
                              {resolving === key && (
                                <div className="mt-1 flex flex-wrap items-center gap-2">
                                  <input
                                    type="text"
                                    value={reason}
                                    onChange={(event) => setReason(event.target.value)}
                                    placeholder="오탐으로 보는 이유(예: 실제 PostgreSQL에서 새 글 id 43·44 확인)"
                                    className="min-w-0 flex-1 rounded-control border border-line bg-panel px-2 py-1 text-xs"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => void resolveFinding(round.round, index)}
                                    disabled={busy || !reason.trim()}
                                    className="rounded-control border border-line px-2 py-0.5 text-xs hover:border-ink disabled:opacity-50"
                                  >
                                    닫기 확인
                                  </button>
                                  <button type="button" onClick={() => setResolving(undefined)} className="text-xs text-muted hover:text-ink">
                                    취소
                                  </button>
                                </div>
                              )}
                            </li>
                          );
                        })}
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
