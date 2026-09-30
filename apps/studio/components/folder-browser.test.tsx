import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FolderBrowser } from "./folder-browser";

// useFolderProposal이 next/navigation의 useRouter를 쓴다. 서버 렌더 컨텍스트가 없는 라우터는 빈 구현으로 바꾼다(project-menu.test.tsx와 같은 방법)
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined, push: () => undefined }) }));

// 목록 상태는 useEffect의 fetch가 받아온 뒤에야 바뀐다. 이 저장소에는 jsdom·testing-library가 없어(다른 컴포넌트
// 테스트와 같은 제약) 더블클릭·키보드 같은 실제 이벤트는 시뮬레이션하지 못한다 — 그 동작(더블클릭·Enter로 들어가기,
// Backspace로 위로, 화살표로 옮기기)은 순수 함수로 빼서 `lib/folder-browser.test.ts`에서 확인한다.
// 여기서는 정적 렌더(react-dom/server)로 첫 그리기 구조만 확인한다
describe("FolderBrowser", () => {
  it("불러오는 동안 목록 자리와 필터·경로 직접 입력 토글·이 폴더 열기 버튼(꺼짐)을 그린다", () => {
    const html = renderToStaticMarkup(<FolderBrowser />);

    expect(html).toContain("불러오는 중");
    expect(html).toContain('role="listbox"');
    expect(html).toContain("폴더 이름으로 거르기");
    expect(html).toContain("경로 직접 입력");
    expect(html).toContain("이 폴더 열기");
    // 아직 고른 폴더가 없으니(목록을 아직 못 받았다) "이 폴더 열기" 버튼은 꺼져 있다
    expect(html).toContain("disabled=\"\"");
  });

  it("경로 직접 입력을 누르기 전에는 그 화면(OpenFolder)을 그리지 않는다", () => {
    const html = renderToStaticMarkup(<FolderBrowser />);

    expect(html).not.toContain("경로로 폴더 열기");
  });
});
