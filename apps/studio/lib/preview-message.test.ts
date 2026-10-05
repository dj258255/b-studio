import { describe, expect, it } from "vitest";
import { PREVIEW_LOCATION_MESSAGE, previewPathFromHref, readPreviewLocationMessage } from "./preview-message";

const SOURCE = { tag: "iframe-window" };
const EXPECTED = { origin: "http://127.0.0.1:41000", source: SOURCE };

describe("readPreviewLocationMessage", () => {
  it("출처와 보낸 창이 맞고 형태도 맞으면 href를 돌려준다", () => {
    const href = readPreviewLocationMessage(
      { origin: "http://127.0.0.1:41000", source: SOURCE, data: { type: PREVIEW_LOCATION_MESSAGE, href: "http://127.0.0.1:41000/posts/1" } },
      EXPECTED,
    );
    expect(href).toBe("http://127.0.0.1:41000/posts/1");
  });

  it("출처가 다르면 거른다", () => {
    const href = readPreviewLocationMessage(
      { origin: "http://evil.example", source: SOURCE, data: { type: PREVIEW_LOCATION_MESSAGE, href: "http://evil.example/" } },
      EXPECTED,
    );
    expect(href).toBeUndefined();
  });

  it("보낸 창이 지금 iframe이 아니면 거른다(다른 iframe·부모 창 자신의 메시지)", () => {
    const href = readPreviewLocationMessage(
      { origin: "http://127.0.0.1:41000", source: { tag: "other-window" }, data: { type: PREVIEW_LOCATION_MESSAGE, href: "http://127.0.0.1:41000/x" } },
      EXPECTED,
    );
    expect(href).toBeUndefined();
  });

  it("기대하는 출처가 아직 없으면(주소를 받기 전) 거른다", () => {
    const href = readPreviewLocationMessage(
      { origin: "http://127.0.0.1:41000", source: SOURCE, data: { type: PREVIEW_LOCATION_MESSAGE, href: "http://127.0.0.1:41000/x" } },
      { origin: undefined, source: SOURCE },
    );
    expect(href).toBeUndefined();
  });

  it("type이 다르거나 href가 문자열이 아니거나 data가 객체가 아니면 거른다", () => {
    expect(readPreviewLocationMessage({ origin: "http://127.0.0.1:41000", source: SOURCE, data: { type: "other", href: "x" } }, EXPECTED)).toBeUndefined();
    expect(
      readPreviewLocationMessage({ origin: "http://127.0.0.1:41000", source: SOURCE, data: { type: PREVIEW_LOCATION_MESSAGE, href: 123 } }, EXPECTED),
    ).toBeUndefined();
    expect(readPreviewLocationMessage({ origin: "http://127.0.0.1:41000", source: SOURCE, data: "그냥 문자열" }, EXPECTED)).toBeUndefined();
    expect(readPreviewLocationMessage({ origin: "http://127.0.0.1:41000", source: SOURCE, data: null }, EXPECTED)).toBeUndefined();
  });
});

describe("previewPathFromHref", () => {
  it("경로·검색·해시만 남기고 출처는 뺀다", () => {
    expect(previewPathFromHref("http://127.0.0.1:41000/posts/1?x=1#top")).toBe("/posts/1?x=1#top");
    expect(previewPathFromHref("http://127.0.0.1:41000/")).toBe("/");
  });

  it("올바르지 않은 주소면 undefined", () => {
    expect(previewPathFromHref("그냥 글자")).toBeUndefined();
  });
});
