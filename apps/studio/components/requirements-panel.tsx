"use client";

import { useEffect, useState } from "react";
import type { SessionView } from "@/lib/session-view";
import { useChatDraft } from "./chat-draft-context";
import { useSessionAccess } from "./session-access";

type RequirementKind = "api" | "ui" | "data" | "nonfunctional" | "docs";
type RequirementPriority = "must" | "should" | "could";
type RequirementStatus = "미착수" | "작업 중" | "검증됨" | "실패";

interface RequirementDraft {
  id: string;
  title: string;
  kind: RequirementKind;
  priority: RequirementPriority;
  acceptance: string[];
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
}

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
}

interface ExtractionPreview {
  requirements: RequirementDraft[];
  questions: string[];
  source: "model" | "fallback";
  reason?: string;
  referencedFiles: ReferencedFileView[];
  outOfScope: string[];
  assumptions: string[];
}

const KIND_LABEL: Record<RequirementKind, string> = { api: "API", ui: "화면", data: "데이터", nonfunctional: "비기능", docs: "문서" };
const PRIORITY_LABEL: Record<RequirementPriority, string> = { must: "필수", should: "권장", could: "선택" };
const STATUS_TONE: Record<RequirementStatus, string> = { 미착수: "text-muted", "작업 중": "text-wait", 검증됨: "text-pass", 실패: "text-fail" };

async function readJson<T>(response: Response): Promise<T & { error?: string }> {
  return (await response.json().catch(() => ({}))) as T & { error?: string };
}

/** 개발 화면의 "명세" 탭(ADR-079). 과제 명세를 요구사항으로 나누고, 요구사항마다 무엇이 됐다는 증거를 추적한다 */
export function RequirementsPanel({ view }: { view: SessionView }) {
  const sessionId = view.snapshot.id;
  const access = useSessionAccess();
  const draft = useChatDraft();
  const [snapshot, setSnapshot] = useState<{ data?: RequirementsSnapshot; error?: string }>();
  const [importing, setImporting] = useState(false);
  const [revision, setRevision] = useState(0);

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
        {snapshot?.data?.exists && access.canManage && (
          <button
            type="button"
            onClick={() => setImporting((value) => !value)}
            className="ml-auto shrink-0 rounded-control border border-line px-3 py-1 text-sm font-medium hover:border-ink"
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
          <ImportFlow sessionId={sessionId} onApplied={onApplied} onCancel={snapshot.data?.exists ? () => setImporting(false) : undefined} />
        ) : (
          <RequirementsList
            sessionId={sessionId}
            snapshot={snapshot.data!}
            canManage={access.canManage}
            onWork={(text) => draft.fill(text)}
            onRefresh={() => setRevision((value) => value + 1)}
          />
        )}
      </div>
    </div>
  );
}

function RequirementsList({
  sessionId,
  snapshot,
  canManage,
  onWork,
  onRefresh,
}: {
  sessionId: string;
  snapshot: RequirementsSnapshot;
  canManage: boolean;
  onWork: (text: string) => void;
  onRefresh: () => void;
}) {
  if (snapshot.requirements.length === 0) {
    return <p className="text-sm text-muted">docs/requirements.md는 있지만 요구사항을 하나도 읽지 못했습니다. &ldquo;명세 다시 가져오기&rdquo;로 다시 뽑아 보세요.</p>;
  }
  const coverage = snapshot.coverage;
  return (
    <div className="flex flex-col gap-4">
      {coverage && (
        <div className="glass-soft flex flex-wrap items-center gap-2 rounded-control px-3 py-2 text-sm">
          <span className="font-medium text-ink">{coverage.text}</span>
          {coverage.mustGapText && <span className="font-medium text-fail">{coverage.mustGapText}</span>}
          {canManage && (
            <button type="button" onClick={() => onRefresh()} className="ml-auto rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
              증거 새로고침
            </button>
          )}
        </div>
      )}
      {canManage && snapshot.allMustHavesPrefill && (
        <div className="flex flex-col gap-1.5 rounded-control border border-line bg-panel p-3">
          <p className="text-sm font-medium text-ink">다음 단계</p>
          <p className="text-xs text-muted">에이전트가 매 요청마다 이 목록을 읽고 요구사항별로 작업·검증 근거를 추적합니다. 한 번에 시작하거나, 아래에서 요구사항 하나씩 골라 시작할 수 있습니다.</p>
          <button
            type="button"
            onClick={() => onWork(snapshot.allMustHavesPrefill!)}
            className="mt-1 self-start rounded-control bg-ink px-3 py-1.5 text-sm font-medium text-panel hover:bg-ink/85"
          >
            전체 계획 세우기(필수 요구사항)
          </button>
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
      <p className="text-xs text-muted">파일: docs/requirements.md · 세션 작업 복사본에 저장되어 체크포인트·PR에 그대로 실립니다. 세션 id: {sessionId}</p>
    </div>
  );
}

function RequirementCard({ requirement, canManage, onWork }: { requirement: RequirementView; canManage: boolean; onWork: () => void }) {
  const [open, setOpen] = useState(false);
  const evidenceCount = requirement.evidence.checkpoints.length + requirement.evidence.tests.length + requirement.evidence.gateChecks.length;
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
          </p>
        </div>
        {canManage && (
          <button type="button" onClick={onWork} className="shrink-0 rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
            이 요구사항 작업
          </button>
        )}
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

type SourceTab = "paste" | "file" | "issue";

/** ImportFlow는 테스트(용어 검사·렌더)에서도 직접 쓸 수 있게 내보낸다 */
export function ImportFlow({ sessionId, onApplied, onCancel }: { sessionId: string; onApplied: (snapshot: RequirementsSnapshot) => void; onCancel?: () => void }) {
  const [sourceTab, setSourceTab] = useState<SourceTab>("paste");
  const [specText, setSpecText] = useState("");
  const [filePath, setFilePath] = useState("");
  const [issueNumber, setIssueNumber] = useState("");
  const [preview, setPreview] = useState<ExtractionPreview>();
  const [drafts, setDrafts] = useState<RequirementDraft[]>([]);
  const [assumptions, setAssumptions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [recommendations, setRecommendations] = useState<Record<number, RecommendationView>>({});
  const [recommendationSource, setRecommendationSource] = useState<"web" | "model">();
  const [recommending, setRecommending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  function sourceBody(withAnswers: boolean) {
    const body: Record<string, unknown> = {};
    if (sourceTab === "paste") body.specText = specText;
    else if (sourceTab === "file") body.filePath = filePath;
    else if (issueNumber.trim()) body.issueNumber = Number(issueNumber);
    if (withAnswers && preview) {
      body.answers = preview.questions.map((question, index) => ({ question, answer: answers[index]?.trim() || "(답변 없음)" })).filter((item) => item.answer !== "(답변 없음)");
    }
    return body;
  }

  async function extract(withAnswers: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/requirements/extract`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sourceBody(withAnswers)),
      });
      const data = await readJson<ExtractionPreview>(response);
      if (!response.ok) {
        setError(data.error ?? "요구사항을 뽑지 못했습니다");
        return;
      }
      setPreview(data);
      setDrafts(data.requirements);
      setAssumptions(data.assumptions);
      setAnswers({});
      setRecommendations({});
      setRecommendationSource(undefined);
    } catch {
      setError("요구사항을 뽑지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  async function recommend() {
    if (!preview || preview.questions.length === 0) return;
    setRecommending(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/requirements/recommend`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ questions: preview.questions, ...(sourceTab === "paste" ? { specText } : {}) }),
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
    } catch {
      setError("추천 값을 받지 못했습니다");
    } finally {
      setRecommending(false);
    }
  }

  async function apply() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/requirements/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requirements: drafts, assumptions }),
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

  const canExtract = sourceTab === "paste" ? specText.trim().length > 0 : sourceTab === "file" ? filePath.trim().length > 0 : issueNumber.trim().length > 0;

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
            { id: "file", label: "작업 복사본 파일" },
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
        <input
          value={filePath}
          onChange={(event) => setFilePath(event.target.value)}
          placeholder="예: 요구사항.md, README.md, docs/spec.md"
          className="rounded-control border border-line bg-ground px-3 py-2 text-sm"
        />
      ) : (
        <input
          value={issueNumber}
          onChange={(event) => setIssueNumber(event.target.value)}
          placeholder="이슈 번호(예: 57)"
          inputMode="numeric"
          className="rounded-control border border-line bg-ground px-3 py-2 text-sm"
        />
      )}

      <button
        type="button"
        disabled={!canExtract || busy}
        onClick={() => extract(false)}
        className="self-start rounded-control bg-ink px-4 py-2 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-60"
      >
        {busy ? "뽑는 중" : "요구사항 뽑기"}
      </button>
      {error && <p className="text-sm text-fail">{error}</p>}

      {preview && (
        <div className="flex flex-col gap-3 rounded-control border border-line p-3">
          <p className="text-sm text-muted">
            {preview.source === "model" ? "추출 모델이 나눴습니다." : `결정론적 방식으로 나눴습니다${preview.reason ? `: ${preview.reason}` : ""}`}
          </p>

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
                <button
                  type="button"
                  disabled={recommending}
                  onClick={recommend}
                  className="ml-auto shrink-0 rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink disabled:opacity-60"
                >
                  {recommending ? "추천 값 찾는 중" : "추천 값으로 채우기"}
                </button>
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
                        {recommendation.rationale}
                        {recommendationSource === "model" && <span className="ml-1 font-medium text-wait">출처 확인 필요</span>}
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

          <p className="text-xs text-muted">
            저장하면: 에이전트가 매 요청마다 이 목록을 읽고, 요구사항별로 작업·검증 근거를 추적하고, 제출 준비 점검표가 이걸로 완료 여부를 판단합니다.
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
