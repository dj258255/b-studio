import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProjectMenu } from "./project-menu";

// 팝오버는 열렸을 때만(useState 초기값 false) body로 포털한다. 서버 렌더 컨텍스트가 없는 라우터는 빈 구현으로 바꾼다
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined, push: () => undefined }) }));

describe("ProjectMenu", () => {
  it("닫힌 첫 그리기는 프로젝트 이름을 누르는 버튼만 그린다(팝오버는 열어야 뜬다)", () => {
    const html = renderToStaticMarkup(<ProjectMenu projectId="orders" projectName="orders" />);

    expect(html).toContain("orders");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    // 열기 전에는 프로젝트 목록·최근 세션 같은 팝오버 내용을 그리지 않는다
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain("최근 세션");
  });
});
