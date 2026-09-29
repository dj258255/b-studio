"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { FleetMemberStatus, FleetView } from "@/lib/fleet-types";
import type { TaskPlanStatus, TaskPlanStepStatus, TaskPlanView } from "@/lib/task-plan-types";
import { Dot, type Tone } from "./status";

/** 진행 중인 계획·비교를 다시 읽는 간격 */
const POLL_MS = 2_500;

const PLAN_STATUS: Record<TaskPlanStatus, { label: string; tone: Tone }> = {
  planning: { label: "작업을 나누는 중", tone: "wait" },
  awaiting_approval: { label: "승인을 기다립니다", tone: "wait" },
  running: { label: "레인 실행 중", tone: "wait" },
  integrating: { label: "결과를 합쳐 다시 검증하는 중", tone: "wait" },
  interrupted: { label: "멈춤(이어서 할 수 있음)", tone: "idle" },
  done: { label: "합친 결과가 검증을 통과했습니다", tone: "pass" },
  failed: { label: "끝내지 못했습니다", tone: "fail" },
  rejected: { label: "거절했습니다", tone: "idle" },
};

const STEP_STATUS: Record<TaskPlanStepStatus, { label: string; tone: Tone }> = {
  queued: { label: "대기", tone: "idle" },
  booting: { label: "준비 중", tone: "wait" },
  running: { label: "실행 중", tone: "wait" },
  done: { label: "통과", tone: "pass" },
  failed: { label: "실패", tone: "fail" },
  skipped: { label: "건너뜀", tone: "idle" },
};

const MEMBER_STATUS: Record<FleetMemberStatus, { label: string; tone: Tone }> = {
  booting: { label: "준비 중", tone: "wait" },
  running: { label: "실행 중", tone: "wait" },
  done: { label: "검증 통과", tone: "pass" },
  failed: { label: "실패", tone: "fail" },
  error: { label: "오류", tone: "fail" },
  cancelled: { label: "취소", tone: "idle" },
  awaiting_input: { label: "답을 기다림", tone: "wait" },
};

const PLAN_ACTIVE: ReadonlySet<TaskPlanStatus> = new Set(["planning", "running", "integrating"]);
const MEMBER_ACTIVE: ReadonlySet<FleetMemberStatus> = new Set(["booting", "running"]);

/** 넘긴 곳 주소(`/task-plans?id=…`, `/fleets?id=…`)에서 id를 꺼낸다 */
export function handoffTarget(href: string): { kind: "plan" | "fleet"; id: string } | undefined {
  const match = href.match(/^\/(task-plans|fleets)\?id=([\w%-]+)$/);
  if (!match) return undefined;
  return { kind: match[1] === "fleets" ? "fleet" : "plan", id: decodeURIComponent(match[2]!) };
}

/**
 * 대화에 남긴 넘김(ADR-068·069)을 진행 카드로 보여 준다. 화면을 옮기지 않고 대화 안에서 계획 승인·레인 진행·비교 고르기까지 한다.
 * 끝나지 않은 동안만 다시 읽는다. 자세한 화면은 링크로 연다
 */
export function HandoffCard({ href, canManage }: { href: string; canManage: boolean }) {
  const target = handoffTarget(href);
  if (!target) return null;
  return target.kind === "plan" ? <PlanProgress id={target.id} href={href} canManage={canManage} /> : <FleetProgress id={target.id} href={href} canManage={canManage} />;
}

function usePolled<T>(url: string, active: (value: T) => boolean): { value?: T; error?: string; reload: () => void } {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (!response.ok) {
          setError(body.error ?? "진행 상황을 불러오지 못했습니다");
          return;
        }
        setValue(body as T);
        setError(undefined);
        if (active(body as T)) timer = window.setTimeout(load, POLL_MS);
      } catch {
        if (!cancelled) timer = window.setTimeout(load, POLL_MS);
      }
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // active는 호출마다 새로 만들어지는 함수라 의존성에서 뺀다(다시 읽을지는 응답마다 판단한다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick]);

  return { value, error, reload: () => setTick((current) => current + 1) };
}

function PlanProgress({ id, href, canManage }: { id: string; href: string; canManage: boolean }) {
  const { value: plan, error, reload } = usePolled<TaskPlanView>(`/api/task-plans/${encodeURIComponent(id)}`, (current) => PLAN_ACTIVE.has(current.status));
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  async function decide(approve: boolean) {
    setBusy(true);
    setActionError(undefined);
    const response = await fetch(`/api/task-plans/${encodeURIComponent(id)}/approval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(approve ? { approve: true } : { approve: false, reason: "대화에서 거절" }),
    }).catch(() => undefined);
    setBusy(false);
    if (!response?.ok) setActionError((await response?.json().catch(() => ({})))?.error ?? "처리하지 못했습니다");
    reload();
  }

  const status = plan ? PLAN_STATUS[plan.status] : undefined;
  return (
    <section className="rounded-md border border-line bg-panel px-3.5 py-3" aria-label="나눠서 병렬 진행">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs font-medium text-muted">나눠서 병렬</span>
        {status && (
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <Dot tone={status.tone} />
            {status.label}
          </span>
        )}
        <Link href={href} className="ml-auto text-xs text-muted underline underline-offset-2 hover:text-ink">
          자세히
        </Link>
      </header>
      {!plan && <p className="mt-2 text-sm text-muted">{error ?? "불러오는 중"}</p>}
      {plan && plan.lanes.length > 0 && (
        <ul className="mt-2 space-y-1.5" aria-label="레인">
          {plan.lanes.map((lane) => {
            const step = STEP_STATUS[lane.status];
            return (
              <li key={lane.id} className="text-sm">
                <p className="flex flex-wrap items-center gap-x-2">
                  <Dot tone={step.tone} />
                  <span className="font-medium">{lane.id}</span>
                  <span className="text-xs text-muted">{lane.paths.join(", ")}</span>
                  <span className="text-xs text-muted">· {step.label}</span>
                  {lane.sessionId && (
                    <Link href={`/sessions/${lane.sessionId}`} className="text-xs text-muted underline underline-offset-2 hover:text-ink">
                      세션
                    </Link>
                  )}
                </p>
                <ul className="mt-0.5 space-y-0.5 pl-4">
                  {lane.tasks.map((task) => (
                    <li key={task.id} className="text-xs text-muted">
                      {STEP_STATUS[task.status].label} · {task.title}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ul>
      )}
      {plan?.integration && (
        <p className="mt-2 text-xs text-muted">
          통합: {STEP_STATUS[plan.integration.status].label}
          {plan.integration.sessionId && (
            <>
              {" · "}
              <Link href={`/sessions/${plan.integration.sessionId}`} className="underline underline-offset-2 hover:text-ink">
                합친 결과 세션 열기
              </Link>
            </>
          )}
        </p>
      )}
      {plan?.error && <p className="mt-2 text-xs text-fail">{plan.error}</p>}
      {plan?.status === "awaiting_approval" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || !canManage}
            onClick={() => void decide(true)}
            className="rounded-control bg-ink px-3 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50"
          >
            이대로 시작
          </button>
          <button
            type="button"
            disabled={busy || !canManage}
            onClick={() => void decide(false)}
            className="rounded-control border border-line px-3 py-1.5 text-sm font-medium hover:border-ink disabled:opacity-50"
          >
            거절
          </button>
        </div>
      )}
      {actionError && <p className="mt-2 text-xs text-fail">{actionError}</p>}
    </section>
  );
}

function FleetProgress({ id, href, canManage }: { id: string; href: string; canManage: boolean }) {
  const { value: fleet, error, reload } = usePolled<FleetView>(`/api/fleets/${encodeURIComponent(id)}`, (current) => current.members.some((member) => MEMBER_ACTIVE.has(member.status)));
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  async function choose(sessionId: string) {
    setBusy(true);
    setActionError(undefined);
    const response = await fetch(`/api/fleets/${encodeURIComponent(id)}/winner`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => undefined);
    setBusy(false);
    if (!response?.ok) setActionError((await response?.json().catch(() => ({})))?.error ?? "고르지 못했습니다");
    reload();
  }

  const running = fleet?.members.filter((member) => MEMBER_ACTIVE.has(member.status)).length ?? 0;
  return (
    <section className="rounded-md border border-line bg-panel px-3.5 py-3" aria-label="여러 명 비교 진행">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs font-medium text-muted">여러 명 비교</span>
        {fleet && (
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <Dot tone={fleet.winnerSessionId ? "pass" : running > 0 ? "wait" : "idle"} />
            {fleet.winnerSessionId ? "하나를 골랐습니다" : running > 0 ? `${running}명이 만드는 중` : "결과를 비교해 하나를 고르세요"}
          </span>
        )}
        <Link href={href} className="ml-auto text-xs text-muted underline underline-offset-2 hover:text-ink">
          자세히
        </Link>
      </header>
      {!fleet && <p className="mt-2 text-sm text-muted">{error ?? "불러오는 중"}</p>}
      {fleet && (
        <ul className="mt-2 space-y-1.5" aria-label="참가자">
          {fleet.members.map((member) => {
            const status = MEMBER_STATUS[member.status];
            const winner = fleet.winnerSessionId === member.sessionId;
            const tokens = member.usage ? member.usage.inputTokens + member.usage.outputTokens + member.usage.cacheReadTokens + member.usage.cacheWriteTokens : undefined;
            return (
              <li key={member.sessionId} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <Dot tone={status.tone} />
                <span className="font-medium">{member.label}</span>
                <span className="text-xs text-muted">· {status.label}</span>
                {tokens !== undefined && <span className="text-xs text-muted">· 토큰 {tokens.toLocaleString("ko-KR")}</span>}
                {member.checkpoint && <span className="text-xs text-muted">· 파일 {member.checkpoint.files.length}개</span>}
                <Link href={`/sessions/${member.sessionId}`} className="text-xs text-muted underline underline-offset-2 hover:text-ink">
                  보기
                </Link>
                {winner ? (
                  <span className="ml-auto text-xs font-medium text-pass">고름</span>
                ) : (
                  member.status === "done" &&
                  !fleet.winnerSessionId && (
                    <button
                      type="button"
                      disabled={busy || !canManage}
                      onClick={() => void choose(member.sessionId)}
                      className="ml-auto rounded-control border border-line px-2 py-0.5 text-xs font-medium hover:border-ink disabled:opacity-50"
                    >
                      이것으로 고르기
                    </button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      {actionError && <p className="mt-2 text-xs text-fail">{actionError}</p>}
    </section>
  );
}
