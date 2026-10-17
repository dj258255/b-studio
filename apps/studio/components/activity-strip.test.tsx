import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createView, reduceSession, type SessionView } from "@/lib/session-view";
import type { SessionSnapshot, StudioEvent } from "@/lib/studio-events";
import { ActivityStrip } from "./activity-strip";
import { SessionAccessProvider } from "./session-access";

const snapshot: SessionSnapshot = {
  id: "s1",
  projectId: "orders",
  projectName: "orders",
  workDir: "/tmp/orders-s1",
  status: "ready",
  mode: "claude-code",
  running: false,
  checkpoints: [],
  services: [],
};
const point = (shortSha: string, incomplete?: "max_turns") => ({ sha: `${shortSha}0000`, shortSha, message: "m", createdAt: "2026-10-12T00:00:00.000Z", files: [], ...(incomplete ? { incomplete } : {}) });

function view(events: StudioEvent[] = [], over: Partial<SessionSnapshot> = {}): SessionView {
  return events.reduce(reduceSession, createView({ ...snapshot, ...over }));
}

const render = (state: SessionView, { open = false, canManage = true } = {}) =>
  renderToStaticMarkup(
    <SessionAccessProvider value={{ canManage, canLogout: false }}>
      <ActivityStrip view={state} open={open} onToggle={() => {}} />
    </SessionAccessProvider>,
  );

const started: StudioEvent = { type: "run_started", runId: "t1", request: "메모 필드 추가", via: "terminal" };
const verifying: StudioEvent = { type: "agent", runId: "t1", event: { type: "verify_start", files: ["api/Order.java"] } };
const verified = (ok: boolean): StudioEvent =>
  ({ type: "agent", runId: "t1", event: { type: "verify_result", report: { ok, sync: { elapsedMs: 1 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }, text: "" } }) as StudioEvent;
const check = (stage: string, ok: boolean): StudioEvent => ({ type: "agent", runId: "t1", event: { type: "workflow_check", check: { stage: stage as never, name: "n", ok, attempts: 1 } } });

describe("터미널 아래의 활동 줄(이슈 #689)", () => {
  it("요청 전에는 무엇이 일어나는지 한 줄로 알리고 단계와 체크포인트는 그리지 않는다", () => {
    const html = render(view());
    expect(html).toContain("턴이 끝날 때 검증하고");
    expect(html).not.toContain("단계별 결과");
    expect(html).not.toContain("체크포인트 <span");
    expect(html).toContain("기록 펼치기");
    expect(html).not.toContain("요청 취소");
    // 대화 입력으로 되돌아가는 길은 없다. 요청은 터미널로만 보낸다
    expect(html).not.toContain("대화 입력");
  });

  it("끝난 요청: 검증 상태, 단계별 통과·실패, 가장 최근 체크포인트를 보인다", () => {
    const html = render(
      view([started, verifying, verified(true), check("test", true), check("review", true), { type: "run_finished", runId: "t1", status: "done", summary: "끝" }], {
        checkpoints: [point("7e12902"), point("c846466")],
      }),
    );
    expect(html).toContain("검증을 통과했습니다");
    expect(html).toContain("실행");
    expect(html).toContain("테스트");
    expect(html).toContain("리뷰");
    expect(html).toContain("7e12902");
    expect(html).not.toContain("✗");
  });

  it("실패한 단계는 통과와 구분해 그리고, 턴 상한에서 남긴 체크포인트는 그렇다고 적는다", () => {
    const html = render(view([started, verifying, verified(true), check("test", false)], { checkpoints: [point("7e12902", "max_turns"), point("c846466")] }));
    expect(html).toContain("✗");
    expect(html).toContain("테스트");
    expect(html).toContain("턴 상한");
  });

  it("진행 중인 요청에는 취소 버튼이 있고, 바꿀 수 없는 사람에게는 없다", () => {
    const running = view([started], { running: true });
    expect(render(running)).toContain("요청 취소");
    expect(render(running, { canManage: false })).not.toContain("요청 취소");
  });

  it("기록을 펼쳐 뒀으면 접기로 바뀐다", () => {
    expect(render(view(), { open: true })).toContain("기록 접기");
  });

  it("마지막 터미널 실행의 토큰·캐시 적중률·걸린 시간·비용을 한 줄로 보인다(#726)", () => {
    // 터미널 실행은 있는데 사용량을 못 받았으면 0이 아니라 "사용량 모름"이다
    expect(render(view([started]))).toContain("사용량 모름");
    const html = render(
      view([
        started,
        { type: "run_usage", runId: "t1", model: "claude-sonnet-5", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 4000, cacheWriteTokens: 0 }, costUsd: 0.04 },
        // 걸린 시간은 실행이 끝날 때 오는 run_finished.durationMs에서 온다(벽시계 시간)
        { type: "run_finished", runId: "t1", status: "done", summary: "끝", durationMs: 6200 },
      ]),
    );
    expect(html).toContain("토큰 ");
    expect(html).toContain("캐시 80%");
    expect(html).toContain("6.2초");
    expect(html).toContain("$0.04");
    expect(html).not.toContain("사용량 모름");
  });

  it("터미널 실행이 하나도 없으면 사용량 줄을 그리지 않는다(#726)", () => {
    expect(render(view([{ type: "run_started", runId: "c1", request: "대화 창 요청" }]))).not.toContain("사용량");
    expect(render(view())).not.toContain("사용량");
  });
});
