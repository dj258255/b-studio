"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DatabaseState, DiscardBackup, ServiceCheck } from "@b-studio/agent";
import { answerRequest } from "@/lib/question-answer";
import { artifactUrl } from "@/lib/artifact-url";
import { chatMethodAvailability, type ChatCapabilities, type ChatMethod } from "@/lib/chat-methods";
import { chatRequestBody, intentFor } from "@/lib/chat-request";
import { submitEntry } from "@/lib/home-entry";
import type { EffortPickerView, ModelPickerOption, ModelPickerView } from "@/lib/server/model-picker";
import { activeRun, outcomeText, runsWithChanges, type ChatItem, type SessionView } from "@/lib/session-view";
import { formatElapsed } from "@/lib/split";
import { describeTokens, formatBytes, formatTokenCount, hasTokens, totalTokens } from "@/lib/usage";
import { useChatDraft } from "./chat-draft-context";
import { DiffView } from "./diff-view";
import { NewDocDialog } from "./docs-panel";
import { GateTrack } from "./gate-track";
import { HandoffCard } from "./handoff-card";
import { Markdown } from "./markdown";
import { useRequirementsImport } from "./requirements-import-context";
import { formatElementSelections, useElementSelections } from "./selection-context";
import { useSessionAccess, type SessionAccess } from "./session-access";
import { useLightVerify } from "./use-light-verify";
import { useReadOnly } from "./use-read-only";
import { useResearch } from "./use-research";

/** packages/agent의 COVERAGE_GAP_PREFIX와 같은 값. 클라이언트 번들에 agent 런타임을 끌어오지 않으려고 문자열로 둔다 */
const COVERAGE_GAP_NAME_PREFIX = "coverage-gap:";

type Intent = "build" | "ask";

/** 질문의 답을 받아 만들기로 넘어갈 때 보내는 요청. 대화를 이어받으므로 앞의 계획을 가리키기만 한다 */
const BUILD_FROM_PLAN = "앞에서 정리한 계획대로 만들어줘";

/**
 * 나눠서 병렬 제안을 수락할 때 이 대화의 모델 선택을 계획에 넘길 값으로 만든다.
 * 아직 모델 선택을 못 받았으면(picker 없음, 예를 들어 데모 세션) 아무것도 넘기지 않아 서버 기본을 그대로 쓴다.
 * 노력 단계는 이 백엔드·모델이 지원할 때만 넣는다(지원하지 않는데 값을 넣으면 서버가 조용히 버린다 — 넣지 않는 편이 뜻이 분명하다)
 */
export function handoffModelInput(picker: ModelPickerView | undefined): { sessionModelId?: string; sessionEffort?: string } {
  if (!picker) return {};
  return {
    sessionModelId: picker.current ?? "",
    ...(picker.effort.supported && picker.effort.current ? { sessionEffort: picker.effort.current } : {}),
  };
}

export function ChatPanel({ view }: { view: SessionView }) {
  const { snapshot, chat } = view;
  const router = useRouter();
  const [text, setText] = useState("");
  const [capabilities, setCapabilities] = useState<ChatCapabilities>();
  const [allowBreaking, setAllowBreaking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  /** 대화 입력창의 모델 선택(고를 수 있는 목록 + 지금 값). 데모 세션은 모델을 부르지 않으므로 불러오지 않는다 */
  const [picker, setPicker] = useState<ModelPickerView>();
  const [modelError, setModelError] = useState<string>();
  const [changingModel, setChangingModel] = useState(false);
  /** 되돌리는 동작이라 한 번 더 누르게 한다. 요청이 바뀌면 확인 상태도 사라지도록 요청 id로 둔다 */
  const [confirmingCancel, setConfirmingCancel] = useState<string>();
  const listRef = useRef<HTMLOListElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const runId = activeRun(view);
  const asking = isAsking(view);
  const access = useSessionAccess();
  const { selections, remove: removeSelection, clear: clearSelections } = useElementSelections();
  // 저장소 탭의 "이 이슈로 작업"이 입력창을 채울 수 있도록 채우기 함수를 등록한다(사람이 보고 고친 뒤 직접 보낸다)
  const draft = useChatDraft();
  useEffect(() => {
    draft.register((value, mode) => {
      setText(value);
      // "대화에서 묻기"(요구사항 카드, ADR-094)는 읽기만·조사를 함께 켜 달라고 부탁할 수 있다
      if (mode?.readOnly) setReadOnly(true);
      if (mode?.research !== undefined) setResearch(mode.research);
      textareaRef.current?.focus();
    });
    return () => draft.register(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);
  const limit = snapshot.tokenLimit;
  const used = totalTokens(snapshot.tokens);
  const budgetReached = limit !== undefined && used >= limit;
  /**
   * 입력은 하나다. "읽기만"이 켜져 있으면 질문 경로(intent `ask`, 읽기 전용 도구)로 보내고,
   * 꺼져 있으면 만들기 경로로 보낸다 — 에이전트가 요청을 보고 답만 하거나 바꾼다
   */
  const [readOnly, setReadOnly] = useReadOnly(snapshot.id);
  /**
   * "가볍게 확인"은 읽기만이 꺼져 있을 때만 보인다. 켜면 게이트가 재시작·준비 판정·계약만 돌리고
   * 테스트·화면 확인·리뷰는 건너뛴다(세션마다 기억하되, 읽기만 중에도 값은 남긴다)
   */
  const [lightVerify, setLightVerify] = useLightVerify(snapshot.id);
  /**
   * "조사"는 읽기만이 켜졌을 때만 보인다(ADR-094). 켜면 질문에 웹에서 찾아 답하라는 안내가 붙고,
   * 이 세션 백엔드가 claude-code면 이번 턴 WebSearch·WebFetch를 실제로 연다(그 밖의 백엔드는 모델 지식만으로 답한다)
   */
  const [research, setResearch] = useResearch(snapshot.id);
  const intent: Intent = intentFor(readOnly);
  const researchWebAvailable = capabilities?.mode === "claude-code";
  /** 파일을 바꾼 실행. 결과 줄에서 "답만 했습니다"와 "완료"를 가른다 */
  const changedRuns = runsWithChanges(chat);
  /** 내 사용량은 세션을 보는 모든 사람에게 방송되지 않으므로 따로 받아 온다 */
  const [personal, setPersonal] = useState<{ used: number; limit?: number; window: "day" | "month" }>();

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [chat]);

  // 요청이 끝나 세션 합계가 바뀔 때마다 내 합계도 다시 받는다
  useEffect(() => {
    let cancelled = false;
    fetch("/api/usage")
      .then(async (response) => {
        const data = await response.json();
        if (!cancelled && response.ok) setPersonal({ used: data.used ?? 0, limit: data.limit, window: data.window ?? "day" });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [used, snapshot.running]);

  // 에이전트가 제안한 비교·병렬을 이 서버에서 바로 넘길 수 있는지는 서버가 정한다(데모는 못 쓰고, API 모드는 모델을 골라야 한다)
  useEffect(() => {
    let cancelled = false;
    fetch("/api/capabilities")
      .then(async (response) => (response.ok ? ((await response.json()) as ChatCapabilities) : undefined))
      .then((data) => {
        if (!cancelled && data) setCapabilities(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const methods = chatMethodAvailability(capabilities);

  // 대화 입력창의 모델 선택. 세션 id가 바뀔 때만 다시 불러온다(백엔드는 세션 동안 바뀌지 않는다)
  useEffect(() => {
    if (snapshot.mode === "demo") return;
    let cancelled = false;
    fetch(`/api/sessions/${snapshot.id}/model`)
      .then(async (response) => (response.ok ? ((await response.json()) as ModelPickerView) : undefined))
      .then((data) => {
        if (!cancelled && data) setPicker(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [snapshot.id, snapshot.mode]);

  /** 모델을 바꾼다. 다음 요청부터 적용되고(진행 중 요청에는 영향이 없다), 실패하면 이전 선택으로 되돌린다 */
  async function changeModel(modelId: string) {
    if (!picker) return;
    await changeSelection({ modelId }, { ...picker, current: modelId });
  }

  /** 노력 단계를 바꾼다. 모델과 같은 API를 쓰고, 같은 실패 규칙(되돌리기)을 따른다 */
  async function changeEffort(effort: string) {
    if (!picker) return;
    await changeSelection({ effort }, { ...picker, effort: { ...picker.effort, current: (effort || undefined) as EffortPickerView["current"] } });
  }

  async function changeSelection(body: { modelId?: string; effort?: string }, optimistic: ModelPickerView) {
    if (!picker) return;
    const previous = picker;
    setChangingModel(true);
    setModelError(undefined);
    setPicker(optimistic);
    const response = await fetch(`/api/sessions/${snapshot.id}/model`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) setPicker((await response.json()) as ModelPickerView);
    else {
      setPicker(previous);
      setModelError((await response.json()).error ?? "모델을 바꾸지 못했습니다");
    }
    setChangingModel(false);
  }

  const personalLimit = personal?.limit;
  const personalReached = personalLimit !== undefined && personal !== undefined && personal.used >= personalLimit;
  // idle(샌드박스 꺼짐)이면 요청을 보낼 수 있다. 읽기만 하면 그대로 끝나고, 필요하면 실행 중에 샌드박스를 켠다
  const awake = snapshot.status === "ready" || snapshot.status === "idle";
  const canSend = awake && !snapshot.running && !sending && !budgetReached && !personalReached && access.canManage;
  // 실행 중에는 새 요청 대신 진행 중 지시를 보낸다. 데모(스크립트)는 반영할 모델 호출이 없어 제외한다
  const canSteer = snapshot.status === "ready" && snapshot.running && snapshot.mode !== "demo" && !sending && !budgetReached && !personalReached && access.canManage;
  /**
   * 샌드박스가 뜨는 중(starting)이라 보내기만 막힌 상태를 버튼 옆에 짧게 알린다. 한도 도달 등 다른 이유는 위쪽 안내(hintFor)가 이미 설명하므로 겹치지 않는다.
   * 입력창 자체는 이 상태와 무관하게 항상 입력할 수 있어야 한다(아래 textarea는 절대 disabled로 두지 않는다) — 부팅 중에 적은 글이 조용히 사라지는 문제를 막는다
   */
  const bootingSendHint = !runId && snapshot.status === "starting" ? "샌드박스가 준비되면 보낼 수 있습니다" : undefined;

  const planRequest = snapshot.mode === "demo" ? snapshot.nextDemoRequest : BUILD_FROM_PLAN;
  /** 에이전트가 되물은 질문. 답을 보내면 지워진다 */
  const pending = snapshot.pendingQuestion;

  /** 질문 카드의 답을 한 요청으로 보낸다. 기존 전송 경로를 그대로 쓴다(첨부 칩도 함께 실린다) */
  function answerQuestion(value: string) {
    if (!pending) return;
    void send(answerRequest(pending.question, value), "build");
  }

  async function send(request: string, sendIntent: Intent = intent) {
    setSending(true);
    setError(undefined);
    // 미리보기에서 고른 요소는 요청 앞에 `[선택한 요소]` 블록으로 붙인다. 스크린샷은 이미지가 아니라 참조 경로로만 넣는다
    const attachments = formatElementSelections(snapshot.id, selections);
    const response = await fetch(`/api/sessions/${snapshot.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(chatRequestBody({ text: attachments ? `${attachments}\n\n${request}` : request, intent: sendIntent, allowBreaking, lightVerify, research })),
    });
    if (response.ok) {
      setText("");
      clearSelections();
    } else setError((await response.json()).error ?? "요청을 보내지 못했습니다");
    setSending(false);
  }

  /**
   * 에이전트의 제안(ADR-068)을 받아 이 요청을 나눠서 병렬·여러 명 비교로 넘긴다. 홈과 같은 경로(submitEntry)로 만들고,
   * 넘긴 사실을 세션에 남긴다. 화면은 옮기지 않고, 대화에 남은 넘김 줄이 진행 카드가 된다(ADR-069).
   * 나눠서 병렬은 이 대화의 모델 선택(picker)을 그대로 이어받는다 — 레인·통합 세션이 계획과 다른(서버 기본) 모델로 돌던 문제를 막는다
   */
  async function handOff(proposal: { mode: Exclude<ChatMethod, "single">; request: string }, questionRunId: string) {
    setSending(true);
    setError(undefined);
    const result = await submitEntry(fetch, {
      method: proposal.mode,
      projectId: snapshot.projectId,
      text: proposal.request,
      workspace: "copy",
      fleetModelIds: [],
      planModelId: "",
      ...(proposal.mode === "split" ? handoffModelInput(picker) : {}),
      ...(capabilities ? { mode: capabilities.mode } : {}),
      // 나눠서 병렬(split)은 이 세션의 최신 체크포인트에서 레인·통합을 시작한다(ADR-096). 여러 명 비교(fleet)는 해당 없다
      ...(proposal.mode === "split" ? { sourceSessionId: snapshot.id } : {}),
    });
    if (!result.ok) {
      setSending(false);
      setError(result.error);
      return;
    }
    const recorded = await fetch(`/api/sessions/${snapshot.id}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: questionRunId, to: proposal.mode, href: result.href }),
    }).catch(() => undefined);
    setSending(false);
    // 기록하지 못했으면 카드가 대화에 생기지 않으므로 그 화면으로 보낸다(만든 비교·계획을 잃지 않게)
    if (!recorded?.ok) router.push(result.href);
  }

  /** 실행 중이면 진행 중 지시로, 아니면 이 세션에 요청으로 보낸다 */
  function submit(request: string) {
    if (runId) {
      if (canSteer) void steer(request);
      return;
    }
    if (canSend) void send(request);
  }

  /** 실행 중 지시를 보낸다. 러너가 다음 모델 호출(또는 다음 턴)에 대화로 넣는다 */
  async function steer(request: string) {
    setSending(true);
    setError(undefined);
    const response = await fetch(`/api/sessions/${snapshot.id}/steer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: request }),
    });
    if (response.ok) setText("");
    else setError((await response.json()).error ?? "지시를 보내지 못했습니다");
    setSending(false);
  }

  /** 질문의 답을 계획으로 삼아 만들기 요청을 보낸다 */
  function buildFromPlan() {
    if (!planRequest) return;
    void send(planRequest, "build");
  }

  /** 취소 중 표시와 결과는 이벤트 스트림으로 온다 */
  async function cancel(target: string) {
    setError(undefined);
    setConfirmingCancel(undefined);
    const response = await fetch(`/api/sessions/${snapshot.id}/runs/${target}/cancel`, { method: "POST" });
    if (!response.ok) setError((await response.json()).error ?? "요청을 취소하지 못했습니다");
  }

  return (
    <section className="glass flex min-h-0 flex-col overflow-hidden rounded-panel" aria-label="대화">
      <div className="border-b border-line px-5 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h2 className="font-semibold">대화</h2>
          {/* 세션 한도를 쓰지 않고 사람 한도만 정한 서버에서도 내 사용량이 보이게 한다 */}
          {(hasTokens(snapshot.tokens) || limit !== undefined || personalLimit !== undefined) && (
            <span className="text-xs text-muted" title="이 세션의 요청들이 쓴 모델 토큰입니다. 취소하거나 실패한 요청도 그때까지 쓴 양을 더합니다">
              {hasTokens(snapshot.tokens) && <>세션 합계 {describeTokens(snapshot.tokens)}</>}
              {limit !== undefined && (
                <span className={`ml-2 whitespace-nowrap ${budgetReached ? "font-medium text-fail" : used >= limit * 0.8 ? "text-wait" : ""}`}>
                  한도 {formatTokenCount(limit)} 중 {formatTokenCount(used)} 사용
                </span>
              )}
              {personalLimit !== undefined && personal !== undefined && (
                <span
                  className={`ml-2 whitespace-nowrap ${personalReached ? "font-medium text-fail" : personal.used >= personalLimit * 0.8 ? "text-wait" : ""}`}
                  title="이 기간에 내가 쓴 모델 토큰입니다. 세션을 새로 만들어도 이어서 셉니다"
                >
                  내 한도 {personal.window === "month" ? "(이번 달)" : "(오늘)"} {formatTokenCount(personalLimit)} 중 {formatTokenCount(personal.used)} 사용
                </span>
              )}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-sm text-muted">{hintFor(view, access, personal && { reached: personalReached, window: personal.window })}</p>
      </div>

      <ol ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4" aria-live="polite">
        {groupChatRows(chat).map((row) =>
          row.kind === "noticeGroup" ? (
            <li key={`notice-${row.startIndex}`}>
              <NoticeGroupEntry text={row.text} count={row.count} />
            </li>
          ) : (
            <li key={row.index}>
              <ChatEntry item={row.item} changedRuns={changedRuns} sessionId={snapshot.id} canManage={access.canManage} />
              {row.index === chat.length - 1 && row.item.kind === "outcome" && row.item.intent === "ask" && row.item.status === "done" && access.canManage && (
                <button
                  type="button"
                  onClick={buildFromPlan}
                  disabled={!canSend || !planRequest}
                  className="mt-2 rounded-control bg-ink px-3.5 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
                >
                  이대로 만들기
                </button>
              )}
            </li>
          ),
        )}
        {snapshot.running && !runId && <li className="text-sm text-wait motion-safe:animate-pulse">작업하는 중</li>}
        {pending && (
          <li>
            {pending.proposal ? (
              <ProposalCard
                reason={pending.question}
                options={pending.options}
                mode={pending.proposal.mode}
                available={methods[pending.proposal.mode]}
                disabled={!access.canManage || sending}
                onAccept={() => void handOff(pending.proposal!, pending.runId)}
                onDecline={(value) => answerQuestion(value)}
                declineDisabled={!canSend}
              />
            ) : (
              <QuestionCard question={pending.question} options={pending.options} allowOther={pending.allowOther} disabled={!canSend} onAnswer={answerQuestion} />
            )}
          </li>
        )}
      </ol>

      <form
        className="border-t border-line px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) submit(text);
        }}
      >
        {selections.length > 0 && (
          <ul className="mb-3 flex flex-wrap gap-2" aria-label="첨부한 요소">
            {selections.map((selection, index) => (
              <li key={index} className="glass-soft flex items-center gap-2 rounded-control px-2 py-1 text-xs">
                <img src={artifactUrl(snapshot.id, selection.screenshotArtifact)} alt="" className="size-8 rounded object-cover" />
                <span className="max-w-[12rem] truncate font-mono" title={selection.selector}>
                  {selection.selector}
                </span>
                <button type="button" onClick={() => removeSelection(index)} aria-label={`${selection.selector} 첨부 제거`} className="text-muted hover:text-fail">
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        {runId && (
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-sm" role="status">
              <span className="text-wait motion-safe:animate-pulse">
                {snapshot.cancelling === "budget"
                  ? asking
                    ? "세션 토큰 한도에 도달해 질문을 멈추는 중"
                    : "세션 토큰 한도에 도달해 요청을 멈추는 중. 바뀐 파일을 되돌리고 서비스를 확인합니다"
                  : snapshot.cancelling
                    ? asking
                      ? "질문을 취소하는 중"
                      : "요청을 취소하는 중. 바뀐 파일을 되돌리고 서비스를 확인합니다"
                    : asking
                      ? "에이전트가 답을 준비하는 중"
                      : "에이전트가 작업하는 중"}
              </span>
              {view.runTokens?.runId === runId && hasTokens(view.runTokens.usage) && (
                <span className="ml-2 text-xs text-muted">{describeTokens(view.runTokens.usage)}</span>
              )}
            </p>
            {!snapshot.cancelling &&
              access.canManage &&
              (confirmingCancel === runId ? (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setConfirmingCancel(undefined)}
                    className="rounded-control px-3 py-1.5 text-sm text-muted hover:text-ink"
                  >
                    계속 진행
                  </button>
                  <button
                    type="button"
                    onClick={() => void cancel(runId)}
                    className="rounded-control bg-fail px-3.5 py-1.5 text-sm font-medium text-panel hover:bg-fail/85"
                  >
                    변경 되돌리고 취소
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  // 질문은 되돌릴 변경이 없으므로 한 번 더 묻지 않는다
                  onClick={() => (asking ? void cancel(runId) : setConfirmingCancel(runId))}
                  className="glass-soft rounded-control px-3.5 py-1.5 text-sm font-medium hover:text-fail"
                >
                  {asking ? "질문 취소" : "요청 취소"}
                </button>
              ))}
          </div>
        )}
        {snapshot.mode === "demo" ? (
          // 데모는 준비된 대본을 순서대로 실행한다. 만들기와 질문이 각각 준비돼 있으면 둘 다 보여 준다
          <div className="space-y-2">
            {snapshot.nextDemoRequest ? (
              <button
                type="button"
                disabled={!canSend}
                onClick={() => void send(snapshot.nextDemoRequest!, "build")}
                className="w-full rounded-control bg-ink px-4 py-2.5 text-left text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
              >
                다음 요청 보내기: {snapshot.nextDemoRequest}
              </button>
            ) : (
              <p className="text-sm text-muted">준비된 데모 요청을 모두 실행했습니다.</p>
            )}
            {snapshot.nextDemoQuestion && (
              <button
                type="button"
                disabled={!canSend}
                onClick={() => void send(snapshot.nextDemoQuestion!, "ask")}
                className="w-full rounded-control border border-line bg-panel px-4 py-2.5 text-left text-sm font-medium hover:border-ink disabled:opacity-50"
              >
                질문하기: {snapshot.nextDemoQuestion}
              </button>
            )}
          </div>
        ) : (
          <>
            {/* 입력은 하나다. "읽기만"을 켜면 파일을 바꾸지 않고 답과 계획만 받는다(세션마다 기억한다) */}
              <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                <button
                  type="button"
                  role="switch"
                  aria-checked={readOnly}
                  onClick={() => setReadOnly(!readOnly)}
                  title="켜면 파일을 바꾸지 않고 답과 계획만 받습니다"
                  className={`rounded-control px-3 py-1 text-sm font-medium transition-colors ${
                    readOnly ? "bg-panel text-ink ring-1 ring-line" : "glass-soft text-muted hover:text-ink"
                  }`}
                >
                  읽기만
                </button>
                {/* 읽기만이 켜지면 숨긴다 — 질문은 게이트를 돌리지 않으므로 가볍게 확인이 뜻이 없다 */}
                {!readOnly && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={lightVerify}
                    onClick={() => setLightVerify(!lightVerify)}
                    title="테스트·화면 확인·리뷰를 건너뛰고 서비스 재시작·계약만 확인합니다. 이런 체크포인트는 배포할 수 없습니다"
                    className={`rounded-control px-3 py-1 text-sm font-medium transition-colors ${
                      lightVerify ? "bg-panel text-ink ring-1 ring-line" : "glass-soft text-muted hover:text-ink"
                    }`}
                  >
                    가볍게 확인
                  </button>
                )}
                {/* "조사"는 읽기만이 켜졌을 때만 보인다 — 질문에 웹에서 찾아 답하라는 안내가 붙는다(ADR-094) */}
                {readOnly && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={research}
                    onClick={() => setResearch(!research)}
                    title={
                      researchWebAvailable
                        ? "켜면 이번 질문에서 웹을 검색해 출처를 링크로 답합니다"
                        : "이 백엔드는 웹 검색을 지원하지 않아 모델 지식으로 답합니다"
                    }
                    className={`rounded-control px-3 py-1 text-sm font-medium transition-colors ${
                      research ? "bg-panel text-ink ring-1 ring-line" : "glass-soft text-muted hover:text-ink"
                    }`}
                  >
                    조사
                  </button>
                )}
                <p className="text-xs text-muted">
                  {readOnly
                    ? research
                      ? researchWebAvailable
                        ? "웹을 검색해 출처를 링크로 답합니다"
                        : "이 백엔드는 웹 검색을 지원하지 않아 모델 지식으로 답합니다"
                      : "파일은 바꾸지 않고 답과 계획만 받습니다"
                    : lightVerify
                      ? "테스트·화면 확인·리뷰를 건너뜁니다. 배포하려면 전체 검증이 필요합니다"
                      : "질문이면 답만 하고, 바꾸면 검증 게이트를 통과한 변경만 남습니다"}
                </p>
              </div>
            <label htmlFor="request" className="sr-only">
              {intent === "ask" ? "질문" : "요청"}
            </label>
            {/* 샌드박스가 뜨는 중이거나 중지됐어도 입력창은 막지 않는다 — 보내기 버튼만 막고, 적은 글은 그대로 남겨 다시 쓸 수 있게 한다 */}
            <textarea
              id="request"
              ref={textareaRef}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && text.trim()) {
                  event.preventDefault();
                  submit(text);
                }
              }}
              rows={3}
              placeholder={
                runId
                  ? "실행 중 지시를 적어 주세요. 다음 모델 호출(또는 다음 턴)에 반영됩니다"
                  : intent === "ask"
                    ? "코드나 동작을 묻거나, 만들기 전에 계획을 세워 보세요"
                    : "만들거나 바꾸고 싶은 내용을 적어 주세요"
              }
              className="w-full resize-none rounded-control border border-line bg-panel px-3 py-2 text-sm leading-6 placeholder:text-muted"
            />
            {/* 대화 칸이 좁아 모델 이름이 길어지면 버튼 글자가 두 줄로 꺾였다 — 줄이 모자라면 체크박스 줄을 위로 넘긴다 */}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              {intent === "build" ? (
                <label className="flex items-center gap-2 text-sm text-muted">
                  <input type="checkbox" checked={allowBreaking} onChange={(event) => setAllowBreaking(event.target.checked)} className="accent-ink" />
                  필드 삭제나 타입 변경 허용
                </label>
              ) : (
                <span />
              )}
              <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
                <div className="flex items-center gap-2">
                  {picker && (
                    <ModelPicker
                      picker={picker}
                      disabled={!access.canManage || snapshot.running || changingModel}
                      disabledReason={snapshot.running ? "요청을 처리하는 동안에는 모델을 바꿀 수 없습니다" : undefined}
                      onChangeModel={(value) => void changeModel(value)}
                      onChangeEffort={(value) => void changeEffort(value)}
                    />
                  )}
                  <button
                    type="submit"
                    disabled={!text.trim() || (runId ? !canSteer : !canSend)}
                    className="whitespace-nowrap rounded-control bg-ink px-4 py-2 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
                  >
                    {runId ? "진행 중 지시" : intent === "ask" ? "질문하기" : "요청 보내기"}
                  </button>
                </div>
                {bootingSendHint && <p className="text-xs text-muted">{bootingSendHint}</p>}
              </div>
            </div>
          </>
        )}
        {modelError && <p className="mt-2 text-sm text-fail">{modelError}</p>}
        {error && <p className="mt-2 text-sm text-fail">{error}</p>}
      </form>
    </section>
  );
}

export type ChatRow = { kind: "noticeGroup"; text: string; count: number; startIndex: number } | { kind: "single"; item: ChatItem; index: number };

/**
 * 대화 기록은 바꾸지 않고(§81) 보여 줄 때만 접는다. 포트 충돌 등으로 샌드박스 기동을 여러 번
 * 다시 시도하면 같은 안내(notice)가 연달아 쌓인다 — 글자가 완전히 같은 notice가 끊기지 않고
 * 이어질 때만 한 줄로 묶는다. 사이에 다른 이벤트가 끼면(boot_network 등) 그 자리에서 묶음이 끊긴다
 */
export function groupChatRows(chat: readonly ChatItem[]): ChatRow[] {
  const rows: ChatRow[] = [];
  chat.forEach((item, index) => {
    const prev = rows[rows.length - 1];
    if (item.kind === "notice" && prev?.kind === "noticeGroup" && prev.text === item.text) {
      prev.count += 1;
      return;
    }
    rows.push(item.kind === "notice" ? { kind: "noticeGroup", text: item.text, count: 1, startIndex: index } : { kind: "single", item, index });
  });
  return rows;
}

/** count가 1이면 평소처럼 한 줄로, 여러 번 반복됐으면 접어서 보여 주고 펼치면 각 시도를 나열한다 */
function NoticeGroupEntry({ text, count }: { text: string; count: number }) {
  if (count <= 1) return <p className="border-l-[3px] border-line pl-3 text-sm text-muted">{text}</p>;
  return (
    <details className="border-l-[3px] border-line pl-3 text-sm text-muted">
      <summary className="cursor-pointer hover:text-ink">
        {text} · {count}번 시도
      </summary>
      <ol className="mt-1 space-y-0.5 pl-4 text-xs">
        {Array.from({ length: count }, (_, i) => (
          <li key={i}>
            시도 {i + 1}: {text}
          </li>
        ))}
      </ol>
    </details>
  );
}

/** 통과한 확인의 근거(무엇을 봤더니 통과였는지)를 펼쳐 보는 목록 */
export function CheckEvidence({ lines }: { lines: readonly string[] }) {
  return (
    <details className="mt-0.5">
      <summary className="cursor-pointer text-muted hover:text-ink">확인한 것 {lines.length}가지</summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted">
        {lines.map((line, index) => (
          <li key={index} className="break-words">
            {line}
          </li>
        ))}
      </ul>
    </details>
  );
}

function ChatEntry({ item, changedRuns, sessionId, canManage }: { item: ChatItem; changedRuns: ReadonlySet<string>; sessionId: string; canManage: boolean }) {
  // baseSync(main 따라잡기, ADR-076)의 "대화 입력창에 채우기"가 쓴다. 조건 없이 맨 위에서 불러 훅 순서를 지킨다
  const draft = useChatDraft();
  switch (item.kind) {
    case "boot": {
      const rx = item.network.reduce((sum, entry) => sum + entry.rxBytes, 0);
      return (
        <p className="text-sm text-muted">
          샌드박스를 띄웠습니다{item.network.length > 0 ? ` · 받음 ${formatBytes(rx)}` : ""}
        </p>
      );
    }

    case "request":
      return (
        <div className={`border-l-[3px] pl-3 ${item.intent === "ask" ? "border-line" : "border-ink"}`}>
          <p className="font-medium leading-7 whitespace-pre-wrap">{item.text}</p>
          {(item.intent === "ask" || item.by) && (
            <p className="text-xs text-muted">
              {item.intent === "ask" && <span className="mr-1.5 rounded-full border border-line px-1.5 py-px">질문</span>}
              {item.by}
            </p>
          )}
        </div>
      );

    case "warning":
      return (
        <p className="border-l-[3px] border-wait pl-3 text-sm text-wait">
          {item.text}
        </p>
      );

    case "notice":
      return <p className="border-l-[3px] border-line pl-3 text-sm text-muted">{item.text}</p>;

    case "planBrief":
      return (
        <details className="rounded-md border border-line bg-panel/60 px-3 py-2 text-sm">
          <summary className="cursor-pointer text-muted hover:text-ink">계획({item.model})</summary>
          <div className="mt-2 border-t border-line pt-2">
            <Markdown text={item.text} />
          </div>
        </details>
      );

    case "steer": {
      const label = item.status === "applied" ? "지시(반영됨)" : item.status === "dropped" ? "지시(적용되지 못함)" : "지시(대기)";
      return (
        <div className={`border-l-[3px] pl-3 ${item.status === "dropped" ? "border-fail" : "border-wait"}`}>
          <p className="text-xs text-muted">
            <span className="mr-1.5 rounded-full border border-line px-1.5 py-px">{label}</span>
            {item.status === "queued" && "다음 모델 호출에 반영됩니다"}
            {item.status === "dropped" && <span className="text-fail">적용되지 못했습니다 — 다시 보내세요</span>}
          </p>
          <p className="whitespace-pre-wrap text-sm leading-6">{item.text}</p>
        </div>
      );
    }

    case "route": {
      const selected = item.candidates.find((candidate) => candidate.id === item.selectedId);
      if (item.auto) {
        return (
          <p className="text-sm text-muted">
            자동 선택: <span className="font-medium text-ink">{selected?.label ?? item.selectedId}</span> — {item.reason}
          </p>
        );
      }
      return (
        <details className="rounded-md border border-line bg-panel/60 px-3 py-2 text-sm">
          <summary className="cursor-pointer text-muted hover:text-ink">
            라우터가 <span className="font-medium text-ink">{selected?.label ?? item.selectedId}</span>을 선택했습니다
            <span className="ml-1.5 text-xs">({item.complexity === "complex" ? "복잡" : item.complexity === "normal" ? "보통" : "단순"}{item.risk === "high" ? " · 고위험" : ""})</span>
          </summary>
          <p className="mt-2 leading-6 text-muted">{item.reason}</p>
          <ol className="mt-2 space-y-1 border-t border-line pt-2 font-mono text-xs">
            {item.candidates.map((candidate, index) => (
              <li key={candidate.id} className={`flex justify-between gap-3 ${candidate.eligible ? "" : "text-muted line-through"}`}>
                <span>{index + 1}. {candidate.label}</span>
                <span>{candidate.eligible ? candidate.score.toFixed(3) : "제외"}{candidate.estimatedCostUsd === undefined ? "" : ` · $${candidate.estimatedCostUsd.toFixed(4)}`}</span>
              </li>
            ))}
          </ol>
        </details>
      );
    }

    case "backend":
      // 작업 분해의 레인 결과 통합(task-plans.ts)은 모델을 부르지 않고 미리 만든 턴만 돌린다(ScriptedModelClient에
      // 그 쓰임새를 담아 보낸다) — "데모 스크립트에서 scripted 모델로 실행합니다"처럼 실제와 다른 문구 대신
      // 있는 그대로 보여준다. 그 밖(실제 모델 호출)은 기존 "{backend}에서 {model} 모델로 실행합니다" 문장 그대로다
      if (item.backend === "레인 결과 합치기") {
        return <p className="text-sm text-muted">레인 결과 합치기 (모델 호출 없음)</p>;
      }
      return (
        <p className="text-sm text-muted">
          {item.backend}에서 <span className="font-mono text-ink">{item.model}</span> 모델로 실행합니다
          {item.effort && ` (노력: ${EFFORT_LABEL[item.effort] ?? item.effort})`}
          {item.auth && ` (${item.auth})`}
        </p>
      );

    case "escalation":
      return (
        <p className="text-sm text-muted">
          같은 실패가 {item.times}번 반복되어 <span className="font-mono text-ink">{item.to}</span>으로 올렸습니다
        </p>
      );

    case "compacting":
      return <p className="text-sm text-muted">대화가 길어져 앞부분을 요약하는 중입니다. 큰 대화는 몇 분 걸릴 수 있습니다</p>;

    case "compacted":
      return (
        <p className="text-sm text-muted">
          {item.trigger === "manual" ? "대화를 요약했습니다" : "대화가 길어져 앞부분을 요약했습니다"} · {formatTokenCount(item.preTokens)}
          {item.postTokens !== undefined && ` → ${formatTokenCount(item.postTokens)}`} 토큰
          {item.durationMs !== undefined && ` · ${formatElapsed(item.durationMs)}`}
        </p>
      );

    case "stage":
      return <p className="text-xs font-medium tracking-wide text-muted">작업 단계 · {stageLabel(item.stage)}</p>;

    case "check":
      // 게이트가 다루지 않은 테스트·화면 알림(ADR-135)은 게이트를 막지 않아 ok가 true지만 "통과"가 아니다.
      // 초록 "통과"로 그리면 확인되지 않았다는 사실이 오히려 통과처럼 보이므로, 경고 색과 설명을 함께 보여 준다
      if (item.name.startsWith(COVERAGE_GAP_NAME_PREFIX)) {
        return (
          <div className="text-xs">
            <p className="text-wait">
              {stageLabel(item.stage)} · {item.name.slice(COVERAGE_GAP_NAME_PREFIX.length).trim()} · 확인 안 됨
            </p>
            {item.detail && <p className="mt-1 whitespace-pre-wrap text-muted">{item.detail}</p>}
          </div>
        );
      }
      return (
        <div className="text-xs">
          <p className={item.ok ? "text-pass" : "text-fail"}>
            {stageLabel(item.stage)} · {item.name} · {item.ok ? "통과" : "실패"}
            {item.attempts > 1 ? ` (시도 ${item.attempts}회)` : ""}
          </p>
          {!item.ok && item.detail && <pre className="mt-1 whitespace-pre-wrap text-muted">{item.detail}</pre>}
          {/* 통과한 확인이 무엇을 쟀는지. 접어 두어 대화의 줄 수를 늘리지 않는다 */}
          {item.ok && item.evidence && item.evidence.length > 0 && <CheckEvidence lines={item.evidence} />}
        </div>
      );

    case "reply":
      return <AssistantReply text={item.text} sessionId={sessionId} canManage={canManage} />;

    case "tools": {
      const failed = item.calls.filter((call) => call.ok === false).length;
      return (
        <details className="rounded-md border border-line">
          <summary className="cursor-pointer px-3 py-2 text-sm text-muted hover:text-ink">
            도구 {item.calls.length}회 사용{failed > 0 && <span className="text-fail">, 실패 {failed}회</span>}
          </summary>
          <ul className="space-y-1 border-t border-line px-3 py-2">
            {item.calls.map((call, index) => (
              <li key={index} className="font-mono text-xs leading-5">
                <span className={call.ok === false ? "text-fail" : call.ok ? "text-pass" : call.interrupted ? "text-muted" : "text-wait"}>
                  {call.ok === false ? "실패" : call.ok ? "완료" : call.interrupted ? "중단" : "실행 중"}
                </span>{" "}
                <span className="break-all">{call.summary}</span>
                {call.ok === false && call.output && <p className="mt-0.5 break-words text-fail">{call.output.split("\n")[0]}</p>}
              </li>
            ))}
          </ul>
        </details>
      );
    }

    case "gate":
      return <GateTrack files={item.files} report={item.report} interrupted={item.interrupted} />;

    case "checkpoint":
      return (
        <p className="text-sm text-muted">
          체크포인트 <span className="font-mono text-ink">{item.checkpoint.shortSha}</span>에 저장했습니다. 바뀐 파일 {item.checkpoint.files.length}개
        </p>
      );

    case "localEdits":
      return (
        <p className="text-sm text-muted">
          {item.reason === "resume" ? "중지한 동안 폴더에서 바뀐" : "스튜디오 밖에서 바꾼"} 파일 {item.checkpoint.files.length}개를 체크포인트{" "}
          <span className="font-mono text-ink">{item.checkpoint.shortSha}</span>에 남겼습니다. 검증 게이트는 거치지 않았습니다.
        </p>
      );

    case "handoff":
      return <HandoffEntry to={item.to} href={item.href} />;
    case "reverted":
      return (
        <div className={`rounded-md border px-3 py-2 text-sm ${item.cancelled ? "border-line" : "border-wait/40 bg-wait/10"}`}>
          <p className={`font-medium ${item.cancelled ? "" : "text-wait"}`}>
            {item.cancelled ? "취소한 요청의 변경을 되돌렸습니다" : "검증을 통과하지 못한 변경을 되돌렸습니다"}: 파일 {item.files.length}개
          </p>
          {databaseSummary(item.databases) && <p className="mt-0.5 text-muted">{databaseSummary(item.databases)}</p>}
          <p className="mt-0.5 text-muted">{restartSummary(item.restarted)}</p>
          {item.files.length > 0 && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-muted hover:text-ink">되돌린 변경 보기</summary>
              <div className="mt-1.5 max-h-72 overflow-auto">
                <DiffView patch={item.patch} />
              </div>
            </details>
          )}
          {item.backup && <BackupRestoreButton sessionId={sessionId} backup={item.backup} canManage={canManage} />}
        </div>
      );

    case "restore":
      if (!item.result) {
        return (
          <p className="text-sm text-wait motion-safe:animate-pulse">
            체크포인트 <span className="font-mono">{item.checkpoint.shortSha}</span>로 되돌리는 중
          </p>
        );
      }
      return item.result.ok ? (
        <div>
          <p className="text-sm text-pass">
            체크포인트 <span className="font-mono">{item.checkpoint.shortSha}</span>로 되돌렸습니다. 파일 {item.result.files.length}개 복원,{" "}
            {databaseSummary(item.result.databases) && `${databaseSummary(item.result.databases)}, `}
            {restartSummary(item.result.restarted)}
          </p>
          {item.result.backup && <BackupRestoreButton sessionId={sessionId} backup={item.result.backup} canManage={canManage} />}
        </div>
      ) : (
        <p className="text-sm text-fail">되돌리지 못했습니다: {item.result.error}</p>
      );

    case "deploy": {
      const { result } = item;
      if (!result) {
        return (
          <p className="text-sm text-wait motion-safe:animate-pulse">
            {item.action === "deploy" ? `체크포인트 ${item.target}를 운영 배포하는 중` : `운영 배포를 릴리스 ${item.target}로 되돌리는 중`}
          </p>
        );
      }
      if (!result.ok) {
        return (
          <div className="rounded-md border border-fail/40 bg-fail/10 px-3 py-2 text-sm">
            <p className="font-medium text-fail">
              {item.action === "deploy" ? "운영 배포" : "되돌리기"}에 실패했습니다: {result.error}
            </p>
            <p className="mt-0.5 text-muted">운영 주소는 바꾸지 않았습니다. 배포 탭에서 원인을 볼 수 있습니다.</p>
          </div>
        );
      }
      return (
        <div className="space-y-0.5 text-sm">
          <p className="text-pass">
            {item.action === "deploy" ? "운영 배포" : "되돌리기"}를 마쳤습니다. 릴리스 <span className="font-mono">{result.release}</span>
            {item.by && <span className="text-muted">, {item.by}</span>}
          </p>
          <p className="flex flex-wrap gap-x-3">
            {Object.entries(result.urls).map(([service, url]) => (
              <a key={service} href={url} target="_blank" rel="noreferrer" className="font-mono underline underline-offset-2">
                {service} {url}
              </a>
            ))}
          </p>
        </div>
      );
    }

    case "exported": {
      const label = item.hostKind === "gitlab" ? "MR" : "PR";
      return (
        <div className="space-y-0.5 text-sm">
          <p className="text-pass">
            <span className="font-mono">{item.branch}</span> 브랜치에 체크포인트 {item.commits}개를 올렸습니다
            {item.forced && ". 되돌린 기록에 맞춰 원격 브랜치를 바꿨습니다"}
          </p>
          {item.pullRequest && (
            <p>
              <a href={item.pullRequest.url} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
                {item.pullRequest.created ? `${label}을 만들었습니다` : `이미 열려 있는 ${label}을 찾았습니다`}
              </a>
              {item.issues && item.issues.length > 0 && (
                <span className="ml-2 text-muted">{item.issues.map((issue) => `#${issue}`).join(", ")} 이슈를 함께 닫습니다</span>
              )}
            </p>
          )}
          {item.pullRequestError && (
            <p className="text-fail">
              {label}을 만들지 못했습니다: {item.pullRequestError}
            </p>
          )}
          {item.requirementsTrackingWarning && <p className="text-muted">{item.requirementsTrackingWarning}</p>}
        </div>
      );
    }

    case "remoteSync": {
      const { result } = item;
      if (!result) return <p className="text-sm text-wait motion-safe:animate-pulse">원격 브랜치에서 다른 사람이 올린 커밋을 가져오는 중</p>;
      if (result.ok && result.status === "up-to-date") return <p className="text-sm text-muted">원격 브랜치에 가져올 커밋이 없습니다.</p>;
      const commitList = result.commits && result.commits.length > 0 && (
        <ul className="mt-1 space-y-0.5 font-mono text-xs text-muted">
          {result.commits.map((commit) => (
            <li key={commit.shortSha} className="break-words">
              {commit.shortSha} {commit.subject} ({commit.author})
            </li>
          ))}
        </ul>
      );
      return (
        <div className="space-y-2">
          {result.ok ? (
            <div className="text-sm">
              <p className="text-pass">
                원격 커밋 {result.commits.length}개를 가져와 체크포인트 <span className="font-mono">{result.checkpoint?.shortSha}</span>에 저장했습니다. 바뀐 파일{" "}
                {result.files.length}개
              </p>
              {result.status === "picked" && <p className="mt-0.5 text-muted">되돌린 체크포인트는 다시 넣지 않고 원격에만 있던 변경을 옮겼습니다.</p>}
              {commitList}
            </div>
          ) : (
            <div className="rounded-md border border-fail/40 bg-fail/10 px-3 py-2 text-sm">
              <p className="font-medium text-fail">원격 변경을 가져오지 못했습니다: {result.error}</p>
              {result.conflicts && <p className="mt-0.5 text-muted">PR이나 원격 브랜치에서 충돌을 해결한 뒤 다시 가져오세요.</p>}
              {result.restarted && <p className="mt-0.5 text-muted">{restartSummary(result.restarted)}</p>}
              {result.backup && <BackupRestoreButton sessionId={sessionId} backup={result.backup} canManage={canManage} />}
              {commitList}
            </div>
          )}
          {result.report && <GateTrack files={result.files ?? []} report={result.report} />}
        </div>
      );
    }

    case "baseSync": {
      const { result } = item;
      if (!result) return <p className="text-sm text-wait motion-safe:animate-pulse">기준 브랜치(main)를 따라잡는 중</p>;
      if (result.ok && result.status === "up-to-date") return <p className="text-sm text-muted">이미 기준 브랜치를 따라잡았습니다.</p>;
      return (
        <div className="space-y-2">
          {result.ok ? (
            <p className="text-sm text-pass">
              기준 브랜치의 커밋 {result.commits}개를 병합으로 따라잡아 체크포인트 <span className="font-mono">{result.checkpoint?.shortSha}</span>에 저장했습니다. 바뀐 파일{" "}
              {result.files.length}개
            </p>
          ) : (
            <div className="rounded-md border border-fail/40 bg-fail/10 px-3 py-2 text-sm">
              <p className="font-medium text-fail">기준 브랜치를 따라잡지 못했습니다: {result.error}</p>
              {result.conflicts && result.conflicts.length > 0 && (
                <p className="mt-0.5 text-muted">
                  충돌한 파일: <span className="break-all font-mono text-xs">{result.conflicts.join(", ")}</span>
                </p>
              )}
              {result.agentRequest && (
                <button
                  type="button"
                  onClick={() => draft.fill(result.agentRequest!)}
                  className="mt-1.5 rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink"
                >
                  대화 입력창에 채우기
                </button>
              )}
              {result.restarted && <p className="mt-0.5 text-muted">{restartSummary(result.restarted)}</p>}
              {result.backup && <BackupRestoreButton sessionId={sessionId} backup={result.backup} canManage={canManage} />}
            </div>
          )}
          {result.report && <GateTrack files={result.files ?? []} report={result.report} />}
        </div>
      );
    }

    case "resumed":
      return (
        <div className="rounded-md border border-line px-3 py-2 text-sm">
          <p className="font-medium">
            새 샌드박스에서 체크포인트 <span className="font-mono">{item.checkpoint.shortSha}</span>부터 이어서 작업합니다
          </p>
          {item.discarded.length > 0 && (
            <p className="mt-0.5 text-muted">
              체크포인트에 없던 변경 {item.discarded.length}개를 {item.backup ? "백업했습니다" : "버렸습니다"}:{" "}
              <span className="break-all font-mono text-xs">
                {item.discarded.slice(0, 5).join(", ")}
                {item.discarded.length > 5 && " 외"}
              </span>
            </p>
          )}
          {databaseSummary(item.databases) && <p className="mt-0.5 text-muted">{databaseSummary(item.databases)}</p>}
          {item.restarted.length > 0 && <p className="mt-0.5 text-muted">{restartSummary(item.restarted)}</p>}
          {item.backup && <BackupRestoreButton sessionId={sessionId} backup={item.backup} canManage={canManage} />}
        </div>
      );

    case "backupRestored":
      if (!item.result) return null;
      return item.result.ok ? (
        <p className="text-sm text-pass">
          백업을 되살렸습니다. 파일 {item.result.files.length}개: <span className="break-all font-mono text-xs">{item.result.files.slice(0, 5).join(", ")}</span>
          {item.result.restarted.length > 0 && <> · {restartSummary(item.result.restarted)}</>}
        </p>
      ) : (
        <p className="text-sm text-fail">백업을 되살리지 못했습니다: {item.result.error}</p>
      );

    case "outcome": {
      const tone = item.status === "done" ? "text-pass" : item.status === "awaiting_input" ? "text-wait" : item.status === "cancelled" ? "text-muted" : "text-fail";
      return (
        <div className="text-sm">
          {/* 바꾼 파일이 없으면 "답만 했습니다"로 알린다(입력이 하나로 합쳐진 뒤의 기본 경로) */}
          <p className={tone}>{outcomeText(item, changedRuns.has(item.runId))}</p>
          {item.verify === "light" && <p className="mt-0.5 text-xs text-muted">가볍게 확인: 테스트·화면 확인·리뷰를 건너뛰었습니다</p>}
          {hasTokens(item.usage) && <p className="mt-0.5 text-xs text-muted">{describeTokens(item.usage)}</p>}
        </div>
      );
    }
  }
}

/**
 * 에이전트 답변 메시지(ADR-094). 답 아래 작은 글씨 메뉴로 복사·문서로 저장·요구사항에 반영을 둔다.
 * 복사는 항상 보이고(읽기 권한만 있어도 쓸 수 있다), 문서로 저장·요구사항에 반영은 쓰기 권한(canManage)이 있을 때만 보인다
 * — 둘 다 세션 작업 복사본에 파일을 더하거나(문서) 요구사항 패치 미리보기를 여는(요구사항) 쓰기 성격의 동작이기 때문이다.
 */
function AssistantReply({ text, sessionId, canManage }: { text: string; sessionId: string; canManage: boolean }) {
  const [copied, setCopied] = useState(false);
  const [savingDoc, setSavingDoc] = useState(false);
  const requirementsImport = useRequirementsImport();

  async function copy() {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 클립보드 접근이 막힌 환경에서도 화면은 그대로 쓸 수 있어야 한다
    }
  }

  return (
    <div>
      <Markdown text={text} />
      <div className="mt-1.5 flex flex-wrap gap-2 text-xs text-muted">
        <button type="button" onClick={() => void copy()} className="font-medium hover:text-ink">
          {copied ? "복사됨" : "복사"}
        </button>
        {canManage && (
          <button type="button" onClick={() => setSavingDoc(true)} className="font-medium hover:text-ink">
            문서로 저장
          </button>
        )}
        {canManage && (
          <button type="button" onClick={() => requirementsImport.open({ specText: text })} className="font-medium hover:text-ink">
            요구사항에 반영
          </button>
        )}
      </div>
      {savingDoc && (
        <NewDocDialog
          sessionId={sessionId}
          initialBody={text}
          onCreated={() => setSavingDoc(false)}
          onCancel={() => setSavingDoc(false)}
        />
      )}
    </div>
  );
}

/**
 * 체크포인트로 되돌리며 버린 변경(ADR-099)의 백업을 작업 복사본에 되살리는 버튼.
 * 되살리기는 세션 이벤트("backupRestored" 대화 줄)로 결과를 알리므로 여기서는 요청만 보내고 끝낸다.
 */
function BackupRestoreButton({ sessionId, backup, canManage }: { sessionId: string; backup: DiscardBackup; canManage: boolean }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string>();
  if (!canManage) return null;

  async function restore() {
    setState("sending");
    setError(undefined);
    const response = await fetch(`/api/sessions/${sessionId}/discarded/${backup.id}/restore`, { method: "POST" });
    if (response.ok) {
      setState("sent");
    } else {
      setState("error");
      setError((await response.json().catch(() => ({})))?.error ?? "되살리지 못했습니다");
    }
  }

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => void restore()}
        disabled={state === "sending" || state === "sent"}
        className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink disabled:opacity-50"
      >
        {state === "sent" ? "되살리기 요청을 보냈습니다" : state === "sending" ? "되살리는 중…" : "되살리기"}
      </button>
      {error && <p className="mt-0.5 text-xs text-fail">{error}</p>}
    </div>
  );
}

/**
 * 에이전트가 되물은 질문 카드. 선택지를 누르면 `[질문] …\n[답] …` 요청으로 보내 이 대화를 이어서 만든다.
 * 실행을 붙잡고 기다리지 않고 질문을 남기고 끝난 뒤, 답을 다음 요청으로 받는 흐름의 화면이다
 */
/** 넘긴 요청의 진행 카드. 대화 안에서 계획 승인·레인 진행·비교 고르기를 한다(ADR-069) */
function HandoffEntry({ to, href }: { to: "split" | "fleet"; href: string }) {
  const access = useSessionAccess();
  return (
    <div>
      <p className="mb-1.5 text-sm text-muted">제안을 받아 이 요청을 {to === "split" ? "나눠서 병렬로" : "여러 명 비교로"} 넘겼습니다</p>
      <HandoffCard href={href} canManage={access.canManage} />
    </div>
  );
}

/**
 * 에이전트의 제안 카드(ADR-068). 첫 선택지는 이 요청을 나눠서 병렬·여러 명 비교로 넘기고, 둘째는 한 명으로 계속한다(보통 답처럼 대화를 이어 감).
 * 이 서버에서 바로 넘길 수 없으면(API 모드는 모델을 골라야 함) 이유만 보여 준다 — 모델을 고르는 화면이 따로 없다
 */
function ProposalCard({
  reason,
  options,
  mode,
  available,
  disabled,
  declineDisabled,
  onAccept,
  onDecline,
}: {
  reason: string;
  options: string[];
  mode: "split" | "fleet";
  available: { enabled: boolean; reason?: string };
  disabled: boolean;
  declineDisabled: boolean;
  onAccept: () => void;
  onDecline: (value: string) => void;
}) {
  const [accept, decline] = [options[0] ?? (mode === "split" ? "나눠서 병렬로 하기" : "여러 안 비교하기"), options[1] ?? "한 명으로 계속"];
  return (
    <div className="rounded-md border border-ink/40 bg-panel px-3.5 py-3">
      <p className="text-xs font-medium text-muted">에이전트의 제안 · {mode === "split" ? "나눠서 병렬" : "여러 명 비교"}</p>
      <p className="mt-1 text-sm font-medium">{reason}</p>
      <p className="mt-1 text-xs leading-5 text-muted">
        {mode === "split"
          ? "요청을 레인으로 나눠 여러 에이전트가 동시에 만들고, 합쳐서 다시 검증합니다. 계획 화면으로 갑니다."
          : "같은 요청을 여러 에이전트가 각자 만들고 결과를 비교해 하나를 고릅니다. 토큰을 2~4배 씁니다. 비교 화면으로 갑니다."}
      </p>
      <div className="mt-2 flex flex-col gap-1.5">
        <button
          type="button"
          disabled={disabled || !available.enabled}
          title={available.reason}
          onClick={onAccept}
          className="rounded-control bg-ink px-3 py-1.5 text-left text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
        >
          {accept}
        </button>
        <button
          type="button"
          disabled={declineDisabled}
          onClick={() => onDecline(decline)}
          className="rounded-control border border-line bg-panel px-3 py-1.5 text-left text-sm font-medium hover:border-ink disabled:opacity-50"
        >
          {decline}
        </button>
      </div>
    </div>
  );
}

function QuestionCard({
  question,
  options,
  allowOther,
  disabled,
  onAnswer,
}: {
  question: string;
  options: string[];
  allowOther: boolean;
  disabled: boolean;
  onAnswer: (value: string) => void;
}) {
  const [other, setOther] = useState("");

  return (
    <div className="rounded-md border border-ink/40 bg-panel px-3.5 py-3">
      <p className="text-sm font-medium">{question}</p>
      <div className="mt-2 flex flex-col gap-1.5">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            disabled={disabled}
            onClick={() => onAnswer(option)}
            className="rounded-control border border-line bg-panel px-3 py-1.5 text-left text-sm font-medium hover:border-ink disabled:opacity-50"
          >
            {option}
          </button>
        ))}
      </div>
      {allowOther && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (other.trim()) onAnswer(other.trim());
          }}
        >
          <label htmlFor="answer-other" className="sr-only">
            직접 입력
          </label>
          <input
            id="answer-other"
            value={other}
            onChange={(event) => setOther(event.target.value)}
            placeholder="직접 입력"
            className="min-w-0 flex-1 rounded-control border border-line bg-panel px-2 py-1.5 text-sm"
          />
          <button type="submit" disabled={disabled || !other.trim()} className="rounded-control bg-ink px-3.5 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50">
            답하기
          </button>
        </form>
      )}
      <p className="mt-2 text-xs text-muted">답을 보내면 이 대화를 이어서 만듭니다.</p>
    </div>
  );
}

/** 노력 단계 id → 화면 표기(대화 기록·run 헤더·작업 분해 레인 카드에서 쓴다). model-picker.ts의 EFFORT_LEVELS와 같은 값을 쓴다 */
export const EFFORT_LABEL: Record<string, string> = { low: "낮음", medium: "보통", high: "높음", max: "최대" };

/**
 * 모델·노력 버튼에 쓸 한 줄 노력 표기. 아직 아무것도 고르지 않았으면(effort.current 없음) "보통"을 지어내지 않고
 * 백엔드가 실제로 쓰는 기본값(effort.defaultLevel)을 "기본(⟨라벨⟩)"으로 보여준다 — claude-code는 실행 중 표시가
 * "노력: 높음"인데 고르지 않은 상태의 버튼이 "보통"으로 보여 서로 어긋나던 문제(실제 기본값은 높음)를 고친다.
 * defaultLevel도 모르는 백엔드(codex·commandcode·opencode)는 예전처럼 "보통"으로 둔다.
 */
function effortDisplayLabel(effort: EffortPickerView): string | undefined {
  if (!effort.supported) return undefined;
  if (effort.current) return EFFORT_LABEL[effort.current] ?? "보통";
  if (effort.defaultLevel) return `기본(${EFFORT_LABEL[effort.defaultLevel] ?? effort.defaultLevel})`;
  return "보통";
}
/** 노력 단계를 지원하지 않는 백엔드에서도 네 단계 버튼을 회색으로 그리기 위한 자리표(레이블만 쓰고, 실제 값·순서는 항상 서버가 내려준 picker.effort.levels를 우선한다) */
const EFFORT_PLACEHOLDER: Array<{ id: string; label: string; hint: string }> = [
  { id: "low", label: "낮음", hint: "빠르고 싸게" },
  { id: "medium", label: "보통", hint: "속도와 깊이의 기본 균형" },
  { id: "high", label: "높음", hint: "느리지만 더 깊게 생각합니다" },
  { id: "max", label: "최대", hint: "가장 느리고 비싸지만 가장 깊게 생각합니다" },
];
/** 목록이 이보다 길면 검색창을 보여준다(commandcode·opencode는 모델이 많을 수 있다) */
const SEARCH_THRESHOLD = 8;
const PROVIDER_LABEL: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI 호환", google: "Google Gemini" };

/**
 * 대화 입력창의 모델 선택(#283). "모델 · 노력" 버튼을 누르면 팝오버가 열려 모델과 노력 단계를 함께 고른다.
 * 팝오버는 body로 포털해 레이아웃에 영향을 주지 않고, Esc·바깥 클릭으로 닫힌다. 요청을 처리하는 동안에는 버튼 자체를 막는다.
 */
export function ModelPicker({
  picker,
  disabled,
  disabledReason,
  onChangeModel,
  onChangeEffort,
}: {
  picker: ModelPickerView;
  disabled: boolean;
  disabledReason?: string;
  onChangeModel: (modelId: string) => void;
  onChangeEffort: (effort: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const current = picker.options.find((option) => option.id === (picker.current ?? ""));
  const currentEffortLabel = effortDisplayLabel(picker.effort);
  const label = [current?.label ?? "기본", currentEffortLabel].filter(Boolean).join(" · ");
  const title = disabledReason ?? [current?.hint, formatPrice(current?.price), current?.resolvedId && `실제 모델: ${current.resolvedId}`, picker.note].filter(Boolean).join(" · ");

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title={title || undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 rounded-control border border-line bg-panel px-2.5 py-2 text-sm text-ink disabled:opacity-50"
      >
        <span className="max-w-[12rem] truncate">{label}</span>
        <span aria-hidden className="text-xs text-muted">
          ▾
        </span>
      </button>
      {open && !disabled && (
        <ModelPickerPopover
          anchor={buttonRef}
          picker={picker}
          onClose={() => setOpen(false)}
          onChangeModel={(modelId) => {
            setOpen(false);
            onChangeModel(modelId);
          }}
          onChangeEffort={onChangeEffort}
        />
      )}
    </>
  );
}

/**
 * 모델 목록 + 노력 단계를 담은 팝오버. body로 포털하는 바깥 껍데기(ModelPickerPopover)와
 * 실제 그리는 내용(ModelPickerDialog)을 나눠, 내용은 포털 없이 단독으로도 그릴 수 있게 한다(테스트용 —
 * 포털은 `document`가 있는 실제 브라우저에서만 의미가 있고, 서버 렌더 테스트에는 `document`가 없다).
 */
function ModelPickerPopover({
  anchor,
  picker,
  onClose,
  onChangeModel,
  onChangeEffort,
}: {
  anchor: RefObject<HTMLButtonElement | null>;
  picker: ModelPickerView;
  onClose: () => void;
  onChangeModel: (modelId: string) => void;
  onChangeEffort: (effort: string) => void;
}) {
  // 여는 자리는 눌린 버튼 곁(body로 포털하므로 화면 좌표로 잡는다). 모델 버튼은 화면 아래쪽 입력창에 있어
  // 아래로 열면 목록이 화면 밖으로 나가 고를 수 없었다 — 버튼이 화면 아래 절반에 있으면 위로 연다
  const [position] = useState<PopoverPosition>(() => {
    const box = anchor.current?.getBoundingClientRect();
    return box ? popoverPositionFor(box, { width: window.innerWidth, height: window.innerHeight }) : { top: 0, left: 0 };
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-40">
      {/* 바깥을 누르면 닫는다. 팝오버 자신은 이 뒤(DOM 순서상 위)에 그려 클릭이 여기로 새지 않는다 */}
      <button type="button" aria-label="모델 선택 닫기" onClick={onClose} className="absolute inset-0 cursor-default bg-transparent" />
      <ModelPickerDialog style={position} picker={picker} onChangeModel={onChangeModel} onChangeEffort={onChangeEffort} />
    </div>,
    document.body,
  );
}

/** 팝오버 폭(w-80 = 20rem)과 화면 가장자리 여백 */
const POPOVER_WIDTH = 320;
const POPOVER_GAP = 8;

export type PopoverPosition = { left: number } & ({ top: number } | { bottom: number });

/**
 * 버튼 위치와 화면 크기로 팝오버를 열 자리를 정한다. 버튼이 화면 아래 절반이면 버튼 위로(bottom 기준),
 * 아니면 버튼 아래로(top 기준) 연다. 오른쪽으로 넘치지 않게 left를 화면 안으로 당긴다
 */
export function popoverPositionFor(box: { top: number; bottom: number; left: number }, viewport: { width: number; height: number }): PopoverPosition {
  const left = Math.max(POPOVER_GAP, Math.min(box.left, viewport.width - POPOVER_WIDTH - POPOVER_GAP));
  if (box.top > viewport.height / 2) return { bottom: viewport.height - box.top + POPOVER_GAP, left };
  return { top: box.bottom + POPOVER_GAP, left };
}

/** 팝오버가 실제로 그리는 내용(검색창 · 모델 목록 · 노력 단계). 포털을 감싸지 않아 단독으로도 그릴 수 있다 */
export function ModelPickerDialog({
  style,
  picker,
  onChangeModel,
  onChangeEffort,
}: {
  style?: PopoverPosition;
  picker: ModelPickerView;
  onChangeModel: (modelId: string) => void;
  onChangeEffort: (effort: string) => void;
}) {
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();
  const filtered = term ? picker.options.filter((option) => `${option.label} ${option.hint ?? ""}`.toLowerCase().includes(term)) : picker.options;
  const groups = groupOptions(picker.backend, filtered);
  const currentId = picker.current ?? "";

  return (
    <div
      role="dialog"
      aria-label="모델·노력 선택"
      style={style}
      className="glass fixed max-h-[calc(100vh-2rem)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-panel p-2 text-sm shadow-xl"
    >
      {picker.options.length > SEARCH_THRESHOLD && (
        <input
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="모델 검색"
          autoFocus
          className="mb-1 w-full rounded-control border border-line bg-panel px-2 py-1.5 text-sm placeholder:text-muted"
        />
      )}
      {picker.note && <p className="px-2 pb-1 text-xs text-muted">{picker.note}</p>}
      {needsAccountConnect(picker.options) && (
        <p className="mb-1 rounded-control bg-panel px-2 py-1.5 text-xs text-muted">
          로그인이 안 돼 못 쓰는 모델이 있습니다.{" "}
          <Link href="/accounts" className="font-medium text-ink underline">
            계정 연결로 가기
          </Link>
        </p>
      )}
      {groups.map((group) => (
        <div key={group.title ?? "__all"}>
          {group.title && <p className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted">{group.title}</p>}
          <ul>
            {group.options.map((option) => (
              <li key={option.id}>
                <ModelOptionRow option={option} selected={option.id === currentId} onSelect={() => onChangeModel(option.id)} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      {filtered.length === 0 && <p className="px-2 py-1.5 text-muted">검색 결과가 없습니다</p>}

      <EffortControl effort={picker.effort} onChange={onChangeEffort} />
    </div>
  );
}

function ModelOptionRow({ option, selected, onSelect }: { option: ModelPickerOption; selected: boolean; onSelect: () => void }) {
  const detail = [option.hint, formatPrice(option.price), formatContextWindow(option.contextWindow), option.resolvedId && `실제 모델: ${option.resolvedId}`]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={option.disabled}
      title={option.disabled ? option.disabledReason : detail || undefined}
      onClick={onSelect}
      className={`flex w-full items-start gap-2 rounded-control px-2 py-1.5 text-left hover:bg-panel disabled:cursor-not-allowed disabled:opacity-50 ${selected ? "bg-panel" : ""}`}
    >
      <span aria-hidden className="mt-0.5 w-3 shrink-0 text-center text-xs">
        {selected ? "✓" : ""}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{option.label}</span>
          {option.badges?.map((badge) => (
            <span key={badge} className="rounded-full border border-line px-1.5 py-px text-[10px] text-muted">
              {badge}
            </span>
          ))}
        </span>
        {option.hint && <span className="block text-xs text-muted">{option.hint}</span>}
        {(option.price || option.contextWindow) && (
          <span className="block text-xs text-muted">{[formatPrice(option.price), formatContextWindow(option.contextWindow)].filter(Boolean).join(" · ")}</span>
        )}
      </span>
    </button>
  );
}

/** 노력 단계 네 칸 버튼(segmented control). 지원하지 않는 백엔드는 자리표 네 칸을 회색으로 두고 이유를 툴팁에 남긴다 */
function EffortControl({ effort, onChange }: { effort: EffortPickerView; onChange: (id: string) => void }) {
  const levels = effort.levels.length > 0 ? effort.levels : EFFORT_PLACEHOLDER;
  // 아직 고르지 않았으면(effort.current 없음) 백엔드 실제 기본값(defaultLevel)을 선택된 것처럼 보여준다.
  // defaultLevel도 모르면(codex 등) 예전처럼 "보통"을 자리표로 쓴다
  const current = effort.current ?? effort.defaultLevel ?? "medium";
  const disabledTitle = effort.supported ? undefined : (effort.reason ?? "이 백엔드는 노력 단계를 지원하지 않습니다");
  return (
    <div className="mt-2 border-t border-line pt-2">
      <p className="px-2 pb-1 text-xs font-medium text-muted">노력</p>
      <div role="radiogroup" aria-label="노력 단계" title={disabledTitle} className="flex gap-1 px-2">
        {levels.map((level) => {
          // 지금 고른 게 없어도 이 단계가 백엔드의 실제 기본값이면 늘 "(기본)"을 붙여 둔다 —
          // 다른 단계를 직접 골랐을 때도 어느 게 기본이었는지 알 수 있게
          const isDefault = effort.defaultLevel === level.id;
          return (
            <button
              key={level.id}
              type="button"
              role="radio"
              aria-checked={effort.supported && current === level.id}
              disabled={!effort.supported}
              title={effort.supported ? level.hint : disabledTitle}
              onClick={() => onChange(level.id)}
              className={`flex-1 rounded-control border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${
                effort.supported && current === level.id ? "border-ink bg-ink text-panel" : "border-line bg-panel text-ink hover:bg-panel/70"
              }`}
            >
              {level.label}
              {isDefault && <span className="ml-1 text-[10px] opacity-70">(기본)</span>}
            </button>
          );
        })}
      </div>
      {effort.supported ? (
        <p className="px-2 pt-1 text-xs text-muted">{levels.find((level) => level.id === current)?.hint}</p>
      ) : (
        <p className="px-2 pt-1 text-xs text-muted">{disabledTitle}</p>
      )}
      {effort.note && <p className="px-2 pt-1 text-xs text-muted">{effort.note}</p>}
    </div>
  );
}

/** 로그인이 안 돼 고를 수 없는 모델이 있으면 "계정 연결로 가기" 안내를 보여준다(ADR-093) */
export function needsAccountConnect(options: ModelPickerOption[]): boolean {
  return options.some((option) => option.disabled && /로그인/.test(option.disabledReason ?? ""));
}

/** api 백엔드는 공급자가 둘 이상이면 공급자별로 묶는다. 그 밖(claude-code·codex·commandcode·opencode)은 한 백엔드의 목록이라 묶지 않는다 */
function groupOptions(backend: ModelPickerView["backend"], options: ModelPickerOption[]): Array<{ title?: string; options: ModelPickerOption[] }> {
  if (backend !== "api") return [{ options }];
  const head = options.filter((option) => option.id === "");
  const rest = options.filter((option) => option.id !== "");
  const providers = new Set(rest.map((option) => option.provider).filter(Boolean));
  if (providers.size < 2) return [{ options: [...head, ...rest] }];
  const groups: Array<{ title?: string; options: ModelPickerOption[] }> = head.length > 0 ? [{ options: head }] : [];
  for (const provider of providers) {
    groups.push({ title: PROVIDER_LABEL[provider!] ?? provider, options: rest.filter((option) => option.provider === provider) });
  }
  const noProvider = rest.filter((option) => !option.provider);
  if (noProvider.length > 0) groups.push({ options: noProvider });
  return groups;
}

function formatPrice(price?: ModelPickerOption["price"]): string | undefined {
  if (!price) return undefined;
  return `백만 토큰당 입력 $${price.inputPerMillion}/출력 $${price.outputPerMillion}`;
}

function formatContextWindow(tokens?: number): string | undefined {
  if (!tokens) return undefined;
  return tokens >= 1000 ? `컨텍스트 ${Math.round(tokens / 1000)}K 토큰` : `컨텍스트 ${tokens} 토큰`;
}

function stageLabel(stage: string): string {
  return (
    {
      plan: "계획",
      implement: "구현",
      run: "실행",
      browser_check: "브라우저 확인",
      contract_check: "API 계약 확인",
      concurrency_check: "동시 요청 확인",
      load_check: "부하 확인",
      test: "테스트",
      review: "리뷰",
      checkpoint: "체크포인트",
    } as Record<string, string>
  )[stage] ?? stage;
}

/** 에이전트 패키지는 서버 전용 모듈을 불러오므로 화면에서는 문구를 따로 만든다 */
function databaseSummary(databases: DatabaseState[] = []): string | undefined {
  const touched = databases.filter((state) => state.action !== "unchanged");
  if (touched.length === 0) return undefined;
  return touched
    .map((state) =>
      state.action === "restored"
        ? `${state.service} 스키마와 데이터 복원`
        : state.action === "missing"
          ? `${state.service} 저장된 상태 없음`
          : `${state.service} 복원 실패 (${state.detail ?? "원인 모름"})`,
    )
    .join(", ");
}

function restartSummary(restarted: ServiceCheck[]): string {
  if (restarted.length === 0) return "재시작한 서비스 없음";
  return restarted
    .map((check) => `${check.service} ${check.ready ? "준비됨" : "재시작 실패"}${check.retried ? " (한 번 더 재시작)" : ""}`)
    .join(", ");
}

/** 처리 중인 요청이 질문인지 */
function isAsking(view: Pick<SessionView, "snapshot" | "chat">): boolean {
  const runId = activeRun(view);
  return runId !== undefined && view.chat.some((item) => item.kind === "request" && item.runId === runId && item.intent === "ask");
}

function hintFor({ snapshot, chat }: SessionView, access: SessionAccess, personalLimit?: { reached: boolean; window: "day" | "month" }): string {
  if (!access.canManage) {
    return `읽기 전용입니다. 세션을 만든 사람(${access.owner ?? "기록 없음"})이나 관리자만 요청하고 바꿀 수 있습니다.`;
  }
  // 사람 한도는 새 세션을 만들어도 풀리지 않으므로 세션 한도보다 먼저 알린다
  if (personalLimit?.reached) {
    return `${personalLimit.window === "month" ? "이번 달" : "오늘"} 쓸 수 있는 토큰 한도에 도달해 새 요청을 받지 않습니다. 기간이 바뀐 뒤에 다시 요청하세요.`;
  }
  if (snapshot.status === "ready" && !snapshot.running && snapshot.tokenLimit !== undefined && totalTokens(snapshot.tokens) >= snapshot.tokenLimit) {
    return "이 세션은 토큰 한도에 도달해 새 요청을 받지 않습니다. 새 세션을 시작해 이어서 작업하세요.";
  }
  if (snapshot.status === "idle") return "샌드박스는 아직 꺼져 있습니다. 첫 만들기 요청이나 미리보기의 '지금 켜기'를 누를 때 켭니다. 질문만 하면 켜지 않습니다.";
  if (snapshot.status === "starting") return "샌드박스를 준비하고 있습니다. 서비스가 모두 준비되면 요청할 수 있습니다.";
  if (snapshot.status === "failed") return "샌드박스를 시작하지 못했습니다. 위의 오류를 확인하세요.";
  if (snapshot.status === "stopped") return "샌드박스를 중지했습니다. 이어서 작업하면 마지막 체크포인트로 새 샌드박스를 띄웁니다.";
  if (snapshot.workspace === "local" && snapshot.running && !isAsking({ snapshot, chat })) {
    return "처리하는 동안 폴더에서 고친 파일은 요청이 실패하거나 취소되면 함께 되돌아갑니다.";
  }
  if (chat.length > 0) return "요청마다 검증 게이트를 통과해야 완료로 표시됩니다.";
  if (snapshot.workspace === "local") {
    return "내 폴더에서 바로 작업합니다. IDE에서 고친 파일은 미리보기에 바로 반영되고, 요청을 보낼 때 체크포인트로 남습니다.";
  }
  if (snapshot.mode === "demo") return "데모 모드는 준비된 요청을 순서대로 스크립트로 실행합니다.";
  if (snapshot.mode === "claude-code") {
    return "이 PC에서 로그인한 Claude 계정으로 실행합니다. 작업을 끝내면 스튜디오가 서비스를 재시작하고 API 계약을 확인합니다.";
  }
  return "에이전트가 작업을 끝내면 스튜디오가 서비스를 재시작하고 API 계약을 확인합니다.";
}
