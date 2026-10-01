"use client";

import { useEffect, useState } from "react";
import type { DesignBundle, DesignDocRecord, DesignPipelineBundleActual, DesignPipelineResult, DesignPipelineReviewInput, DesignPipelineVerificationInput, ReviewIndependence } from "@b-studio/agent";
import { buildDesignDraftChatPrefill } from "@/lib/design-chat-prefill";
import { useChatDraft } from "./chat-draft-context";
import { useSessionAccess } from "./session-access";

/**
 * "요구사항" 탭의 "파이프라인" 하위 화면(ADR-100). 설계 문서마다 요구사항 → 설계 → 작업 묶음 → 구현 → 검토 → 검증
 * 단계를 보여 주고, "완료"(구현이 끝났다)와 "성공"(독립 검토 + 검증 재실행 통과)을 나눠 보여 준다.
 * 설계 승인은 여기서 하지만, 승인 전 구현 차단은 서버(messages·task-plans 라우트)가 강제한다 — 이 화면이 막는 게 아니다.
 */
export interface DesignPipelineDocView {
  design: DesignDocRecord;
  linkedTaskPlanIds: string[];
  bundleActuals: DesignPipelineBundleActual[];
  review?: DesignPipelineReviewInput;
  verification?: DesignPipelineVerificationInput;
  implementationCheckpointExists: boolean;
  result: DesignPipelineResult;
}

async function readJson<T>(response: Response): Promise<T & { error?: string }> {
  return (await response.json().catch(() => ({}))) as T & { error?: string };
}

const INDEPENDENCE_LABEL: Record<ReviewIndependence, string> = {
  independent: "다른 계열 검토",
  "same-family": "같은 계열 검토(독립성 낮음)",
  unknown: "검토 계열 확인 안 됨",
};

export function DesignPipelinePanel({ sessionId }: { sessionId: string }) {
  const access = useSessionAccess();
  const [state, setState] = useState<{ docs?: DesignPipelineDocView[]; error?: string }>();
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/design-pipeline`)
      .then(async (response) => {
        const data = await readJson<{ docs: DesignPipelineDocView[] }>(response);
        if (cancelled) return;
        setState(response.ok ? { docs: data.docs } : { error: data.error ?? "파이프라인을 불러오지 못했습니다" });
      })
      .catch(() => {
        if (!cancelled) setState({ error: "파이프라인을 불러오지 못했습니다" });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, revision]);

  function refresh() {
    setRevision((value) => value + 1);
  }

  async function approve(path: string) {
    const response = await fetch(`/api/sessions/${sessionId}/design-docs/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await readJson(response);
    if (!response.ok) {
      window.alert(data.error ?? "설계를 승인하지 못했습니다");
      return;
    }
    refresh();
  }

  if (!state) return <p className="text-sm text-muted">불러오는 중</p>;
  if (state.error) return <p className="text-sm text-fail">{state.error}</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">설계 먼저, 구현은 따로 — 승인된 설계만 구현을 시작할 수 있습니다</p>
        {access.canManage && (
          <button type="button" onClick={() => setCreating((value) => !value)} className="shrink-0 rounded-control border border-line px-3 py-1 text-sm font-medium hover:border-ink">
            {creating ? "닫기" : "새 설계 문서"}
          </button>
        )}
      </div>
      {creating && <NewDesignDocForm sessionId={sessionId} onCreated={() => { setCreating(false); refresh(); }} />}
      {state.docs!.length === 0 ? (
        <p className="text-sm text-muted">아직 설계 문서가 없습니다. 설계 문서가 없는 요구사항은 지금처럼 바로 구현을 시작할 수 있습니다.</p>
      ) : (
        state.docs!.map((doc) => <DesignPipelineCard key={doc.design.path} doc={doc} canManage={access.canManage} onApprove={() => approve(doc.design.path)} />)
      )}
    </div>
  );
}

function NewDesignDocForm({ sessionId, onCreated }: { sessionId: string; onCreated: () => void }) {
  const draft = useChatDraft();
  const [title, setTitle] = useState("");
  const [requirementIds, setRequirementIds] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const parsedIds = requirementIds
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);

  async function submit() {
    setSaving(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/design-docs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, requirementIds: parsedIds.length > 0 ? parsedIds : undefined }),
      });
      const data = await readJson(response);
      if (!response.ok) {
        setError(data.error ?? "설계 문서를 만들지 못했습니다");
        return;
      }
      onCreated();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-md border border-line bg-panel px-3.5 py-3">
      <p className="text-sm font-medium text-ink">새 설계 문서(초안)</p>
      <p className="mt-1 text-xs leading-5 text-muted">
        먼저 &quot;설계 요청&quot;으로 대화창에 읽기만(조사) 모드 질문을 채운 뒤 보내 모델의 설계 답을 받고, 그 답을 아래 내용 칸에 붙여 넣어 저장하세요.
        저장하면 &quot;초안&quot; 상태로 시작하고, 사람이 승인해야 이 설계가 다루는 요구사항의 구현을 시작할 수 있습니다.
      </p>
      <div className="mt-2 flex flex-col gap-2">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="제목(예: 채팅 입력 설계)"
          className="rounded-control border border-line bg-base px-2.5 py-1.5 text-sm"
        />
        <input
          value={requirementIds}
          onChange={(event) => setRequirementIds(event.target.value)}
          placeholder="대상 요구사항 id(쉼표로 구분, 예: R1, R2) — 비우면 내용에서 스스로 찾습니다"
          className="rounded-control border border-line bg-base px-2.5 py-1.5 text-sm"
        />
        <button
          type="button"
          disabled={!title.trim()}
          onClick={() => draft.fill(buildDesignDraftChatPrefill({ title: title.trim() || "제목 없음", requirementIds: parsedIds }), { readOnly: true })}
          className="self-start rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink disabled:opacity-50"
        >
          설계 요청(대화창에 채우기)
        </button>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={10}
          placeholder="모델의 설계 답(또는 직접 쓴 설계)을 붙여 넣으세요. 작업 묶음 표를 그대로 포함하면 예상 시간을 함께 기록합니다."
          className="rounded-control border border-line bg-base px-2.5 py-1.5 text-sm font-mono text-xs"
        />
        {error && <p className="text-xs text-fail">{error}</p>}
        <button
          type="button"
          disabled={saving || !title.trim() || !body.trim()}
          onClick={() => void submit()}
          className="self-start rounded-control bg-ink px-3 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
        >
          {saving ? "만드는 중" : "초안으로 저장"}
        </button>
      </div>
    </div>
  );
}

function DesignPipelineCard({ doc, canManage, onApprove }: { doc: DesignPipelineDocView; canManage: boolean; onApprove: () => void }) {
  const { design, result } = doc;
  return (
    <div className="rounded-md border border-line bg-panel px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium text-ink">
          [{String(design.number).padStart(2, "0")}] {design.title}
        </p>
        <StatusBadge approved={design.status === "approved"} />
        <ResultBadges result={result} />
        {canManage && design.status === "draft" && (
          <button type="button" onClick={onApprove} className="ml-auto shrink-0 rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
            승인
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">{design.path}</p>

      <Stage title="요구사항">
        {design.requirementIds.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {design.requirementIds.map((id) => (
              <span key={id} className="rounded-control bg-base px-1.5 py-0.5 text-xs">
                {id}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">대상 요구사항이 없습니다</p>
        )}
      </Stage>

      <Stage title="설계">
        <p className="text-xs text-muted">
          {design.status === "approved" ? `${design.approvedBy ?? "?"}님이 ${design.approvedAt ? new Date(design.approvedAt).toLocaleString() : ""}에 승인` : `${design.createdBy}님이 초안 작성`}
        </p>
      </Stage>

      <Stage title="작업 묶음">
        {doc.bundleActuals.length === 0 ? <p className="text-xs text-muted">작업 묶음 표가 없습니다</p> : <BundleTable actuals={doc.bundleActuals} />}
      </Stage>

      <Stage title="구현">
        <p className="text-xs text-muted">{doc.implementationCheckpointExists ? "구현 체크포인트 있음" : "아직 구현 체크포인트가 없습니다"}</p>
      </Stage>

      <Stage title="검토">
        {doc.review ? (
          <p className="text-xs text-muted">
            {doc.review.ran ? (doc.review.passed ? "통과" : "통과하지 못함") : "검토 못 함"} · {INDEPENDENCE_LABEL[doc.review.independence]}
            {doc.review.findingsCount !== undefined ? ` · 지적 ${doc.review.findingsCount}건` : ""}
          </p>
        ) : (
          <p className="text-xs text-muted">검토 못 함(아직 리뷰를 부르지 않았습니다)</p>
        )}
      </Stage>

      <Stage title="검증">
        {doc.verification ? (
          <p className="text-xs text-muted">
            {doc.verification.ran ? (doc.verification.ok ? "통과" : "통과하지 못함") : "검증을 다시 돌리지 못했습니다"}
            {doc.verification.ran ? ` · 테스트 재실행 ${doc.verification.testsRerun ? "포함" : "미포함"}` : ""}
          </p>
        ) : (
          <p className="text-xs text-muted">검증을 다시 돌리지 못했습니다</p>
        )}
      </Stage>

      {result.reasons.length > 0 && (
        <p className="mt-2 text-xs text-wait">성공이 아닌 이유: {result.reasons.join(", ")}</p>
      )}
    </div>
  );
}

function Stage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-2">
      <p className="text-xs font-semibold text-muted">{title}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function StatusBadge({ approved }: { approved: boolean }) {
  return <span className={`rounded-control px-1.5 py-0.5 text-xs font-medium ${approved ? "bg-pass/15 text-pass" : "bg-wait/15 text-wait"}`}>{approved ? "승인됨" : "초안"}</span>;
}

function ResultBadges({ result }: { result: DesignPipelineResult }) {
  return (
    <span className="flex gap-1">
      <span className={`rounded-control px-1.5 py-0.5 text-xs font-medium ${result.completed ? "bg-pass/15 text-pass" : "bg-base text-muted"}`}>
        완료 {result.completed ? "✓" : "–"}
      </span>
      <span className={`rounded-control px-1.5 py-0.5 text-xs font-medium ${result.succeeded ? "bg-pass/15 text-pass" : "bg-base text-muted"}`}>
        성공 {result.succeeded ? "✓" : "–"}
      </span>
    </span>
  );
}

function BundleTable({ actuals }: { actuals: readonly DesignPipelineBundleActual[] }) {
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-muted">
          <th className="pr-2 font-medium">묶음</th>
          <th className="pr-2 font-medium">예상(분)</th>
          <th className="pr-2 font-medium">실제(분)</th>
          <th className="pr-2 font-medium">코더</th>
        </tr>
      </thead>
      <tbody>
        {actuals.map(({ bundle, actualMinutes, coder }: { bundle: DesignBundle; actualMinutes?: number; coder?: DesignPipelineBundleActual["coder"] }) => (
          <tr key={bundle.id} className="border-t border-line">
            <td className="py-1 pr-2">
              {bundle.id} {bundle.title}
            </td>
            <td className="py-1 pr-2">
              {bundle.estimateMinMinutes}–{bundle.estimateMaxMinutes}
            </td>
            <td className="py-1 pr-2">{actualMinutes ?? "–"}</td>
            <td className="py-1 pr-2">
              {coder ? `${coder.backend ?? "?"}${coder.model ? `/${coder.model}` : ""}${coder.escalated ? " (승격됨)" : ""}` : "–"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
