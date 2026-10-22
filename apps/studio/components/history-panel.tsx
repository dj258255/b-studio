"use client";

import { useEffect, useState } from "react";
import type { SessionView } from "@/lib/session-view";
import type { ReverifyRecord } from "@/lib/studio-events";
import { DiffView } from "./diff-view";
import { RepositoryBar } from "./repository-bar";
import { useSessionAccess } from "./session-access";

/** 체크포인트 기록. 게이트를 통과한 요청마다 하나씩 쌓이고, 이전 시점으로 되돌릴 수 있다 */
export function HistoryPanel({ view }: { view: SessionView }) {
  const { snapshot } = view;
  const [selectedSha, setSelectedSha] = useState<string>();
  const [patch, setPatch] = useState<{ sha: string; text?: string; error?: string }>();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  const access = useSessionAccess();

  const checkpoints = snapshot.checkpoints;
  const active = checkpoints.find((checkpoint) => checkpoint.sha === selectedSha) ?? checkpoints[0];
  const activeSha = active?.sha;
  const newerCount = active ? checkpoints.indexOf(active) : 0;

  useEffect(() => {
    if (!activeSha) return;
    let cancelled = false;
    fetch(`/api/sessions/${snapshot.id}/checkpoints/${activeSha}`)
      .then(async (response) => {
        const data = await response.json();
        if (!cancelled) setPatch(response.ok ? { sha: activeSha, text: data.patch } : { sha: activeSha, error: data.error });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setPatch({ sha: activeSha, error: String(reason) });
      });
    return () => {
      cancelled = true;
    };
  }, [snapshot.id, activeSha]);

  async function reverify() {
    if (!active) return;
    setError(undefined);
    const response = await fetch(`/api/sessions/${snapshot.id}/checkpoints/${active.sha}/reverify`, { method: "POST" });
    if (!response.ok) setError((await response.json().catch(() => ({}))).error ?? "다시 검증을 시작하지 못했습니다");
  }

  async function restore() {
    if (!active) return;
    setError(undefined);
    const response = await fetch(`/api/sessions/${snapshot.id}/checkpoints/${active.sha}/restore`, { method: "POST" });
    if (!response.ok) setError((await response.json()).error ?? "되돌리지 못했습니다");
    setConfirming(false);
  }

  if (!active) return <p className="p-6 text-sm text-muted">아직 체크포인트가 없습니다.</p>;

  const canRestore = newerCount > 0 && snapshot.status === "ready" && !snapshot.running && access.canManage;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RepositoryBar view={view} />
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[20rem_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-b border-line bg-panel md:border-r md:border-b-0">
          <h3 className="px-4 pt-4 text-sm font-semibold">체크포인트</h3>
          <p className="px-4 pt-1 text-xs leading-5 text-muted">
            {snapshot.workspace === "local"
              ? "검증 게이트를 통과한 요청과, 요청 전에 남긴 폴더의 직접 수정이 쌓입니다."
              : "검증 게이트를 통과한 요청만 남습니다."}
          </p>
          <ol className="px-2 py-2">
            {checkpoints.map((checkpoint, index) => (
              <li key={checkpoint.sha}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedSha(checkpoint.sha);
                    setConfirming(false);
                    setError(undefined);
                  }}
                  aria-current={checkpoint.sha === active.sha}
                  className={`w-full rounded px-2 py-2 text-left ${checkpoint.sha === active.sha ? "bg-ground" : "hover:bg-ground"}`}
                >
                  <span className="block text-sm font-medium">
                    {checkpoint.message}
                    {/* 가볍게 확인한 체크포인트. 테스트·화면 확인·리뷰를 건너뛰어 배포 조건을 채우지 못한다 */}
                    {checkpoint.verify === "light" && (
                      <span className="ml-1.5 rounded-full border border-line px-1.5 py-px align-middle text-[10px] font-normal text-muted">가볍게</span>
                    )}
                    {/* 문서만 바꿔 검증 게이트 없이 남긴 체크포인트(요구사항 저장 등). 배포 조건·"검증됨" 판정의 증거로 쓰지 않는다 */}
                    {checkpoint.verify === "docs" && (
                      <span className="ml-1.5 rounded-full border border-line px-1.5 py-px align-middle text-[10px] font-normal text-muted">문서</span>
                    )}
                    {/* 요청 사이에 쌓인 변경을 게이트 없이 남긴 직접 수정. 기본 설정에서는 배포하지 않는다 */}
                    {checkpoint.verify === "unverified" && (
                      <span className="ml-1.5 rounded-full border border-line px-1.5 py-px align-middle text-[10px] font-normal text-muted">게이트 없음</span>
                    )}
                    {/* 턴 상한에 닿은 실행이 게이트만 통과해 남긴 체크포인트. 요청이 끝나지 않았을 수 있다(ADR-131 덧붙임) */}
                    {checkpoint.incomplete === "max_turns" && (
                      <span className="ml-1.5 rounded-full border border-wait/40 bg-wait/10 px-1.5 py-px align-middle text-[10px] font-normal text-wait">턴 상한</span>
                    )}
                    {/* 가볍게·문서 체크포인트가 아닌데 통과한 검증 단계 기록이 하나도 없다(Workflow-Passed: none).
                        정상 경로로는 생기지 않아야 할 상태라(ADR-131 사고) 눈에 띄게 알린다 */}
                    {checkpoint.verify === undefined && checkpoint.passedStages?.length === 0 && (
                      <span className="ml-1.5 rounded-full border border-fail/40 bg-fail/10 px-1.5 py-px align-middle text-[10px] font-normal text-fail">
                        검증되지 않음
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">
                    <span className="font-mono">{checkpoint.shortSha}</span>, 파일 {checkpoint.files.length}개{index === 0 && ", 현재"}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </aside>

        <div className="flex min-h-0 flex-col overflow-y-auto p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">
                {active.message}
                {active.verify === "light" && (
                  <span className="ml-1.5 rounded-full border border-line px-1.5 py-px align-middle text-[10px] font-normal text-muted">가볍게</span>
                )}
                {active.verify === "docs" && (
                  <span className="ml-1.5 rounded-full border border-line px-1.5 py-px align-middle text-[10px] font-normal text-muted">문서</span>
                )}
                {active.verify === "unverified" && (
                  <span className="ml-1.5 rounded-full border border-line px-1.5 py-px align-middle text-[10px] font-normal text-muted">게이트 없음</span>
                )}
                {active.incomplete === "max_turns" && (
                  <span className="ml-1.5 rounded-full border border-wait/40 bg-wait/10 px-1.5 py-px align-middle text-[10px] font-normal text-wait">턴 상한</span>
                )}
                {active.verify === undefined && active.passedStages?.length === 0 && (
                  <span className="ml-1.5 rounded-full border border-fail/40 bg-fail/10 px-1.5 py-px align-middle text-[10px] font-normal text-fail">
                    검증되지 않음
                  </span>
                )}
              </h3>
              <p className="mt-0.5 text-sm text-muted">
                <span className="font-mono">{active.shortSha}</span>
                {active.createdAt && `, ${new Date(active.createdAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`}
                {active.verify === "light" && ", 가볍게 확인(배포 조건 미충족)"}
                {active.verify === "docs" && ", 문서만 바꿔 검증 게이트 없이 남긴 체크포인트"}
                {active.verify === "unverified" && ", 요청 사이에 바뀐 파일을 검증 게이트 없이 남긴 체크포인트(기본 배포 조건 미충족)"}
                {active.incomplete === "max_turns" && ", 턴 상한에 닿아 멈춘 실행이 남긴 체크포인트(게이트는 통과, 요청이 끝나지 않았을 수 있음)"}
                {active.verify === undefined && active.passedStages?.length === 0 && ", 검증 게이트를 통과한 기록이 없습니다(배포 조건 미충족)"}
              </p>
            </div>

            {newerCount > 0 ? (
              confirming ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-fail/40 bg-fail/10 px-3 py-2">
                  <p className="text-sm text-fail">
                    {snapshot.workspace === "local"
                      ? `이후 체크포인트 ${newerCount}개와 그 변경, 체크포인트에 없는 폴더의 수정이 내 폴더에서 사라집니다.`
                      : `이후 체크포인트 ${newerCount}개와 그 변경이 사라집니다.`}
                  </p>
                  <button type="button" onClick={() => void restore()} disabled={!canRestore} className="rounded-control bg-fail px-3 py-1 text-sm font-medium text-panel disabled:opacity-50">
                    되돌리기
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className="rounded-control px-2 py-1 text-sm text-muted hover:text-ink">
                    취소
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  disabled={!canRestore}
                  className="rounded-control border border-line px-3.5 py-1.5 text-sm font-medium hover:border-ink disabled:opacity-50"
                >
                  이 시점으로 되돌리기
                </button>
              )
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void reverify()}
                  disabled={snapshot.status !== "ready" || snapshot.running || !access.canManage}
                  title="에이전트를 돌리지 않고 이 체크포인트를 같은 검증 게이트로 처음부터 다시 확인합니다. 결과는 기록으로만 남고 새 체크포인트는 만들지 않습니다"
                  className="rounded-control border border-line px-3.5 py-1.5 text-sm font-medium hover:border-ink disabled:opacity-50"
                >
                  다시 검증
                </button>
                {/* 지금(head) 체크포인트는 파일을 움직일 게 없다. 실행 실패·중단이 되돌리지 못한 데이터베이스만
                    이 체크포인트 상태로 다시 맞춘다(파일·체크포인트 기록은 그대로다) — 되돌릴 데이터베이스가 없는
                    프로젝트에서는 서버가 거부하고(canRestore가 running·권한만 본다) 오류로 안내한다 */}
                <button
                  type="button"
                  onClick={() => void restore()}
                  disabled={snapshot.status !== "ready" || snapshot.running || !access.canManage}
                  title="되돌릴 파일 변경은 없지만, 실행이 중간에 멈춰 데이터베이스가 이 체크포인트와 어긋났을 수 있습니다"
                  className="rounded-control border border-line px-3.5 py-1.5 text-sm font-medium hover:border-ink disabled:opacity-50"
                >
                  데이터베이스 다시 맞추기
                </button>
              </div>
            )}
          </div>
          {error && <p className="mt-2 text-sm text-fail">{error}</p>}
          <ReverifyRecords records={(snapshot.reverifications ?? []).filter((record) => record.sha === active.sha)} />

          <div className="mt-4 min-h-0">
            {patch?.sha !== active.sha ? (
              <p className="text-sm text-muted">변경 내용을 불러오는 중</p>
            ) : patch.error ? (
              <p className="text-sm text-fail">{patch.error}</p>
            ) : (
              <DiffView patch={patch.text ?? ""} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 이 체크포인트를 다시 검증한 기록(#798). 최근 세 번까지 보인다. 체크포인트의 통과 기록(배포 조건)과는 따로다 —
 * "지금 다시 돌려도 통과하는가"를 본 것일 뿐이라 배포 조건을 채우지 않는다
 */
export function ReverifyRecords({ records }: { records: readonly ReverifyRecord[] }) {
  if (records.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-col gap-1 text-sm" aria-label="다시 검증 기록">
      {records.slice(0, 3).map((record) => (
        <li key={record.startedAt} className={`rounded-md border px-3 py-1.5 ${record.ok ? "border-pass/40 bg-pass/10" : "border-fail/40 bg-fail/10"}`}>
          <span className={`font-medium ${record.ok ? "text-pass" : "text-fail"}`}>{record.ok ? "다시 검증 통과" : record.platformFailure ? "다시 검증 못 함" : "다시 검증 실패"}</span>
          <span className="text-muted">
            {" "}
            · {new Date(record.finishedAt).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · {record.by}
          </span>
          <span className="block text-xs text-muted">{record.summary}</span>
          {record.failed.length > 0 && (
            <ul className="mt-0.5 text-xs text-fail">
              {record.failed.slice(0, 5).map((check) => (
                <li key={check.name}>
                  {check.name}
                  {check.detail ? `: ${check.detail}` : ""}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
