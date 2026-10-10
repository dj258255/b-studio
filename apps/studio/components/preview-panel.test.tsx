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

describe("PreviewPanel 위 탭(ADR-087)", () => {
  it("서비스가 없으면 코드·요구사항·실행·저장소 네 자리만 보여준다(위 탭 묶기, ADR-166)", () => {
    const html = renderToStaticMarkup(<PreviewPanel view={createView(baseSnapshot)} />);

    expect(html).toContain(">코드<");
    expect(html).toContain(">요구사항<");
    expect(html).toContain(">실행<");
    expect(html).toContain(">저장소<");
    // 문서·현황·토큰은 위 탭이 아니다(요구사항·실행 묶음의 하위 탭으로 옮겼다)
    expect(html).not.toContain(">토큰<");
    expect(html).not.toContain(">문서<");
    expect(html).not.toContain(">현황<");
    expect((html.match(/role="tab"/g) ?? []).length - (html.match(/aria-label="코드 하위 탭"/g) ?? []).length * 2).toBe(4);
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

  it("꺼 둔 서비스는 위 탭을 두지 않는다 (ADR-166)", () => {
    const snapshot: SessionSnapshot = {
      ...baseSnapshot,
      services: [
        { name: "web", template: "next", preview: "browser", state: "ready", hasContract: false },
        { name: "consumer-app", template: "next", preview: "browser", state: "off", hasContract: false },
      ],
    };
    const html = renderToStaticMarkup(<PreviewPanel view={createView(snapshot)} />);

    expect(html).toContain(">화면 (web)<");
    expect(html).not.toContain(">화면 (consumer-app)<");
  });

  it("화면 탭의 원격 브라우저·디자인 비교는 실험 기능을 켰을 때만 보인다 (ADR-166)", () => {
    const services = [{ name: "web", template: "next", preview: "browser", state: "ready", hasContract: false, url: "http://127.0.0.1:1" }] as SessionSnapshot["services"];
    const hidden = renderToStaticMarkup(<PreviewPanel view={createView({ ...baseSnapshot, services })} />);
    expect(hidden).toContain(">앱 미리보기<");
    expect(hidden).toContain(">QA<");
    expect(hidden).not.toContain(">원격 브라우저<");
    expect(hidden).not.toContain(">디자인 비교<");

    const shown = renderToStaticMarkup(<PreviewPanel view={createView({ ...baseSnapshot, services, experimental: true })} />);
    expect(shown).toContain(">원격 브라우저<");
    expect(shown).toContain(">디자인 비교<");
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
