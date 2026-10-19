import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StartProjectChoice } from "./start-project-choice";

describe("StartProjectChoice", () => {
  it("프로젝트마다 그 프로젝트의 첫 화면으로 가는 링크만 그린다 — 고르기 전에는 세션을 만들지 않는다", () => {
    const html = renderToStaticMarkup(
      <StartProjectChoice
        projects={[
          { id: "orders", name: "주문" },
          { id: "pipeline-lint", name: "파이프라인" },
        ]}
      />,
    );

    expect(html).toContain("어떤 프로젝트로 시작할까요?");
    expect(html).toContain('href="/?project=orders"');
    expect(html).toContain('href="/?project=pipeline-lint"');
    expect(html).toContain("파이프라인");
    // 버튼이 없다: 링크를 누르기 전에는 POST /api/workspace가 나갈 길이 없다
    expect(html).not.toContain("<button");
  });
});
