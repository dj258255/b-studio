"use client";

import { useEffect, useRef, useState } from "react";
import type { ExploreQaResult, QaActionRecord, QaExpectedRejection, QaFinding } from "@b-studio/agent";
import { artifactUrl } from "@/lib/artifact-url";
import type { LiveFrame } from "./live-frames";

export interface ExploreQaRun {
  id: string;
  service: string;
  goal: { goal: string; startPath: string; confirmText?: string };
  status: "running" | "done";
  actions: QaActionRecord[];
  findings: QaFinding[];
  expectedRejections?: QaExpectedRejection[];
  texts: string[];
  result?: ExploreQaResult;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const POLL_MS = 1200;

const STOP_REASON_LABEL: Record<string, string> = {
  finish: "목표 완료 선언",
  max_actions: "최대 행동 수 도달",
  max_time: "시간 상한 도달",
  repeated_screen: "같은 화면에서 같은 조작 반복",
  no_tool_call: "도구 호출 없이 끝남",
};

const SEVERITY_CLASS: Record<QaFinding["severity"], string> = { blocker: "bg-fail/20 text-fail", major: "bg-fail/10 text-fail", minor: "bg-wait/20 text-wait" };

/** 판정 이름과 색. 점검을 마치지 못한 실행(inconclusive)은 통과로도 실패로도 보이지 않게 따로 둔다 */
function verdictOf(status: ExploreQaResult["status"]): { label: string; box: string; text: string } {
  if (status === "pass") return { label: "통과", box: "border-pass/40 bg-pass/10", text: "text-pass" };
  if (status === "inconclusive") return { label: "점검을 마치지 못함", box: "border-line bg-ground", text: "text-wait" };
  return { label: "문제 발견", box: "border-fail/40 bg-fail/10", text: "text-fail" };
}

/** 모델이 화면을 보고 보고한 문제 목록. 실행 중에도, 끝나고 나서도 같은 모양으로 보여 준다 */
function FindingList({ findings }: { findings: QaFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <div className="mb-3 rounded-control border border-line p-2 text-sm">
      <p className="font-semibold">모델이 화면에서 본 문제 {findings.length}건</p>
      <ul className="mt-1 space-y-1.5">
        {findings.map((finding, index) => (
          <li key={index} className="break-words text-xs">
            <span className={`mr-1 rounded-sm px-1 font-medium ${SEVERITY_CLASS[finding.severity]}`}>{finding.severity}</span>
            {finding.summary}
            {finding.where && <span className="block text-muted">위치: {finding.where}</span>}
            {finding.evidence && <span className="block text-muted">근거: {finding.evidence}</span>}
            {finding.observedAtAction !== undefined && <span className="block text-muted">본 화면: {finding.observedAtAction}번째 동작의 캡처·스냅샷</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 모델이 조작 전에 "거절되는 것이 정상"이라고 미리 알린 시험. 사람이 정말 의도한 시험이었는지 볼 수 있게 이유와 응답을 그대로 보여 준다 */
function RejectionList({ title, hint, items }: { title: string; hint?: string; items: QaExpectedRejection[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mb-3 rounded-control border border-line p-2 text-sm">
      <p className="font-semibold">
        {title} {items.length}건
      </p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      <ul className="mt-1 space-y-1.5">
        {items.map((item, index) => (
          <li key={index} className="break-words text-xs">
            <span className="font-medium">{item.actionIndex !== undefined ? `${item.actionIndex}번째 동작 ${item.tool ?? ""}` : "조작 없이 끝남"}</span>
            <span className="block text-muted">이유: {item.reason}</span>
            {item.requests.map((request, requestIndex) => (
              <span key={requestIndex} className="block font-mono text-muted">
                {request.status} {request.url}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

async function call(sessionId: string, body: unknown): Promise<Response> {
  return fetch(`/api/sessions/${sessionId}/explore-qa`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** 도구 호출의 대상(ref·좌표·텍스트 등)을 한 줄로 요약한다 */
function describeInput(action: QaActionRecord): string {
  const input = action.input;
  if (typeof input.ref === "string") return action.stableSelector ? `${input.ref} (${action.stableSelector})` : String(input.ref);
  if (typeof input.path === "string") return String(input.path);
  if (typeof input.query === "string") return String(input.query);
  if (typeof input.forText === "string") return `'${input.forText}' 기다림`;
  if (typeof input.key === "string") return String(input.key);
  if (typeof input.x === "number" && typeof input.y === "number") return `(${input.x}, ${input.y})`;
  return "";
}

/**
 * 탐색형 QA 보기 — 목표 문장으로 모델이 스스로 화면을 조작하게 하고, 실시간 프레임 위에 지금 행동 위치를 겹쳐 그리며
 * 옆에 단계 타임라인을 보여 준다. 끝나면 결과 카드(통과/실패, 발견한 진단 신호)와 저장 버튼을 보여 준다.
 * 기존 QaView(게이트 화면 확인 보기)와 같은 QA 하위 탭 안에서, 부모가 안쪽 토글로 이 보기와 구분한다.
 */
export function ExploreQaView({ sessionId, service, frame }: { sessionId: string; service: string; frame?: LiveFrame }) {
  const [run, setRun] = useState<ExploreQaRun | null>(null);
  const [goal, setGoal] = useState("");
  const [startPath, setStartPath] = useState("/");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string>();
  const [saveResult, setSaveResult] = useState<{ skipped: Array<{ index: number; tool: string; reason: string }> } | { error: string }>();
  const [saving, setSaving] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgBox, setImgBox] = useState<{ left: number; top: number; width: number; height: number }>();
  const containerRef = useRef<HTMLDivElement>(null);
  const running = run?.status === "running";

  // 실행 중에는 1.2초 간격으로 상태를 폴링하고, 끝나면 스스로 멈춘다(처음 열 때 한 번은 늘 불러온다).
  // running이 바뀌면(시작·멈춤) 폴링을 다시 건다
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = async (): Promise<void> => {
      const response = await fetch(`/api/sessions/${sessionId}/explore-qa`);
      const body = (await response.json().catch(() => null)) as ExploreQaRun | null;
      if (cancelled) return;
      setRun(body);
      if ((!body || body.status === "done") && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [sessionId, running]);

  useEffect(() => {
    const image = imgRef.current;
    const container = containerRef.current;
    if (!image || !container) {
      setImgBox(undefined);
      return;
    }
    const update = () => {
      const imageRect = image.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      if (imageRect.width === 0 || imageRect.height === 0) return;
      setImgBox({ left: imageRect.left - containerRect.left, top: imageRect.top - containerRect.top, width: imageRect.width, height: imageRect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(image);
    observer.observe(container);
    return () => observer.disconnect();
  }, [frame?.width, frame?.height]);

  async function start(): Promise<void> {
    setError(undefined);
    setSaveResult(undefined);
    const response = await call(sessionId, {
      action: "start",
      service,
      goal,
      startPath: startPath.startsWith("/") ? startPath : `/${startPath}`,
      ...(confirmText.trim() ? { confirmText: confirmText.trim() } : {}),
    });
    const body = (await response.json().catch(() => ({}))) as ExploreQaRun & { error?: string };
    if (!response.ok) {
      setError(body.error ?? "탐색형 QA를 시작하지 못했습니다");
      return;
    }
    setRun(body);
  }

  async function stop(): Promise<void> {
    await call(sessionId, { action: "stop" });
  }

  async function save(): Promise<void> {
    setSaving(true);
    setSaveResult(undefined);
    const response = await call(sessionId, { action: "save", service });
    const body = (await response.json().catch(() => ({}))) as { skipped?: Array<{ index: number; tool: string; reason: string }>; error?: string };
    setSaving(false);
    setSaveResult(response.ok ? { skipped: body.skipped ?? [] } : { error: body.error ?? "저장하지 못했습니다" });
  }

  const lastAction = run?.actions.at(-1);
  const rect = lastAction?.targetRect;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-end gap-2 border-b border-line bg-panel px-3 py-2 text-sm">
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1">
          <span className="text-xs text-muted">목표</span>
          <input
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            disabled={running}
            placeholder="예: 상품 목록에서 상세로 가서 댓글을 쓰고 지운다"
            className="rounded-control border border-line bg-ground px-2 py-1 disabled:opacity-60"
          />
        </label>
        <label className="flex w-36 flex-col gap-1">
          <span className="text-xs text-muted">시작 경로</span>
          <input value={startPath} onChange={(event) => setStartPath(event.target.value)} disabled={running} className="rounded-control border border-line bg-ground px-2 py-1 font-mono disabled:opacity-60" />
        </label>
        <label className="flex w-48 flex-col gap-1">
          <span className="text-xs text-muted">확인 문구(선택)</span>
          <input value={confirmText} onChange={(event) => setConfirmText(event.target.value)} disabled={running} className="rounded-control border border-line bg-ground px-2 py-1 disabled:opacity-60" />
        </label>
        {running ? (
          <button type="button" onClick={stop} className="rounded-control bg-fail px-3 py-1.5 font-medium text-panel hover:opacity-90">
            멈추기
          </button>
        ) : (
          <button
            type="button"
            onClick={start}
            disabled={goal.trim().length === 0}
            className="rounded-control bg-ink px-3 py-1.5 font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
          >
            시작
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="border-b border-fail/40 bg-fail/10 px-3 py-1.5 text-sm text-fail">
          {error}
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-1">
        <div ref={containerRef} className="relative flex min-h-0 w-full items-center justify-center overflow-hidden bg-ground">
          {frame ? (
            <>
              <img ref={imgRef} src={`data:${frame.mime};base64,${frame.data}`} alt="" className="max-h-full max-w-full" />
              {imgBox && rect && (
                <div
                  className="pointer-events-none absolute border-2 border-ink bg-ink/10"
                  style={{
                    left: imgBox.left + (rect.x / frame.width) * imgBox.width,
                    top: imgBox.top + (rect.y / frame.height) * imgBox.height,
                    width: Math.max(2, (rect.width / frame.width) * imgBox.width),
                    height: Math.max(2, (rect.height / frame.height) * imgBox.height),
                  }}
                >
                  <span className="absolute -top-5 left-0 truncate rounded-sm bg-ink px-1 py-0.5 text-[10px] leading-tight text-panel">
                    {lastAction?.tool}
                  </span>
                </div>
              )}
            </>
          ) : (
            <p role="status" className="px-4 py-3 text-sm text-muted">
              {run ? "첫 화면을 기다리는 중입니다" : "목표를 입력하고 시작을 누르면 이곳에 화면이 나옵니다"}
            </p>
          )}
        </div>

        <aside className="min-h-0 overflow-y-auto border-t border-line bg-panel p-3 lg:border-t-0 lg:border-l">
          {run?.result && (
            <div className={`mb-3 rounded-control border p-2 text-sm ${verdictOf(run.result.status).box}`}>
              <p className={`font-semibold ${verdictOf(run.result.status).text}`}>{verdictOf(run.result.status).label}</p>
              <p className="mt-1 text-xs text-muted">{run.result.reason}</p>
              <p className="mt-1 text-xs text-muted">멈춘 이유: {STOP_REASON_LABEL[run.result.stoppedBy] ?? run.result.stoppedBy}</p>
              {run.result.modelDeclared && (
                <p className="mt-1 text-xs text-muted">
                  모델 선언: {run.result.modelDeclared.success ? "성공" : "실패"} — {run.result.modelDeclared.summary}
                </p>
              )}
              {(run.result.usage.inputTokens > 0 || run.result.usage.outputTokens > 0) && (
                <p className="mt-1 text-xs text-muted">
                  이번 실행 토큰: 입력 {run.result.usage.inputTokens.toLocaleString("ko-KR")} · 출력 {run.result.usage.outputTokens.toLocaleString("ko-KR")}
                  {run.result.usage.cacheReadTokens > 0 && ` · 캐시 읽기 ${run.result.usage.cacheReadTokens.toLocaleString("ko-KR")}`}
                  <span className="block">(프로젝트 토큰 보고서에는 아직 합산되지 않습니다)</span>
                </p>
              )}
              {run.actions.length > 0 && (
                <div className="mt-2">
                  <button type="button" onClick={save} disabled={saving} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink disabled:opacity-60">
                    {saving ? "저장하는 중" : "이 흐름을 게이트 화면 확인으로 저장"}
                  </button>
                  {saveResult && "error" in saveResult && <p className="mt-1 text-xs text-fail">{saveResult.error}</p>}
                  {saveResult && "skipped" in saveResult && (
                    <div className="mt-1 text-xs text-muted">
                      <p>저장했습니다.</p>
                      {saveResult.skipped.length > 0 && (
                        <ul className="mt-1 list-disc pl-4">
                          {saveResult.skipped.map((entry) => (
                            <li key={entry.index}>
                              {entry.index}. {entry.tool}: {entry.reason}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {run && <FindingList findings={run.result?.findings ?? run.findings ?? []} />}
          {run && (
            <RejectionList
              title="예상된 거절"
              hint="모델이 조작 전에 거절되는 것이 정상이라고 알린 시험입니다. 실패한 요청으로 세지 않았습니다."
              items={run.result?.expectedRejections ?? run.expectedRejections ?? []}
            />
          )}
          {run?.result && (
            <RejectionList
              title="거절 응답이 없던 시험"
              hint="거절될 것으로 선언했지만 거절 응답이 없었습니다. 서버가 요청을 통과시켰거나 화면에서 먼저 막혔을 수 있어 확인이 필요합니다."
              items={run.result.unmetRejections ?? []}
            />
          )}
          {run?.error && <p className="mb-3 rounded-control border border-fail/40 bg-fail/10 p-2 text-sm text-fail">{run.error}</p>}
          {run && run.actions.length > 0 ? (
            <ol className="space-y-1.5">
              {run.actions.map((action) => (
                <li key={action.index} className="flex items-start gap-2 text-sm">
                  <span aria-hidden className={action.ok ? "text-pass" : "text-fail"}>
                    {action.ok ? "✓" : "✗"}
                  </span>
                  <span className="min-w-0 flex-1 break-words">
                    <span className="font-medium">{action.tool}</span>
                    {describeInput(action) && <span className="text-muted"> · {describeInput(action)}</span>}
                    {action.newDiagnosticsCount > 0 && <span className="ml-1 rounded-sm bg-wait/20 px-1 text-xs text-wait">진단 {action.newDiagnosticsCount}</span>}
                    {action.detail && <span className="mt-0.5 block text-xs text-fail">{action.detail}</span>}
                    {action.artifact && (
                      <a href={artifactUrl(sessionId, action.artifact)} target="_blank" rel="noreferrer" className="mt-0.5 block">
                        <img src={artifactUrl(sessionId, action.artifact)} alt={`${action.tool} 스크린샷`} className="mt-1 h-16 rounded-sm border border-line object-cover" />
                      </a>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">{run ? "아직 행동이 없습니다." : "실행 기록이 아직 없습니다."}</p>
          )}
        </aside>
      </div>
    </div>
  );
}
