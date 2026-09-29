import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "@/lib/studio-events";
import { SplitView } from "./split-view";

// 칸을 닫을 때 쓰는 라우터는 서버 렌더에 컨텍스트가 없다. 화면 마크업만 보므로 빈 구현으로 바꾼다
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined, push: () => undefined }) }));

const snapshot: SessionSnapshot = {
  id: "s1",
  projectId: "orders",
  projectName: "orders",
  workDir: "/tmp/orders-s1",
  status: "ready",
  mode: "api",
  running: false,
  checkpoints: [],
  services: [{ name: "web", template: "nextjs", preview: "browser", state: "ready", hasContract: false }],
};

const render = (over: Partial<SessionSnapshot> = {}) => renderToStaticMarkup(<SplitView panes={[{ id: "s1", snapshot: { ...snapshot, ...over } }]} />);

describe("나란히 보기 칸 입력", () => {
  it("대화 화면과 같이 입력창 하나와 읽기만 스위치를 둔다", () => {
    const html = render();

    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("읽기만");
    // 기본은 만들기 경로라는 것을 짧게 알린다
    expect(html).toContain("바꾸면 게이트를 통과해야 남습니다");
    // 예전처럼 칸마다 만들기 요청만 보내는 고정 문구는 없다
    expect(html).toContain("이 세션에 보낼 요청");
  });

  it("실행 중인 칸은 진행 중 지시만 보내므로 스위치를 감춘다", () => {
    const html = render({ running: true });

    expect(html).toContain("진행 중 지시");
    expect(html).not.toContain('role="switch"');
    expect(html).not.toContain("읽기만");
  });
});
