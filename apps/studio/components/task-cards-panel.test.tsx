// @vitest-environment happy-dom
/**
 * 나란히 보기 왼쪽 칸의 "작업 카드" 편집기와 계획 진행 보기(#B6b)를 본다.
 * 마크업만이 아니라 타이핑·디바운스·폴링까지 봐야 해서 실제 DOM에 올려(happy-dom) act로 업데이트한다.
 */
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentUsage } from "@b-studio/agent";
import type { ProjectSummary } from "@/lib/studio-events";
import type { TaskPlanView } from "@/lib/task-plan-types";
import {
  CARDS_STORAGE_KEY,
  cardsPayload,
  clearStoredCards,
  doneCommandHint,
  lanePreviewText,
  planUsageLine,
  readStoredCards,
  selectedService,
  splitPaths,
  taskUsageLine,
  TaskCardsEditor,
  TaskPlanProgress,
  writeStoredCards,
  type TaskCardDraft,
} from "./task-cards-panel";

const mocks = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
// act()를 쓰려면 React에 이 환경이 act를 지원한다고 알려야 한다(다른 DOM 컴포넌트 테스트와 같은 처리)
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push, replace: mocks.replace }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: unknown; children?: ReactNode }) => <a href={typeof href === "string" ? href : "#"}>{children}</a>,
}));

const usage = (input: number, output: number): AgentUsage => ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 });

const projects: ProjectSummary[] = [{ id: "orders", name: "orders", services: [] }];
const services: Record<string, string[]> = { orders: ["web"] };

let mounted: { root: Root; container: HTMLElement } | undefined;

function mount(element: ReactElement): HTMLElement {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  act(() => root.render(element));
  mounted = { root, container };
  return container;
}

/** React가 추적하는 value 세터를 거쳐야 실제 타이핑처럼 onChange가 울린다 */
function setValue(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

/** 라벨 글자로 그 안의 입력칸을 찾는다 */
function field(container: HTMLElement, labelText: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const label = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent?.includes(labelText));
  const element = label?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select");
  if (!element) throw new Error(`입력칸을 찾지 못했습니다: ${labelText}`);
  return element;
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (!found) throw new Error(`버튼을 찾지 못했습니다: ${text}`);
  return found;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function editor(over: { limits?: { maxTasks: number } } = {}): ReactElement {
  return <TaskCardsEditor projects={projects} limits={over.limits ?? { maxTasks: 3 }} services={services} />;
}

function fill(container: HTMLElement, { title = "카드1", request = "작업", paths = "web/a" } = {}): void {
  setValue(field(container, "제목"), title);
  setValue(field(container, "할 일"), request);
  setValue(field(container, "쓸 수 있는 경로"), paths);
}

beforeEach(() => {
  mocks.push.mockClear();
  mocks.replace.mockClear();
  window.localStorage.clear();
});

afterEach(() => {
  if (mounted) act(() => mounted!.root.unmount());
  mounted?.container.remove();
  mounted = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("splitPaths / cardsPayload", () => {
  it("경로를 줄바꿈·쉼표로 나누고 앞뒤 빈칸과 빈 항목을 뺀다", () => {
    expect(splitPaths("web/a\nweb/b")).toEqual(["web/a", "web/b"]);
    expect(splitPaths("web/a, web/b ,,")).toEqual(["web/a", "web/b"]);
    expect(splitPaths("  \n , ")).toEqual([]);
  });

  it("완료 명령이 있으면 서비스를 싣되, 지금 목록에 있는 이름만 쓴다(옛 서비스는 비워 보낸다)", () => {
    const cards: TaskCardDraft[] = [
      { key: 1, title: "A", request: "일", paths: "web/a,\nweb/b", doneCommand: "", doneService: "" },
      { key: 2, title: "B", request: "일", paths: "web/c", doneCommand: "pnpm test", doneService: "" },
      { key: 3, title: "C", request: "일", paths: "web/d", doneCommand: "pnpm test", doneService: "api" },
      { key: 4, title: "D", request: "일", paths: "web/e", doneCommand: "pnpm test", doneService: "web" },
    ];

    expect(cardsPayload(cards, ["web"])).toEqual([
      { title: "A", request: "일", paths: ["web/a", "web/b"] },
      { title: "B", request: "일", paths: ["web/c"], doneCommand: "pnpm test" },
      { title: "C", request: "일", paths: ["web/d"], doneCommand: "pnpm test" },
      { title: "D", request: "일", paths: ["web/e"], doneCommand: "pnpm test", doneService: "web" },
    ]);
  });

  it("selectedService: 고른 값이 목록에 없으면 첫 서비스를 보인다", () => {
    expect(selectedService("api", ["web", "api"])).toBe("api");
    expect(selectedService("옛서비스", ["web"])).toBe("web");
    expect(selectedService("", ["web"])).toBe("web");
    expect(selectedService("", [])).toBe("");
  });

  it("doneCommandHint: 서비스가 있으면 그 컨테이너의 작업 폴더에서 돈다고, 없으면 못 돈다고 알린다", () => {
    expect(doneCommandHint("backend")).toBe("backend 컨테이너의 작업 폴더에서 돕니다(저장소 루트가 아닐 수 있습니다)");
    expect(doneCommandHint("")).toBe("서비스가 없어 완료 명령을 돌릴 수 없습니다");
  });
});

describe("lanePreviewText", () => {
  it("레인 미리보기를 한 줄로 만든다", () => {
    const lanes = [
      { id: "lane-1", cards: [{ id: "card-1", title: "카드1" }, { id: "card-3", title: "카드3" }], paths: ["web/a"] },
      { id: "lane-2", cards: [{ id: "card-2", title: "카드2" }], paths: ["web/b"] },
    ];

    expect(lanePreviewText(lanes)).toBe("레인 2개 · 동시에 · 레인 1: 카드 1 → 카드 3(경로가 겹쳐 순서대로) · 레인 2: 카드 2");
  });
});

describe("planUsageLine / taskUsageLine", () => {
  const taskRun = (over: Record<string, unknown> = {}) => ({ status: "done", durationMs: 1_000, usage: usage(100, 10), ...over });

  it("비용이 오지 않았으면 비용 칸을 그리지 않고, 토큰은 보여 준다", () => {
    const noCost = summarize([taskRun()]);
    expect(planUsageLine(noCost)).toContain("토큰");
    expect(planUsageLine(noCost)).not.toContain("$");

    const withCost = summarize([taskRun({ costUsd: 0.5 })]);
    expect(planUsageLine(withCost)).toContain("$0.50");

    // 실행 기록이 하나도 없으면 줄 자체가 없다
    expect(planUsageLine(plan({ lanes: [] }))).toBeUndefined();
  });

  it("작업 한 줄은 task.run이 없으면 없다", () => {
    expect(taskUsageLine(undefined)).toBeUndefined();
    expect(taskUsageLine({ status: "done", usage: usage(50, 5), durationMs: 500 })).toContain("토큰");
  });

  function plan(over: Partial<TaskPlanView> = {}): TaskPlanView {
    return { id: "plan-1", owner: "kim", projectId: "orders", request: "요청", modelId: "terminal", status: "done", createdAt: "", lanes: [], ...over };
  }
  function summarize(runs: Array<ReturnType<typeof taskRun>>): TaskPlanView {
    return plan({
      lanes: [
        {
          id: "lane-1",
          paths: ["web/a"],
          status: "done",
          tasks: runs.map((run, index) => ({ id: `card-${index + 1}`, title: "카드", request: "일", paths: ["web/a"], dependsOn: [], status: "done", run })),
        },
      ],
    });
  }
});

describe("카드 초안 저장소", () => {
  it("접근이 실패해도 던지지 않고, 손상된 값은 없는 것으로 본다", () => {
    const broken = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    };
    expect(readStoredCards(broken)).toBeUndefined();
    expect(() => writeStoredCards(broken, [])).not.toThrow();
    expect(() => clearStoredCards(broken)).not.toThrow();
    expect(readStoredCards({ getItem: () => "그냥 글" })).toBeUndefined();
    expect(readStoredCards(undefined)).toBeUndefined();
  });

  it("카드 초안을 저장하고 다시 읽고, 지우면 없어진다", () => {
    const store = new Map<string, string>();
    const fake = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };

    writeStoredCards(fake, [{ key: 1, title: "A", request: "일", paths: "web/a", doneCommand: "", doneService: "" }]);
    expect(store.has(CARDS_STORAGE_KEY)).toBe(true);
    expect(readStoredCards(fake)).toEqual([{ key: 1, title: "A", request: "일", paths: "web/a", doneCommand: "", doneService: "" }]);

    clearStoredCards(fake);
    expect(readStoredCards(fake)).toBeUndefined();
  });
});

describe("TaskCardsEditor", () => {
  it("카드를 더하고, 상한에서 더하기가 막히며, 빼기로 줄인다", () => {
    const container = mount(editor({ limits: { maxTasks: 2 } }));

    expect(container.querySelectorAll("fieldset")).toHaveLength(1);
    act(() => button(container, "카드 더하기").click());
    expect(container.querySelectorAll("fieldset")).toHaveLength(2);
    expect(button(container, "카드 더하기").disabled).toBe(true);
    act(() => button(container, "빼기").click());
    expect(container.querySelectorAll("fieldset")).toHaveLength(1);
  });

  it("카드를 채우면 400ms 뒤 미리보기를 요청하고, 본문에 다듬은 카드를 담는다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ lanes: [{ id: "lane-1", cards: [{ id: "card-1", title: "카드1" }], paths: ["web/a", "web/b"] }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const container = mount(editor());

    fill(container, { paths: "web/a, web/b" });
    // 입력이 멈추기 전에는 부르지 않는다
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(400); });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/task-plans/preview");
    expect(JSON.parse(init.body as string)).toEqual({ projectId: "orders", cards: [{ title: "카드1", request: "작업", paths: ["web/a", "web/b"] }] });
    expect(container.textContent).toContain("레인 1개");
  });

  it("미리보기가 오류면 서버 문구를 보이고 실행을 막는다", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "병렬 레인의 쓰기 범위가 겹칩니다" }) })));
    const container = mount(editor());

    fill(container);
    await act(async () => { vi.advanceTimersByTime(400); });
    await flush();

    expect(container.textContent).toContain("병렬 레인의 쓰기 범위가 겹칩니다");
    expect(button(container, "실행").disabled).toBe(true);
  });

  it("실행에 성공하면 계획 id로 /split?plan=…으로 가고 저장해 둔 카드를 지운다", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/preview")
          ? { ok: true, json: async () => ({ lanes: [{ id: "lane-1", cards: [{ id: "card-1", title: "카드1" }], paths: ["web/a"] }] }) }
          : { ok: true, json: async () => ({ id: "plan-9" }) },
      ),
    );
    const container = mount(editor());

    fill(container);
    await act(async () => { vi.advanceTimersByTime(400); });
    await flush();

    await act(async () => { button(container, "실행").click(); });
    await flush();

    expect(mocks.push).toHaveBeenCalledWith("/split?plan=plan-9");
    expect(window.localStorage.getItem(CARDS_STORAGE_KEY)).toBeNull();
  });

  it("실행이 실패하면 서버 문구를 보이고 이동하지 않는다", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/preview")
          ? { ok: true, json: async () => ({ lanes: [{ id: "lane-1", cards: [{ id: "card-1", title: "카드1" }], paths: ["web/a"] }] }) }
          : { ok: false, json: async () => ({ error: "작업 카드 형식이 올바르지 않습니다" }) },
      ),
    );
    const container = mount(editor());

    fill(container);
    await act(async () => { vi.advanceTimersByTime(400); });
    await flush();

    await act(async () => { button(container, "실행").click(); });
    await flush();

    expect(container.textContent).toContain("작업 카드 형식이 올바르지 않습니다");
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("미리보기가 오기 전(디바운스 중)에는 실행을 켜지 않고, 성공하면 켠다", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ lanes: [{ id: "lane-1", cards: [{ id: "card-1", title: "카드1" }], paths: ["web/a"] }] }) })));
    const container = mount(editor());

    fill(container);
    // 아직 미리보기 응답이 없다 → 실행 꺼짐
    expect(button(container, "실행").disabled).toBe(true);

    await act(async () => { vi.advanceTimersByTime(400); });
    await flush();
    expect(button(container, "실행").disabled).toBe(false);
  });

  it("카드를 고치면 새 미리보기가 올 때까지 실행이 꺼진다", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ lanes: [{ id: "lane-1", cards: [{ id: "card-1", title: "카드1" }], paths: ["web/a"] }] }) })));
    const container = mount(editor());

    fill(container);
    await act(async () => { vi.advanceTimersByTime(400); });
    await flush();
    expect(button(container, "실행").disabled).toBe(false);

    // 제목을 고치면 받아 둔 미리보기는 옛 내용의 것이다 → 다시 꺼진다
    setValue(field(container, "제목"), "카드1 고침");
    expect(button(container, "실행").disabled).toBe(true);

    await act(async () => { vi.advanceTimersByTime(400); });
    await flush();
    expect(button(container, "실행").disabled).toBe(false);
  });

  it("미리보기가 성공해도 레인이 없으면 실행을 켜지 않는다", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ lanes: [] }) })));
    const container = mount(editor());

    fill(container);
    await act(async () => { vi.advanceTimersByTime(400); });
    await flush();

    expect(button(container, "실행").disabled).toBe(true);
  });

  it("미리보기 응답이 순서가 뒤바뀌어 와도 마지막 요청의 응답만 쓴다", async () => {
    vi.useFakeTimers();
    const pending: Array<(value: unknown) => void> = [];
    vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { pending.push(resolve); })));
    const container = mount(editor());

    fill(container);
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(pending).toHaveLength(1); // 요청 1(옛 내용) 발행

    setValue(field(container, "제목"), "카드1 고침");
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(pending).toHaveLength(2); // 요청 2(지금 내용) 발행

    // 마지막 요청(2)을 성공으로 먼저 채운다
    await act(async () => {
      pending[1]!({ ok: true, json: async () => ({ lanes: [{ id: "lane-1", cards: [{ id: "card-1", title: "카드1" }], paths: ["web/a"] }] }) });
    });
    await flush();
    // 옛 요청(1)이 늦게 오류로 와도 무시된다
    await act(async () => {
      pending[0]!({ ok: false, json: async () => ({ error: "옛 오류" }) });
    });
    await flush();

    expect(container.textContent).not.toContain("옛 오류");
    expect(button(container, "실행").disabled).toBe(false);
  });

  it("완료 명령을 채우면 그 서비스 컨테이너의 작업 폴더에서 돈다고 안내한다(저장소 루트가 아닐 수 있다)", () => {
    const container = mount(editor());

    setValue(field(container, "완료 조건 명령 (선택)"), "pnpm test");

    expect(container.textContent).toContain("web 컨테이너의 작업 폴더에서 돕니다(저장소 루트가 아닐 수 있습니다)");
  });

  it("완료 명령을 채웠는데 서비스가 없으면 못 돈다고 알린다", () => {
    const container = mount(<TaskCardsEditor projects={projects} limits={{ maxTasks: 3 }} services={{}} />);

    setValue(field(container, "완료 조건 명령 (선택)"), "pnpm test");

    expect(container.textContent).toContain("서비스가 없어 완료 명령을 돌릴 수 없습니다");
  });

  it("저장소 접근이 던져도 편집기는 그려진다", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    const container = mount(editor());

    expect(container.textContent).toContain("카드 더하기");
  });
});

describe("TaskPlanProgress", () => {
  const plan = (over: Partial<TaskPlanView> = {}): TaskPlanView => ({
    id: "plan-1",
    owner: "kim",
    projectId: "orders",
    request: "요청",
    modelId: "terminal",
    status: "running",
    createdAt: "",
    lanes: [],
    ...over,
  });

  const fetchPlan = (value: TaskPlanView) => vi.fn(async () => ({ ok: true, json: async () => value }));

  it("카드마다 상태 칩·레인·기다리는 이유·완료 명령·체크포인트를 보여 주고, 비용이 없으면 비용 칸을 그리지 않는다", async () => {
    const value = plan({
      lanes: [
        {
          id: "lane-1",
          sessionId: "s1",
          paths: ["web/a"],
          status: "running",
          waiting: "터미널의 claude가 뜨기를 기다립니다",
          tasks: [
            {
              id: "card-1",
              title: "카드1",
              request: "일",
              paths: ["web/a"],
              dependsOn: [],
              status: "running",
              doneCommand: "pnpm test",
              doneService: "web",
              run: { status: "done", durationMs: 1_000, usage: usage(100, 10) },
              checkpoint: { sha: "abcdef", shortSha: "abcdefg", files: [] },
            },
          ],
        },
      ],
    });
    vi.stubGlobal("fetch", fetchPlan(value));
    const container = mount(<TaskPlanProgress planId="plan-1" onSelectSession={() => {}} />);

    await flush();

    expect(container.textContent).toContain("도는 중");
    expect(container.textContent).toContain("터미널의 claude가 뜨기를 기다립니다");
    expect(container.textContent).toContain("완료 pnpm test");
    expect(container.textContent).toContain("abcdefg");
    expect(container.textContent).toContain("토큰");
    // 비용이 오지 않았으면 비용 칸($)을 그리지 않는다
    expect(container.textContent).not.toContain("$");
  });

  it("비용이 오면 계획 합계에 비용을 보여 준다", async () => {
    const value = plan({
      status: "done",
      lanes: [
        {
          id: "lane-1",
          sessionId: "s1",
          paths: ["web/a"],
          status: "done",
          tasks: [{ id: "card-1", title: "카드1", request: "일", paths: ["web/a"], dependsOn: [], status: "done", run: { status: "done", durationMs: 1_000, usage: usage(100, 10), costUsd: 0.5 } }],
        },
      ],
    });
    vi.stubGlobal("fetch", fetchPlan(value));
    const container = mount(<TaskPlanProgress planId="plan-1" onSelectSession={() => {}} />);

    await flush();

    expect(container.textContent).toContain("$0.50");
  });

  it("끝난 계획이면 더 부르지 않는다", async () => {
    vi.useFakeTimers();
    const fetchMock = fetchPlan(plan({ status: "done" }));
    vi.stubGlobal("fetch", fetchMock);
    mount(<TaskPlanProgress planId="plan-1" onSelectSession={() => {}} />);

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { vi.advanceTimersByTime(10_000); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("카드를 누르면 그 레인 세션을 고르라고 알린다", async () => {
    const onSelect = vi.fn();
    const value = plan({
      lanes: [
        {
          id: "lane-1",
          sessionId: "s1",
          paths: ["web/a"],
          status: "running",
          tasks: [{ id: "card-1", title: "카드1", request: "일", paths: ["web/a"], dependsOn: [], status: "running" }],
        },
      ],
    });
    vi.stubGlobal("fetch", fetchPlan(value));
    const container = mount(<TaskPlanProgress planId="plan-1" onSelectSession={onSelect} />);

    await flush();
    await act(async () => { button(container, "카드1").click(); });

    expect(onSelect).toHaveBeenCalledWith("s1");
  });

  it("실패한 계획은 '실패'로 보인다('중단됨'이 아니다)", async () => {
    vi.stubGlobal("fetch", fetchPlan(plan({ status: "failed" })));
    const container = mount(<TaskPlanProgress planId="plan-1" onSelectSession={() => {}} />);

    await flush();

    expect(container.textContent).toContain("실패");
    expect(container.textContent).not.toContain("중단됨");
  });

  it("403·404면 멈추고 사유를 보인다(다시 시도하지 않는다)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({ error: "이 작업 계획을 볼 수 없습니다" }) }));
    vi.stubGlobal("fetch", fetchMock);
    const container = mount(<TaskPlanProgress planId="plan-1" onSelectSession={() => {}} />);

    await flush();
    expect(container.textContent).toContain("이 작업 계획을 볼 수 없습니다");

    await act(async () => { vi.advanceTimersByTime(60_000); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5xx면 '다시 연결하는 중'을 보이고 시간을 늘려 다시 시도한다, 성공하면 이어서 돈다", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const value = plan({ status: "running" });
    const fetchMock = vi.fn(async () => (++calls === 1 ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => value }));
    vi.stubGlobal("fetch", fetchMock);
    const container = mount(<TaskPlanProgress planId="plan-1" onSelectSession={() => {}} />);

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("다시 연결하는 중");

    // 첫 실패는 2초 뒤에 다시 시도한다
    await act(async () => { vi.advanceTimersByTime(2_000); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("다시 연결하는 중");
  });

  it("숨겨져 있으면 부르지 않고, 다시 보이면 시작한다", async () => {
    vi.useFakeTimers();
    let hidden = true;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    const fetchMock = fetchPlan(plan({ status: "running" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      mount(<TaskPlanProgress planId="plan-1" onSelectSession={() => {}} />);

      await flush();
      // 숨겨져 있으면 부르지 않는다(예약하지도 않는다)
      expect(fetchMock).not.toHaveBeenCalled();

      // 보이면 visibilitychange로 다시 시작한다
      hidden = false;
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      delete (document as unknown as { hidden?: boolean }).hidden;
    }
  });

  it("언마운트하면 타이머를 풀어 더 부르지 않는다", async () => {
    vi.useFakeTimers();
    const fetchMock = fetchPlan(plan({ status: "running" }));
    vi.stubGlobal("fetch", fetchMock);
    mount(<TaskPlanProgress planId="plan-1" onSelectSession={() => {}} />);

    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => mounted!.root.unmount());
    mounted = undefined;

    await act(async () => { vi.advanceTimersByTime(60_000); });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
