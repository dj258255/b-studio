import { describe, expect, it } from "vitest";
import { filterFolders, folderListQuery, hintLabel, moveSelectionIndex, resolveListKey } from "./folder-browser";

describe("filterFolders", () => {
  const children = [{ name: "web" }, { name: "api" }, { name: "web-legacy" }];

  it("빈 글자면 그대로 돌려준다", () => {
    expect(filterFolders(children, "")).toEqual(children);
    expect(filterFolders(children, "  ")).toEqual(children);
  });

  it("대소문자 구분 없이 이름에 든 것만 남긴다", () => {
    expect(filterFolders(children, "WEB")).toEqual([{ name: "web" }, { name: "web-legacy" }]);
    expect(filterFolders(children, "api")).toEqual([{ name: "api" }]);
    expect(filterFolders(children, "zzz")).toEqual([]);
  });
});

describe("hintLabel", () => {
  it("실마리마다 한국어 표시를 돌려준다", () => {
    expect(hintLabel("nextjs")).toBe("Next.js");
    expect(hintLabel("spring-boot")).toBe("Spring");
    expect(hintLabel("registered")).toBe("이미 등록됨");
  });
});

describe("resolveListKey", () => {
  it("Enter는 들어가기, Backspace는 위로, 화살표는 옮기기다", () => {
    expect(resolveListKey("Enter")).toEqual({ type: "enter" });
    expect(resolveListKey("Backspace")).toEqual({ type: "up" });
    expect(resolveListKey("ArrowDown")).toEqual({ type: "move", delta: 1 });
    expect(resolveListKey("ArrowUp")).toEqual({ type: "move", delta: -1 });
  });

  it("그 밖의 키는 아무 동작도 없다", () => {
    expect(resolveListKey("a")).toBeUndefined();
    expect(resolveListKey("Escape")).toBeUndefined();
  });
});

describe("folderListQuery", () => {
  it("경로·showHidden을 쿼리 문자열로 만든다", () => {
    expect(folderListQuery(undefined, false)).toBe("");
    expect(folderListQuery("/Users/kim", false)).toBe("?path=%2FUsers%2Fkim");
    expect(folderListQuery("/Users/kim", true)).toBe("?path=%2FUsers%2Fkim&showHidden=1");
    expect(folderListQuery(undefined, true)).toBe("?showHidden=1");
  });
});

describe("moveSelectionIndex", () => {
  it("범위 안에서 옮기고 끝에서는 멈춘다", () => {
    expect(moveSelectionIndex(1, 1, 5)).toBe(2);
    expect(moveSelectionIndex(4, 1, 5)).toBe(4);
    expect(moveSelectionIndex(0, -1, 5)).toBe(0);
  });

  it("고른 것이 없으면(-1) 처음이나 마지막으로 간다", () => {
    expect(moveSelectionIndex(-1, 1, 5)).toBe(0);
  });

  it("목록이 비었으면 -1", () => {
    expect(moveSelectionIndex(-1, 1, 0)).toBe(-1);
  });
});
