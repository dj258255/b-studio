import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildFileTree } from "@/lib/file-tree";
import { FileTreeList } from "./code-panel";

const nodes = buildFileTree(["src/index.ts", "src/a/z.ts", "src/a/a.ts", "README.md"]);

describe("FileTreeList", () => {
  it("폴더가 파일보다 먼저 보이고, 접힌 폴더는 안의 파일을 그리지 않는다", () => {
    const html = renderToStaticMarkup(
      <FileTreeList nodes={nodes} depth={0} expanded={new Set()} onToggle={() => undefined} onOpen={() => undefined} changeOf={() => undefined} />,
    );
    expect(html).toContain("src");
    expect(html).toContain("README.md");
    expect(html).not.toContain("index.ts");
    expect(html.indexOf("src")).toBeLessThan(html.indexOf("README.md"));
  });

  it("펼친 폴더는 자식을 이름순으로 그리고, 활성 파일에 aria-current를 단다", () => {
    const html = renderToStaticMarkup(
      <FileTreeList
        nodes={nodes}
        depth={0}
        expanded={new Set(["src", "src/a"])}
        onToggle={() => undefined}
        active="src/a/a.ts"
        onOpen={() => undefined}
        changeOf={() => undefined}
      />,
    );
    expect(html).toContain("index.ts");
    expect(html).toContain("a.ts");
    expect(html).toContain("z.ts");
    expect(html.indexOf(">a.ts<")).toBeLessThan(html.indexOf(">z.ts<"));
    expect(html).toMatch(/aria-current="true"[^>]*>[\s\S]*?a\.ts/);
  });

  it("바뀐 파일이면 배지를 함께 보인다", () => {
    const html = renderToStaticMarkup(
      <FileTreeList
        nodes={nodes}
        depth={0}
        expanded={new Set()}
        onToggle={() => undefined}
        onOpen={() => undefined}
        changeOf={(path) => (path === "README.md" ? "modified" : undefined)}
      />,
    );
    expect(html).toContain("수정");
  });
});
