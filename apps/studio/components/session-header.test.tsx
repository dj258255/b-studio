import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createView, reduceSession } from "@/lib/session-view";
import type { SessionSnapshot, StudioEvent } from "@/lib/studio-events";
import { SessionHeader } from "./session-header";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined, push: () => undefined }) }));

const snapshot: SessionSnapshot = {
  id: "s1",
  projectId: "shop",
  projectName: "shop",
  workDir: "/tmp/shop-s1",
  status: "ready",
  mode: "api",
  running: false,
  checkpoints: [],
  services: [
    { name: "api", template: "spring-boot", preview: "openapi", state: "ready", hasContract: true },
    { name: "web", template: "nextjs", preview: "browser", state: "ready", hasContract: false },
    { name: "admin", template: "nextjs", preview: "browser", state: "off", hasContract: false },
  ],
  usage: { at: "2026-10-10T00:00:00.000Z", services: [{ service: "api", state: "running", memoryBytes: 512 * 1024 * 1024 } as never] },
};

const render = (events: StudioEvent[] = [], base: SessionSnapshot = snapshot) => renderToStaticMarkup(<SessionHeader snapshot={events.reduce(reduceSession, createView(base)).snapshot} />);

describe("세션 헤더의 샌드박스 연결 상태 (트러블슈팅 123)", () => {
  it("문제가 없으면 준비됨과 서비스 상태를 그대로 보여 준다", () => {
    const html = render();
    expect(html).toContain("준비됨");
    expect(html).not.toContain("확인 불가");
    expect(html).not.toContain("샌드박스 다시 올리기");
  });

  it("도커에 닿지 않으면 준비됨이라고 하지 않고, 서비스 상태를 확인 불가로 바꾸며 사유와 시각을 보여 준다", () => {
    const html = render([{ type: "sandbox_link", link: { state: "unreachable", since: "2026-10-10T08:12:00+09:00", reason: "Cannot connect to the Docker daemon" } }]);
    expect(html).toContain("샌드박스에 닿지 않습니다");
    expect(html).not.toContain("준비됨");
    expect(html.match(/확인 불가/g)).toHaveLength(2);
    // 꺼 둔 서비스는 컨테이너가 없는 것이 정상이라 그대로다
    expect(html).toContain("꺼 둠");
    expect(html).toContain("도커에 물어도 답을 받지 못하고 있습니다");
    expect(html).toContain("Cannot connect to the Docker daemon");
    expect(html).toContain("마지막으로 본 값");
    // 마지막으로 잰 메모리 사용량을 지금 값처럼 보여 주지 않는다
    expect(html).not.toContain("512");
    // 닿지 않을 때는 다시 올릴 수도 없으므로 버튼을 두지 않는다
    expect(html).not.toContain("샌드박스 다시 올리기");
  });

  it("컨테이너가 사라졌으면 다시 올리라고 안내한다", () => {
    const html = render([{ type: "sandbox_link", link: { state: "missing", since: "2026-10-10T08:12:00+09:00", reason: "이 세션의 컨테이너가 하나도 없습니다" } }]);
    expect(html).toContain("샌드박스 컨테이너가 없습니다");
    expect(html).toContain("작업 복사본과 체크포인트는 그대로입니다");
    expect(html).toContain("샌드박스 다시 올리기");
  });

  it("연결이 돌아오면(link 없는 이벤트) 원래 표시로 돌아간다", () => {
    const html = render([
      { type: "sandbox_link", link: { state: "unreachable", since: "2026-10-10T08:12:00+09:00", reason: "x" } },
      { type: "sandbox_link" },
    ]);
    expect(html).toContain("준비됨");
    expect(html).not.toContain("샌드박스에 닿지 않습니다");
  });

  it("준비됨이 아닌 세션(멈춤·기동 중)에는 연결 상태를 겹쳐 보이지 않는다", () => {
    const html = render([], { ...snapshot, status: "stopped", sandboxLink: { state: "missing", since: "2026-10-10T08:12:00+09:00", reason: "x" } });
    expect(html).toContain("중지됨");
    expect(html).not.toContain("샌드박스 컨테이너가 없습니다");
  });
});
