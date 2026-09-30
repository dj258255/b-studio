"use client";

import { useEffect, useState } from "react";
import type { CheckStatus, IssueSummary, PullRequestSummary, ReviewDecision } from "@b-studio/agent";
import type { RepositoryIssuesResult, RepositoryPullsResult, RepositoryQueryReason } from "@/lib/server/repository-panel";
import type { SessionView } from "@/lib/session-view";
import { useChatDraft } from "./chat-draft-context";
import { IssueDetailPanel, PullDetailPanel } from "./repository-detail";
import { useSessionAccess } from "./session-access";

type SubTab = "issues" | "pulls";
type ListState = "open" | "closed" | "all";

const SUB_TABS: Array<{ id: SubTab; label: string }> = [
  { id: "issues", label: "이슈" },
  { id: "pulls", label: "PR" },
];

const STATE_FILTERS: Array<{ id: ListState; label: string }> = [
  { id: "open", label: "열림" },
  { id: "closed", label: "닫힘" },
  { id: "all", label: "전체" },
];

const TIME = new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" });

export const REASON_TEXT: Record<RepositoryQueryReason, (detail: string) => string> = {
  no_remote: () => "이 프로젝트는 원격 저장소가 없어 이슈·PR을 볼 수 없습니다.",
  unsupported_host: (detail) => detail,
  no_token: (detail) => detail,
  rate_limited: (detail) => detail,
  error: (detail) => detail,
};

/** 개발 화면의 "저장소" 탭. 프로젝트의 원격 저장소 이슈·PR을 보여 주고, 이슈는 대화 요청으로 바로 넘길 수 있다 */
export function RepositoryPanel({ view }: { view: SessionView }) {
  const projectId = view.snapshot.projectId;
  const [subTab, setSubTab] = useState<SubTab>("issues");
  const [state, setState] = useState<ListState>("open");
  // 하위 탭·상태 필터가 바뀔 때마다 목록을 다시 그리도록 key로 새로 마운트한다(DesignPanel과 같은 방식).
  // effect 안에서 "불러오는 중"으로 되돌리는 setState를 하지 않아도 돼, 매 렌더에서 목록 하나만 그린다
  return subTab === "issues" ? (
    <IssueList key={state} projectId={projectId} state={state} subTab={subTab} onSubTab={setSubTab} onState={setState} />
  ) : (
    <PullList key={state} projectId={projectId} state={state} subTab={subTab} onSubTab={setSubTab} onState={setState} />
  );
}

/** 하위 탭·상태 필터 줄과 "GitHub·Gitea에서 열기" 링크. 두 목록이 그대로 재사용한다 */
function RepositoryToolbar({
  subTab,
  state,
  onSubTab,
  onState,
  remote,
}: {
  subTab: SubTab;
  state: ListState;
  onSubTab: (tab: SubTab) => void;
  onState: (state: ListState) => void;
  remote?: { kind: string; webUrl?: string };
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
      <div className="glass-soft inline-flex rounded-control p-0.5 text-sm" role="tablist" aria-label="저장소 보기">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={subTab === tab.id}
            onClick={() => onSubTab(tab.id)}
            className={`rounded-md px-3 py-1 font-medium transition-colors ${subTab === tab.id ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="glass-soft inline-flex rounded-control p-0.5 text-sm" role="group" aria-label="상태 필터">
        {STATE_FILTERS.map((filter) => (
          <button
            key={filter.id}
            type="button"
            aria-pressed={state === filter.id}
            onClick={() => onState(filter.id)}
            className={`rounded-md px-2.5 py-1 font-medium transition-colors ${state === filter.id ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"}`}
          >
            {filter.label}
          </button>
        ))}
      </div>
      {remote?.webUrl && (
        <a
          href={`${remote.webUrl}/${subTab === "issues" ? "issues" : "pulls"}`}
          target="_blank"
          rel="noreferrer"
          className="ml-auto shrink-0 rounded-control border border-line px-3 py-1 text-sm font-medium hover:border-ink"
        >
          {remote.kind === "gitea" ? "Gitea에서 열기" : "GitHub에서 열기"}
        </a>
      )}
    </div>
  );
}

interface ListProps {
  projectId: string;
  state: ListState;
  subTab: SubTab;
  onSubTab: (tab: SubTab) => void;
  onState: (state: ListState) => void;
}

function IssueList({ projectId, state, subTab, onSubTab, onState }: ListProps) {
  const [loaded, setLoaded] = useState<{ result?: RepositoryIssuesResult; error?: string }>();
  const [openNumber, setOpenNumber] = useState<number>();
  const access = useSessionAccess();
  const draft = useChatDraft();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/repository/issues?state=${state}`)
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as RepositoryIssuesResult & { error?: string };
        if (!cancelled) setLoaded(response.ok ? { result: data } : { error: data.error ?? "이슈 목록을 불러오지 못했습니다" });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ error: "이슈 목록을 불러오지 못했습니다" });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, state]);

  function workOnIssue(issue: IssueSummary) {
    const excerpt = issue.body?.trim().slice(0, 1_000);
    draft.fill(`#${issue.number} 이슈를 해결해줘: ${issue.title}${excerpt ? `\n\n${excerpt}` : ""}`);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RepositoryToolbar subTab={subTab} state={state} onSubTab={onSubTab} onState={onState} remote={loaded?.result?.remote} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loaded ? (
          <p className="p-6 text-sm text-muted">불러오는 중</p>
        ) : loaded.error ? (
          <p className="p-6 text-sm text-fail">{loaded.error}</p>
        ) : !loaded.result?.ok ? (
          <p className="p-6 text-sm leading-6 text-muted">{REASON_TEXT[loaded.result?.reason ?? "error"](loaded.result?.detail ?? "이유를 알 수 없습니다")}</p>
        ) : loaded.result.issues && loaded.result.issues.length > 0 ? (
          <ul className="divide-y divide-line">
            {loaded.result.issues.map((issue) => (
              <IssueRow
                key={issue.number}
                issue={issue}
                onWork={access.canManage ? () => workOnIssue(issue) : undefined}
                onOpen={() => setOpenNumber(issue.number)}
              />
            ))}
          </ul>
        ) : (
          <p className="p-6 text-sm text-muted">조건에 맞는 이슈가 없습니다.</p>
        )}
      </div>
      {openNumber !== undefined && <IssueDetailPanel key={openNumber} projectId={projectId} number={openNumber} onClose={() => setOpenNumber(undefined)} />}
    </div>
  );
}

function PullList({ projectId, state, subTab, onSubTab, onState }: ListProps) {
  const [loaded, setLoaded] = useState<{ result?: RepositoryPullsResult; error?: string }>();
  const [openNumber, setOpenNumber] = useState<number>();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/repository/pulls?state=${state}`)
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as RepositoryPullsResult & { error?: string };
        if (!cancelled) setLoaded(response.ok ? { result: data } : { error: data.error ?? "PR 목록을 불러오지 못했습니다" });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ error: "PR 목록을 불러오지 못했습니다" });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, state]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RepositoryToolbar subTab={subTab} state={state} onSubTab={onSubTab} onState={onState} remote={loaded?.result?.remote} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loaded ? (
          <p className="p-6 text-sm text-muted">불러오는 중</p>
        ) : loaded.error ? (
          <p className="p-6 text-sm text-fail">{loaded.error}</p>
        ) : !loaded.result?.ok ? (
          <p className="p-6 text-sm leading-6 text-muted">{REASON_TEXT[loaded.result?.reason ?? "error"](loaded.result?.detail ?? "이유를 알 수 없습니다")}</p>
        ) : loaded.result.pulls && loaded.result.pulls.length > 0 ? (
          <ul className="divide-y divide-line">
            {loaded.result.pulls.map((pull) => (
              <PullRow key={pull.number} pull={pull} onOpen={() => setOpenNumber(pull.number)} />
            ))}
          </ul>
        ) : (
          <p className="p-6 text-sm text-muted">조건에 맞는 PR이 없습니다.</p>
        )}
      </div>
      {openNumber !== undefined && <PullDetailPanel key={openNumber} projectId={projectId} number={openNumber} onClose={() => setOpenNumber(undefined)} />}
    </div>
  );
}

export const STATE_DOT = { open: "bg-pass", closed: "bg-line" } as const;

export function IssueRow({ issue, onWork, onOpen }: { issue: IssueSummary; onWork?: () => void; onOpen: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
      <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${STATE_DOT[issue.state]}`} title={issue.state === "open" ? "열림" : "닫힘"} />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-left hover:underline" title={issue.title}>
        <span className="font-mono text-muted">#{issue.number}</span> {issue.title}
      </button>
      <a href={issue.url} target="_blank" rel="noreferrer" title="GitHub·Gitea에서 보기" aria-label="GitHub·Gitea에서 보기" className="shrink-0 text-muted hover:text-ink">
        ↗
      </a>
      {issue.labels.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {issue.labels.map((label) => (
            <span key={label} className="glass-soft rounded-control px-1.5 py-0.5 text-xs text-muted">
              {label}
            </span>
          ))}
        </span>
      )}
      <span className="shrink-0 text-xs text-muted">{issue.author}</span>
      <span className="shrink-0 text-xs text-muted">{TIME.format(new Date(issue.updatedAt))}</span>
      {onWork && (
        <button type="button" onClick={onWork} className="shrink-0 rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
          이 이슈로 작업
        </button>
      )}
    </li>
  );
}

export const CHECK_LABEL: Record<CheckStatus, string> = { success: "통과", failure: "실패", pending: "진행 중", unknown: "-" };
export const CHECK_TONE: Record<CheckStatus, string> = { success: "text-pass", failure: "text-fail", pending: "text-wait", unknown: "text-muted" };
export const REVIEW_LABEL: Record<ReviewDecision, string> = { approved: "승인", changes_requested: "변경 요청", review_required: "리뷰 대기", unknown: "-" };
export const REVIEW_TONE: Record<ReviewDecision, string> = { approved: "text-pass", changes_requested: "text-fail", review_required: "text-wait", unknown: "text-muted" };

export function PullRow({ pull, onOpen }: { pull: PullRequestSummary; onOpen: () => void }) {
  const check = pull.checkStatus ?? "unknown";
  const review = pull.reviewDecision ?? "unknown";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
      <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${STATE_DOT[pull.state]}`} title={pull.state === "open" ? "열림" : "닫힘"} />
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 truncate text-left hover:underline" title={pull.title}>
        <span className="font-mono text-muted">#{pull.number}</span> {pull.title}
        {pull.draft && <span className="ml-1.5 text-xs text-muted">(초안)</span>}
      </button>
      <a href={pull.url} target="_blank" rel="noreferrer" title="GitHub·Gitea에서 보기" aria-label="GitHub·Gitea에서 보기" className="shrink-0 text-muted hover:text-ink">
        ↗
      </a>
      {pull.labels.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {pull.labels.map((label) => (
            <span key={label} className="glass-soft rounded-control px-1.5 py-0.5 text-xs text-muted">
              {label}
            </span>
          ))}
        </span>
      )}
      {pull.checkStatus !== undefined && <span className={`shrink-0 text-xs font-medium ${CHECK_TONE[check]}`}>CI {CHECK_LABEL[check]}</span>}
      {pull.reviewDecision !== undefined && <span className={`shrink-0 text-xs font-medium ${REVIEW_TONE[review]}`}>리뷰 {REVIEW_LABEL[review]}</span>}
      {pull.sessionId && (
        <a
          href={`/sessions/${pull.sessionId}`}
          className="glass-soft shrink-0 rounded-control px-1.5 py-0.5 text-xs font-medium text-muted hover:text-ink"
          title="이 PR을 만든 b-studio 세션을 엽니다"
        >
          b-studio
        </a>
      )}
      <span className="shrink-0 text-xs text-muted">{pull.author}</span>
      <span className="shrink-0 text-xs text-muted">{TIME.format(new Date(pull.updatedAt))}</span>
    </li>
  );
}
