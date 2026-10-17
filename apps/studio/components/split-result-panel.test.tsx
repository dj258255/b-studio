import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createView, reduceSession, type SessionView } from "@/lib/session-view";
import type { SessionSnapshot, StudioEvent } from "@/lib/studio-events";
import { SessionAccessProvider } from "./session-access";
import { SplitResultPanel } from "./split-result-panel";

const snapshot: SessionSnapshot = {
  id: "s1",
  projectId: "orders",
  projectName: "orders",
  workDir: "/tmp/orders-s1",
  status: "ready",
  mode: "claude-code",
  running: false,
  checkpoints: [],
  services: [{ name: "web", template: "nextjs", preview: "browser", state: "ready", hasContract: false }],
};
const point = (shortSha: string) => ({ sha: `${shortSha}0000`, shortSha, message: "요청 처리", createdAt: "2026-10-12T00:00:00.000Z", files: ["api/Order.java"] });

function view(events: StudioEvent[] = [], over: Partial<SessionSnapshot> = {}): SessionView {
  return events.reduce(reduceSession, createView({ ...snapshot, ...over }));
}

const render = (state: SessionView) =>
  renderToStaticMarkup(
    <SessionAccessProvider value={{ canManage: true, canLogout: false }}>
      <SplitResultPanel view={state} />
    </SessionAccessProvider>,
  );

const started: StudioEvent = { type: "run_started", runId: "t1", request: "메모 필드 추가", via: "terminal" };
const verifying: StudioEvent = { type: "agent", runId: "t1", event: { type: "verify_start", files: ["api/Order.java"] } };
const verified: StudioEvent = { type: "agent", runId: "t1", event: { type: "verify_result", report: { ok: true, sync: { elapsedMs: 1 }, restarted: [], contracts: [], unverifiedFiles: [], secretLeaks: [], skippedOff: [] }, text: "" } };

describe("나란히 보기의 오른쪽 결과 칸(B4)", () => {
  it("고른 칸의 이름과 세션 화면으로 가는 길, 바뀐 파일·미리보기를 보인다", () => {
    const html = render(view());
    expect(html).toContain("선택한 칸의 결과");
    expect(html).toContain("orders");
    expect(html).toContain("세션 화면 열기");
    expect(html).toContain("/sessions/s1");
    expect(html).toContain("바뀐 파일");
    expect(html).toContain("아직 체크포인트가 없습니다");
    expect(html).toContain("미리보기");
    expect(html).toContain("열기");
  });

  it("마지막 요청의 상태·단계·체크포인트와 사용량을 활동 줄로 보인다", () => {
    const html = render(
      view(
        [
          started,
          verifying,
          verified,
          { type: "run_finished", runId: "t1", status: "done", summary: "끝", durationMs: 6200 },
          { type: "run_usage", runId: "t1", model: "claude-sonnet-5", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 4000, cacheWriteTokens: 0 }, costUsd: 0.04 },
        ],
        { checkpoints: [point("7e12902"), point("c846466")] },
      ),
    );
    expect(html).toContain("검증을 통과했습니다");
    expect(html).toContain("7e12902");
    expect(html).toContain("캐시 80%");
    expect(html).toContain("$0.04");
    // 결과 칸에는 기록 펼치기 버튼을 두지 않는다(자세한 기록은 세션 화면에서 본다)
    expect(html).not.toContain("기록 펼치기");
  });

  it("화면 미리보기가 없는 세션은 그렇게 알린다", () => {
    const html = render(view([], { services: [] }));
    expect(html).toContain("이 세션에는 화면 미리보기가 없습니다");
  });
});
