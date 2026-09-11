import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { languageForFence, Markdown } from "./markdown";

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

describe("Markdown", () => {
  it("에이전트 답변의 굵게, 목록, 인용, 인라인 코드, 표를 요소로 그린다", () => {
    const html = render(
      ["- **바꾼 파일:** `web/app/page.tsx` 하나만 바꿨어요.", "", "> 주문을 관리하는 사내 도구입니다.", "", "| 파일 | 변경 |", "|---|---|", "| page.tsx | 추가 |"].join("\n"),
    );

    expect(html).toContain("<ul");
    expect(html).toContain("<strong>바꾼 파일:</strong>");
    expect(html).toMatch(/<code[^>]*>web\/app\/page\.tsx<\/code>/);
    expect(html).toMatch(/<blockquote[^>]*>[\s\S]*주문을 관리하는 사내 도구입니다\.[\s\S]*<\/blockquote>/);
    expect(html).toMatch(/<table[^>]*>[\s\S]*<th[^>]*>파일<\/th>[\s\S]*<td[^>]*>추가<\/td>/);
  });

  it("HTML은 요소로 만들지 않고 글자로 남겨, 백틱 없이 쓴 제네릭 타입도 사라지지 않는다", () => {
    const html = render('응답은 List<OrderResponse>입니다. <script>alert("x")</script> <img src="https://example.com/t.png">');

    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("List&lt;OrderResponse&gt;");
    expect(html).toContain("&lt;script&gt;");
  });

  it("javascript: 링크는 주소를 지우고, 링크는 새 탭으로 열며, 외부 이미지는 대체 글만 보여 준다", () => {
    const html = render("[위험](javascript:alert(1)) [문서](https://nextjs.org/docs) ![화면 캡처](https://example.com/shot.png)");

    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://nextjs.org/docs" target="_blank" rel="noreferrer noopener"');
    expect(html).not.toContain("<img");
    expect(html).toContain("[이미지: 화면 캡처]");
  });

  it("코드 블록은 강조가 끝나기 전에도 원문을 줄 단위로 보여 준다", () => {
    const html = render(["```java", "@GetMapping", 'List<OrderResponse> list() { return List.of(); }', "```"].join("\n"));

    expect(html).toMatch(/<pre[^>]*><div[^>]*>@GetMapping<\/div><div[^>]*>List&lt;OrderResponse&gt; list\(\) \{ return List\.of\(\); \}<\/div><\/pre>/);
  });
});

describe("languageForFence", () => {
  it("코드 블록 언어 이름과 흔한 별칭을 강조할 문법으로 바꾼다", () => {
    expect(languageForFence("ts")).toBe("typescript");
    expect(languageForFence("TSX")).toBe("tsx");
    expect(languageForFence("java")).toBe("java");
    expect(languageForFence("bash")).toBe("shellscript");
    expect(languageForFence("shell")).toBe("shellscript");
    expect(languageForFence("yml")).toBe("yaml");
    expect(languageForFence("dockerfile")).toBe("docker");
    expect(languageForFence("text")).toBeUndefined();
    expect(languageForFence(undefined)).toBeUndefined();
  });
});
