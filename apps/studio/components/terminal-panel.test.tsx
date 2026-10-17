// @vitest-environment happy-dom
/**
 * 다시 보낸 터미널 출력에 xterm이 자동으로 답한 값이 입력으로 POST되어 셸에 글자가 들어가는 것을 막는지 본다(B4 2차).
 * xterm은 브라우저 모듈이라 가짜로 끼우고, 다시 보낸 출력의 그리기 끝(write 콜백)을 시험이 직접 만진다.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPanel } from "./terminal-panel";
import { TerminalStreamProvider } from "./terminal-stream";

// React가 act로 감싼 갱신을 시험 환경으로 알아보게 한다(없으면 경고를 찍는다)
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fakes = vi.hoisted(() => {
  type WriteEntry = { data: unknown; callback?: () => void };
  class FakeTerminal {
    static instances: FakeTerminal[] = [];
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    writes: WriteEntry[] = [];
    dataListeners: Array<(data: string) => void> = [];
    constructor() {
      FakeTerminal.instances.push(this);
    }
    loadAddon(): void {}
    open(): void {}
    reset(): void {}
    focus(): void {}
    paste(): void {}
    dispose(): void {}
    onData(listener: (data: string) => void): { dispose(): void } {
      this.dataListeners.push(listener);
      return { dispose() {} };
    }
    write(data: unknown, callback?: () => void): void {
      this.writes.push({ data, callback });
    }
    /** 터미널이 스스로 낸 자동 응답(장치 속성 질의 답 등)이나 사람이 친 키를 흉내낸다 */
    emit(data: string): void {
      for (const listener of this.dataListeners) listener(data);
    }
    /** 다시 보낸 출력의 그리기가 끝난 것으로 만든다(xterm의 write 콜백) */
    flushWrites(): void {
      const writes = this.writes;
      this.writes = [];
      for (const entry of writes) entry.callback?.();
    }
  }
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 0;
    readonly url: string;
    constructor(url: string) {
      this.url = url;
      FakeEventSource.instances.push(this);
    }
    close(): void {
      this.readyState = 2;
    }
    open(): void {
      this.onopen?.();
    }
    /** 단일 통로의 메시지(그대로) */
    emit(message: unknown): void {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
    /** 묶음 통로의 메시지({ id, message }) */
    emitBundled(id: string, message: unknown): void {
      this.onmessage?.({ data: JSON.stringify({ id, message }) });
    }
  }
  return { FakeTerminal, FakeEventSource };
});

vi.mock("@xterm/xterm", () => ({ Terminal: fakes.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit(): void {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

interface Call {
  url: string;
  body: Record<string, unknown>;
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

async function flushMicro(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** 자동 응답·사람 키 POST를 가려내려고 fetch 호출을 모은다 */
function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }),
  );
  return calls;
}

/** 입력으로 POST된 값들만 */
const inputs = (calls: Call[]): unknown[] => calls.filter((call) => call.body.action === "input").map((call) => call.body.data);
const b64 = (text: string): string => btoa(text);
const lastTerminal = (): InstanceType<typeof fakes.FakeTerminal> => fakes.FakeTerminal.instances.at(-1)!;

beforeEach(() => {
  fakes.FakeTerminal.instances = [];
  fakes.FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", fakes.FakeEventSource);
  vi.stubGlobal("ResizeObserver", class { observe(): void {} disconnect(): void {} });
});

afterEach(() => {
  for (const root of roots) act(() => root.unmount());
  roots = [];
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("터미널 패널 — 다시 보낸 출력의 자동 응답을 입력으로 보내지 않는다(B4 2차)", () => {
  it("다시 보낸 출력의 질의 응답은 POST하지 않고, 실시간 출력의 응답은 POST한다", async () => {
    const calls = stubFetch();
    mount(<TerminalPanel sessionId="s1" ready={true} />);
    await flushMicro();
    const terminal = lastTerminal();
    const source = fakes.FakeEventSource.instances.find((entry) => entry.url === "/api/sessions/s1/terminal")!;

    // 서버가 최근 출력과 상태를 다시 보낸다
    act(() => source.open());
    act(() => source.emit({ kind: "data", data: b64("prompt$ \x1b[c") }));
    // 그리기가 끝나기 전에 xterm이 질의에 자동으로 답한다
    act(() => terminal.emit("\x1b[?1;2c"));
    expect(inputs(calls)).toEqual([]);

    // 상태(묶음 끝)가 오고 그리기가 끝나면 실시간으로 돌아간다
    act(() => source.emit({ kind: "status", state: "open" }));
    terminal.flushWrites();
    // 그 뒤 실시간 출력의 질의 응답은 보낸다(CLI가 실제로 묻는 질의에는 답해야 한다)
    act(() => source.emit({ kind: "data", data: b64("prompt$ \x1b[6n") }));
    act(() => terminal.emit("\x1b[1;1R"));
    expect(inputs(calls)).toEqual(["\x1b[1;1R"]);
  });

  it("사람이 친 키는 다시 보내기 여부와 상관없이 POST한다", async () => {
    const calls = stubFetch();
    mount(<TerminalPanel sessionId="s1" ready={true} />);
    await flushMicro();
    const terminal = lastTerminal();

    act(() => terminal.emit("ls\r"));
    expect(inputs(calls)).toEqual(["ls\r"]);
  });

  it("공급자가 구독 직후 준 되보내기 몫의 자동 응답도 POST하지 않는다", async () => {
    const calls = stubFetch();
    // 먼저 공급자만 열어 되보내기 몫을 쌓아 둔다(칸은 아직 없다)
    const root = mount(
      <TerminalStreamProvider ids={["s1"]}>
        <div />
      </TerminalStreamProvider>,
    );
    await flushMicro();
    const source = fakes.FakeEventSource.instances.find((entry) => entry.url.startsWith("/api/terminals/stream"))!;
    act(() => source.emitBundled("s1", { kind: "data", data: b64("prompt$ \x1b[c") }));
    act(() => source.emitBundled("s1", { kind: "status", state: "open" }));

    // 이제 칸을 붙인다 → 구독하는 순간 되보내기 몫(출력·상태)이 먼저 전달된다
    act(() =>
      root.render(
        <TerminalStreamProvider ids={["s1"]}>
          <TerminalPanel sessionId="s1" ready={true} />
        </TerminalStreamProvider>,
      ),
    );
    await flushMicro();
    const terminal = lastTerminal();

    act(() => terminal.emit("\x1b[?1;2c"));
    expect(inputs(calls)).toEqual([]);
  });
});
