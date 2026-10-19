// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "@/lib/studio-events";
import type { TaskPlanLaneView, TaskPlanView } from "@/lib/task-plan-types";
import { SplitPicker, SplitView, laneRefreshSignature, type SplitCardsEditor } from "./split-view";

// act()를 쓰려면 React에 이 환경이 act를 지원한다고 알려야 한다(다른 DOM 컴포넌트 테스트와 같은 처리)
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// 칸을 닫을 때·새 레인 세션이 생겼을 때 쓰는 라우터는 서버 렌더에 컨텍스트가 없다. 빈 구현으로 바꾼다(refresh는 스파이)
const router = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: router.push, replace: router.replace, refresh: router.refresh }) }));
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

const cardsEditor: SplitCardsEditor = {
  terminalAllowed: true,
  projects: [{ id: "orders", name: "orders", services: [] }],
  defaultProjectId: "orders",
  limits: { maxTasks: 3 },
  services: { orders: ["web"] },
};

const plan: TaskPlanView = {
  id: "plan-1",
  owner: "kim",
  projectId: "orders",
  request: "요청",
  modelId: "terminal",
  status: "running",
  createdAt: "",
  lanes: [
    {
      id: "lane-1",
      sessionId: "s1",
      paths: ["web/a"],
      status: "running",
      tasks: [{ id: "card-1", title: "카드1", request: "일", paths: ["web/a"], dependsOn: [], status: "running", run: { status: "done", durationMs: 1_000, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } } }],
    },
  ],
};

let mounted: { root: Root; container: HTMLElement } | undefined;

function mount(element: ReactElement): HTMLElement {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  act(() => root.render(element));
  mounted = { root, container };
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** 900px 미만(좁은 화면)을 흉내 낸다. use-narrow가 window.matchMedia를 본다 */
function stubNarrow(narrow: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: narrow && query.includes("899"),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  router.push.mockClear();
  router.replace.mockClear();
  router.refresh.mockClear();
  // 테스트마다 넓은 화면에서 시작한다(좁은 화면 테스트만 직접 흉내 낸다)
  stubNarrow(false);
  // 마운트하며 부르는 배경 fetch(플릿·계획 폴링)가 실제 네트워크를 타지 않게 막는다
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
});

afterEach(() => {
  if (mounted) act(() => mounted!.root.unmount());
  mounted?.container.remove();
  mounted = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

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

describe("나란히 보기 왼쪽 칸(#B6b)", () => {
  it("계획이 있으면 왼쪽에 진행 보기를 둔다", () => {
    const html = renderToStaticMarkup(<SplitView panes={[{ id: "s1", snapshot }]} plan={plan} cardsEditor={cardsEditor} />);

    expect(html).toContain('aria-label="계획 진행"');
    // 진행 보기는 서버가 준 계획을 곧바로 그리고, 첫 폴링 전에는 불러오는 중이다
    expect(html).toContain("계획을 불러오는 중");
    // 계획이 있으면 편집기 버튼은 두지 않는다(진행 보기가 그 자리를 쓴다)
    expect(html).not.toContain(">작업 카드<");
  });

  it("계획이 없으면 편집기는 접힌 채고, 머리의 '작업 카드' 버튼으로 연다", () => {
    const html = renderToStaticMarkup(<SplitView panes={[{ id: "s1", snapshot }]} cardsEditor={cardsEditor} />);

    // 접힘이 기본이라 편집기 내용은 왼쪽 칸에 없다
    expect(html).toContain("작업 카드");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-label="작업 카드"');
    expect(html).not.toContain("카드 더하기");
  });

  it("레인 세션이 아직 없으면(만드는 중) 격자 자리에 빈 상태를 보인다", () => {
    const html = renderToStaticMarkup(<SplitView panes={[]} plan={plan} cardsEditor={cardsEditor} />);

    expect(html).toContain("레인 세션을 만드는 중입니다");
  });

  it("좁은 화면(<900px)에서는 왼쪽 칸도 '작업 카드' 버튼도 그리지 않는다", () => {
    stubNarrow(true);
    const container = mount(<SplitView panes={[]} cardsEditor={cardsEditor} />);

    expect(container.querySelector('[aria-label="작업 카드"]')).toBeNull();
    expect(container.textContent).not.toContain("작업 카드");
  });

  it("넓은 화면에서 '작업 카드' 버튼을 누르면 왼쪽에 편집기가 열린다", () => {
    const container = mount(<SplitView panes={[]} cardsEditor={cardsEditor} />);

    expect(container.textContent).not.toContain("카드 더하기");
    const toggle = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("작업 카드"))!;
    act(() => toggle.click());

    expect(container.querySelector('[aria-label="작업 카드"]')).not.toBeNull();
    expect(container.textContent).toContain("카드 더하기");
  });

  it("터미널을 쓸 수 없으면 편집기 대신 안내 한 줄을 보인다(세션 고르기 화면)", () => {
    const html = renderToStaticMarkup(<SplitPicker sessions={[]} cardsEditor={{ ...cardsEditor, terminalAllowed: false }} />);

    expect(html).toContain("작업 카드는 세션 터미널을 쓸 수 있을 때 씁니다");
    expect(html).not.toContain("카드 더하기");
  });

  it("세션 고르기 화면의 안내는 터미널 세션 설명을 쓴다(#B6b 수정 2-4)", () => {
    const html = renderToStaticMarkup(<SplitPicker sessions={[]} cardsEditor={cardsEditor} />);

    expect(html).toContain("터미널 세션은 칸마다 터미널로 열립니다. 위의 작업 카드로 일을 나눠 맡길 수도 있습니다.");
    expect(html).not.toContain("칸마다 대화를 보고 요청을 보낼 수 있습니다");
  });
});

describe("새 레인 세션 감지 — 서버를 다시 부른다(#B6b 수정 3)", () => {
  it("laneRefreshSignature: 새 세션이 없거나 같은 집합이면 갱신하지 않고, 레인이 하나 더 생기면 다시 갱신한다", () => {
    expect(laneRefreshSignature([], [], undefined)).toBeUndefined();
    // 레인 s1이 생김 → 갱신
    expect(laneRefreshSignature([], ["s1"], undefined)).toBe("s1");
    // 서버가 ids를 다시 계산해 s1이 칸에 들어옴: 같은 집합이면 되풀이하지 않는다
    expect(laneRefreshSignature(["s1"], ["s1"], "s1")).toBeUndefined();
    // 레인 s2가 또 생김 → 서명이 달라져 다시 갱신
    expect(laneRefreshSignature(["s1"], ["s1", "s2"], "s1")).toBe("s1,s2");
    // 둘 다 칸에 있으면 멈춘다
    expect(laneRefreshSignature(["s1", "s2"], ["s1", "s2"], "s1,s2")).toBeUndefined();
  });

  it("레인 세션이 하나씩 두 번 생기면 서버를 두 번 다시 부른다(refresh)", async () => {
    vi.useFakeTimers();
    const lane = (id: string, sessionId: string): TaskPlanLaneView => ({ id, sessionId, paths: ["web/a"], status: "running", tasks: [] });
    const planOne: TaskPlanView = { ...plan, lanes: [lane("lane-1", "s1")] };
    const planTwo: TaskPlanView = { ...plan, lanes: [lane("lane-1", "s1"), lane("lane-2", "s2")] };
    const responses = [planOne, planTwo];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/fleets")
          ? { ok: true, json: async () => [] }
          : { ok: true, status: 200, json: async () => responses[Math.min(calls++, responses.length - 1)] },
      ),
    );

    mount(<SplitView panes={[]} plan={plan} cardsEditor={cardsEditor} />);
    await flush();
    // 첫 폴링: s1만 있다 → 갱신 1회
    expect(router.refresh).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(2_000); });
    await flush();
    // 두 번째 폴링: s2가 더 생겼다 → 갱신 2회
    expect(router.refresh).toHaveBeenCalledTimes(2);

    await act(async () => { vi.advanceTimersByTime(2_000); });
    await flush();
    // 같은 세션 집합으로는 되풀이하지 않는다
    expect(router.refresh).toHaveBeenCalledTimes(2);
  });
});
