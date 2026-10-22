import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MismatchNotice } from "./mismatch-notice";

const mismatch = { requestValue: "배송비 3,000원", checkValue: "OrderTest는 2,500원", followed: "check" as const, note: "테스트를 따랐습니다" };

describe("MismatchNotice(#666)", () => {
  it("확인 필요와 두 값, 따른 쪽, 설명을 보인다", () => {
    const html = renderToStaticMarkup(<MismatchNotice mismatches={[mismatch]} />);
    expect(html).toContain("확인 필요");
    expect(html).toContain("배송비 3,000원");
    expect(html).toContain("OrderTest는 2,500원");
    expect(html).toContain("확인을 따름");
    expect(html).toContain("테스트를 따랐습니다");
  });

  it("어긋남이 없으면 아무것도 그리지 않는다", () => {
    expect(renderToStaticMarkup(<MismatchNotice mismatches={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<MismatchNotice mismatches={[]} />)).toBe("");
  });
});
