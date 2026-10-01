"use client";

import { useEffect, useRef, useState } from "react";
import { buildRequirementAskPrefill, requirementToMarkdown } from "@/lib/requirement-chat-prefill";
import type { SessionView } from "@/lib/session-view";
import { useChatDraft } from "./chat-draft-context";
import { useRequirementsImport } from "./requirements-import-context";
import { useSessionAccess } from "./session-access";

type RequirementKind = "api" | "ui" | "data" | "nonfunctional" | "docs";
type RequirementPriority = "must" | "should" | "could";
type RequirementStatus = "미착수" | "작업 중" | "검증됨" | "재확인 필요" | "실패";
type EarsPattern = "ubiquitous" | "event" | "state" | "unwanted" | "optional";

interface Scenario {
  id: string;
  given: string;
  when: string;
  then: string;
}

interface Nfr {
  metric: string;
  threshold: string;
  condition: string;
  method: string;
}

interface Trace {
  issue?: number;
  dependsOn?: string[];
  supersedes?: string;
}

interface RequirementDraft {
  id: string;
  title: string;
  kind: RequirementKind;
  priority: RequirementPriority;
  acceptance: string[];
  rev?: number;
  ears?: { pattern: EarsPattern; statement: string };
  scenarios?: Scenario[];
  nfr?: Nfr;
  trace?: Trace;
  hash?: string;
  revisedAt?: string;
}

interface RequirementEvidence {
  checkpoints: Array<{ sha: string; shortSha: string; message: string }>;
  tests: Array<{ file: string; name: string }>;
  gateChecks: Array<{ name: string; ok: boolean }>;
}

interface RequirementView extends RequirementDraft {
  status: RequirementStatus;
  confidence: "🟢" | "🟡" | "🔴";
  evidence: RequirementEvidence;
  workPrefill: string;
  /** 이슈로 발행했을 때 생긴 하위 이슈 번호(ADR-092). 발행하지 않았으면 없다 */
  issue?: number;
}

type RequirementPlanAction = "create" | "update" | "unchanged" | "conflict" | "reverify" | "closed_but_requirement_exists";

interface RequirementPlanEntry {
  id: string;
  action: RequirementPlanAction;
  issue?: number;
  localHash: string;
  remoteHash?: string;
  checklistOnly: boolean;
  note: string;
}

interface RequirementPlanSummary {
  total: number;
  create: number;
  update: number;
  unchanged: number;
  conflict: number;
  reverify: number;
  closedButRequirementExists: number;
  /** could·docs라 하위 이슈 없이 추적 이슈 체크리스트로만 남는 항목 수(이들은 create에 세지 않는다) */
  checklistOnly: number;
}

const PLAN_ACTION_LABEL: Record<RequirementPlanAction, string> = {
  create: "새로 만들기",
  update: "본문 갱신",
  unchanged: "바뀐 것 없음",
  conflict: "충돌",
  reverify: "다시 열고 재확인",
  closed_but_requirement_exists: "닫혔지만 미검증",
};
const PLAN_ACTION_TONE: Record<RequirementPlanAction, string> = {
  create: "text-pass",
  update: "text-wait",
  unchanged: "text-muted",
  conflict: "text-fail",
  reverify: "text-wait",
  closed_but_requirement_exists: "text-fail",
};

interface RequirementCoverage {
  total: number;
  verified: number;
  mustTotal: number;
  mustVerified: number;
  text: string;
  mustGapText?: string;
}

interface RequirementsSnapshot {
  exists: boolean;
  requirements: RequirementView[];
  coverage?: RequirementCoverage;
  allMustHavesPrefill?: string;
  assumptions: string[];
  manualSteps: string[];
  /** 저장(apply)하지 않은 추출 결과가 세션 상태 폴더에 남아 있으면 있다(ADR-0XX, A) */
  draft?: PersistedExtractionDraft;
}

interface ReferencedFileView {
  path: string;
  exists: boolean;
  sizeBytes?: number;
  preview?: string;
}

interface RecommendationSource {
  url: string;
  title?: string;
}

interface RecommendationView {
  question: string;
  answer: string;
  rationale: string;
  sources: RecommendationSource[];
  basis?: "spec" | "practice";
  specQuote?: string;
}

interface RequirementDiffEntry {
  status: "added" | "changed" | "unchanged" | "removed";
  id: string;
  requirement: RequirementDraft;
  previous?: RequirementDraft;
}

interface ExtractionPreview {
  requirements: RequirementDraft[];
  questions: string[];
  /** model=추출 모델, fallback=결정론적 대체 파서, managed=b-studio가 이미 발행한 이슈를 모델 호출 없이 그대로 되읽음(ADR-0XX) */
  source: "model" | "fallback" | "managed";
  reason?: string;
  referencedFiles: ReferencedFileView[];
  outOfScope: string[];
  assumptions: string[];
  manualSteps: string[];
  diff?: RequirementDiffEntry[];
}

/** 저장하지 않은 추출 결과를 세션 상태 폴더에 남긴 것(서버 재시작·새로고침 뒤에도 이어서 볼 수 있다, ADR-0XX) */
interface PersistedExtractionDraft extends ExtractionPreview {
  savedAt: string;
}

const KIND_LABEL: Record<RequirementKind, string> = { api: "API", ui: "화면", data: "데이터", nonfunctional: "비기능", docs: "문서" };
const PRIORITY_LABEL: Record<RequirementPriority, string> = { must: "필수", should: "권장", could: "선택" };
const STATUS_TONE: Record<RequirementStatus, string> = { 미착수: "text-muted", "작업 중": "text-wait", 검증됨: "text-pass", "재확인 필요": "text-wait", 실패: "text-fail" };
const DIFF_LABEL: Record<RequirementDiffEntry["status"], string> = { added: "추가", changed: "변경(개정 상승)", unchanged: "그대로", removed: "명세에서 사라짐(그대로 유지됨)" };

async function readJson<T>(response: Response): Promise<T & { error?: string }> {
  return (await response.json().catch(() => ({}))) as T & { error?: string };
}

/** 경과 시간을 "2분 13초"/"13초"로 보여준다(A — "뽑는 중" 버튼 옆에 붙인다) */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

/** 개발 화면의 "명세" 탭(ADR-079). 과제 명세를 요구사항으로 나누고, 요구사항마다 무엇이 됐다는 증거를 추적한다 */
type PanelView = "list" | "matrix";

export function RequirementsPanel({ view }: { view: SessionView }) {
  const sessionId = view.snapshot.id;
  const access = useSessionAccess();
  const draft = useChatDraft();
  const [snapshot, setSnapshot] = useState<{ data?: RequirementsSnapshot; error?: string }>();
  const [importing, setImporting] = useState(false);
  const [panelView, setPanelView] = useState<PanelView>("list");
  const [revision, setRevision] = useState(0);
  // 대화의 "요구사항에 반영"(ADR-094)이 채운 글. 있으면 "명세 다시 가져오기" 화면을 열고 바로 한 번 추출해
  // 병합 diff를 보여 준다 — 한 번 반영했으면 지워서, 탭을 오가도 같은 글로 또 열리지 않게 한다.
  // 코드 탭 열기(preview-panel.tsx의 codeOpen)와 같은 규칙으로, 렌더 중에 비교해 반영한다(useEffect 안에서
  // setState를 곧바로 부르지 않는다 — 리액트 컴파일러 린트가 막는 패턴이다)
  const requirementsImport = useRequirementsImport();
  const [importSpecText, setImportSpecText] = useState<string>();
  const [appliedImportTarget, setAppliedImportTarget] = useState(requirementsImport.target);
  if (requirementsImport.target && requirementsImport.target !== appliedImportTarget) {
    setAppliedImportTarget(requirementsImport.target);
    setImportSpecText(requirementsImport.target.specText);
    setImporting(true);
    setPanelView("list");
    requirementsImport.clear();
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/requirements`)
      .then(async (response) => {
        const data = await readJson<RequirementsSnapshot>(response);
        if (cancelled) return;
        setSnapshot(response.ok ? { data } : { error: data.error ?? "요구사항을 불러오지 못했습니다" });
        if (response.ok && !data.exists) setImporting(true);
      })
      .catch(() => {
        if (!cancelled) setSnapshot({ error: "요구사항을 불러오지 못했습니다" });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, revision]);

  function onApplied(next: RequirementsSnapshot) {
    setSnapshot({ data: next });
    setImporting(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <p className="text-sm font-medium text-ink">명세 → 요구사항 → 검증 추적</p>
        {snapshot?.data?.exists && !importing && (
          <div className="glass-soft inline-flex rounded-control p-0.5 text-sm" role="tablist" aria-label="요구사항 하위 화면">
            {(
              [
                { id: "list", label: "목록" },
                { id: "matrix", label: "추적 매트릭스" },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={panelView === tab.id}
                onClick={() => setPanelView(tab.id)}
                className={`rounded-md px-3 py-1 font-medium transition-colors ${panelView === tab.id ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
        {snapshot?.data?.exists && access.canManage && (
          <button
            type="button"
            onClick={() => {
              // 사람이 직접 연 가져오기는 "요구사항에 반영"이 채웠던 글을 더는 쓰지 않는다(빈 붙여넣기 칸부터 시작)
              setImportSpecText(undefined);
              setImporting((value) => !value);
            }}
            className={`${panelView === "matrix" ? "" : "ml-auto"} shrink-0 rounded-control border border-line px-3 py-1 text-sm font-medium hover:border-ink`}
          >
            {importing ? "목록으로" : "명세 다시 가져오기"}
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!snapshot ? (
          <p className="text-sm text-muted">불러오는 중</p>
        ) : snapshot.error ? (
          <p className="text-sm text-fail">{snapshot.error}</p>
        ) : importing ? (
          <ImportFlow
            sessionId={sessionId}
            onApplied={onApplied}
            onCancel={snapshot.data?.exists ? () => setImporting(false) : undefined}
            initialSpecText={importSpecText}
            draft={snapshot.data?.draft}
          />
        ) : panelView === "matrix" ? (
          <MatrixView sessionId={sessionId} />
        ) : (
          <RequirementsList
            sessionId={sessionId}
            snapshot={snapshot.data!}
            canManage={access.canManage}
            isGithub={view.snapshot.repository?.kind === "github"}
            onWork={(text) => draft.fill(text)}
            onRefresh={() => setRevision((value) => value + 1)}
          />
        )}
      </div>
    </div>
  );
}

/**
 * "전체 계획 세우기"를 누르기 전에 "먼저 발행할까요?"를 한 번 물어볼지 정한다(ADR-092).
 * 원격이 GitHub이고, 아직 하나도 발행하지 않았고, 이 세션에서 아직 묻지 않았을 때만 확인한다(한 번 답하면 다시 묻지 않는다).
 * 순수 함수로 빼서 UI 렌더 없이도 그대로 테스트한다.
 */
export function shouldConfirmBeforePlanAll(isGithub: boolean, hasPublished: boolean, askedOnce: boolean): boolean {
  return isGithub && !hasPublished && !askedOnce;
}

/** RequirementsPanel 안의 목록 화면. ImportFlow·RequirementPublishFlow와 같은 이유로 테스트가 직접 렌더링할 수 있게 내보낸다 */
export function RequirementsList({
  sessionId,
  snapshot,
  canManage,
  isGithub,
  onWork,
  onRefresh,
}: {
  sessionId: string;
  snapshot: RequirementsSnapshot;
  canManage: boolean;
  /** 원격이 GitHub이면(요구사항을 이슈로 발행할 수 있으면) "다음 단계"에서 발행을 계획 세우기보다 앞세운다(ADR-092) */
  isGithub: boolean;
  onWork: (text: string) => void;
  onRefresh: () => void;
}) {
  const [publishOpen, setPublishOpen] = useState(false);
  // "전체 계획 세우기"를 아직 발행하지 않은 채 누르면 한 번만 "먼저 발행할까요?"를 물어본다(대답하면 이 세션 동안 다시 묻지 않는다)
  const [confirmPlanAll, setConfirmPlanAll] = useState(false);
  const [askedOnce, setAskedOnce] = useState(false);
  if (snapshot.requirements.length === 0) {
    return <p className="text-sm text-muted">docs/requirements.md는 있지만 요구사항을 하나도 읽지 못했습니다. &ldquo;명세 다시 가져오기&rdquo;로 다시 뽑아 보세요.</p>;
  }
  const coverage = snapshot.coverage;
  const hasPublished = snapshot.requirements.some((requirement) => requirement.issue !== undefined);

  function planAll() {
    if (shouldConfirmBeforePlanAll(isGithub, hasPublished, askedOnce)) {
      setConfirmPlanAll(true);
      return;
    }
    onWork(snapshot.allMustHavesPrefill!);
  }

  return (
    <div className="flex flex-col gap-4">
      {coverage && (
        <div className="glass-soft flex flex-wrap items-center gap-2 rounded-control px-3 py-2 text-sm">
          <span className="font-medium text-ink">{coverage.text}</span>
          {coverage.mustGapText && <span className="font-medium text-fail">{coverage.mustGapText}</span>}
          {canManage && (
            <div className="ml-auto flex shrink-0 gap-2">
              <button type="button" onClick={() => setPublishOpen((value) => !value)} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
                {publishOpen ? "발행 닫기" : "이슈로 발행"}
              </button>
              <button type="button" onClick={() => onRefresh()} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
                증거 새로고침
              </button>
            </div>
          )}
        </div>
      )}
      {canManage && publishOpen && <RequirementPublishFlow sessionId={sessionId} onRefresh={onRefresh} />}
      {canManage && snapshot.allMustHavesPrefill && (
        <div className="flex flex-col gap-1.5 rounded-control border border-line bg-panel p-3">
          <p className="text-sm font-medium text-ink">다음 단계</p>
          <p className="text-xs text-muted">에이전트가 매 요청마다 이 목록을 읽고 요구사항별로 작업·검증 근거를 추적합니다. 한 번에 시작하거나, 아래에서 요구사항 하나씩 골라 시작할 수 있습니다.</p>
          {confirmPlanAll ? (
            <div className="mt-1 flex flex-col gap-1.5 rounded-control border border-fail/40 bg-fail/10 px-3 py-2">
              <p className="text-sm text-ink">아직 이슈로 발행하지 않았습니다 — 먼저 발행할까요?</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmPlanAll(false);
                    setAskedOnce(true);
                    setPublishOpen(true);
                  }}
                  className="rounded-control bg-ink px-3 py-1 text-xs font-medium text-panel hover:bg-ink/85"
                >
                  발행하기
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmPlanAll(false);
                    setAskedOnce(true);
                    onWork(snapshot.allMustHavesPrefill!);
                  }}
                  className="rounded-control border border-line px-3 py-1 text-xs font-medium hover:border-ink"
                >
                  그냥 계속
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-1 flex flex-wrap gap-2">
              {isGithub && (
                <button
                  type="button"
                  onClick={() => setPublishOpen(true)}
                  className="self-start rounded-control border border-line px-3 py-1.5 text-sm font-medium hover:border-ink"
                >
                  이슈로 발행
                </button>
              )}
              <button type="button" onClick={planAll} className="self-start rounded-control bg-ink px-3 py-1.5 text-sm font-medium text-panel hover:bg-ink/85">
                전체 계획 세우기(필수 요구사항)
              </button>
            </div>
          )}
        </div>
      )}
      <ul className="flex flex-col gap-3">
        {snapshot.requirements.map((requirement) => (
          <RequirementCard key={requirement.id} requirement={requirement} canManage={canManage} onWork={() => onWork(requirement.workPrefill)} />
        ))}
      </ul>
      {snapshot.assumptions.length > 0 && (
        <div className="rounded-control border border-line bg-panel p-3">
          <p className="text-sm font-medium text-ink">가정</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm text-muted">
            {snapshot.assumptions.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </div>
      )}
      {snapshot.manualSteps.length > 0 && <ManualStepsNotice items={snapshot.manualSteps} />}
      <p className="text-xs text-muted">파일: docs/requirements.md · 세션 작업 복사본에 저장되어 체크포인트·PR에 그대로 실립니다. 세션 id: {sessionId}</p>
    </div>
  );
}

interface RequirementIssueDraft {
  title: string;
  kind: string;
  priority: string;
  acceptance: string[];
  guessed: boolean;
}

/** "이슈로 발행" 흐름(ADR-092): dry-run 미리보기 → 확인 → 발행, 충돌은 가져오기·덮어쓰기·무시로 하나씩 푼다. ImportFlow와 같은 이유로 테스트가 직접 쓸 수 있게 내보낸다 */
/** "이슈로 발행" 미리보기 응답. 외부 저장소에 쓰는 동작이라 대상 저장소와 추적 이슈 처리를 함께 받는다 */
interface RequirementPublishPreview {
  plan: RequirementPlanEntry[];
  summary: RequirementPlanSummary;
  /** 예: github.com/dj258255/test (옛 서버 응답에는 없을 수 있다) */
  repository?: string;
  tracking?: { action: "create" } | { action: "update"; issue: number };
}

export function RequirementPublishFlow({ sessionId, onRefresh }: { sessionId: string; onRefresh: () => void }) {
  const [preview, setPreview] = useState<RequirementPublishPreview>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [publishing, setPublishing] = useState(false);
  // 발행에 성공하면 미리보기·발행 버튼 대신 이 완료 요약만 보여준다(F) — "닫기"를 눌러야 다시 미리보기로 돌아간다
  const [published, setPublished] = useState<{ tracking?: { issue: number; url: string }; errors: Array<{ id: string; message: string }>; summary: RequirementPlanSummary }>();
  const [resolving, setResolving] = useState<string>();
  const [imported, setImported] = useState<Record<string, RequirementIssueDraft>>({});

  /** 발행·충돌 해결 뒤 미리보기를 다시 불러온다(이벤트 처리기에서만 부른다 — useEffect는 위의 .then 체인을 따로 쓴다) */
  async function loadPreview() {
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/requirements/publish/preview`, { method: "POST" });
      const data = await readJson<RequirementPublishPreview>(response);
      if (!response.ok) {
        setError(data.error ?? "미리보기를 만들지 못했습니다");
        return;
      }
      setPreview(data);
    } catch {
      setError("미리보기를 만들지 못했습니다");
    }
  }

  useEffect(() => {
    let cancelled = false;
    // loadPreview(async 함수)를 그대로 부르면 "effect 안에서 setState를 동기적으로 부른다"는 린트가 막는다
    // (react-hooks/set-state-in-effect) — RequirementsPanel의 최초 목록 로딩과 같은 모양(.then 체인)으로 대신한다
    fetch(`/api/sessions/${sessionId}/requirements/publish/preview`, { method: "POST" })
      .then(async (response) => {
        const data = await readJson<RequirementPublishPreview>(response);
        if (cancelled) return;
        if (!response.ok) {
          setError(data.error ?? "미리보기를 만들지 못했습니다");
        } else {
          setPreview(data);
        }
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("미리보기를 만들지 못했습니다");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  async function publish() {
    setPublishing(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/requirements/publish`, { method: "POST" });
      const data = await readJson<{ tracking?: { issue: number; url: string }; errors: Array<{ id: string; message: string }>; summary: RequirementPlanSummary }>(response);
      if (!response.ok) {
        setError(data.error ?? "발행하지 못했습니다");
        return;
      }
      // 미리보기·발행 버튼 대신 완료 요약만 보여준다(F) — 다시 열면(닫기) 새 미리보기를 받는다
      setPublished(data);
      setPreview(undefined);
      onRefresh();
    } catch {
      setError("발행하지 못했습니다");
    } finally {
      setPublishing(false);
    }
  }

  /** 완료 요약의 "닫기" — 다시 열면 발행 미리보기를 새로 받는다(F) */
  async function closeCompletion() {
    setPublished(undefined);
    setImported({});
    setLoading(true);
    await loadPreview();
    setLoading(false);
  }

  async function resolveConflict(requirementId: string, resolution: "import" | "overwrite" | "ignore") {
    setResolving(requirementId);
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/requirements/publish/conflict`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requirementId, resolution }),
      });
      const data = await readJson<{ action: string; draft?: RequirementIssueDraft }>(response);
      if (!response.ok) {
        setError(data.error ?? "충돌을 풀지 못했습니다");
        return;
      }
      if (data.draft) setImported((current) => ({ ...current, [requirementId]: data.draft! }));
      await loadPreview();
    } catch {
      setError("충돌을 풀지 못했습니다");
    } finally {
      setResolving(undefined);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-control border border-line bg-panel p-3">
      <p className="text-sm font-medium text-ink">요구사항을 GitHub 이슈로 발행</p>
      <p className="text-xs text-muted">
        요구사항마다 하위 이슈(필수·권장), 전체를 묶는 추적 이슈를 만들거나 갱신합니다. 선택(could)·문서(docs)는 추적 이슈의 체크리스트로만 남습니다.
        <code className="ml-1">docs/requirements.md</code>가 언제나 원본입니다(한 방향).
      </p>
      {published ? (
        // 발행에 성공하면 미리보기·발행 버튼 대신 이 완료 요약만 보여준다(F). "닫기"를 눌러야 다시 미리보기를 받는다
        <div className="flex flex-col gap-2 rounded-control bg-ground px-3 py-2.5 text-sm">
          <p className="font-medium text-ink">발행했습니다</p>
          <p className="text-muted">
            {published.tracking && (
              <>
                추적 이슈{" "}
                <a href={published.tracking.url} target="_blank" rel="noreferrer" className="underline">
                  #{published.tracking.issue}
                </a>{" "}
                ·{" "}
              </>
            )}
            새로 만든 {published.summary.create}개 · 갱신 {published.summary.update}개
            {published.summary.checklistOnly > 0 && ` · 체크리스트 ${published.summary.checklistOnly}개`}
          </p>
          {published.errors.length > 0 && (
            <ul className="list-inside list-disc text-xs text-fail">
              {published.errors.map((item, index) => (
                <li key={index}>
                  {item.id}: {item.message}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={closeCompletion}
            className="self-start rounded-control border border-line px-3 py-1.5 text-sm font-medium hover:border-ink"
          >
            닫기
          </button>
        </div>
      ) : loading ? (
        <p className="text-sm text-muted">미리보기를 만드는 중</p>
      ) : error ? (
        <p className="text-sm text-fail">{error}</p>
      ) : preview ? (
        <>
          {preview.repository && (
            <p className="text-sm text-ink">
              대상 저장소 <span className="font-mono">{preview.repository}</span>
              {preview.tracking && (preview.tracking.action === "update" ? ` · 추적 이슈 #${preview.tracking.issue} 갱신` : " · 추적 이슈 새로 만들기")}
            </p>
          )}
          <p className="text-sm text-ink">
            새로 만들기 {preview.summary.create} · 체크리스트 {preview.summary.checklistOnly} · 갱신 {preview.summary.update} · 그대로 {preview.summary.unchanged} · 충돌{" "}
            <span className={preview.summary.conflict > 0 ? "font-medium text-fail" : undefined}>{preview.summary.conflict}</span> · 재확인 {preview.summary.reverify}
          </p>
          <ul className="flex flex-col gap-1.5">
            {preview.plan.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 rounded-control bg-ground px-2.5 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-muted">{entry.id}</span>
                  <span className={`font-medium ${PLAN_ACTION_TONE[entry.action]}`}>{PLAN_ACTION_LABEL[entry.action]}</span>
                  {entry.issue !== undefined && <span className="text-muted">#{entry.issue}</span>}
                  {entry.checklistOnly && <span className="text-muted">(체크리스트 전용)</span>}
                </div>
                <p className="text-muted">{entry.note}</p>
                {entry.action === "conflict" && (
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      disabled={resolving === entry.id}
                      onClick={() => resolveConflict(entry.id, "import")}
                      className="rounded-control border border-line px-2 py-0.5 font-medium hover:border-ink disabled:opacity-60"
                    >
                      가져오기
                    </button>
                    <button
                      type="button"
                      disabled={resolving === entry.id}
                      onClick={() => resolveConflict(entry.id, "overwrite")}
                      className="rounded-control border border-line px-2 py-0.5 font-medium hover:border-ink disabled:opacity-60"
                    >
                      덮어쓰기
                    </button>
                    <button
                      type="button"
                      disabled={resolving === entry.id}
                      onClick={() => resolveConflict(entry.id, "ignore")}
                      className="rounded-control border border-line px-2 py-0.5 font-medium hover:border-ink disabled:opacity-60"
                    >
                      무시
                    </button>
                  </div>
                )}
                {imported[entry.id] && (
                  <div className="rounded-control bg-panel px-2 py-1.5 text-muted">
                    <p className="font-medium text-ink">이슈에서 가져온 내용(참고 — 파일에는 자동으로 반영하지 않습니다)</p>
                    <p>
                      {imported[entry.id]!.kind} · {imported[entry.id]!.priority}
                      {imported[entry.id]!.guessed && " · 추측값(검토 필요)"}
                    </p>
                    <ul className="list-inside list-disc">
                      {imported[entry.id]!.acceptance.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            disabled={publishing || preview.summary.create + preview.summary.update + preview.summary.reverify === 0}
            onClick={publish}
            className="self-start rounded-control bg-ink px-3 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-60"
          >
            {publishing ? "발행하는 중" : preview.repository ? `${preview.repository}에 발행` : "확인하고 발행"}
          </button>
        </>
      ) : null}
    </div>
  );
}

/** "사람이 할 일" 절 — 요구사항이 아니다, 에이전트가 절대 하지 않는 절차(저장소 권한·협업자 추가, 이메일 제출 등)임을 분명히 한다 */
function ManualStepsNotice({ items }: { items: string[] }) {
  return (
    <div className="rounded-control border border-wait/40 bg-panel p-3">
      <p className="text-sm font-medium text-ink">사람이 할 일 (에이전트 금지)</p>
      <p className="mt-0.5 text-xs text-muted">저장소 권한·협업자·공개 범위 변경, 이메일 제출처럼 코드·문서 밖에서 사람이 손으로 해야 하는 절차입니다. 요구사항이 아니므로 에이전트는 이 항목을 시도하지 않습니다.</p>
      <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-sm text-muted">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

interface MatrixRowView {
  kind: "requirement" | "scenario";
  id: string;
  parentId?: string;
  title: string;
  rev: number;
  priority: RequirementPriority;
  issue?: number;
  checkpoints: Array<{ sha: string; shortSha: string; message: string }>;
  tests: Array<{ file: string; name: string }>;
  gateChecks: Array<{ name: string; ok: boolean }>;
  status: RequirementStatus;
}

interface TraceabilityMatrixView {
  rows: MatrixRowView[];
  orphanTests: Array<{ file: string; name: string }>;
  mustHavesWithoutTests: Array<{ id: string; title: string }>;
}

/** "추적 매트릭스" 하위 화면(ADR-090): 요구사항·시나리오 행마다 개정·우선순위·커밋·테스트·게이트·상태를 한 줄로 보여주고, CSV로 내보낸다 */
function MatrixView({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<{ data?: TraceabilityMatrixView; error?: string }>();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/requirements/matrix`)
      .then(async (response) => {
        const data = await readJson<TraceabilityMatrixView>(response);
        if (!cancelled) setState(response.ok ? { data } : { error: data.error ?? "추적 매트릭스를 불러오지 못했습니다" });
      })
      .catch(() => {
        if (!cancelled) setState({ error: "추적 매트릭스를 불러오지 못했습니다" });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!state) return <p className="text-sm text-muted">불러오는 중</p>;
  if (state.error) return <p className="text-sm text-fail">{state.error}</p>;
  const matrix = state.data!;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted">요구사항·시나리오마다 개정·우선순위·커밋·테스트·게이트·상태를 모읍니다.</p>
        <a
          href={`/api/sessions/${sessionId}/requirements/matrix?format=csv`}
          download={`requirements-matrix-${sessionId}.csv`}
          className="ml-auto shrink-0 rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink"
        >
          CSV로 내보내기
        </a>
      </div>
      <div className="overflow-x-auto rounded-control border border-line">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-panel text-xs text-muted">
            <tr>
              <th className="px-2.5 py-1.5 font-medium">id</th>
              <th className="px-2.5 py-1.5 font-medium">제목</th>
              <th className="px-2.5 py-1.5 font-medium">개정</th>
              <th className="px-2.5 py-1.5 font-medium">우선순위</th>
              <th className="px-2.5 py-1.5 font-medium">이슈</th>
              <th className="px-2.5 py-1.5 font-medium">커밋</th>
              <th className="px-2.5 py-1.5 font-medium">테스트</th>
              <th className="px-2.5 py-1.5 font-medium">게이트</th>
              <th className="px-2.5 py-1.5 font-medium">상태</th>
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <tr key={row.id} className="border-t border-line align-top">
                <td className={`px-2.5 py-1.5 font-mono text-xs ${row.kind === "scenario" ? "pl-5 text-muted" : "text-ink"}`}>{row.id}</td>
                <td className="max-w-[320px] truncate px-2.5 py-1.5 text-ink" title={row.title}>
                  {row.title}
                </td>
                <td className="px-2.5 py-1.5 text-muted">{row.rev}</td>
                <td className="px-2.5 py-1.5 text-muted">{PRIORITY_LABEL[row.priority]}</td>
                <td className="px-2.5 py-1.5 text-muted">{row.issue !== undefined ? `#${row.issue}` : "—"}</td>
                <td className="px-2.5 py-1.5 text-muted">{row.checkpoints.length > 0 ? row.checkpoints.map((c) => c.shortSha).join(", ") : "—"}</td>
                <td className="px-2.5 py-1.5 text-muted">{row.tests.length > 0 ? `${row.tests.length}개` : "—"}</td>
                <td className="px-2.5 py-1.5 text-muted">
                  {row.gateChecks.length > 0 ? row.gateChecks.map((c) => (c.ok ? "통과" : "실패")).join(", ") : "—"}
                </td>
                <td className={`px-2.5 py-1.5 font-medium ${STATUS_TONE[row.status]}`}>{row.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-control border border-line bg-panel p-3">
          <p className="text-sm font-medium text-ink">주인 없는 테스트</p>
          <p className="text-xs text-muted">어느 요구사항·시나리오 id도 이름에 없는 테스트입니다.</p>
          {matrix.orphanTests.length === 0 ? (
            <p className="mt-1 text-sm text-muted">없습니다.</p>
          ) : (
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm text-muted">
              {matrix.orphanTests.map((test, index) => (
                <li key={index} className="truncate" title={test.name}>
                  <span className="font-mono text-xs">{test.file}</span>: {test.name}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-control border border-line bg-panel p-3">
          <p className="text-sm font-medium text-ink">테스트 없는 필수 요구사항</p>
          <p className="text-xs text-muted">시나리오 테스트를 포함해 테스트가 하나도 없는 필수(must) 요구사항입니다.</p>
          {matrix.mustHavesWithoutTests.length === 0 ? (
            <p className="mt-1 text-sm text-muted">없습니다.</p>
          ) : (
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm text-muted">
              {matrix.mustHavesWithoutTests.map((requirement) => (
                <li key={requirement.id}>
                  [{requirement.id}] {requirement.title}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function RequirementCard({ requirement, canManage, onWork }: { requirement: RequirementView; canManage: boolean; onWork: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const draft = useChatDraft();
  const evidenceCount = requirement.evidence.checkpoints.length + requirement.evidence.tests.length + requirement.evidence.gateChecks.length;

  async function copy() {
    try {
      await navigator.clipboard?.writeText(requirementToMarkdown(requirement));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 클립보드 접근이 막힌 환경(권한 거부 등)에서도 화면은 그대로 쓸 수 있어야 한다
    }
  }
  return (
    <li className="rounded-control border border-line bg-panel p-3">
      <div className="flex flex-wrap items-start gap-2">
        <span aria-hidden className="mt-0.5 text-base leading-none">
          {requirement.confidence}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-ink">
            {requirement.id}. {requirement.title}
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
            <span className="glass-soft rounded-control px-1.5 py-0.5">{KIND_LABEL[requirement.kind]}</span>
            <span className="glass-soft rounded-control px-1.5 py-0.5">{PRIORITY_LABEL[requirement.priority]}</span>
            <span className={`font-medium ${STATUS_TONE[requirement.status]}`}>{requirement.status}</span>
            {requirement.issue !== undefined && (
              <span className="glass-soft rounded-control px-1.5 py-0.5 font-medium text-ink" title="이슈로 발행됨">
                #{requirement.issue}
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          <button type="button" onClick={() => void copy()} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
            {copied ? "복사됨" : "복사"}
          </button>
          {canManage && (
            <button
              type="button"
              onClick={() => draft.fill(buildRequirementAskPrefill(requirement), { readOnly: true })}
              title="대화창을 읽기만 모드로 열고 이 요구사항을 맥락으로 채웁니다"
              className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink"
            >
              대화에서 묻기
            </button>
          )}
          {canManage && (
            <button type="button" onClick={onWork} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
              이 요구사항 작업
            </button>
          )}
        </div>
      </div>
      <ul className="mt-2 list-inside list-disc space-y-0.5 text-sm text-muted">
        {requirement.acceptance.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
      <button type="button" onClick={() => setOpen((value) => !value)} className="mt-2 text-xs font-medium text-muted hover:text-ink">
        {open ? "근거 접기" : `근거 보기 (${evidenceCount})`}
      </button>
      {open && (
        <div className="mt-1.5 space-y-1 rounded-control bg-ground px-2.5 py-2 text-xs text-muted">
          {evidenceCount === 0 ? (
            <p>아직 근거가 없습니다.</p>
          ) : (
            <>
              {requirement.evidence.checkpoints.map((checkpoint) => (
                <p key={checkpoint.sha} className="truncate">
                  체크포인트 <span className="font-mono">{checkpoint.shortSha}</span>: {checkpoint.message.split("\n")[0]}
                </p>
              ))}
              {requirement.evidence.tests.map((test, index) => (
                <p key={`${test.file}:${index}`} className="truncate">
                  테스트 <span className="font-mono">{test.file}</span>: {test.name}
                </p>
              ))}
              {requirement.evidence.gateChecks.map((check, index) => (
                <p key={`${check.name}:${index}`} className={check.ok ? "text-pass" : "text-fail"}>
                  게이트 확인 &ldquo;{check.name}&rdquo;: {check.ok ? "통과" : "실패"}
                </p>
              ))}
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** "재추출 병합" 미리보기(ADR-090): 이미 저장된 문서가 있을 때만 있다. 개수만 요약해 보여 준다(자세한 내용은 아래 편집 목록에서 본다) */
function DiffSummary({ diff }: { diff: RequirementDiffEntry[] }) {
  const counts = (["added", "changed", "unchanged", "removed"] as const).map((status) => ({
    status,
    count: diff.filter((entry) => entry.status === status).length,
  }));
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-control bg-ground px-3 py-2 text-sm">
      <span className="font-medium text-ink">기존 문서와 병합(제목·EARS 유사도로 id를 지켰습니다)</span>
      {counts
        .filter(({ count }) => count > 0)
        .map(({ status, count }) => (
          <span key={status} className="glass-soft rounded-control px-1.5 py-0.5 text-xs text-muted">
            {DIFF_LABEL[status]} {count}개
          </span>
        ))}
    </div>
  );
}

type SourceTab = "paste" | "file" | "issue";
/** 파일 선택으로 읽을 명세 파일의 상한. 명세 글은 보통 수십 KB 안이다 */
const MAX_SPEC_FILE_BYTES = 512 * 1024;

/** ImportFlow는 테스트(용어 검사·렌더)에서도 직접 쓸 수 있게 내보낸다 */
export function ImportFlow({
  sessionId,
  onApplied,
  onCancel,
  initialSpecText,
  draft,
}: {
  sessionId: string;
  onApplied: (snapshot: RequirementsSnapshot) => void;
  onCancel?: () => void;
  /** "요구사항에 반영"(대화 메시지 → 요구사항 패치, ADR-094)이 채운다 — 붙여넣기 칸을 채우고 바로 한 번 추출한다 */
  initialSpecText?: string;
  /** 저장 안 한 채 남은 추출 결과(세션 요구사항 스냅샷이 함께 돌려준다, ADR-0XX) — 있으면 "이어서 보기/버리기" 배너를 보여준다 */
  draft?: PersistedExtractionDraft;
}) {
  const [sourceTab, setSourceTab] = useState<SourceTab>("paste");
  const [specText, setSpecText] = useState(initialSpecText ?? "");
  /** 파일 선택 창으로 고른 파일의 이름과 내용. 내용은 브라우저에서 바로 읽어 붙여넣기처럼 보낸다 */
  const [pickedFile, setPickedFile] = useState<{ name: string; text: string }>();
  const [fileError, setFileError] = useState<string>();
  const [issueNumber, setIssueNumber] = useState("");
  const [preview, setPreview] = useState<ExtractionPreview>();
  const [drafts, setDrafts] = useState<RequirementDraft[]>([]);
  const [assumptions, setAssumptions] = useState<string[]>([]);
  const [manualSteps, setManualSteps] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [recommendations, setRecommendations] = useState<Record<number, RecommendationView>>({});
  const [recommendationSource, setRecommendationSource] = useState<"web" | "model">();
  const [recommending, setRecommending] = useState(false);
  // initialSpecText가 있으면(요구사항에 반영) 마운트 때부터 뽑는 중으로 시작한다 — effect 안에서 setState를
  // 곧바로 부르지 않고 초기값으로 미리 반영해 두는 식이다(리액트 컴파일러 린트가 막는 패턴을 피한다)
  const [busy, setBusy] = useState(() => Boolean(initialSpecText));
  const [error, setError] = useState<string>();
  // A: "뽑는 중 · 2분 13초" 경과 시간과 취소 — busy/recommending이 켜질 때마다 0부터 다시 잰다
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recommendElapsedMs, setRecommendElapsedMs] = useState(0);
  const extractAbortRef = useRef<AbortController | undefined>(undefined);
  const recommendAbortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    if (!busy) {
      setElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  useEffect(() => {
    if (!recommending) {
      setRecommendElapsedMs(0);
      return;
    }
    const startedAt = Date.now();
    setRecommendElapsedMs(0);
    const timer = setInterval(() => setRecommendElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(timer);
  }, [recommending]);

  // "요구사항에 반영"이 initialSpecText를 주면 붙여넣기 칸을 채운 뒤 바로 한 번 추출해 병합 diff를 보여 준다.
  // state(specText)를 거치지 않고 바로 이 값으로 요청해야 "방금 setSpecText한 값"을 또 기다리는 경합이 없다
  useEffect(() => {
    if (!initialSpecText) return;
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/requirements/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specText: initialSpecText }),
    })
      .then(async (response) => ({ response, data: await readJson<ExtractionPreview>(response) }))
      .then(({ response, data }) => {
        if (cancelled) return;
        if (!response.ok) {
          setError(data.error ?? "요구사항을 뽑지 못했습니다");
          return;
        }
        setPreview(data);
        setDrafts(data.requirements);
        setAssumptions(data.assumptions);
        setManualSteps(data.manualSteps);
      })
      .catch(() => {
        if (!cancelled) setError("요구사항을 뽑지 못했습니다");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, initialSpecText]);

  // A: "요구사항" 탭이 받은 스냅샷에 저장 안 한 추출 결과가 실려 있으면(세션 상태 폴더에 남아 있던 것) 그대로 이어받는다.
  // initialSpecText로 바로 추출하는 경우(요구사항에 반영)는 그 결과가 곧 새로 덮어쓰므로 배너를 띄우지 않는다
  const [resumableDraft, setResumableDraft] = useState(() => (initialSpecText ? undefined : draft));

  function resumeDraft() {
    if (!resumableDraft) return;
    setPreview(resumableDraft);
    setDrafts(resumableDraft.requirements);
    setAssumptions(resumableDraft.assumptions);
    setManualSteps(resumableDraft.manualSteps);
    setResumableDraft(undefined);
  }

  async function discardDraft() {
    setResumableDraft(undefined);
    await fetch(`/api/sessions/${sessionId}/requirements/extract`, { method: "DELETE" }).catch(() => {});
  }

  function sourceBody(withAnswers: boolean) {
    const body: Record<string, unknown> = {};
    if (sourceTab === "paste") body.specText = specText;
    else if (sourceTab === "file") body.specText = pickedFile?.text ?? "";
    else if (issueNumber.trim()) body.issueNumber = Number(issueNumber);
    if (withAnswers && preview) {
      body.answers = preview.questions.map((question, index) => ({ question, answer: answers[index]?.trim() || "(답변 없음)" })).filter((item) => item.answer !== "(답변 없음)");
    }
    return body;
  }

  async function extract(withAnswers: boolean) {
    setBusy(true);
    setError(undefined);
    const controller = new AbortController();
    extractAbortRef.current = controller;
    try {
      const response = await fetch(`/api/sessions/${sessionId}/requirements/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sourceBody(withAnswers)),
        signal: controller.signal,
      });
      const data = await readJson<ExtractionPreview>(response);
      if (!response.ok) {
        setError(data.error ?? "요구사항을 뽑지 못했습니다");
        return;
      }
      setPreview(data);
      setDrafts(data.requirements);
      setAssumptions(data.assumptions);
      setManualSteps(data.manualSteps);
      setAnswers({});
      setRecommendations({});
      setRecommendationSource(undefined);
      // 방금 받은 결과가 화면에 떴으니 "저장 안 한 결과가 있습니다" 배너는 더 보여줄 필요가 없다(저장 전까지는 서버가 계속 들고 있다)
      setResumableDraft(undefined);
    } catch (err) {
      setError(err instanceof DOMException && err.name === "AbortError" ? "요구사항 뽑기를 취소했습니다" : "요구사항을 뽑지 못했습니다");
    } finally {
      setBusy(false);
      extractAbortRef.current = undefined;
    }
  }

  /** "취소" 버튼 — 브라우저 쪽 fetch를 끊는다(AbortSignal이 라우트를 거쳐 서버 쪽 모델 호출까지 그대로 이어진다) */
  function cancelExtract() {
    extractAbortRef.current?.abort();
  }

  async function recommend() {
    if (!preview || preview.questions.length === 0) return;
    setRecommending(true);
    setError(undefined);
    const controller = new AbortController();
    recommendAbortRef.current = controller;
    try {
      const response = await fetch(`/api/sessions/${sessionId}/requirements/recommend`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questions: preview.questions, ...(sourceTab === "paste" ? { specText } : {}) }),
        signal: controller.signal,
      });
      const data = await readJson<{ recommendations: RecommendationView[]; sourced: "web" | "model" }>(response);
      if (!response.ok) {
        setError(data.error ?? "추천 값을 받지 못했습니다");
        return;
      }
      const byIndex: Record<number, RecommendationView> = {};
      const nextAnswers: Record<number, string> = { ...answers };
      data.recommendations.forEach((recommendation) => {
        const index = preview.questions.indexOf(recommendation.question);
        if (index === -1) return;
        byIndex[index] = recommendation;
        nextAnswers[index] = recommendation.answer;
      });
      setRecommendations(byIndex);
      setRecommendationSource(data.sourced);
      setAnswers(nextAnswers);
    } catch (err) {
      setError(err instanceof DOMException && err.name === "AbortError" ? "추천 값 찾기를 취소했습니다" : "추천 값을 받지 못했습니다");
    } finally {
      setRecommending(false);
      recommendAbortRef.current = undefined;
    }
  }

  function cancelRecommend() {
    recommendAbortRef.current?.abort();
  }

  async function apply() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/requirements/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requirements: drafts, assumptions, manualSteps }),
      });
      const data = await readJson<RequirementsSnapshot>(response);
      if (!response.ok) {
        setError(data.error ?? "저장하지 못했습니다");
        return;
      }
      onApplied(data);
    } catch {
      setError("저장하지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  function updateDraft(index: number, patch: Partial<RequirementDraft>) {
    setDrafts((current) => current.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  }
  function removeDraft(index: number) {
    setDrafts((current) => current.filter((_, i) => i !== index));
  }

  const canExtract = sourceTab === "paste" ? specText.trim().length > 0 : sourceTab === "file" ? (pickedFile?.text.trim().length ?? 0) > 0 : issueNumber.trim().length > 0;

  return (
    <div className="flex flex-col gap-4">
      {onCancel && (
        <button type="button" onClick={onCancel} className="self-start text-xs font-medium text-muted hover:text-ink">
          ← 목록으로
        </button>
      )}
      <div className="glass-soft inline-flex w-fit rounded-control p-0.5 text-sm" role="tablist" aria-label="요구사항 입력 방법">
        {(
          [
            { id: "paste", label: "붙여넣기" },
            { id: "file", label: "파일에서" },
            { id: "issue", label: "저장소 이슈" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={sourceTab === tab.id}
            onClick={() => setSourceTab(tab.id)}
            className={`rounded-md px-3 py-1 font-medium transition-colors ${sourceTab === tab.id ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {sourceTab === "paste" ? (
        <textarea
          value={specText}
          onChange={(event) => setSpecText(event.target.value)}
          rows={8}
          placeholder="만들 것을 적어 주세요"
          className="rounded-control border border-line bg-ground px-3 py-2 text-sm"
        />
      ) : sourceTab === "file" ? (
        <div className="flex flex-col gap-1.5">
          <label className="glass-soft w-fit cursor-pointer rounded-control px-4 py-2 text-sm font-medium hover:bg-panel">
            {pickedFile ? "다른 파일 선택…" : "파일 선택…"}
            <input
              type="file"
              accept=".md,.markdown,.txt,.json,.yaml,.yml,.csv,.html,.adoc,.rst"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                if (file.size > MAX_SPEC_FILE_BYTES) {
                  setFileError(`파일이 너무 큽니다(${Math.round(file.size / 1024).toLocaleString("ko-KR")}KB). ${MAX_SPEC_FILE_BYTES / 1024}KB 이하 텍스트 파일을 골라 주세요`);
                  return;
                }
                setFileError(undefined);
                void file.text().then((text) => setPickedFile({ name: file.name, text }));
              }}
            />
          </label>
          {pickedFile && (
            <p className="text-xs text-muted">
              <span className="font-mono">{pickedFile.name}</span> · {pickedFile.text.length.toLocaleString("ko-KR")}자
            </p>
          )}
          {fileError && <p className="text-xs text-fail">{fileError}</p>}
        </div>
      ) : (
        <input
          value={issueNumber}
          onChange={(event) => setIssueNumber(event.target.value)}
          placeholder="이슈 번호(예: 57)"
          inputMode="numeric"
          className="rounded-control border border-line bg-ground px-3 py-2 text-sm"
        />
      )}

      {resumableDraft && !preview && (
        <div className="flex flex-wrap items-center gap-2 rounded-control border border-line bg-ground px-3 py-2 text-sm">
          <p className="flex-1 text-ink">저장 안 한 추출 결과가 있습니다</p>
          <button type="button" onClick={resumeDraft} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
            이어서 보기
          </button>
          <button type="button" onClick={discardDraft} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
            버리기
          </button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!canExtract || busy}
          onClick={() => extract(false)}
          className="self-start rounded-control bg-ink px-4 py-2 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-60"
        >
          {busy ? `뽑는 중 · ${formatElapsed(elapsedMs)}` : "요구사항 뽑기"}
        </button>
        {busy && (
          <button type="button" onClick={cancelExtract} className="rounded-control border border-line px-3 py-2 text-sm font-medium hover:border-ink">
            취소
          </button>
        )}
      </div>
      {error && <p className="text-sm text-fail">{error}</p>}

      {preview && (
        <div className="flex flex-col gap-3 rounded-control border border-line p-3">
          <p className="text-sm text-muted">
            {preview.source === "model"
              ? "추출 모델이 나눴습니다."
              : preview.source === "managed"
                ? preview.reason
                : `결정론적 방식으로 나눴습니다${preview.reason ? `: ${preview.reason}` : ""}`}
          </p>

          {preview.diff && <DiffSummary diff={preview.diff} />}

          {preview.manualSteps.length > 0 && <ManualStepsNotice items={preview.manualSteps} />}

          {preview.referencedFiles.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-control bg-ground px-3 py-2">
              <p className="text-sm font-medium text-ink">참조 파일</p>
              <ul className="flex flex-col gap-1 text-xs text-muted">
                {preview.referencedFiles.map((file) => (
                  <li key={file.path} className={file.exists ? undefined : "text-fail"}>
                    <span className="font-mono">{file.path}</span>
                    {file.exists ? (
                      <>
                        {" "}
                        · 있음{file.sizeBytes !== undefined ? ` (${file.sizeBytes.toLocaleString("ko-KR")} bytes)` : ""}
                        {file.preview ? ` · ${file.preview}` : ""}
                      </>
                    ) : (
                      " · 작업 복사본에 없음"
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.questions.length > 0 && (
            <div className="flex flex-col gap-2 rounded-control bg-ground px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-medium text-ink">모호한 점 (최대 5개) — 답하고 &ldquo;스펙을 고치고 다시 뽑기&rdquo;를 눌러 보세요</p>
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    disabled={recommending}
                    onClick={recommend}
                    className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink disabled:opacity-60"
                  >
                    {recommending ? `추천 값 찾는 중 · ${formatElapsed(recommendElapsedMs)}` : "추천 값으로 채우기"}
                  </button>
                  {recommending && (
                    <button type="button" onClick={cancelRecommend} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
                      취소
                    </button>
                  )}
                </div>
              </div>
              {preview.questions.map((question, index) => {
                const recommendation = recommendations[index];
                return (
                  <label key={index} className="flex flex-col gap-1 text-sm">
                    <span>{question}</span>
                    <input
                      value={answers[index] ?? ""}
                      onChange={(event) => setAnswers((current) => ({ ...current, [index]: event.target.value }))}
                      className="rounded-control border border-line bg-panel px-2 py-1 text-sm"
                    />
                    {recommendation && (
                      <p className="text-xs text-muted">
                        {recommendation.basis === "spec" ? (
                          <span className="mr-1 font-medium text-pass">명세에 있음</span>
                        ) : (
                          recommendationSource === "model" && <span className="mr-1 font-medium text-wait">출처 확인 필요</span>
                        )}
                        {recommendation.rationale}
                        {recommendation.basis === "spec" && recommendation.specQuote && <span className="ml-1 italic">&ldquo;{recommendation.specQuote}&rdquo;</span>}
                        {recommendation.sources.map((source, sourceIndex) => (
                          <a key={sourceIndex} href={source.url} target="_blank" rel="noreferrer" className="ml-1 underline">
                            {source.title ?? source.url}
                          </a>
                        ))}
                      </p>
                    )}
                  </label>
                );
              })}
              <button
                type="button"
                disabled={busy}
                onClick={() => extract(true)}
                className="self-start rounded-control border border-line px-3 py-1.5 text-sm font-medium hover:border-ink disabled:opacity-60"
              >
                스펙을 고치고 다시 뽑기
              </button>
            </div>
          )}

          {preview.outOfScope.length > 0 && (
            <div className="flex flex-col gap-1 rounded-control bg-ground px-3 py-2">
              <p className="text-sm font-medium text-ink">범위 밖</p>
              <ul className="list-inside list-disc text-sm text-muted">
                {preview.outOfScope.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          <ul className="flex flex-col gap-2">
            {drafts.map((requirement, index) => (
              <li key={index} className="flex flex-col gap-1.5 rounded-control border border-line p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-muted">{requirement.id}</span>
                  <input
                    value={requirement.title}
                    onChange={(event) => updateDraft(index, { title: event.target.value })}
                    className="min-w-0 flex-1 rounded-control border border-line bg-ground px-2 py-1 text-sm"
                  />
                  <select
                    value={requirement.kind}
                    onChange={(event) => updateDraft(index, { kind: event.target.value as RequirementKind })}
                    className="rounded-control border border-line bg-ground px-1.5 py-1 text-xs"
                  >
                    {Object.entries(KIND_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={requirement.priority}
                    onChange={(event) => updateDraft(index, { priority: event.target.value as RequirementPriority })}
                    className="rounded-control border border-line bg-ground px-1.5 py-1 text-xs"
                  >
                    {Object.entries(PRIORITY_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={() => removeDraft(index)} className="shrink-0 text-xs font-medium text-fail hover:underline">
                    빼기
                  </button>
                </div>
                <textarea
                  value={requirement.acceptance.join("\n")}
                  onChange={(event) => updateDraft(index, { acceptance: event.target.value.split("\n").filter((line) => line.trim().length > 0) })}
                  rows={Math.max(2, requirement.acceptance.length)}
                  placeholder="인수 조건(줄마다 하나)"
                  className="rounded-control border border-line bg-ground px-2 py-1 text-sm"
                />
                {(requirement.ears || (requirement.scenarios && requirement.scenarios.length > 0) || requirement.nfr) && (
                  <div className="flex flex-col gap-0.5 rounded-control bg-ground px-2 py-1.5 text-xs text-muted">
                    {requirement.rev !== undefined && <p>개정 {requirement.rev}</p>}
                    {requirement.ears && (
                      <p>
                        EARS({requirement.ears.pattern}): {requirement.ears.statement}
                      </p>
                    )}
                    {requirement.scenarios && requirement.scenarios.length > 0 && (
                      <ul className="list-inside list-disc">
                        {requirement.scenarios.map((scenario) => (
                          <li key={scenario.id}>
                            {scenario.id}: (Given) {scenario.given} (When) {scenario.when} (Then) {scenario.then}
                          </li>
                        ))}
                      </ul>
                    )}
                    {requirement.nfr && (
                      <p>
                        NFR: {requirement.nfr.metric} {requirement.nfr.threshold} (조건: {requirement.nfr.condition} · 측정: {requirement.nfr.method})
                      </p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>

          <div className="flex flex-col gap-1.5 rounded-control border border-line p-2.5">
            <p className="text-sm font-medium text-ink">가정</p>
            <textarea
              value={assumptions.join("\n")}
              onChange={(event) => setAssumptions(event.target.value.split("\n").filter((line) => line.trim().length > 0))}
              rows={Math.max(2, assumptions.length)}
              placeholder="가정(줄마다 하나) — 데이터 규모·동시성/트래픽(명세가 실마리를 줄 때만)·페이지네이션 등"
              className="rounded-control border border-line bg-ground px-2 py-1 text-sm"
            />
          </div>

          <div className="flex flex-col gap-1.5 rounded-control border border-line p-2.5">
            <p className="text-sm font-medium text-ink">사람이 할 일 (에이전트 금지)</p>
            <p className="text-xs text-muted">저장소 권한·협업자·공개 범위 변경, 이메일 제출처럼 사람이 손으로 해야 하는 절차입니다. 요구사항으로 저장되지 않고, 에이전트에게도 절대 하지 말라고 안내됩니다.</p>
            <textarea
              value={manualSteps.join("\n")}
              onChange={(event) => setManualSteps(event.target.value.split("\n").filter((line) => line.trim().length > 0))}
              rows={Math.max(2, manualSteps.length)}
              placeholder="사람이 할 일(줄마다 하나) — 예: private 저장소를 만들고 협업자를 추가한다"
              className="rounded-control border border-line bg-ground px-2 py-1 text-sm"
            />
          </div>

          <p className="text-xs text-muted">
            저장하면: 에이전트가 매 요청마다 이 목록을 읽고, 요구사항별로 작업·검증 근거를 추적하고, 저장소 탭의 &ldquo;올리기 전 점검&rdquo;이 이걸로 완료 여부를 판단합니다.
          </p>
          <button
            type="button"
            disabled={busy || drafts.length === 0}
            onClick={apply}
            className="self-start rounded-control bg-ink px-4 py-2 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-60"
          >
            {busy ? "저장하는 중" : "docs/requirements.md로 저장"}
          </button>
        </div>
      )}
    </div>
  );
}
