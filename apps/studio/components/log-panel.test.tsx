import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LogPanel } from "./log-panel";

describe("LogPanel", () => {
  it("에러·경고·플랫폼 줄을 각각 다른 색 클래스로 그린다", () => {
    const html = renderToStaticMarkup(
      <LogPanel
        logs={[
          { service: "web", text: "Error: 연결 실패", at: "2024-01-01T00:00:00.000Z" },
          { service: "web", text: "WARN deprecated option", at: "2024-01-01T00:00:01.000Z" },
          { service: "web", text: "[b-studio] 체크포인트를 만들었습니다", at: "2024-01-01T00:00:02.000Z" },
          { service: "web", text: "GET /health 200 3ms", at: "2024-01-01T00:00:03.000Z" },
        ]}
        services={["web"]}
      />,
    );
    expect(html).toContain("text-fail");
    expect(html).toContain("text-wait");
    expect(html).toContain("text-ink font-semibold");
    expect(html).toContain("text-pass");
    expect(html).toContain("Error: 연결 실패");
  });

  it("로그가 없으면 안내 문구를 보인다", () => {
    const html = renderToStaticMarkup(<LogPanel logs={[]} services={[]} />);
    expect(html).toContain("아직 로그가 없습니다.");
  });
});
