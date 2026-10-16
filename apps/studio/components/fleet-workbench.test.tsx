import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FleetWorkbench } from "./fleet-workbench";

describe("실험 기능을 켜지 않은 서버에서 주소로 연 여러 명 비교 화면(이슈 #720)", () => {
  it("환경 변수 이름 대신 실험 기능이라고 알리고 켜는 방법 문서로 잇는다. 내부 용어(라우터)는 쓰지 않는다", () => {
    const docsUrl = "https://github.com/dj258255/b-studio/blob/main/docs/configuration.md#실험-기능";
    const html = renderToStaticMarkup(
      <FleetWorkbench
        projects={[{ id: "orders", name: "orders", services: [] }]}
        models={[]}
        initialFleets={[]}
        fleet={{ enabled: false, reason: "실험 기능입니다. 켜는 방법은 설정 문서에 있습니다.", docsUrl }}
      />,
    );

    expect(html).toContain("실험 기능입니다");
    expect(html).toContain(`href="${docsUrl}"`);
    expect(html).not.toContain("B_STUDIO_EXPERIMENTAL");
    expect(html).not.toContain("라우터");
    // 문장 안에 줄표(—)를 쓰지 않는다
    expect(html).not.toContain(" — ");
  });
});
