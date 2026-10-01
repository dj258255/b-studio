import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DevStatusBanner, DevStatusBannerView } from "./dev-status-banner";

describe("DevStatusBannerView", () => {
  it("코드가 바뀌었으면 옛 커밋→새 커밋과 다시 시작하라는 안내를 보여준다", () => {
    const html = renderToStaticMarkup(
      <DevStatusBannerView status={{ active: true, bootHead: "abc1234", headNow: "def5678", codeChanged: true, lockfileChanged: false }} dismissedHead={undefined} onDismiss={() => undefined} />,
    );

    expect(html).toContain("abc1234→def5678");
    expect(html).toContain("다시 시작하세요");
    expect(html).not.toContain("의존성도 바뀌어");
  });

  it("의존성(pnpm-lock.yaml)도 바뀌었으면 다시 설치한다는 문구를 더한다", () => {
    const html = renderToStaticMarkup(
      <DevStatusBannerView status={{ active: true, bootHead: "abc1234", headNow: "def5678", codeChanged: true, lockfileChanged: true }} dismissedHead={undefined} onDismiss={() => undefined} />,
    );

    expect(html).toContain("의존성도 바뀌어 다시 시작할 때 설치합니다");
  });

  it("운영 빌드(active=false)거나 코드가 바뀌지 않았으면 아무것도 그리지 않는다", () => {
    expect(renderToStaticMarkup(<DevStatusBannerView status={{ active: false }} dismissedHead={undefined} onDismiss={() => undefined} />)).toBe("");
    expect(
      renderToStaticMarkup(
        <DevStatusBannerView status={{ active: true, bootHead: "abc1234", headNow: "abc1234", codeChanged: false, lockfileChanged: false }} dismissedHead={undefined} onDismiss={() => undefined} />,
      ),
    ).toBe("");
    expect(renderToStaticMarkup(<DevStatusBannerView status={undefined} dismissedHead={undefined} onDismiss={() => undefined} />)).toBe("");
  });

  it("닫기를 누른 커밋과 지금 커밋이 같으면 다시 그리지 않는다", () => {
    const html = renderToStaticMarkup(
      <DevStatusBannerView status={{ active: true, bootHead: "abc1234", headNow: "def5678", codeChanged: true, lockfileChanged: false }} dismissedHead="def5678" onDismiss={() => undefined} />,
    );
    expect(html).toBe("");
  });
});

describe("DevStatusBanner", () => {
  it("fetch 결과가 오기 전(첫 그리기)에는 아무것도 보여주지 않는다", () => {
    expect(renderToStaticMarkup(<DevStatusBanner />)).toBe("");
  });
});
