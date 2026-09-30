import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SupportingServicesChip } from "./supporting-services-chip";

describe("SupportingServicesChip", () => {
  it("닫힌 첫 그리기는 '서비스' 버튼만 그린다(팝오버는 열어야 목록을 불러온다)", () => {
    const html = renderToStaticMarkup(
      <SupportingServicesChip sessionId="s1" services={[{ service: "db", role: "supporting", state: "running" }]} />,
    );

    expect(html).toContain("서비스");
    expect(html).toContain("+1");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    // 열기 전에는 서비스 켜고 끄기 목록(fetch로 불러온다)을 그리지 않는다
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain("개발만");
  });

  it("부가 서비스 컨테이너가 없어도(관리형 서비스만 있어도) 서비스 메뉴는 항상 보인다", () => {
    const html = renderToStaticMarkup(<SupportingServicesChip sessionId="s1" services={[]} />);

    expect(html).toContain("서비스");
    expect(html).not.toContain("+0");
  });
});
