"use client";

import { useEffect, useRef, useState } from "react";
import type { DatabaseState, ServiceCheck } from "@b-studio/agent";
import { answerRequest } from "@/lib/question-answer";
import { artifactUrl } from "@/lib/artifact-url";
import { chatRequestBody, intentFor } from "@/lib/chat-request";
import { activeRun, outcomeText, runsWithChanges, type ChatItem, type SessionView } from "@/lib/session-view";
import { describeTokens, formatBytes, formatTokenCount, hasTokens, totalTokens } from "@/lib/usage";
import { DiffView } from "./diff-view";
import { GateTrack } from "./gate-track";
import { Markdown } from "./markdown";
import { formatElementSelections, useElementSelections } from "./selection-context";
import { useSessionAccess, type SessionAccess } from "./session-access";
import { useLightVerify } from "./use-light-verify";
import { useReadOnly } from "./use-read-only";

type Intent = "build" | "ask";

/** 질문의 답을 받아 만들기로 넘어갈 때 보내는 요청. 대화를 이어받으므로 앞의 계획을 가리키기만 한다 */
const BUILD_FROM_PLAN = "앞에서 정리한 계획대로 만들어줘";

export function ChatPanel({ view }: { view: SessionView }) {
  const { snapshot, chat } = view;
  const [text, setText] = useState("");
  const [allowBreaking, setAllowBreaking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  /** 되돌리는 동작이라 한 번 더 누르게 한다. 요청이 바뀌면 확인 상태도 사라지도록 요청 id로 둔다 */
  const [confirmingCancel, setConfirmingCancel] = useState<string>();
  const listRef = useRef<HTMLOListElement>(null);
  const runId = activeRun(view);
  const asking = isAsking(view);
  const access = useSessionAccess();
  const { selections, remove: removeSelection, clear: clearSelections } = useElementSelections();
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
  const intent: Intent = intentFor(readOnly);
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

  const personalLimit = personal?.limit;
  const personalReached = personalLimit !== undefined && personal !== undefined && personal.used >= personalLimit;
  // idle(샌드박스 꺼짐)이면 요청을 보낼 수 있다. 읽기만 하면 그대로 끝나고, 필요하면 실행 중에 샌드박스를 켠다
  const awake = snapshot.status === "ready" || snapshot.status === "idle";
  const canSend = awake && !snapshot.running && !sending && !budgetReached && !personalReached && access.canManage;
  // 실행 중에는 새 요청 대신 진행 중 지시를 보낸다. 데모(스크립트)는 반영할 모델 호출이 없어 제외한다
  const canSteer = snapshot.status === "ready" && snapshot.running && snapshot.mode !== "demo" && !sending && !budgetReached && !personalReached && access.canManage;

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
      body: JSON.stringify(chatRequestBody({ text: attachments ? `${attachments}\n\n${request}` : request, intent: sendIntent, allowBreaking, lightVerify })),
    });
    if (response.ok) {
      setText("");
      clearSelections();
    } else setError((await response.json()).error ?? "요청을 보내지 못했습니다");
    setSending(false);
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
        {chat.map((item, index) => (
          <li key={index}>
            <ChatEntry item={item} changedRuns={changedRuns} />
            {index === chat.length - 1 && item.kind === "outcome" && item.intent === "ask" && item.status === "done" && access.canManage && (
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
        ))}
        {snapshot.running && !runId && <li className="text-sm text-wait motion-safe:animate-pulse">작업하는 중</li>}
        {pending && (
          <li>
            <QuestionCard question={pending.question} options={pending.options} allowOther={pending.allowOther} disabled={!canSend} onAnswer={answerQuestion} />
          </li>
        )}
      </ol>

      <form
        className="border-t border-line px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (runId) {
            if (canSteer && text.trim()) void steer(text);
          } else if (canSend && text.trim()) void send(text);
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
              <p className="text-xs text-muted">
                {readOnly
                  ? "파일은 바꾸지 않고 답과 계획만 받습니다"
                  : lightVerify
                    ? "테스트·화면 확인·리뷰를 건너뜁니다. 배포하려면 전체 검증이 필요합니다"
                    : "질문이면 답만 하고, 바꾸면 검증 게이트를 통과한 변경만 남습니다"}
              </p>
            </div>
            <label htmlFor="request" className="sr-only">
              {intent === "ask" ? "질문" : "요청"}
            </label>
            <textarea
              id="request"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && text.trim()) {
                  if (runId) {
                    if (canSteer) {
                      event.preventDefault();
                      void steer(text);
                    }
                  } else if (canSend) {
                    event.preventDefault();
                    void send(text);
                  }
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
            <div className="mt-2 flex items-center justify-between gap-3">
              {intent === "build" ? (
                <label className="flex items-center gap-2 text-sm text-muted">
                  <input type="checkbox" checked={allowBreaking} onChange={(event) => setAllowBreaking(event.target.checked)} className="accent-ink" />
                  필드 삭제나 타입 변경 허용
                </label>
              ) : (
                <span />
              )}
              <button
                type="submit"
                disabled={runId ? !canSteer || !text.trim() : !canSend || !text.trim()}
                className="rounded-control bg-ink px-4 py-2 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
              >
                {runId ? "진행 중 지시" : intent === "ask" ? "질문하기" : "요청 보내기"}
              </button>
            </div>
          </>
        )}
        {error && <p className="mt-2 text-sm text-fail">{error}</p>}
      </form>
    </section>
  );
}

function ChatEntry({ item, changedRuns }: { item: ChatItem; changedRuns: ReadonlySet<string> }) {
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
      return (
        <p className="text-sm text-muted">
          {item.backend}에서 <span className="font-mono text-ink">{item.model}</span> 모델로 실행합니다
          {item.auth && ` (${item.auth})`}
        </p>
      );

    case "escalation":
      return (
        <p className="text-sm text-muted">
          같은 실패가 {item.times}번 반복되어 <span className="font-mono text-ink">{item.to}</span>으로 올렸습니다
        </p>
      );

    case "stage":
      return <p className="text-xs font-medium tracking-wide text-muted">작업 단계 · {stageLabel(item.stage)}</p>;

    case "check":
      return (
        <div className="text-xs">
          <p className={item.ok ? "text-pass" : "text-fail"}>
            {stageLabel(item.stage)} · {item.name} · {item.ok ? "통과" : "실패"}
            {item.attempts > 1 ? ` (시도 ${item.attempts}회)` : ""}
          </p>
          {!item.ok && item.detail && <pre className="mt-1 whitespace-pre-wrap text-muted">{item.detail}</pre>}
        </div>
      );

    case "reply":
      return <Markdown text={item.text} />;

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
        <p className="text-sm text-pass">
          체크포인트 <span className="font-mono">{item.checkpoint.shortSha}</span>로 되돌렸습니다. 파일 {item.result.files.length}개 복원,{" "}
          {databaseSummary(item.result.databases) && `${databaseSummary(item.result.databases)}, `}
          {restartSummary(item.result.restarted)}
        </p>
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
              {commitList}
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
              체크포인트에 없던 변경 {item.discarded.length}개를 버렸습니다:{" "}
              <span className="break-all font-mono text-xs">
                {item.discarded.slice(0, 5).join(", ")}
                {item.discarded.length > 5 && " 외"}
              </span>
            </p>
          )}
          {databaseSummary(item.databases) && <p className="mt-0.5 text-muted">{databaseSummary(item.databases)}</p>}
          {item.restarted.length > 0 && <p className="mt-0.5 text-muted">{restartSummary(item.restarted)}</p>}
        </div>
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
 * 에이전트가 되물은 질문 카드. 선택지를 누르면 `[질문] …\n[답] …` 요청으로 보내 이 대화를 이어서 만든다.
 * 실행을 붙잡고 기다리지 않고 질문을 남기고 끝난 뒤, 답을 다음 요청으로 받는 흐름의 화면이다
 */
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

function stageLabel(stage: string): string {
  return (
    {
      plan: "계획",
      implement: "구현",
      run: "실행",
      browser_check: "브라우저 확인",
      contract_check: "API 계약 확인",
      concurrency_check: "동시 요청 확인",
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
