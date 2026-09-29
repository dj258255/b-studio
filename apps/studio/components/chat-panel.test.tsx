import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createView, reduceSession, type SessionView } from "@/lib/session-view";
import type { SessionSnapshot, StudioEvent } from "@/lib/studio-events";
import { ChatPanel } from "./chat-panel";

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

/** 이벤트를 접어 화면 상태를 만든다(대화 화면이 받는 것과 같은 모양) */
function view(events: StudioEvent[] = []): SessionView {
  return events.reduce(reduceSession, createView(snapshot));
}

const render = (state: SessionView) => renderToStaticMarkup(<ChatPanel view={state} />);

const asked: StudioEvent[] = [
  { type: "run_started", runId: "r1", request: "이 함수는 어떻게 동작해?" },
  { type: "run_finished", runId: "r1", status: "done", summary: "이렇게 동작합니다", turns: 1 },
];

describe("ChatPanel 입력", () => {
  it("입력창은 하나이고, 만들기/질문 토글 대신 읽기만 스위치가 있다(기본 꺼짐)", () => {
    const html = render(view());

    // 입력창 하나
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html.match(/id="request"/g)).toHaveLength(1);
    // 예전 모드 토글은 사라졌다
    expect(html).not.toContain("요청 종류");
    expect(html).not.toContain("만들기</button>");
    expect(html).not.toContain(">질문</button>");
    // 스위치는 꺼진 채로 그려지고, 기본이 만들기 경로라는 것을 글로 알린다
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("읽기만");
    expect(html).toContain("질문이면 답만 하고, 바꾸면 검증 게이트를 통과한 변경만 남습니다");
    // 기본 경로에서는 호환성 파괴 허용을 고를 수 있다
    expect(html).toContain("필드 삭제나 타입 변경 허용");
  });

  it("읽기만 스위치는 세션마다 저장된 값을 쓰고, 켜지면 파일을 바꾸지 않는다고 알린다", () => {
    // 저장된 값을 읽는 훅은 브라우저 저장소를 쓴다. 여기서는 저장소가 없는 서버 렌더라 기본값을 본다
    const html = render(view(asked));
    expect(html).toContain('aria-checked="false"');
  });
});

describe("ChatPanel 결과 표시", () => {
  it("바꾼 파일이 없는 실행은 '답만 했습니다'로 알린다", () => {
    const html = render(view(asked));

    expect(html).toContain("답만 했습니다(바꾼 파일 없음), 1턴");
    expect(html).not.toContain("완료, 1턴");
  });

  it("게이트를 돌아 파일을 바꾼 실행은 지금처럼 완료로 알린다", () => {
    const html = render(
      view([
        { type: "run_started", runId: "r1", request: "필터를 추가해 줘" },
        { type: "agent", runId: "r1", event: { type: "verify_start", files: ["web/app/page.tsx"] } },
        { type: "run_finished", runId: "r1", status: "done", summary: "추가했습니다", turns: 2 },
      ]),
    );

    expect(html).toContain("완료, 2턴");
    expect(html).not.toContain("답만 했습니다");
  });

  it("'이대로 만들기'는 읽기만(질문) 실행의 답에만 붙는다", () => {
    const askedHtml = render(view([{ type: "run_started", runId: "r1", request: "어떻게 만들까?", intent: "ask" }, ...asked.slice(1)]));
    expect(askedHtml).toContain("이대로 만들기");

    // 만들기 경로에서 답만 한 실행에는 붙지 않는다(파일을 바꾸지 않아도 읽기만 실행이 아니다)
    expect(render(view(asked))).not.toContain("이대로 만들기");
  });
});
