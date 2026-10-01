"use client";

import { useEffect, useRef, useState } from "react";
import { buildRequirementAskPrefill, requirementToMarkdown } from "@/lib/requirement-chat-prefill";
import type { SessionView } from "@/lib/session-view";
import { useChatDraft } from "./chat-draft-context";
import { DesignPipelinePanel } from "./design-pipeline-panel";
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

/** "테스트" 탭(ADR-084)이 HEAD 체크포인트에서 돌린 결과 중 이 요구사항을 언급하는 행을 모은 증거 하나 */
interface TestRunEvidence {
  at: string;
  sha: string;
  shortSha: string;
  passed: number;
  failed: number;
}

interface RequirementEvidence {
  checkpoints: Array<{ sha: string; shortSha: string; message: string }>;
  tests: Array<{ file: string; name: string }>;
  gateChecks: Array<{ name: string; ok: boolean }>;
  testRun?: TestRunEvidence;
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
  /** 저장(apply)하지 않은 추출 결과가 세션 상태 폴더에 남아 있으면 있다(ADR-097, A) */
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
  /** model=추출 모델, fallback=결정론적 대체 파서, managed=b-studio가 이미 발행한 이슈를 모델 호출 없이 그대로 되읽음(ADR-097) */
  source: "model" | "fallback" | "managed";
  reason?: string;
  referencedFiles: ReferencedFileView[];
  outOfScope: string[];
  assumptions: string[];
  manualSteps: string[];
  diff?: RequirementDiffEntry[];
}

/**
 * 추출 결과를 세션 상태 폴더에 남긴 것(서버 재시작·새로고침 뒤에도 "추출 결과" 하위 화면이 그대로 보여준다, ADR-097 개정).
 * "지우기"를 직접 누르기 전까지는 docs/requirements.md로 저장(apply)한 뒤에도 사라지지 않는다.
 */
interface PersistedExtractionDraft extends ExtractionPreview {
  /** 이 추출(또는 재추출)이 끝난 시각 */
  savedAt: string;
  /** 가장 마지막으로 이 결과를 고친 시각(재추출·자동 저장·apply 모두 갱신한다) */
  updatedAt: string;
  /** docs/requirements.md로 저장(apply)한 시각. 저장한 적이 없으면 없다 */
  appliedAt?: string;
  /** 이 추출에 쓴 원래 입력(답변은 뺀다). "스펙을 고치고 다시 뽑기"가 재사용한다 — 없으면(옛 draft) 그 버튼을 숨긴다 */
  sourceInput?: { specText?: string; filePath?: string; issueNumber?: number };
  /** "모호한 점" 질문 인덱스(문자열 키) → 사람이 입력한 답 */
  answers?: Record<string, string>;
  /** 질문 인덱스(문자열 키) → 받은 추천 */
  recommendations?: Record<string, RecommendationView>;
  recommendationSource?: "web" | "model";
}

const KIND_LABEL: Record<RequirementKind, string> = { api: "API", ui: "화면", data: "데이터", nonfunctional: "비기능", docs: "문서" };
const PRIORITY_LABEL: Record<RequirementPriority, string> = { must: "필수", should: "권장", could: "선택" };
const STATUS_TONE: Record<RequirementStatus, string> = { 미착수: "text-muted", "작업 중": "text-wait", 검증됨: "text-pass", "재확인 필요": "text-wait", 실패: "text-fail" };
const DIFF_LABEL: Record<RequirementDiffEntry["status"], string> = { added: "추가", changed: "변경(개정 상승)", unchanged: "그대로", removed: "명세에서 사라짐(그대로 유지됨)" };

async function readJson<T>(response: Response): Promise<T & { error?: string }> {
  return (await response.json().catch(() => ({}))) as T & { error?: string };
}

/** 경과 시간을 "2분 13초"/"13초"로 보여준다(A — "뽑는 중" 버튼 옆에 붙인다) */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}분 ${seconds}초` : `${seconds}초`;
}

/** "추출 결과" 상태줄의 시각 표기("10월 1일 16:20") — 로케일에 기대지 않고 결정론적으로 맞춘다(ADR-097 개정) */
export function formatDraftTimestamp(iso: string): string {
  const date = new Date(iso);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${month}월 ${day}일 ${hours}:${minutes}`;
}

/** "추출 결과" 상태줄: "저장됨 · 10월 1일 16:20"(+"저장한 뒤 바뀜") 또는 "아직 저장 안 함"(ADR-097 개정) */
export function requirementsDraftStatusLine(appliedAt: string | undefined, updatedAt: string): string {
  if (!appliedAt) return "아직 저장 안 함";
  const base = `저장됨 · ${formatDraftTimestamp(appliedAt)}`;
  return updatedAt > appliedAt ? `${base} · 저장한 뒤 바뀜` : base;
}

/** 재추출이 이전 추출 결과를 덮어쓰기 전에 확인을 받아야 하는지(ADR-097 개정): 저장한 적이 없거나, 저장한 뒤에 또 바뀌었으면 */
export function hasUnsavedDraftEdits(draft: PersistedExtractionDraft | undefined): boolean {
  if (!draft) return false;
  return !draft.appliedAt || draft.updatedAt > draft.appliedAt;
}

/**
 * 개발 화면의 "명세" 탭(ADR-079). 과제 명세를 요구사항으로 나누고, 요구사항마다 무엇이 됐다는 증거를 추적한다.
 * "추출 결과"(ADR-097 개정)는 마지막 추출 결과를 배너 뒤에 숨기지 않고 항상 보여준다 — "지우기"를 직접 누르기
 * 전까지는 docs/requirements.md로 저장한 뒤에도 그대로 남는다.
 * "파이프라인"(ADR-100)은 설계 먼저·구현은 따로 하는 요구사항의 진행을 보여 준다 — 요구사항 탭이 이미 요구사항
 * id·추적 매트릭스를 다루고 있어 설계·작업 묶음·구현·검토·검증까지 한곳에서 이어 보기 좋다(새 최상위 탭을 만들지 않았다).
 */
type PanelView = "list" | "extraction" | "matrix" | "pipeline";

export function RequirementsPanel({ view }: { view: SessionView }) {
  const sessionId = view.snapshot.id;
  const access = useSessionAccess();
  const chatDraft = useChatDraft();
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
        if (!response.ok) return;
        if (!data.exists) {
          // 저장한 요구사항이 아직 없다 — 추출 결과가 남아 있으면(지우기 전) 배너 없이 그 화면부터 보여주고,
          // 추출한 적도 없으면 가져오기부터 시작한다
          if (data.draft) setPanelView("extraction");
          else setImporting(true);
        } else {
          // 방금 "지우기"를 눌러 추출 결과가 사라졌는데 "추출 결과" 화면을 보던 중이었다면 목록으로 돌아간다
          setPanelView((current) => (current === "extraction" && !data.draft ? "list" : current));
        }
      })
      .catch(() => {
        if (!cancelled) setSnapshot({ error: "요구사항을 불러오지 못했습니다" });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, revision]);

  /** "요구사항 뽑기"가 끝났다(아직 저장 전) — 가져오기 화면을 닫고 "추출 결과"로 넘어가, 서버가 막 남긴 draft를 다시 읽는다 */
  function onExtracted() {
    setImporting(false);
    setPanelView("extraction");
    setRevision((value) => value + 1);
  }

  function onApplied(next: RequirementsSnapshot) {
    setSnapshot({ data: next });
  }

  function onDiscarded() {
    setRevision((value) => value + 1);
  }

  const showTabs = Boolean(snapshot?.data?.exists || snapshot?.data?.draft) && !importing;
  const tabs = [
    ...(snapshot?.data?.exists ? ([{ id: "list", label: "목록" }] as const) : []),
    ...(snapshot?.data?.draft ? ([{ id: "extraction", label: "추출 결과" }] as const) : []),
    ...(snapshot?.data?.exists ? ([{ id: "matrix", label: "추적 매트릭스" }, { id: "pipeline", label: "파이프라인" }] as const) : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <p className="text-sm font-medium text-ink">명세 → 요구사항 → 검증 추적</p>
        {showTabs && (
          <div className="glass-soft inline-flex rounded-control p-0.5 text-sm" role="tablist" aria-label="요구사항 하위 화면">
            {tabs.map((tab) => (
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
        {(snapshot?.data?.exists || snapshot?.data?.draft) && access.canManage && (
          <button
            type="button"
            onClick={() => {
              // 사람이 직접 연 가져오기는 "요구사항에 반영"이 채웠던 글을 더는 쓰지 않는다(빈 붙여넣기 칸부터 시작)
              setImportSpecText(undefined);
              setImporting((value) => !value);
            }}
            className={`${showTabs ? "" : "ml-auto"} shrink-0 rounded-control border border-line px-3 py-1 text-sm font-medium hover:border-ink`}
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
            onExtracted={onExtracted}
            onCancel={snapshot.data?.exists || snapshot.data?.draft ? () => setImporting(false) : undefined}
            initialSpecText={importSpecText}
            draft={snapshot.data?.draft}
          />
        ) : panelView === "extraction" && snapshot.data?.draft ? (
          <ExtractionResultView sessionId={sessionId} draft={snapshot.data.draft} onApplied={onApplied} onDiscarded={onDiscarded} onRefresh={() => setRevision((value) => value + 1)} />
        ) : panelView === "matrix" ? (
          <MatrixView sessionId={sessionId} />
        ) : panelView === "pipeline" ? (
          <DesignPipelinePanel sessionId={sessionId} />
        ) : (
          <RequirementsList
            sessionId={sessionId}
            snapshot={snapshot.data!}
            canManage={access.canManage}
            isGithub={view.snapshot.repository?.kind === "github"}
            onWork={(text) => chatDraft.fill(text)}
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
  const evidenceCount =
    requirement.evidence.checkpoints.length + requirement.evidence.tests.length + requirement.evidence.gateChecks.length + (requirement.evidence.testRun ? 1 : 0);

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
              {requirement.evidence.testRun && (
                <p className={requirement.evidence.testRun.failed > 0 ? "text-fail" : "text-pass"}>
                  테스트 탭 실행 · {new Date(requirement.evidence.testRun.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} · 체크포인트{" "}
                  <span className="font-mono">{requirement.evidence.testRun.shortSha}</span> · 통과 {requirement.evidence.testRun.passed}
                  {requirement.evidence.testRun.failed > 0 ? ` · 실패 ${requirement.evidence.testRun.failed}` : ""}
                </p>
              )}
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
export function DiffSummary({
  diff,
  onDropRemoved,
  onMatch,
}: {
  diff: RequirementDiffEntry[];
  onDropRemoved?: (ids: string[]) => void;
  /** 자동 병합이 놓친 짝을 사람이 잇는다: 새로 생긴 항목(addedId)이 사라진 기존 항목(removedId)과 같은 요구사항이다 */
  onMatch?: (addedId: string, removedId: string) => void;
}) {
  const counts = (["added", "changed", "unchanged", "removed"] as const).map((status) => ({
    status,
    count: diff.filter((entry) => entry.status === status).length,
  }));
  // 명세에서 사라진 요구사항은 기본으로 지키지만(지운 것이 아니라 이번 명세가 다루지 않을 수 있다), 이전에 잘못
  // 저장한 목록을 통째로 바꿀 때는 한 번에 뺄 수 있어야 한다 — 하나씩 "빼기"를 누르게 하지 않는다
  const removedIds = diff.filter((entry) => entry.status === "removed").map((entry) => entry.id);
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
      {onDropRemoved && removedIds.length > 0 && (
        <button
          type="button"
          onClick={() => onDropRemoved(removedIds)}
          className="rounded-control border border-line px-2 py-0.5 text-xs text-ink hover:bg-panel"
        >
          사라진 {removedIds.length}개도 목록에서 빼기
        </button>
      )}
      {onMatch && removedIds.length > 0 && diff.some((entry) => entry.status === "added") && (
        <div className="mt-1 flex w-full flex-col gap-1.5 border-t border-line pt-2">
          <p className="text-xs text-muted">
            제목이 달라 자동으로 잇지 못한 짝이 있으면 골라 주세요. 고른 기존 id를 이어받아 이미 발행한 이슈와 연결이 유지됩니다.
          </p>
          {diff
            .filter((entry) => entry.status === "added")
            .map((entry) => (
              <label key={entry.id} className="flex flex-wrap items-center gap-2 text-xs text-ink">
                <span className="font-mono text-muted">{entry.id}</span>
                <span className="min-w-0 flex-1 truncate">{entry.requirement.title}</span>
                <select
                  aria-label={`${entry.id}와 같은 기존 요구사항`}
                  defaultValue=""
                  onChange={(event) => event.target.value && onMatch(entry.id, event.target.value)}
                  className="rounded-control border border-line bg-panel px-1.5 py-0.5"
                >
                  <option value="">새 요구사항</option>
                  {diff
                    .filter((removed) => removed.status === "removed")
                    .map((removed) => (
                      <option key={removed.id} value={removed.id}>
                        기존 {removed.id}와 같음 — {(removed.previous ?? removed.requirement).title}
                      </option>
                    ))}
                </select>
              </label>
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * 사람이 고른 짝을 반영한다: 새 항목의 id(와 시나리오 id 앞부분)를 기존 id로 바꾸고, 목록에 남아 있던 기존 항목은 뺀다.
 * 차이 목록에서는 사라짐 항목을 지우고 새 항목을 "변경(개정 상승)"으로 바꾼다. 순수 함수라 테스트에서 바로 쓴다
 */
export function applyManualMatch(
  drafts: RequirementDraft[],
  diff: RequirementDiffEntry[],
  addedId: string,
  removedId: string,
): { drafts: RequirementDraft[]; diff: RequirementDiffEntry[] } {
  const previous = diff.find((entry) => entry.id === removedId && entry.status === "removed");
  const renamed = drafts
    .filter((item) => item.id !== removedId)
    .map((item) =>
      item.id === addedId
        ? {
            ...item,
            id: removedId,
            ...(item.scenarios ? { scenarios: item.scenarios.map((scenario) => ({ ...scenario, id: scenario.id.replace(new RegExp(`^${addedId}\\.`), `${removedId}.`) })) } : {}),
          }
        : item,
    );
  const nextDiff = diff
    .filter((entry) => !(entry.id === removedId && entry.status === "removed"))
    .map((entry) =>
      entry.id === addedId && entry.status === "added"
        ? {
            ...entry,
            status: "changed" as const,
            id: removedId,
            requirement: renamed.find((item) => item.id === removedId) ?? entry.requirement,
            ...(previous ? { previous: previous.previous ?? previous.requirement } : {}),
          }
        : entry,
    );
  return { drafts: renamed, diff: nextDiff };
}

type SourceTab = "paste" | "file" | "issue";
/** 파일 선택으로 읽을 명세 파일의 상한. 명세 글은 보통 수십 KB 안이다 */
const MAX_SPEC_FILE_BYTES = 512 * 1024;

/**
 * ImportFlow는 테스트(용어 검사·렌더)에서도 직접 쓸 수 있게 내보낸다. 입력(붙여넣기/파일/저장소 이슈)을 모아
 * "요구사항 뽑기"만 맡는다 — 뽑은 결과의 편집·질문 답변·저장(apply)·지우기는 모두 "추출 결과" 화면
 * (ExtractionResultView)이 맡는다(ADR-097 개정: 전에는 이 화면이 미리보기·편집까지 전부 가지고 있었다).
 */
export function ImportFlow({
  sessionId,
  onExtracted,
  onCancel,
  initialSpecText,
  draft,
}: {
  sessionId: string;
  /** 추출이 끝나 서버에 결과가 남았다 — 부모가 "추출 결과" 화면으로 넘어간다 */
  onExtracted: () => void;
  onCancel?: () => void;
  /** "요구사항에 반영"(대화 메시지 → 요구사항 패치, ADR-094)이 채운다 — 붙여넣기 칸을 채우고 바로 한 번 추출한다 */
  initialSpecText?: string;
  /** 지금 남아 있는 추출 결과. 저장한 뒤 또 바뀐 게 있으면 재추출 전에 "이전 추출 결과를 새 결과로 바꿉니다"로 확인을 받는다(ADR-097 개정) */
  draft?: PersistedExtractionDraft;
}) {
  const [sourceTab, setSourceTab] = useState<SourceTab>("paste");
  const [specText, setSpecText] = useState(initialSpecText ?? "");
  /** 파일 선택 창으로 고른 파일의 이름과 내용. 내용은 브라우저에서 바로 읽어 붙여넣기처럼 보낸다 */
  const [pickedFile, setPickedFile] = useState<{ name: string; text: string }>();
  const [fileError, setFileError] = useState<string>();
  const [issueNumber, setIssueNumber] = useState("");
  // initialSpecText가 있으면(요구사항에 반영) 마운트 때부터 뽑는 중으로 시작한다 — effect 안에서 setState를
  // 곧바로 부르지 않고 초기값으로 미리 반영해 두는 식이다(리액트 컴파일러 린트가 막는 패턴을 피한다)
  const [busy, setBusy] = useState(() => Boolean(initialSpecText));
  const [error, setError] = useState<string>();
  // 저장한 뒤 또 바뀐 추출 결과가 있으면 재추출 전에 한 번 확인을 받는다
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false);
  // A: "뽑는 중 · 2분 13초" 경과 시간과 취소 — 시작 시각은 busy를 켜는 쪽(extract·초기 추출 effect)이 setState와
  // 같은 틱에 ref로 남긴다. 아래 effect는 그 값을 기준으로 간격만 재깍여 setState를 구독 콜백 안에서만 부른다
  // (effect 본문에서 곧바로 부르지 않는다 — 리액트 컴파일러 린트가 막는 패턴이다)
  const [elapsedMs, setElapsedMs] = useState(0);
  // 0은 렌더 중에 Date.now()를 부르지 않으려는 자리표시값일 뿐이다(리액트 컴파일러 린트가 렌더 중 비순수 호출을
  // 막는다) — mount 때 뽑는 중으로 시작하면(initialSpecText) 아래 effect가, 사람이 누르면 extract가 채운다
  const extractStartedAtRef = useRef(0);
  const extractAbortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setElapsedMs(Date.now() - extractStartedAtRef.current), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  // "요구사항에 반영"이 initialSpecText를 주면 붙여넣기 칸을 채운 뒤 바로 한 번 추출하고 "추출 결과" 화면으로 넘어간다.
  // state(specText)를 거치지 않고 바로 이 값으로 요청해야 "방금 setSpecText한 값"을 또 기다리는 경합이 없다
  useEffect(() => {
    if (!initialSpecText) return;
    extractStartedAtRef.current = Date.now();
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
        onExtracted();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onExtracted는 부모가 매 렌더 새로 만드는 콜백이라 뺀다(최초 한 번만 돈다)
  }, [sessionId, initialSpecText]);

  function sourceBody(): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (sourceTab === "paste") body.specText = specText;
    else if (sourceTab === "file") body.specText = pickedFile?.text ?? "";
    else if (issueNumber.trim()) body.issueNumber = Number(issueNumber);
    return body;
  }

  async function extract() {
    setBusy(true);
    setElapsedMs(0);
    extractStartedAtRef.current = Date.now();
    setError(undefined);
    const controller = new AbortController();
    extractAbortRef.current = controller;
    try {
      const response = await fetch(`/api/sessions/${sessionId}/requirements/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sourceBody()),
        signal: controller.signal,
      });
      const data = await readJson<ExtractionPreview>(response);
      if (!response.ok) {
        setError(data.error ?? "요구사항을 뽑지 못했습니다");
        return;
      }
      onExtracted();
    } catch (err) {
      setError(err instanceof DOMException && err.name === "AbortError" ? "요구사항 뽑기를 취소했습니다" : "요구사항을 뽑지 못했습니다");
    } finally {
      setBusy(false);
      extractAbortRef.current = undefined;
    }
  }

  function onExtractClick() {
    if (hasUnsavedDraftEdits(draft) && !confirmingOverwrite) {
      setConfirmingOverwrite(true);
      return;
    }
    setConfirmingOverwrite(false);
    void extract();
  }

  /** "취소" 버튼 — 브라우저 쪽 fetch를 끊는다(AbortSignal이 라우트를 거쳐 서버 쪽 모델 호출까지 그대로 이어진다) */
  function cancelExtract() {
    extractAbortRef.current?.abort();
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

      {confirmingOverwrite && (
        <div className="flex flex-wrap items-center gap-2 rounded-control border border-wait/40 bg-panel px-3 py-2 text-sm">
          <p className="flex-1 text-ink">이전 추출 결과를 새 결과로 바꿉니다</p>
          <button type="button" onClick={onExtractClick} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
            계속
          </button>
          <button type="button" onClick={() => setConfirmingOverwrite(false)} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
            취소
          </button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!canExtract || busy}
          onClick={onExtractClick}
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
    </div>
  );
}

function indexifyRecord<T>(record: Record<string, T> | undefined): Record<number, T> {
  const result: Record<number, T> = {};
  for (const [key, value] of Object.entries(record ?? {})) result[Number(key)] = value;
  return result;
}

function stringifyRecord<T>(record: Record<number, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [String(key), value]));
}

/**
 * "추출 결과" 하위 화면(ADR-097 개정). 마지막 추출 결과를 배너 뒤에 숨기지 않고 항상 그대로 보여준다 — 요구사항·
 * 가정·사람이 할 일을 고치거나 질문에 답하거나 추천 값을 받으면 800ms 정지 뒤 자동 저장(PATCH)하고, docs/requirements.md로
 * 저장(apply)해도 지워지지 않는다. "지우기"를 직접 눌러 확인해야만 사라진다.
 */
export function ExtractionResultView({
  sessionId,
  draft,
  onApplied,
  onDiscarded,
  onRefresh,
}: {
  sessionId: string;
  draft: PersistedExtractionDraft;
  onApplied: (snapshot: RequirementsSnapshot) => void;
  onDiscarded: () => void;
  /** "스펙을 고치고 다시 뽑기"가 서버에 새 추출 결과를 남긴 뒤, 부모가 다시 읽어 이 컴포넌트에 새 draft를 내려보낸다 */
  onRefresh: () => void;
}) {
  const [savedAt, setSavedAt] = useState(draft.savedAt);
  const [drafts, setDrafts] = useState<RequirementDraft[]>(draft.requirements);
  const [diffEntries, setDiffEntries] = useState(draft.diff);
  const [assumptions, setAssumptions] = useState<string[]>(draft.assumptions);
  const [manualSteps, setManualSteps] = useState<string[]>(draft.manualSteps);
  const [answers, setAnswers] = useState<Record<number, string>>(() => indexifyRecord(draft.answers));
  const [recommendations, setRecommendations] = useState<Record<number, RecommendationView>>(() => indexifyRecord(draft.recommendations));
  const [recommendationSource, setRecommendationSource] = useState(draft.recommendationSource);
  const [appliedAt, setAppliedAt] = useState(draft.appliedAt);
  const [updatedAt, setUpdatedAt] = useState(draft.updatedAt);

  // 부모가 새 draft를 내려보내면(재추출이 끝남) savedAt이 바뀐다 — 이때만 편집 상태를 통째로 새로 초기화한다
  // (렌더 중에 비교해 반영한다 — requirementsImport.target과 같은 관례, effect 안에서 곧바로 setState하지 않는다)
  if (draft.savedAt !== savedAt) {
    setSavedAt(draft.savedAt);
    setDrafts(draft.requirements);
    setDiffEntries(draft.diff);
    setAssumptions(draft.assumptions);
    setManualSteps(draft.manualSteps);
    setAnswers(indexifyRecord(draft.answers));
    setRecommendations(indexifyRecord(draft.recommendations));
    setRecommendationSource(draft.recommendationSource);
    setAppliedAt(draft.appliedAt);
    setUpdatedAt(draft.updatedAt);
  }

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [recommending, setRecommending] = useState(false);
  const [recommendElapsedMs, setRecommendElapsedMs] = useState(0);
  const [reExtracting, setReExtracting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const recommendStartedAtRef = useRef(0);
  const recommendAbortRef = useRef<AbortController | undefined>(undefined);
  const pendingPatchRef = useRef<Record<string, unknown>>({});
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!recommending) return;
    const timer = setInterval(() => setRecommendElapsedMs(Date.now() - recommendStartedAtRef.current), 1000);
    return () => clearInterval(timer);
  }, [recommending]);

  function flushAutosave() {
    if (!saveTimerRef.current) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = undefined;
    const body = pendingPatchRef.current;
    pendingPatchRef.current = {};
    if (Object.keys(body).length === 0) return;
    void fetch(`/api/sessions/${sessionId}/requirements/draft`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
  }

  // 탭을 떠나거나(언마운트) 세션이 바뀌면, 아직 800ms를 다 기다리지 못한 편집도 잃지 않도록 바로 흘려보낸다
  // eslint-disable-next-line react-hooks/exhaustive-deps -- flushAutosave는 매 렌더 새로 만드는 클로저라 뺀다(언마운트 시점 것만 돌면 된다)
  useEffect(() => () => flushAutosave(), [sessionId]);

  /** 800ms 정지 뒤 자동 저장한다(ADR-097 개정). 편집 즉시 상태줄은 "저장한 뒤 바뀜"으로 낙관적으로 먼저 바꾼다 */
  function scheduleAutosave(patch: Record<string, unknown>) {
    pendingPatchRef.current = { ...pendingPatchRef.current, ...patch };
    setUpdatedAt(new Date().toISOString());
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushAutosave, 800);
  }

  function updateDraftItem(index: number, patch: Partial<RequirementDraft>) {
    setDrafts((current) => {
      const next = current.map((item, i) => (i === index ? { ...item, ...patch } : item));
      scheduleAutosave({ requirements: next });
      return next;
    });
  }
  function removeDraftItem(index: number) {
    setDrafts((current) => {
      const next = current.filter((_, i) => i !== index);
      scheduleAutosave({ requirements: next });
      return next;
    });
  }
  function updateAssumptions(next: string[]) {
    setAssumptions(next);
    scheduleAutosave({ assumptions: next });
  }
  function updateManualSteps(next: string[]) {
    setManualSteps(next);
    scheduleAutosave({ manualSteps: next });
  }
  function updateAnswer(index: number, value: string) {
    setAnswers((current) => {
      const next = { ...current, [index]: value };
      scheduleAutosave({ answers: stringifyRecord(next) });
      return next;
    });
  }

  async function recommend() {
    if (draft.questions.length === 0) return;
    setRecommending(true);
    setRecommendElapsedMs(0);
    // eslint-disable-next-line react-hooks/purity -- 사람이 누른 버튼 핸들러 안에서만 도는 경과시간 측정 시작점이다(렌더 중 호출이 아니다)
    recommendStartedAtRef.current = Date.now();
    setError(undefined);
    const controller = new AbortController();
    recommendAbortRef.current = controller;
    try {
      const response = await fetch(`/api/sessions/${sessionId}/requirements/recommend`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questions: draft.questions, ...(draft.sourceInput?.specText ? { specText: draft.sourceInput.specText } : {}) }),
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
        const index = draft.questions.indexOf(recommendation.question);
        if (index === -1) return;
        byIndex[index] = recommendation;
        nextAnswers[index] = recommendation.answer;
      });
      setRecommendations(byIndex);
      setRecommendationSource(data.sourced);
      setAnswers(nextAnswers);
      scheduleAutosave({ recommendations: stringifyRecord(byIndex), recommendationSource: data.sourced, answers: stringifyRecord(nextAnswers) });
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

  async function reExtractWithAnswers() {
    if (!draft.sourceInput) return;
    setReExtracting(true);
    setError(undefined);
    try {
      const answered = draft.questions.map((question, index) => ({ question, answer: answers[index]?.trim() || "(답변 없음)" })).filter((item) => item.answer !== "(답변 없음)");
      const response = await fetch(`/api/sessions/${sessionId}/requirements/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draft.sourceInput, answers: answered }),
      });
      const data = await readJson<ExtractionPreview>(response);
      if (!response.ok) {
        setError(data.error ?? "요구사항을 뽑지 못했습니다");
        return;
      }
      flushAutosave();
      onRefresh();
    } catch {
      setError("요구사항을 뽑지 못했습니다");
    } finally {
      setReExtracting(false);
    }
  }

  async function apply() {
    flushAutosave();
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
      const now = new Date().toISOString();
      setAppliedAt(now);
      setUpdatedAt(now);
      onApplied(data);
    } catch {
      setError("저장하지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    flushAutosave();
    await fetch(`/api/sessions/${sessionId}/requirements/draft`, { method: "DELETE" }).catch(() => {});
    onDiscarded();
  }

  const statusLine = requirementsDraftStatusLine(appliedAt, updatedAt);

  return (
    <div className="flex flex-col gap-3 rounded-control border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-ink">{statusLine}</p>
        <div className="ml-auto">
          {confirmingDelete ? (
            <div className="flex flex-wrap items-center gap-2 rounded-control border border-fail/40 bg-fail/10 px-3 py-2 text-sm">
              <p className="text-ink">추출 결과를 지웁니다. 저장한 요구사항(docs/requirements.md)은 그대로 남습니다.</p>
              <button type="button" onClick={discard} className="rounded-control border border-fail px-2.5 py-1 text-xs font-medium text-fail hover:bg-fail/10">
                정말 지우기
              </button>
              <button type="button" onClick={() => setConfirmingDelete(false)} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
                취소
              </button>
            </div>
          ) : (
            <button type="button" onClick={() => setConfirmingDelete(true)} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium text-fail hover:border-fail">
              지우기
            </button>
          )}
        </div>
      </div>

      {draft.source === "fallback" ? (
        <div className="rounded-control border border-fail/40 bg-fail/10 px-3 py-2 text-sm text-fail">
          <span className="font-medium">모델 호출 없이 결정론적 방식으로 나눴습니다</span>
          {draft.reason ? ` — ${draft.reason}` : ""}
        </div>
      ) : (
        <p className="text-sm text-muted">{draft.source === "model" ? "추출 모델이 나눴습니다." : draft.reason}</p>
      )}

      {diffEntries && (
        <DiffSummary
          diff={diffEntries}
          onDropRemoved={(ids) => {
            const drop = new Set(ids);
            setDrafts((current) => {
              const next = current.filter((item) => !drop.has(item.id));
              scheduleAutosave({ requirements: next });
              return next;
            });
            setDiffEntries((current) => current?.filter((entry) => !drop.has(entry.id)));
          }}
          onMatch={(addedId, removedId) => {
            const result = applyManualMatch(drafts, diffEntries, addedId, removedId);
            setDrafts(result.drafts);
            setDiffEntries(result.diff);
            scheduleAutosave({ requirements: result.drafts });
          }}
        />
      )}

      {draft.manualSteps.length > 0 && <ManualStepsNotice items={draft.manualSteps} />}

      {draft.referencedFiles.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-control bg-ground px-3 py-2">
          <p className="text-sm font-medium text-ink">참조 파일</p>
          <ul className="flex flex-col gap-1 text-xs text-muted">
            {draft.referencedFiles.map((file) => (
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

      {draft.questions.length > 0 && (
        <div className="flex flex-col gap-2 rounded-control bg-ground px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-ink">모호한 점 (최대 5개)</p>
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
          {draft.questions.map((question, index) => {
            const recommendation = recommendations[index];
            return (
              <label key={index} className="flex flex-col gap-1 text-sm">
                <span>{question}</span>
                <input value={answers[index] ?? ""} onChange={(event) => updateAnswer(index, event.target.value)} className="rounded-control border border-line bg-panel px-2 py-1 text-sm" />
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
          {draft.sourceInput && (
            <button
              type="button"
              disabled={reExtracting}
              onClick={reExtractWithAnswers}
              className="self-start rounded-control border border-line px-3 py-1.5 text-sm font-medium hover:border-ink disabled:opacity-60"
            >
              {reExtracting ? "다시 뽑는 중" : "스펙을 고치고 다시 뽑기"}
            </button>
          )}
        </div>
      )}

      {draft.outOfScope.length > 0 && (
        <div className="flex flex-col gap-1 rounded-control bg-ground px-3 py-2">
          <p className="text-sm font-medium text-ink">범위 밖</p>
          <ul className="list-inside list-disc text-sm text-muted">
            {draft.outOfScope.map((item, index) => (
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
                onChange={(event) => updateDraftItem(index, { title: event.target.value })}
                className="min-w-0 flex-1 rounded-control border border-line bg-ground px-2 py-1 text-sm"
              />
              <select
                value={requirement.kind}
                onChange={(event) => updateDraftItem(index, { kind: event.target.value as RequirementKind })}
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
                onChange={(event) => updateDraftItem(index, { priority: event.target.value as RequirementPriority })}
                className="rounded-control border border-line bg-ground px-1.5 py-1 text-xs"
              >
                {Object.entries(PRIORITY_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => removeDraftItem(index)} className="shrink-0 text-xs font-medium text-fail hover:underline">
                빼기
              </button>
            </div>
            <textarea
              value={requirement.acceptance.join("\n")}
              onChange={(event) => updateDraftItem(index, { acceptance: event.target.value.split("\n").filter((line) => line.trim().length > 0) })}
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
          onChange={(event) => updateAssumptions(event.target.value.split("\n").filter((line) => line.trim().length > 0))}
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
          onChange={(event) => updateManualSteps(event.target.value.split("\n").filter((line) => line.trim().length > 0))}
          rows={Math.max(2, manualSteps.length)}
          placeholder="사람이 할 일(줄마다 하나) — 예: private 저장소를 만들고 협업자를 추가한다"
          className="rounded-control border border-line bg-ground px-2 py-1 text-sm"
        />
      </div>

      {error && <p className="text-sm text-fail">{error}</p>}
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
  );
}
