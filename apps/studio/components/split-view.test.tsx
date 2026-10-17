import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "@/lib/studio-events";
import { SplitView } from "./split-view";

// 칸을 닫을 때 쓰는 라우터는 서버 렌더에 컨텍스트가 없다. 화면 마크업만 보므로 빈 구현으로 바꾼다
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined, push: () => undefined }) }));
// 터미널 패널은 브라우저에서만 도는 xterm을 부른다. 이 테스트는 마크업만 보므로 CSS와 xterm을 가짜로 둔다
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

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

const terminal: SessionSnapshot = { ...snapshot, terminal: true, terminalMode: "host" };

const render = (over: Partial<SessionSnapshot> = {}) => renderToStaticMarkup(<SplitView panes={[{ id: "s1", snapshot: { ...snapshot, ...over } }]} />);
const renderPanes = (...panes: SessionSnapshot[]) => renderToStaticMarkup(<SplitView panes={panes.map((pane) => ({ id: pane.id, snapshot: pane }))} />);

describe("나란히 보기 칸 입력", () => {
  it("대화 화면과 같이 입력창 하나와 읽기만 스위치를 둔다", () => {
    const html = render();

    // 위쪽 "모두에게 보내기" 입력창 하나 + 칸 자체 입력창 하나
    expect(html.match(/<textarea/g)).toHaveLength(2);
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

describe("나란히 보기 머리·칸 구성", () => {
  it("상태 칩·모두에게 보내기·칸 탭을 둔다", () => {
    const html = render();

    // 선택은 칸을 고르는 것이고 집중은 칸 머리의 버튼으로만 한다(머리의 배치 토글은 없앴다)
    expect(html).toContain("집중해서 보기");
    expect(html).toContain("모두에게 보내기");
    expect(html).toContain("바뀐 파일");
    expect(html).toContain("미리보기");
    expect(html).toContain("세션 화면");
    expect(html).toContain("빼기");
    // 백엔드 이름을 칸 머리에 보여준다
    expect(html).toContain("Claude API");
  });

  it("검증을 통과한(대기 중) 칸은 '검증 통과'로, 실패한 칸은 강조 테두리로 보인다", () => {
    expect(render()).toContain("검증 통과");
    expect(render({ status: "failed" })).toContain("ring-fail");
  });

  it("고른 칸의 결과를 오른쪽 결과 칸에 보인다(넓은 화면)", () => {
    const html = render();

    expect(html).toContain("선택한 칸의 결과");
    expect(html).toContain("세션 화면 열기");
    expect(html).toContain(`/sessions/s1`);
    // 고른 칸은 테두리로 표시한다
    expect(html).toContain("outline-ink");
  });
});

describe("터미널 세션 칸(B4)", () => {
  it("터미널 세션 칸은 대화 탭·입력창 없이 터미널과 활동 줄을 그린다", () => {
    const html = render({ terminal: true, terminalMode: "host" });

    // 위쪽 "모두에게 보내기" 입력창 하나뿐이다(칸의 대화 입력창이 없다)
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).not.toContain("이 세션에 보낼 요청");
    expect(html).not.toContain("읽기만");
    // 터미널과 활동 줄이 있다
    expect(html).toContain('aria-label="터미널"');
    expect(html).toContain("터미널에서 요청을 보내면 턴이 끝날 때 검증하고");
    // 세션 화면으로 가는 길은 남는다
    expect(html).toContain("세션 화면");
  });

  it("터미널이 아닌 칸은 지금 그대로(탭·입력창) 남는다", () => {
    const html = render();

    expect(html.match(/<textarea/g)).toHaveLength(2);
    expect(html).toContain(">대화<");
    expect(html).toContain("이 세션에 보낼 요청");
  });

  it("터미널 세션이 있고 칸이 4개 미만이면 '+ 새 터미널'이 있다", () => {
    expect(render({ terminal: true, terminalMode: "host" })).toContain("+ 새 터미널");
  });

  it("터미널 세션이 하나도 없으면 '+ 새 터미널'이 없다", () => {
    expect(render()).not.toContain("+ 새 터미널");
  });

  it("칸이 4개면 '+ 새 터미널'이 없다", () => {
    const panes = ["s1", "s2", "s3", "s4"].map((id) => ({ ...terminal, id }));
    expect(renderPanes(...panes)).not.toContain("+ 새 터미널");
  });
});
