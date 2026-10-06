import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectSummary } from "@/lib/studio-events";
import type { TaskPlanMetrics } from "@/lib/task-plan-metrics";
import type { TaskPlanLaneView, TaskPlanView } from "@/lib/task-plan-types";
import { laneBackendLabel, LaneBackendControl, PlanTokenTotals, TaskPlanWorkbench, type PlanLimitView, type PlannerCapability } from "./task-plan-workbench";

function metrics(over: Partial<TaskPlanMetrics> = {}): TaskPlanMetrics {
  return {
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    modelCalls: 0,
    maxContextTokens: 0,
    bootMsTotal: 0,
    bootMsMax: 0,
    bootRxBytesTotal: 0,
    modelMs: 0,
    toolMs: 0,
    gateMs: 0,
    sessions: 1,
    ...over,
  };
}

describe("PlanTokenTotals", () => {
  it("계획 토큰 합계와 모델별 합을 보여 준다", () => {
    const html = renderToStaticMarkup(
      <PlanTokenTotals
        metrics={metrics({
          usage: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 },
          usageByModel: {
            haiku: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
            sonnet: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
        })}
      />,
    );

    expect(html).toContain("토큰 합계");
    expect(html).toContain("haiku");
    expect(html).toContain("sonnet");
  });

  it("토큰이 없으면 아무것도 그리지 않는다", () => {
    expect(renderToStaticMarkup(<PlanTokenTotals metrics={metrics()} />)).toBe("");
    expect(renderToStaticMarkup(<PlanTokenTotals metrics={undefined} />)).toBe("");
  });
});

/** 레인 백엔드 선택기(이슈 #398) 테스트의 최소 계획·레인 뷰 */
function plan(over: Partial<TaskPlanView> = {}): TaskPlanView {
  return { id: "plan-1", owner: "kim", projectId: "orders", request: "요청", modelId: "model-a", status: "awaiting_approval", createdAt: "", lanes: [], ...over };
}

function lane(over: Partial<TaskPlanLaneView> = {}): TaskPlanLaneView {
  return { id: "lane-1", paths: ["web/a"], status: "queued", tasks: [], ...over };
}

describe("laneBackendLabel(레인 카드 머리글의 백엔드·모델 표시, 이슈 #398)", () => {
  it("레인이 백엔드를 고르지 않았으면 '세션과 같음'과 계획 기본 모델을 보여준다", () => {
    expect(laneBackendLabel(plan({ modelId: "model-a" }), lane(), [{ id: "model-a", label: "Model A", configured: true } as never])).toBe(
      "세션과 같음 · Model A",
    );
  });

  it("레인이 백엔드·모델·노력을 골랐으면 그 값을 사람이 읽는 이름으로 보여준다", () => {
    const label = laneBackendLabel(plan(), lane({ backend: "claude-code", model: "sonnet", effort: "high" }), []);
    expect(label).toBe("로컬 Claude Agent · Sonnet 5 · 높음");
  });

  it("레인이 백엔드만 고르고 모델은 고르지 않았으면 '기본'을 보여준다", () => {
    const label = laneBackendLabel(plan(), lane({ backend: "commandcode" }), []);
    expect(label).toBe("로컬 Command Code Agent · 기본");
  });
});

describe("LaneBackendControl(레인 백엔드·모델 선택기, 이슈 #398)", () => {
  it("기본은 '세션과 같음'이 선택돼 있고, 고를 수 있는 백엔드가 옵션으로 있다", () => {
    const html = renderToStaticMarkup(
      <LaneBackendControl plan={plan()} lane={lane()} laneBackends={["claude-code", "codex"]} onUpdate={() => undefined} />,
    );

    expect(html).toContain("세션과 같음");
    expect(html).toContain("로컬 Claude Agent");
    expect(html).toContain("로컬 ChatGPT Agent");
    // 백엔드를 고르지 않았으면 모델 선택기 절을 그리지 않는다
    expect(html).not.toContain("모델 목록을 불러오는 중");
  });

  it("레인이 백엔드를 골랐으면 그 값이 선택되고, 모델 목록을 불러오는 동안 안내를 보여준다", () => {
    const html = renderToStaticMarkup(
      <LaneBackendControl plan={plan()} lane={lane({ backend: "claude-code" })} laneBackends={["claude-code", "codex"]} onUpdate={() => undefined} />,
    );

    expect(html).toContain('value="claude-code" selected');
    expect(html).toContain("모델 목록을 불러오는 중");
  });
});

describe("TaskPlanWorkbench 레인 카드(이슈 #82)", () => {
  it("작업 카드의 에이전트 요약을 대화 패널과 같은 마크다운 렌더러로 그린다(원문 **, ` 글자가 남지 않는다)", () => {
    const planner: PlannerCapability = { mode: "api", enabled: true };
    const limits: PlanLimitView = { maxLanes: 4, maxTasks: 12 };
    const projects: ProjectSummary[] = [{ id: "orders", name: "orders", services: [] }];
    const summary = "**구현 (backend만 — 이 작업의 쓰기 허용 경로)**\n`application.yml`에 설정을 더했다";
    const taskPlan: TaskPlanView = {
      id: "plan-1",
      owner: "kim",
      projectId: "orders",
      request: "백엔드 핵심과 시드를 만들어줘",
      modelId: "model-a",
      status: "running",
      createdAt: "",
      lanes: [
        {
          id: "lane-1",
          paths: ["backend/"],
          status: "running",
          tasks: [
            {
              id: "task-1",
              title: "Backend core & seed",
              request: "백엔드 핵심과 시드",
              paths: ["backend/"],
              dependsOn: [],
              status: "done",
              summary,
            },
          ],
        },
      ],
    };

    const html = renderToStaticMarkup(
      <TaskPlanWorkbench
        projects={projects}
        models={[]}
        initialPlans={[taskPlan]}
        initialSelectedId="plan-1"
        planner={planner}
        limits={limits}
        modelPicker={{ backend: "api", options: [], effort: { supported: false, levels: [] } }}
        laneBackends={["claude-code"]}
      />,
    );

    // 원문 마크다운 글자(**, `)는 그대로 남지 않고 강조·코드 태그로 바뀐다
    expect(html).not.toContain("**구현");
    expect(html).not.toContain("`application.yml`");
    expect(html).toContain("<strong>구현 (backend만 — 이 작업의 쓰기 허용 경로)</strong>");
    expect(html).toMatch(/<code[^>]*>application\.yml<\/code>/);
  });
});
