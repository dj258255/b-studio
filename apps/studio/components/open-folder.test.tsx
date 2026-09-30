import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OpenFolder } from "./open-folder";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined, push: () => undefined }) }));

describe("OpenFolder", () => {
  it("처음 그리기는 경로 입력·살펴보기 버튼만 보이고 제안은 없다", () => {
    const html = renderToStaticMarkup(<OpenFolder />);

    expect(html).toContain("경로로 폴더 열기");
    expect(html).toContain("살펴보기");
    expect(html).not.toContain("찾은 서비스");
    expect(html).not.toContain('role="alert"');
  });
});
