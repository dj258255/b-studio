// @vitest-environment happy-dom
/**
 * 나란히 보기의 터미널 출력 공급자(B4). 칸마다 통로를 열지 않고 하나의 묶음 통로에서 받아 id별로 나눈다.
 * 그 밖(공급자 없이)에서는 패널이 자기 통로를 여는지도 함께 본다 — 그래야 세션 화면의 터미널이 그대로 돈다.
 */
import { act, useEffect, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPanel } from "./terminal-panel";
import { TerminalStreamProvider, useTerminalStream, type TerminalStreamMessage } from "./terminal-stream";

// React가 act로 감싼 갱신을 시험 환경으로 알아보게 한다(없으면 경고를 찍는다)
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// xterm은 브라우저에서만 도는 모듈이라 가짜로 둔다(패널은 이 테스트의 대상이 아니다)
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    loadAddon(): void {}
    open(): void {}
    write(): void {}
    reset(): void {}
    focus(): void {}
    paste(): void {}
    dispose(): void {}
    onData(): { dispose(): void } {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} } }));

/** 가짜 EventSource. 테스트가 직접 열고, 메시지를 밀어 넣고, 닫힘을 확인한다 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  open(): void {
    this.onopen?.();
  }
  emit(id: string, message: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ id, message }) });
  }
}

/** 구독한 메시지를 모으는 시험용 구독자. show가 거짓이면 마운트만 되고 아직 구독하지 않는다 */
function Consumer({ id, received, show = true }: { id: string; received: TerminalStreamMessage[]; show?: boolean }) {
  const subscribe = useTerminalStream(id);
  useEffect(() => {
    if (!show || !subscribe) return;
    return subscribe((message) => {
      received.push(message);
    });
  }, [subscribe, received, show]);
  return <p>{id}</p>;
}

let roots: Root[] = [];

function mount(element: ReactElement): Root {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  roots.push(root);
  return root;
}

/** 동적 import와 마이크로태스크가 끝나게 한 번 돌린다 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })));
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("터미널 출력 공급자(B4)", () => {
  it("묶음 통로 하나를 열고 메시지를 id별로 나눈다", () => {
    const a: TerminalStreamMessage[] = [];
    const b: TerminalStreamMessage[] = [];
    mount(
      <TerminalStreamProvider ids={["a", "b"]}>
        <Consumer id="a" received={a} />
        <Consumer id="b" received={b} />
      </TerminalStreamProvider>,
    );

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe("/api/terminals/stream?ids=a%2Cb");

    act(() => source.emit("a", { kind: "data", data: "hello" }));
    expect(a).toEqual([{ kind: "data", data: "hello" }]);
    expect(b).toEqual([]);

    act(() => source.emit("b", { kind: "status", state: "open" }));
    expect(b).toEqual([{ kind: "status", state: "open" }]);
  });

  it("다시 연결하면 칸에 화면을 비우라는 신호를 보낸다", () => {
    const a: TerminalStreamMessage[] = [];
    mount(
      <TerminalStreamProvider ids={["a"]}>
        <Consumer id="a" received={a} />
      </TerminalStreamProvider>,
    );
    act(() => FakeEventSource.instances[0]!.open());
    expect(a).toEqual([{ kind: "reset" }]);
  });

  it("ids가 바뀌면 통로를 다시 열고 이전 연결을 닫는다", () => {
    const a: TerminalStreamMessage[] = [];
    const b: TerminalStreamMessage[] = [];
    const root = mount(
      <TerminalStreamProvider ids={["a"]}>
        <Consumer id="a" received={a} />
      </TerminalStreamProvider>,
    );
    const first = FakeEventSource.instances[0]!;

    act(() =>
      root.render(
        <TerminalStreamProvider ids={["a", "b"]}>
          <Consumer id="a" received={a} />
          <Consumer id="b" received={b} />
        </TerminalStreamProvider>,
      ),
    );

    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1]!.url).toBe("/api/terminals/stream?ids=a%2Cb");
  });

  it('구독 전에 온 출력·상태·cli를 늦게 구독한 칸이 먼저 받는다', () => {
    const received: TerminalStreamMessage[] = [];
    const root = mount(
      <TerminalStreamProvider ids={["a"]}>
        <Consumer id="a" received={received} show={false} />
      </TerminalStreamProvider>,
    );
    const source = FakeEventSource.instances[0]!;
    act(() => {
      source.emit("a", { kind: "data", data: "early" });
      source.emit("a", { kind: "status", state: "open" });
      source.emit("a", { kind: "cli", alive: true });
    });
    // 아직 구독 전이라 아무것도 받지 못한다
    expect(received).toEqual([]);

    act(() =>
      root.render(
        <TerminalStreamProvider ids={["a"]}>
          <Consumer id="a" received={received} show={true} />
        </TerminalStreamProvider>,
      ),
    );
    // 늦게 붙었어도 되보내기 몫을 서버와 같은 순서(출력 → 상태 → cli)로 먼저 받는다
    expect(received).toEqual([
      { kind: "data", data: "early" },
      { kind: "status", state: "open" },
      { kind: "cli", alive: true },
    ]);
  });

  it('되보내기 몫이 상한(512KB)을 넘으면 앞에서부터 버린다', () => {
    const received: TerminalStreamMessage[] = [];
    const root = mount(
      <TerminalStreamProvider ids={["a"]}>
        <Consumer id="a" received={received} show={false} />
      </TerminalStreamProvider>,
    );
    const source = FakeEventSource.instances[0]!;
    const early = "a".repeat(400_000);
    const late = "b".repeat(400_000);
    act(() => {
      source.emit("a", { kind: "data", data: early });
      source.emit("a", { kind: "data", data: late });
    });
    act(() =>
      root.render(
        <TerminalStreamProvider ids={["a"]}>
          <Consumer id="a" received={received} show={true} />
        </TerminalStreamProvider>,
      ),
    );
    // 앞의 조각은 상한을 넘겨 버려지고 마지막 조각만 남는다
    expect(received.filter((message) => message.kind === "data")).toEqual([{ kind: "data", data: late }]);
  });

  it('다시 연결(reset) 뒤에는 그 전의 되보내기 몫을 주지 않는다', () => {
    const received: TerminalStreamMessage[] = [];
    const root = mount(
      <TerminalStreamProvider ids={["a"]}>
        <Consumer id="a" received={received} show={false} />
      </TerminalStreamProvider>,
    );
    const source = FakeEventSource.instances[0]!;
    act(() => {
      source.emit("a", { kind: "data", data: "old" });
      source.open();
      source.emit("a", { kind: "data", data: "new" });
    });
    act(() =>
      root.render(
        <TerminalStreamProvider ids={["a"]}>
          <Consumer id="a" received={received} show={true} />
        </TerminalStreamProvider>,
      ),
    );
    expect(received).toEqual([{ kind: "data", data: "new" }]);
  });

  it("공급자 밖의 TerminalPanel은 자기 통로를 연다", async () => {
    mount(<TerminalPanel sessionId="s1" ready={true} />);
    await flush();

    expect(FakeEventSource.instances.some((source) => source.url === "/api/sessions/s1/terminal")).toBe(true);
    expect(FakeEventSource.instances.some((source) => source.url.startsWith("/api/terminals/stream"))).toBe(false);
  });
});
