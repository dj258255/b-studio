import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createView } from "@/lib/session-view";
import type { SessionSnapshot } from "@/lib/studio-events";
import { ImportFlow, RequirementPublishFlow, RequirementsList, RequirementsPanel, shouldConfirmBeforePlanAll } from "./requirements-panel";

const baseSnapshot: SessionSnapshot = {
  id: "s1",
  projectId: "orders",
  projectName: "orders",
  workDir: "/tmp/orders-s1",
  status: "ready",
  mode: "api",
  running: false,
  checkpoints: [],
  services: [],
};

describe("RequirementsPanel", () => {
  it("데이터를 받기 전에는 불러오는 중이라고 알린다(명세 → 요구사항 → 검증 추적, ADR-079)", () => {
    const html = renderToStaticMarkup(<RequirementsPanel view={createView(baseSnapshot)} />);

    expect(html).toContain("명세 → 요구사항 → 검증 추적");
    expect(html).toContain("불러오는 중");
  });
});

describe("ImportFlow 용어", () => {
  it("과제처럼 들리는 말 대신 중립적인 제품 용어를 쓴다", () => {
    const html = renderToStaticMarkup(<ImportFlow sessionId="s1" onApplied={() => {}} />);

    expect(html).not.toContain("과제");
    expect(html).toContain("만들 것을 적어 주세요");
  });
});

const snapshot = {
  exists: true as const,
  requirements: [
    {
      id: "R1",
      title: "로그인 API",
      kind: "api" as const,
      priority: "must" as const,
      acceptance: ["a"],
      status: "미착수" as const,
      confidence: "🔴" as const,
      evidence: { checkpoints: [], tests: [], gateChecks: [] },
      workPrefill: "[R1] 로그인 API",
    },
  ],
  allMustHavesPrefill: "다음 필수(must) 요구사항을 모두 구현해 주세요.\n\n- [R1] 로그인 API",
  assumptions: [],
};

describe("RequirementsList 다음 단계 순서(ADR-089)", () => {
  it("원격이 GitHub이고 아직 발행하지 않았으면 이슈로 발행이 전체 계획 세우기보다 먼저 나온다", () => {
    const html = renderToStaticMarkup(<RequirementsList sessionId="s1" snapshot={snapshot} canManage isGithub onWork={() => {}} onRefresh={() => {}} />);
    const publishIndex = html.indexOf("이슈로 발행");
    const planIndex = html.indexOf("전체 계획 세우기");
    expect(publishIndex).toBeGreaterThan(-1);
    expect(planIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeLessThan(planIndex);
  });

  it("원격이 GitHub이 아니면 '다음 단계'에 이슈로 발행 지름길을 보여주지 않는다", () => {
    const html = renderToStaticMarkup(<RequirementsList sessionId="s1" snapshot={snapshot} canManage isGithub={false} onWork={() => {}} onRefresh={() => {}} />);
    expect(html).toContain("전체 계획 세우기");
    expect(html).not.toContain("이슈로 발행");
  });

  it("이미 발행된(issue 있음) 요구사항이면 관리 권한이 있어도 확인을 다시 묻지 않는다(순수 로직)", () => {
    expect(shouldConfirmBeforePlanAll(true, false, false)).toBe(true);
    expect(shouldConfirmBeforePlanAll(true, true, false)).toBe(false);
    expect(shouldConfirmBeforePlanAll(true, false, true)).toBe(false);
    expect(shouldConfirmBeforePlanAll(false, false, false)).toBe(false);
  });
});

describe("RequirementPublishFlow(ADR-089)", () => {
  it("미리보기를 불러오는 동안 안내 문구와 설명을 보여준다(서버 렌더는 effect를 돌리지 않아 fetch가 일어나지 않는다)", () => {
    const html = renderToStaticMarkup(<RequirementPublishFlow sessionId="s1" onRefresh={() => {}} />);

    expect(html).toContain("요구사항을 GitHub 이슈로 발행");
    expect(html).toContain("docs/requirements.md");
    expect(html).toContain("미리보기를 만드는 중");
  });
});
