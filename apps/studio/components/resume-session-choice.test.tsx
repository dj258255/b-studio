import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ResumeSessionChoice } from "./resume-session-choice";

// 다른 프로젝트 고르기는 열어야만 /api/projects를 받는다. 서버 렌더 컨텍스트가 없는 라우터는 빈 구현으로 바꾼다
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined, push: () => undefined }) }));

describe("ResumeSessionChoice", () => {
  it("마지막 프로젝트 이름과 이어서 열기·다른 프로젝트로 시작 버튼을 그린다 — 샌드박스를 곧바로 켜지 않는다", () => {
    const html = renderToStaticMarkup(<ResumeSessionChoice projectId="orders" projectName="주문" updatedAt="2026-01-01T00:00:00.000Z" />);

    expect(html).toContain("주문");
    expect(html).toContain("이어서 열기");
    expect(html).toContain("다른 프로젝트로 시작");
    // "고르기"를 누르기 전에는 프로젝트 목록을 그리지 않는다(아직 /api/projects를 받지 않았다)
    expect(html).not.toContain("불러오는 중");
  });
});
