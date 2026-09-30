"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { IndividualReviewState, IssueDetail, PullDetail, PullFile } from "@b-studio/agent";
import type { RepositoryIssueDetailResult, RepositoryPullDetailResult } from "@/lib/server/repository-panel";
import type { SessionSnapshot } from "@/lib/studio-events";
import { useChatDraft } from "./chat-draft-context";
import { DiffView } from "./diff-view";
import { Markdown } from "./markdown";
import { CHECK_LABEL, CHECK_TONE, REASON_TEXT, REVIEW_LABEL, REVIEW_TONE, STATE_DOT } from "./repository-panel";
import { ReviewCard } from "./review-card";
import { useSessionAccess } from "./session-access";

const TIME = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" });

const INDIVIDUAL_REVIEW_LABEL: Record<IndividualReviewState, string> = {
  approved: "승인",
  changes_requested: "변경 요청",
  commented: "코멘트",
  dismissed: "무시됨",
  pending: "대기 중",
  unknown: "-",
};
const INDIVIDUAL_REVIEW_TONE: Record<IndividualReviewState, string> = {
  approved: "text-pass",
  changes_requested: "text-fail",
  commented: "text-muted",
  dismissed: "text-muted",
  pending: "text-wait",
  unknown: "text-muted",
};

/**
 * 이슈·PR 상세 옆 패널의 공통 껍데기(ADR-081). WorkDrawer와 같은 이유로 body에 포털로 그린다 —
 * 머리의 유리 효과(backdrop-filter)가 안쪽 fixed 요소의 기준을 머리로 바꿔 패널이 머리 안에 갇혔다.
 */
function DetailDrawer({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-labelledby="repo-detail-title">
      <button type="button" aria-label="닫기" onClick={onClose} className="absolute inset-0 bg-ink/15" />
      <aside className="glass absolute inset-y-2 right-2 flex w-[min(44rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-panel shadow-xl">
        <header className="flex items-start gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="repo-detail-title" className="truncate text-lg font-semibold">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 truncate text-xs text-muted" title={subtitle}>
                {subtitle}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="glass-soft shrink-0 rounded-control px-3 py-1 text-sm font-medium hover:bg-panel">
            닫기
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold">{children}</h3>;
}

/**
 * 이슈 상세 내용(데이터를 이미 받은 뒤). 렌더링만 하는 순수 컴포넌트라 서버 렌더 테스트로 확인할 수 있다
 * (포털·fetch를 쓰는 IssueDetailPanel은 이 컴포넌트를 데이터가 오면 그린다).
 */
export function IssueDetailBody({ issue, canManage, onWork }: { issue: IssueDetail; canManage: boolean; onWork: (taskItem?: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span aria-hidden className={`inline-block size-2 rounded-full ${STATE_DOT[issue.state]}`} />
        <span>{issue.state === "open" ? "열림" : "닫힘"}</span>
        <span>· {issue.author}</span>
        <span>· {TIME.format(new Date(issue.updatedAt))}</span>
        {issue.assignees.length > 0 && <span>· 담당 {issue.assignees.join(", ")}</span>}
      </div>

      {issue.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {issue.labels.map((label) => (
            <span key={label} className="glass-soft rounded-control px-1.5 py-0.5 text-xs text-muted">
              {label}
            </span>
          ))}
        </div>
      )}

      {issue.taskList.total > 0 && (
        <p className="text-sm font-medium">
          체크리스트 {issue.taskList.checked}/{issue.taskList.total}
        </p>
      )}

      <Markdown text={issue.body?.trim() || "_본문이 없습니다._"} />

      {canManage && issue.taskList.items.some((item) => !item.checked) && (
        <div>
          <SectionTitle>항목별로 작업 맡기기</SectionTitle>
          <ul className="mt-1.5 space-y-1">
            {issue.taskList.items
              .filter((item) => !item.checked)
              .map((item, index) => (
                <li key={index} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 flex-1 truncate">{item.text}</span>
                  <button
                    type="button"
                    onClick={() => onWork(item.text)}
                    className="shrink-0 rounded-control border border-line px-2 py-0.5 text-xs font-medium hover:border-ink"
                  >
                    체크리스트 항목으로 작업
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}

      {issue.linkedPulls.length > 0 && (
        <div>
          <SectionTitle>연결된 PR</SectionTitle>
          <ul className="mt-1.5 space-y-1">
            {issue.linkedPulls.map((pull) => (
              <li key={pull.number}>
                <a href={pull.url} target="_blank" rel="noreferrer" className="text-sm hover:underline">
                  <span aria-hidden className={`mr-1 inline-block size-2 rounded-full ${STATE_DOT[pull.state]}`} />
                  #{pull.number} {pull.title}
                  {pull.draft && <span className="text-muted"> (초안)</span>}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <SectionTitle>
          댓글 {issue.totalComments}개{issue.commentsTruncated ? ` (최근 ${issue.comments.length}개만 보여줍니다)` : ""}
        </SectionTitle>
        {issue.comments.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted">아직 댓글이 없습니다.</p>
        ) : (
          <ul className="mt-1.5 space-y-2">
            {issue.comments.map((comment, index) => (
              <li key={index} className="rounded-control border border-line px-3 py-2">
                <p className="text-xs text-muted">
                  {comment.author} · {TIME.format(new Date(comment.createdAt))}
                </p>
                <div className="mt-1 text-sm">
                  <Markdown text={comment.body.trim() || "_내용이 없습니다._"} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {canManage && (
        <button type="button" onClick={() => onWork()} className="rounded-control bg-ink px-3.5 py-1.5 text-sm font-medium text-panel hover:bg-ink/85">
          이 이슈로 작업
        </button>
      )}
    </div>
  );
}

/**
 * 이슈 상세 옆 패널(ADR-081). projectId·number로 상세를 불러와 IssueDetailBody에 넘긴다.
 * 호출부(repository-panel.tsx)가 number를 key로 줘서, 다른 이슈를 열면 이 컴포넌트를 통째로 새로 마운트한다
 * (목록의 상태 필터가 key={state}로 다시 그리는 것과 같은 이유 — effect 안에서 "불러오는 중"으로 되돌리는 setState를 하지 않아도 된다)
 */
export function IssueDetailPanel({ projectId, number, onClose }: { projectId: string; number: number; onClose: () => void }) {
  const [loaded, setLoaded] = useState<{ result?: RepositoryIssueDetailResult; error?: string }>();
  const access = useSessionAccess();
  const draft = useChatDraft();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/repository/issues/${number}`)
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as RepositoryIssueDetailResult & { error?: string };
        if (!cancelled) setLoaded(response.ok ? { result: data } : { error: data.error ?? "이슈를 불러오지 못했습니다" });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ error: "이슈를 불러오지 못했습니다" });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, number]);

  const issue = loaded?.result?.issue;

  function workOnIssue(taskItem?: string) {
    if (!issue) return;
    const excerpt = issue.body?.trim().slice(0, 1_000);
    const suffix = taskItem ? `\n\n체크리스트에서 이 항목을 처리해줘: ${taskItem}` : "";
    draft.fill(`#${issue.number} 이슈를 해결해줘: ${issue.title}${excerpt ? `\n\n${excerpt}` : ""}${suffix}`);
    onClose();
  }

  return (
    <DetailDrawer title={issue ? `#${issue.number} ${issue.title}` : `이슈 #${number}`} subtitle={issue?.url} onClose={onClose}>
      {!loaded ? (
        <p className="text-sm text-muted">불러오는 중</p>
      ) : loaded.error ? (
        <p className="text-sm text-fail">{loaded.error}</p>
      ) : !loaded.result?.ok || !issue ? (
        <p className="text-sm leading-6 text-muted">{REASON_TEXT[loaded.result?.reason ?? "error"](loaded.result?.detail ?? "이유를 알 수 없습니다")}</p>
      ) : (
        <IssueDetailBody issue={issue} canManage={access.canManage} onWork={workOnIssue} />
      )}
    </DetailDrawer>
  );
}

/** PR 파일 하나. 눌러서 펼치면 기록 탭·나란히 보기와 같은 DiffView로 unified diff를 보여준다 */
function FileEntry({ file }: { file: PullFile }) {
  const [open, setOpen] = useState(false);
  const canExpand = Boolean(file.patch);
  return (
    <li className="rounded-control border border-line">
      <button
        type="button"
        onClick={() => canExpand && setOpen((value) => !value)}
        disabled={!canExpand}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 text-left text-sm disabled:cursor-default"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{file.path}</span>
        <span className="shrink-0 text-xs text-pass">+{file.additions}</span>
        <span className="shrink-0 text-xs text-fail">-{file.deletions}</span>
        {file.binary && <span className="shrink-0 text-xs text-muted">이진 파일</span>}
        {file.truncated && <span className="shrink-0 rounded-control bg-wait/15 px-1.5 py-0.5 text-xs text-wait">잘림</span>}
      </button>
      {open && file.patch && (
        <div className="border-t border-line p-1">
          <DiffView patch={`diff --git a/${file.path} b/${file.path}\n${file.patch}`} />
        </div>
      )}
    </li>
  );
}

/**
 * PR 상세 내용(데이터를 이미 받은 뒤). 렌더링만 하는 순수 컴포넌트라 서버 렌더 테스트로 확인할 수 있다.
 * "확인" 액션: 요구 사항 대조(연결된 이슈의 체크리스트를 모아 대화 요청으로 채운다)와 PR 브랜치로 작업(둘 다 채우기만 하고 보내지 않는다).
 * "세션에서 다시 검증"은 세션에 그 기능(게이트를 처음부터 다시 돌리는 진입점)이 아직 없어 넣지 않았다.
 */
export function PullDetailBody({
  pull,
  remoteWebUrl,
  session,
  canManage,
  matchBusy,
  matchError,
  onMatchRequirements,
  onWorkOnBranch,
}: {
  pull: PullDetail;
  remoteWebUrl?: string;
  session?: SessionSnapshot;
  canManage: boolean;
  matchBusy: boolean;
  matchError?: string;
  onMatchRequirements: () => void;
  onWorkOnBranch: () => void;
}) {
  const groupedReviewComments = Object.entries(
    pull.reviewComments.reduce<Record<string, typeof pull.reviewComments>>((groups, comment) => {
      (groups[comment.path] ??= []).push(comment);
      return groups;
    }, {}),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span aria-hidden className={`inline-block size-2 rounded-full ${STATE_DOT[pull.state]}`} />
        <span>
          {pull.state === "open" ? "열림" : "닫힘"}
          {pull.draft && " · 초안"}
        </span>
        <span>· {pull.author}</span>
        <span>· {TIME.format(new Date(pull.updatedAt))}</span>
        {pull.sessionId && (
          <a href={`/sessions/${pull.sessionId}`} className="glass-soft rounded-control px-1.5 py-0.5 font-medium text-muted hover:text-ink">
            b-studio 세션
          </a>
        )}
      </div>

      <p className="font-mono text-sm">
        {pull.baseBranch} ← {pull.headBranch}
      </p>
      {pull.mergeableState && <p className="text-xs text-muted">병합 상태: {pull.mergeableState}</p>}

      {(pull.checkStatus !== undefined || pull.reviewDecision !== undefined) && (
        <p className="text-sm">
          {pull.checkStatus !== undefined && <span className={`font-medium ${CHECK_TONE[pull.checkStatus]}`}>CI {CHECK_LABEL[pull.checkStatus]}</span>}
          {pull.checkStatus !== undefined && pull.reviewDecision !== undefined && " · "}
          {pull.reviewDecision !== undefined && (
            <span className={`font-medium ${REVIEW_TONE[pull.reviewDecision]}`}>리뷰 {REVIEW_LABEL[pull.reviewDecision]}</span>
          )}
        </p>
      )}

      {pull.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {pull.labels.map((label) => (
            <span key={label} className="glass-soft rounded-control px-1.5 py-0.5 text-xs text-muted">
              {label}
            </span>
          ))}
        </div>
      )}

      <Markdown text={pull.body?.trim() || "_설명이 없습니다._"} />

      {pull.linkedIssues.length > 0 && (
        <div>
          <SectionTitle>연결된 이슈</SectionTitle>
          <ul className="mt-1.5 space-y-1">
            {pull.linkedIssues.map((issueNumber) =>
              remoteWebUrl ? (
                <li key={issueNumber}>
                  <a href={`${remoteWebUrl}/issues/${issueNumber}`} target="_blank" rel="noreferrer" className="text-sm hover:underline">
                    #{issueNumber}
                  </a>
                </li>
              ) : (
                <li key={issueNumber} className="text-sm">
                  #{issueNumber}
                </li>
              ),
            )}
          </ul>
        </div>
      )}

      <div>
        <SectionTitle>CI 체크</SectionTitle>
        {!pull.checksSupported ? (
          <p className="mt-1.5 text-xs leading-5 text-muted">{pull.checksUnsupportedReason}</p>
        ) : pull.checkRuns.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted">체크 실행이 없습니다.</p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {pull.checkRuns.map((run, index) => {
              const tone = run.status !== "completed" ? "text-wait" : run.conclusion === "success" ? "text-pass" : "text-fail";
              return (
                <li key={index} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">{run.name}</span>
                  <span className={`shrink-0 text-xs font-medium ${tone}`}>{run.status !== "completed" ? "진행 중" : (run.conclusion ?? "-")}</span>
                  {run.durationMs !== undefined && <span className="shrink-0 text-xs text-muted">{Math.round(run.durationMs / 1_000)}초</span>}
                  {run.url && (
                    <a href={run.url} target="_blank" rel="noreferrer" className="shrink-0 text-xs text-muted hover:text-ink">
                      보기
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div>
        <SectionTitle>리뷰</SectionTitle>
        {pull.reviews.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted">아직 리뷰가 없습니다.</p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {pull.reviews.map((review, index) => (
              <li key={index} className="text-sm">
                {review.author} — <span className={`font-medium ${INDIVIDUAL_REVIEW_TONE[review.state]}`}>{INDIVIDUAL_REVIEW_LABEL[review.state]}</span>
              </li>
            ))}
          </ul>
        )}
        {!pull.reviewCommentsSupported ? (
          <p className="mt-2 text-xs leading-5 text-muted">{pull.reviewCommentsUnsupportedReason}</p>
        ) : groupedReviewComments.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {groupedReviewComments.map(([path, comments]) => (
              <li key={path} className="rounded-control border border-line px-3 py-2">
                <p className="font-mono text-xs text-muted">{path}</p>
                <ul className="mt-1 space-y-1.5">
                  {comments.map((comment, index) => (
                    <li key={index} className="text-sm">
                      <span className="text-xs text-muted">
                        {comment.author}
                        {comment.line !== undefined && ` · ${comment.line}줄`}
                      </span>
                      <div className="mt-0.5">
                        <Markdown text={comment.body.trim() || "_내용이 없습니다._"} />
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div>
        <SectionTitle>
          바뀐 파일 {pull.files.length}개{pull.filesTruncated ? " (더 있습니다)" : ""}
        </SectionTitle>
        {!pull.filesSupported ? (
          <p className="mt-1.5 text-xs leading-5 text-muted">{pull.filesUnsupportedReason}</p>
        ) : pull.files.length === 0 ? (
          <p className="mt-1.5 text-sm text-muted">바뀐 파일이 없습니다.</p>
        ) : (
          <ul className="mt-1.5 space-y-1.5">
            {pull.files.map((file, index) => (
              <FileEntry key={index} file={file} />
            ))}
          </ul>
        )}
      </div>

      {pull.sessionId && <ReviewCard sessionId={pull.sessionId} review={session?.review} canManage={canManage} hasPullRequest />}

      {canManage && (
        <div className="space-y-2 border-t border-line pt-3">
          <SectionTitle>확인</SectionTitle>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onMatchRequirements}
              disabled={matchBusy}
              className="rounded-control border border-line px-3.5 py-1.5 text-sm font-medium hover:border-ink disabled:opacity-50"
            >
              {matchBusy ? "모으는 중" : "요구 사항 대조"}
            </button>
            <button type="button" onClick={onWorkOnBranch} className="rounded-control border border-line px-3.5 py-1.5 text-sm font-medium hover:border-ink">
              PR 브랜치로 작업
            </button>
          </div>
          {matchError && <p className="text-sm text-fail">{matchError}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * PR 상세 옆 패널(ADR-081). projectId·number로 상세를(필요하면 세션 스냅샷도) 불러와 PullDetailBody에 넘긴다.
 * 호출부가 number를 key로 줘서, 다른 PR을 열면 이 컴포넌트를 통째로 새로 마운트한다(IssueDetailPanel과 같은 이유)
 */
export function PullDetailPanel({ projectId, number, onClose }: { projectId: string; number: number; onClose: () => void }) {
  const [loaded, setLoaded] = useState<{ result?: RepositoryPullDetailResult; error?: string }>();
  const [session, setSession] = useState<SessionSnapshot>();
  const [matchBusy, setMatchBusy] = useState(false);
  const [matchError, setMatchError] = useState<string>();
  const access = useSessionAccess();
  const draft = useChatDraft();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/repository/pulls/${number}`)
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as RepositoryPullDetailResult & { error?: string };
        if (!cancelled) setLoaded(response.ok ? { result: data } : { error: data.error ?? "PR을 불러오지 못했습니다" });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ error: "PR을 불러오지 못했습니다" });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, number]);

  const pull = loaded?.result?.pull;
  const sessionId = pull?.sessionId;

  // AI 리뷰 카드(ReviewCard)는 세션 스냅샷의 review를 그대로 그리므로, 이 PR을 만든 세션을 따로 한 번 불러온다.
  // 세션이 없는 PR(sessionId 없음)은 session이 초기값(undefined) 그대로 남아 ReviewCard를 그리지 않는다
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}`)
      .then((response) => (response.ok ? (response.json() as Promise<SessionSnapshot>) : undefined))
      .then((data) => {
        if (!cancelled && data) setSession(data);
      })
      .catch(() => {
        // 세션을 못 찾아도(지운 세션 등) PR 상세 자체는 보여준다
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  function workOnBranch() {
    if (!pull) return;
    draft.fill(`PR #${pull.number}(${pull.title})의 브랜치 \`${pull.headBranch}\`로 이어서 작업해줘. 그 브랜치의 최신 상태를 기준으로 진행해줘.`);
    onClose();
  }

  async function matchRequirements() {
    if (!pull) return;
    setMatchBusy(true);
    setMatchError(undefined);
    try {
      const lines: string[] = [];
      for (const issueNumber of pull.linkedIssues) {
        const response = await fetch(`/api/projects/${projectId}/repository/issues/${issueNumber}`);
        const data = (await response.json().catch(() => ({}))) as RepositoryIssueDetailResult;
        if (!data.ok || !data.issue) {
          lines.push(`- #${issueNumber}: 이슈를 불러오지 못했습니다`);
          continue;
        }
        lines.push(`- #${issueNumber} ${data.issue.title}`);
        for (const item of data.issue.taskList.items) lines.push(`  - [${item.checked ? "x" : " "}] ${item.text}`);
      }
      const requirement = lines.length > 0 ? lines.join("\n") : `- PR 제목·설명 기준으로 확인: ${pull.title}`;
      draft.fill(
        `PR #${pull.number}(${pull.title})가 아래 요구 사항을 실제로 만족하는지 PR diff와 대조해서 확인해줘. 항목마다 반영 여부와 빠진 부분을 알려줘.\n\n${requirement}`,
      );
      onClose();
    } catch (reason) {
      setMatchError(String(reason));
    } finally {
      setMatchBusy(false);
    }
  }

  return (
    <DetailDrawer title={pull ? `#${pull.number} ${pull.title}` : `PR #${number}`} subtitle={pull?.url} onClose={onClose}>
      {!loaded ? (
        <p className="text-sm text-muted">불러오는 중</p>
      ) : loaded.error ? (
        <p className="text-sm text-fail">{loaded.error}</p>
      ) : !loaded.result?.ok || !pull ? (
        <p className="text-sm leading-6 text-muted">{REASON_TEXT[loaded.result?.reason ?? "error"](loaded.result?.detail ?? "이유를 알 수 없습니다")}</p>
      ) : (
        <PullDetailBody
          pull={pull}
          remoteWebUrl={loaded.result.remote?.webUrl}
          session={session}
          canManage={access.canManage}
          matchBusy={matchBusy}
          matchError={matchError}
          onMatchRequirements={() => void matchRequirements()}
          onWorkOnBranch={workOnBranch}
        />
      )}
    </DetailDrawer>
  );
}
