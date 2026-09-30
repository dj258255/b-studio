import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DesktopFolderPicker } from "./desktop-folder-picker";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined, push: () => undefined }) }));

describe("DesktopFolderPicker", () => {
  it("처음 그리기는 폴더 선택 버튼만 보이고 제안은 아직 없다", () => {
    const html = renderToStaticMarkup(<DesktopFolderPicker />);

    expect(html).toContain("폴더 선택…");
    expect(html).toContain("폴더 열기");
    // 아직 고르지 않았으니 제안(찾은 서비스 목록)은 없다
    expect(html).not.toContain("찾은 서비스");
    expect(html).not.toContain('role="alert"');
  });
});
