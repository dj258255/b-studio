"use client";

import { useEffect, useRef, useState } from "react";
import type { DatabaseState, ServiceCheck } from "@b-studio/agent";
import type { ChatItem, SessionView } from "@/lib/session-view";
import { DiffView } from "./diff-view";
import { GateTrack } from "./gate-track";

export function ChatPanel({ view }: { view: SessionView }) {
  const { snapshot, chat } = view;
  const [text, setText] = useState("");
  const [allowBreaking, setAllowBreaking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [chat]);

  const canSend = snapshot.status === "ready" && !snapshot.running && !sending;

  async function send(request: string) {
    setSending(true);
    setError(undefined);
    const response = await fetch(`/api/sessions/${snapshot.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: request, allowBreaking }),
    });
    if (response.ok) setText("");
    else setError((await response.json()).error ?? "요청을 보내지 못했습니다");
    setSending(false);
  }

  return (
    <section className="flex min-h-0 flex-col border-t border-line bg-panel lg:border-t-0" aria-label="대화">
      <div className="border-b border-line px-5 py-3">
        <h2 className="font-semibold">대화</h2>
        <p className="mt-0.5 text-sm text-muted">{hintFor(view)}</p>
      </div>

      <ol ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4" aria-live="polite">
        {chat.map((item, index) => (
          <li key={index}>
            <ChatEntry item={item} />
          </li>
        ))}
        {snapshot.running && <li className="text-sm text-wait motion-safe:animate-pulse">에이전트가 작업하는 중</li>}
      </ol>

      <form
        className="border-t border-line px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend && text.trim()) void send(text);
        }}
      >
        {snapshot.mode === "demo" ? (
          snapshot.nextDemoRequest ? (
            <button
              type="button"
              disabled={!canSend}
              onClick={() => void send(snapshot.nextDemoRequest!)}
              className="w-full rounded-md bg-ink px-4 py-2.5 text-left text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
            >
              다음 요청 보내기: {snapshot.nextDemoRequest}
            </button>
          ) : (
            <p className="text-sm text-muted">준비된 데모 요청을 모두 실행했습니다.</p>
          )
        ) : (
          <>
            <label htmlFor="request" className="sr-only">
              요청
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
              placeholder="만들거나 바꾸고 싶은 내용을 적어 주세요"
              className="w-full resize-none rounded-md border border-line bg-ground px-3 py-2 text-sm leading-6 placeholder:text-muted"
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm text-muted">
                <input type="checkbox" checked={allowBreaking} onChange={(event) => setAllowBreaking(event.target.checked)} className="accent-ink" />
                필드 삭제나 타입 변경 허용
              </label>
              <button
                type="submit"
                disabled={!canSend || !text.trim()}
                className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
              >
                요청 보내기
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
      return <p className="border-l-[3px] border-ink pl-3 font-medium leading-7 whitespace-pre-wrap">{item.text}</p>;

    case "backend":
      return (
        <p className="text-sm text-muted">
          {item.backend}에서 <span className="font-mono text-ink">{item.model}</span> 모델로 실행합니다
          {item.auth && ` (${item.auth})`}
        </p>
      );

    case "reply":
      return <p className="leading-7 whitespace-pre-wrap">{item.text}</p>;

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

    case "reverted":
      return (
        <div className="rounded-md border border-wait/40 bg-wait/10 px-3 py-2 text-sm">
          <p className="font-medium text-wait">검증을 통과하지 못한 변경을 되돌렸습니다: 파일 {item.files.length}개</p>
          {databaseSummary(item.databases) && <p className="mt-0.5 text-muted">{databaseSummary(item.databases)}</p>}
          <p className="mt-0.5 text-muted">{restartSummary(item.restarted)}</p>
          <details className="mt-1.5">
            <summary className="cursor-pointer text-muted hover:text-ink">되돌린 변경 보기</summary>
            <div className="mt-1.5 max-h-72 overflow-auto">
              <DiffView patch={item.patch} />
            </div>
          </details>
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

    case "outcome":
      return (
        <p className={`text-sm ${item.status === "done" ? "text-pass" : "text-fail"}`}>
          {item.status === "done" ? `완료, ${item.turns ?? 0}턴` : `${item.status === "failed" ? "완료하지 못함" : "오류"}: ${item.summary}`}
        </p>
      );
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

function hintFor({ snapshot, chat }: SessionView): string {
  if (snapshot.status === "starting") return "샌드박스를 준비하고 있습니다. 서비스가 모두 준비되면 요청할 수 있습니다.";
  if (snapshot.status === "failed") return "샌드박스를 시작하지 못했습니다. 위의 오류를 확인하세요.";
  if (snapshot.status === "stopped") return "샌드박스를 중지했습니다. 이어서 작업하면 마지막 체크포인트로 새 샌드박스를 띄웁니다.";
  if (chat.length > 0) return "요청마다 검증 게이트를 통과해야 완료로 표시됩니다.";
  if (snapshot.mode === "demo") return "데모 모드는 준비된 요청을 순서대로 스크립트로 실행합니다.";
  if (snapshot.mode === "claude-code") {
    return "이 PC에서 로그인한 Claude 계정으로 실행합니다. 작업을 끝내면 스튜디오가 서비스를 재시작하고 API 계약을 확인합니다.";
  }
  return "에이전트가 작업을 끝내면 스튜디오가 서비스를 재시작하고 API 계약을 확인합니다.";
}
