import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createView } from "@/lib/session-view";
import type { SessionSnapshot } from "@/lib/studio-events";
import { PreviewPanel } from "./preview-panel";

const baseSnapshot: SessionSnapshot = {
  id: "s1",
  projectId: "orders",
  projectName: "orders",
  workDir: "/tmp/orders-s1",
  status: "ready",
  mode: "api",
  running: false,
  checkpoints: [],
  services: [],
};

describe("PreviewPanel 위 탭(ADR-086)", () => {
  it("서비스가 없으면 코드·요구사항·실행·저장소·토큰 다섯 자리만 보여준다(위 탭 묶기)", () => {
    const html = renderToStaticMarkup(<PreviewPanel view={createView(baseSnapshot)} />);

    expect(html).toContain(">코드<");
    expect(html).toContain(">요구사항<");
    expect(html).toContain(">실행<");
    expect(html).toContain(">저장소<");
    expect(html).toContain(">토큰<");
    // 예전의 낱개 위 탭 이름은 더 이상 위 탭으로 나오지 않는다(하위 탭으로 옮겼다. 기본 활성 탭은 "코드"라 그 하위 탭만 보인다)
    expect(html).not.toContain(">디자인<");
    expect(html).not.toContain(">명세<");
    expect(html).not.toContain(">테스트<");
    expect(html).not.toContain(">기록<");
    expect(html).not.toContain(">배포<");
    expect(html).not.toContain(">로그<");
    expect(html).not.toContain(">리소스<");
    expect(html).not.toContain(">제출 준비<");
  });

  it("화면·API 서비스는 서비스마다 위 탭이 하나씩 생긴다", () => {
    const snapshot: SessionSnapshot = {
      ...baseSnapshot,
      services: [
        { name: "web", template: "next", preview: "browser", state: "ready", hasContract: false },
        { name: "api", template: "spring-boot", preview: "openapi", state: "ready", hasContract: true },
        { name: "worker", template: "spring-boot", preview: "logs", state: "ready", hasContract: false },
      ],
    };
    const html = renderToStaticMarkup(<PreviewPanel view={createView(snapshot)} />);

    expect(html).toContain(">화면 (web)<");
    expect(html).toContain(">API (api)<");
    // preview가 "logs"뿐인 서비스는 위 탭을 만들지 않는다(로그는 "실행" 탭 안에 있다)
    expect(html).not.toContain(">화면 (worker)<");
    expect(html).not.toContain(">API (worker)<");
  });

  it("기본 활성 탭(코드)은 파일·변경 기록 하위 탭을 role=tablist로 보여준다", () => {
    const html = renderToStaticMarkup(<PreviewPanel view={createView(baseSnapshot)} />);

    expect(html).toContain('aria-label="코드 하위 탭"');
    expect(html).toMatch(/role="tablist"[^>]*aria-label="코드 하위 탭"/);
    expect(html).toContain(">파일<");
    expect(html).toContain(">변경 기록<");
  });

  it("과제·채점·제출처럼 들리는 말을 쓰지 않는다(올리기 전 점검으로 바꿨다)", () => {
    const html = renderToStaticMarkup(<PreviewPanel view={createView(baseSnapshot)} />);

    expect(html).not.toContain("과제");
    expect(html).not.toContain("채점");
    expect(html).not.toContain("제출");
  });
});
