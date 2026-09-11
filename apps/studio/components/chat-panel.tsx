"use client";

import { useEffect, useRef, useState } from "react";
import type { DatabaseState, ServiceCheck } from "@b-studio/agent";
import { activeRun, type ChatItem, type SessionView } from "@/lib/session-view";
import { describeTokens, formatTokenCount, hasTokens, totalTokens } from "@/lib/usage";
import { DiffView } from "./diff-view";
import { GateTrack } from "./gate-track";
import { Markdown } from "./markdown";
import { useSessionAccess, type SessionAccess } from "./session-access";

type Intent = "build" | "ask";

/** 질문의 답을 받아 만들기로 넘어갈 때 보내는 요청. 대화를 이어받으므로 앞의 계획을 가리키기만 한다 */
const BUILD_FROM_PLAN = "앞에서 정리한 계획대로 만들어줘";

export function ChatPanel({ view }: { view: SessionView }) {
  const { snapshot, chat } = view;
  const [text, setText] = useState("");
  const [allowBreaking, setAllowBreaking] = useState(false);
  const [intent, setIntent] = useState<Intent>("build");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  /** 되돌리는 동작이라 한 번 더 누르게 한다. 요청이 바뀌면 확인 상태도 사라지도록 요청 id로 둔다 */
  const [confirmingCancel, setConfirmingCancel] = useState<string>();
  const listRef = useRef<HTMLOListElement>(null);
  const runId = activeRun(view);
  const asking = isAsking(view);
  const access = useSessionAccess();
  const limit = snapshot.tokenLimit;
  const used = totalTokens(snapshot.tokens);
  const budgetReached = limit !== undefined && used >= limit;

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [chat]);

  const canSend = snapshot.status === "ready" && !snapshot.running && !sending && !budgetReached && access.canManage;

  const planRequest = snapshot.mode === "demo" ? snapshot.nextDemoRequest : BUILD_FROM_PLAN;

  async function send(request: string, sendIntent: Intent = intent) {
    setSending(true);
    setError(undefined);
    const response = await fetch(`/api/sessions/${snapshot.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: request, allowBreaking: sendIntent === "build" && allowBreaking, intent: sendIntent }),
    });
    if (response.ok) setText("");
    else setError((await response.json()).error ?? "요청을 보내지 못했습니다");
    setSending(false);
  }

  /** 질문의 답을 계획으로 삼아 만들기 요청을 보낸다 */
  function buildFromPlan() {
    if (!planRequest) return;
    setIntent("build");
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
    <section className="glass flex min-h-0 flex-col overflow-hidden rounded-2xl" aria-label="대화">
      <div className="border-b border-line px-5 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h2 className="font-semibold">대화</h2>
          {(hasTokens(snapshot.tokens) || limit !== undefined) && (
            <span className="text-xs text-muted" title="이 세션의 요청들이 쓴 모델 토큰입니다. 취소하거나 실패한 요청도 그때까지 쓴 양을 더합니다">
              {hasTokens(snapshot.tokens) && <>세션 합계 {describeTokens(snapshot.tokens)}</>}
              {limit !== undefined && (
                <span className={`ml-2 whitespace-nowrap ${budgetReached ? "font-medium text-fail" : used >= limit * 0.8 ? "text-wait" : ""}`}>
                  한도 {formatTokenCount(limit)} 중 {formatTokenCount(used)} 사용
                </span>
              )}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-sm text-muted">{hintFor(view, access)}</p>
      </div>

      <ol ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4" aria-live="polite">
        {chat.map((item, index) => (
          <li key={index}>
            <ChatEntry item={item} />
            {index === chat.length - 1 && item.kind === "outcome" && item.intent === "ask" && item.status === "done" && access.canManage && (
              <button
                type="button"
                onClick={buildFromPlan}
                disabled={!canSend || !planRequest}
                className="mt-2 rounded-full bg-ink px-3.5 py-1.5 text-sm font-medium text-panel shadow-sm hover:bg-ink/85 disabled:opacity-50"
              >
                이대로 만들기
              </button>
            )}
          </li>
        ))}
        {snapshot.running && !runId && <li className="text-sm text-wait motion-safe:animate-pulse">작업하는 중</li>}
      </ol>

      <form
        className="border-t border-line px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend && text.trim()) void send(text);
        }}
      >
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
                    className="rounded-full px-3 py-1.5 text-sm text-muted hover:text-ink"
                  >
                    계속 진행
                  </button>
                  <button
                    type="button"
                    onClick={() => void cancel(runId)}
                    className="rounded-full bg-fail px-3.5 py-1.5 text-sm font-medium text-panel shadow-sm hover:bg-fail/85"
                  >
                    변경 되돌리고 취소
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  // 질문은 되돌릴 변경이 없으므로 한 번 더 묻지 않는다
                  onClick={() => (asking ? void cancel(runId) : setConfirmingCancel(runId))}
                  className="glass-soft rounded-full px-3.5 py-1.5 text-sm font-medium hover:text-fail"
                >
                  {asking ? "질문 취소" : "요청 취소"}
                </button>
              ))}
          </div>
        )}
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="glass-soft inline-flex rounded-full p-0.5 text-sm" role="group" aria-label="요청 종류">
            {(["build", "ask"] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                aria-pressed={intent === kind}
                onClick={() => setIntent(kind)}
                className={`rounded-full px-3 py-1 font-medium transition-colors ${
                  intent === kind ? "bg-panel text-ink shadow-sm ring-1 ring-line" : "text-muted hover:text-ink"
                }`}
              >
                {kind === "build" ? "만들기" : "질문"}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">{intent === "ask" ? "파일은 바꾸지 않고 답과 계획만 받습니다" : "검증 게이트를 통과한 변경만 남습니다"}</p>
        </div>
        {snapshot.mode === "demo" ? (
          intent === "ask" ? (
            snapshot.nextDemoQuestion ? (
              <button
                type="button"
                disabled={!canSend}
                onClick={() => void send(snapshot.nextDemoQuestion!, "ask")}
                className="w-full rounded-xl border border-line bg-panel px-4 py-2.5 text-left text-sm font-medium shadow-sm hover:border-ink disabled:opacity-50"
              >
                질문하기: {snapshot.nextDemoQuestion}
              </button>
            ) : (
              <p className="text-sm text-muted">지금 단계에는 준비된 데모 질문이 없습니다.</p>
            )
          ) : snapshot.nextDemoRequest ? (
            <button
              type="button"
              disabled={!canSend}
              onClick={() => void send(snapshot.nextDemoRequest!, "build")}
              className="w-full rounded-xl bg-ink px-4 py-2.5 text-left text-sm font-medium text-panel shadow-sm hover:bg-ink/85 disabled:opacity-50"
            >
              다음 요청 보내기: {snapshot.nextDemoRequest}
            </button>
          ) : (
            <p className="text-sm text-muted">준비된 데모 요청을 모두 실행했습니다.</p>
          )
        ) : (
          <>
            <label htmlFor="request" className="sr-only">
              {intent === "ask" ? "질문" : "요청"}
            </label>
            <textarea
              id="request"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSend && text.trim()) {
                  event.preventDefault();
                  void send(text);
                }
              }}
              rows={3}
              placeholder={intent === "ask" ? "코드나 동작을 묻거나, 만들기 전에 계획을 세워 보세요" : "만들거나 바꾸고 싶은 내용을 적어 주세요"}
              className="w-full resize-none rounded-xl border border-line bg-panel px-3 py-2 text-sm leading-6 placeholder:text-muted"
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
                disabled={!canSend || !text.trim()}
                className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-panel shadow-sm hover:bg-ink/85 disabled:opacity-50"
              >
                {intent === "ask" ? "질문하기" : "요청 보내기"}
              </button>
            </div>
          </>
        )}
        {error && <p className="mt-2 text-sm text-fail">{error}</p>}
      </form>
    </section>
  );
}

function ChatEntry({ item }: { item: ChatItem }) {
  switch (item.kind) {
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

    case "backend":
      return (
        <p className="text-sm text-muted">
          {item.backend}에서 <span className="font-mono text-ink">{item.model}</span> 모델로 실행합니다
          {item.auth && ` (${item.auth})`}
        </p>
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
      const tone = item.status === "done" ? "text-pass" : item.status === "cancelled" ? "text-muted" : "text-fail";
      const text =
        item.status === "done"
          ? `${item.intent === "ask" ? "답변 완료" : "완료"}, ${item.turns ?? 0}턴`
          : item.status === "cancelled"
            ? item.summary
            : `${item.status === "failed" ? "완료하지 못함" : "오류"}: ${item.summary}`;
      return (
        <div className="text-sm">
          <p className={tone}>{text}</p>
          {hasTokens(item.usage) && <p className="mt-0.5 text-xs text-muted">{describeTokens(item.usage)}</p>}
        </div>
      );
    }
  }
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

function hintFor({ snapshot, chat }: SessionView, access: SessionAccess): string {
  if (!access.canManage) {
    return `읽기 전용입니다. 세션을 만든 사람(${access.owner ?? "기록 없음"})이나 관리자만 요청하고 바꿀 수 있습니다.`;
  }
  if (snapshot.status === "ready" && !snapshot.running && snapshot.tokenLimit !== undefined && totalTokens(snapshot.tokens) >= snapshot.tokenLimit) {
    return "이 세션은 토큰 한도에 도달해 새 요청을 받지 않습니다. 새 세션을 시작해 이어서 작업하세요.";
  }
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
