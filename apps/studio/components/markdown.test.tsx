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

  it("각주는 같은 답변 안을 가리키므로 새 탭으로 열지 않고, 각주 묶음 제목은 화면에서 숨긴다", () => {
    const html = render(["본문에 각주[^1]가 있다.", "", "[^1]: 각주 내용"].join("\n"));

    expect(html).toMatch(/<sup><a href="#user-content-fn-1"[^>]*>1<\/a><\/sup>/);
    expect(html).not.toMatch(/<a href="#user-content-fn-1"[^>]*target="_blank"/);
    expect(html).toMatch(/<section[^>]*class="footnotes"/);
    // 묶음 제목은 sr-only로 남아 화면에 글자로 보이지 않는다
    expect(html).toMatch(/class="font-semibold leading-7 sr-only"[^>]*>각주</);
    expect(html).toContain("각주 내용");
  });

  it("블록 수식과 인라인 수식을 요소로 그리고, 화면 낭독기용 MathML을 함께 남긴다", () => {
    const math = render(["$$", "a^2 + b^2 = c^2", "$$"].join("\n"));
    expect(math).toContain("katex-display");
    expect(math).toMatch(/<annotation encoding="application\/x-tex">a\^2 \+ b\^2 = c\^2/);

    // 실제 모델은 인라인 수식을 달러 하나로 적는다
    const inline = render("품목이 $n$개이고 단가는 $p_i$ 입니다.");
    expect(inline).not.toContain("katex-display");
    expect(inline).toMatch(/<annotation encoding="application\/x-tex">n<\/annotation>/);
    expect(inline).toMatch(/<annotation encoding="application\/x-tex">p_i<\/annotation>/);
  });

  it("금액처럼 숫자로 시작하는 달러 표기는 수식으로 보지 않고, 코드 블록의 $1도 그대로 둔다", () => {
    const money = render("가격은 $100 이고 배송비는 $5 입니다.");
    expect(money).not.toContain("katex");
    expect(money).toContain("$100");
    expect(money).toContain("$5");

    const code = render(["```bash", 'echo "$1 $2"', "```"].join("\n"));
    expect(code).not.toContain("katex");
    expect(code).toContain("$1 $2");

    // 금액과 구분할 방법이 없어, 숫자로 시작하는 인라인 수식은 수식으로 그리지 않는다 (감수한 한계)
    const digitFirst = render("계수는 $2x$ 입니다.");
    expect(digitFirst).not.toContain("katex");
    expect(digitFirst).toContain("$2x$");
  });

  it("문법이 틀린 수식은 답변을 깨뜨리지 않고 원문을 남긴다", () => {
    const broken = render(["$$", "\\frac{1}{", "$$"].join("\n"));
    expect(broken).toContain("frac{1}{");
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
