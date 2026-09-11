"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { languageFor, SUPPORTED_LANGUAGES } from "@/lib/highlight";
import { CodeTokens, useHighlightedCode } from "./code-tokens";

const FENCE_ALIASES: Record<string, string> = {
  shell: "shellscript",
  console: "shellscript",
  golang: "go",
  dockerfile: "docker",
};

/** 코드 블록의 언어 이름(```ts, ```bash)을 강조할 문법으로 바꾼다 */
export function languageForFence(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  if (SUPPORTED_LANGUAGES.has(lower)) return lower;
  return FENCE_ALIASES[lower] ?? languageFor(`file.${lower}`);
}

type MarkdownNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; data?: unknown; children?: MarkdownNode[] };

/**
 * 답변 속 HTML을 글자로 남긴다. HTML로 그리지 않을 뿐 아니라, 버리지도 않아서
 * `List<OrderResponse>`처럼 백틱 없이 쓴 제네릭 타입이 사라지지 않는다
 */
function remarkHtmlAsText() {
  const walk = (node: MarkdownNode) => {
    if (node.type === "html") node.type = "text";
    node.children?.forEach(walk);
  };
  return walk;
}

/**
 * 금액처럼 쓴 달러는 수식으로 보지 않는다. 실제 모델 답변은 인라인 수식을 `$n$`, `$p_i$`처럼 달러 하나로 적으므로
 * 인라인 수식을 켜야 하는데, 그러면 "가격은 $100 이고 배송비는 $5"가 수식이 된다.
 * 글자를 미리 바꾸면 코드 블록 안의 `$1`까지 망가지므로, 파싱한 뒤 숫자로 시작하는 수식만 원문 글자로 되돌린다
 */
function remarkMoneyAsText() {
  const walk = (node: MarkdownNode) => {
    for (const child of node.children ?? []) {
      if (child.type === "inlineMath" && /^\d/.test(child.value ?? "")) {
        child.type = "text";
        child.value = `$${child.value ?? ""}$`;
        // 수식 노드는 hast로 바꿀 때 쓸 정보(span.math-inline)를 data에 들고 온다. 타입만 바꾸면 그 정보로 수식이 다시 만들어진다
        delete child.data;
      }
      walk(child);
    }
  };
  return walk;
}

function textOf(node: MarkdownNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

/**
 * 제목은 대화 흐름에서 문단 크기로 둔다. 다만 원래 붙어 있던 클래스는 지우지 않는다.
 * 각주 묶음의 제목은 화면에서 숨기는 클래스(sr-only)를 달고 오는데, 지우면 "각주"라는 글자가 그대로 보인다
 */
const heading: Components["h1"] = ({ children, className }) => <p className={`font-semibold leading-7${className ? ` ${className}` : ""}`}>{children}</p>;

const COMPONENTS: Components = {
  p: ({ children }) => <p className="leading-7">{children}</p>,
  h1: heading,
  h2: heading,
  h3: heading,
  h4: heading,
  h5: heading,
  h6: heading,
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5 leading-7">{children}</ul>,
  ol: ({ children, start }) => (
    <ol start={start} className="list-decimal space-y-1 pl-5 leading-7">
      {children}
    </ol>
  ),
  blockquote: ({ children }) => <blockquote className="space-y-2 border-l-2 border-line pl-3 text-muted">{children}</blockquote>,
  // 각주처럼 같은 답변 안을 가리키는 링크는 새 탭으로 열지 않는다
  a: ({ href, children }) =>
    href?.startsWith("#") ? (
      <a href={href} className="underline underline-offset-2">
        {children}
      </a>
    ) : (
      <a href={href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
        {children}
      </a>
    ),
  // 에이전트가 적은 외부 이미지를 불러오면 사용자 몰래 밖으로 요청이 나가므로 대체 글만 보여 준다
  img: ({ alt }) => <span className="text-muted">[이미지{alt ? `: ${alt}` : ""}]</span>,
  hr: () => <hr className="border-line" />,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  // break-word는 표의 최소 너비를 줄이지 못해 긴 경로 한 칸이 다른 열을 밀어낸다. anywhere는 최소 너비 계산에서도 줄을 바꾼다
  th: ({ children }) => <th className="border border-line bg-ground px-2 py-1 text-left font-semibold [overflow-wrap:anywhere]">{children}</th>,
  td: ({ children }) => <td className="border border-line px-2 py-1 align-top [overflow-wrap:anywhere]">{children}</td>,
  code: ({ children }) => <code className="rounded bg-ground px-1 py-0.5 font-mono text-[0.85em]">{children}</code>,
  pre: ({ node }) => {
    const code = (node as unknown as MarkdownNode | undefined)?.children?.[0];
    if (code?.type !== "element" || code.tagName !== "code") return null;
    const classes = code.properties?.className;
    const fence = Array.isArray(classes)
      ? classes
          .map(String)
          .find((name) => name.startsWith("language-"))
          ?.slice("language-".length)
      : undefined;
    return <CodeBlock code={textOf(code).replace(/\n$/, "")} lang={languageForFence(fence)} />;
  },
};

/** 강조가 끝나기 전과 모르는 언어는 원문을 그대로 보여 준다 */
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const highlighted = useHighlightedCode(code, lang);
  return (
    <pre className="overflow-x-auto rounded-md border border-line bg-panel px-3 py-2 font-mono text-xs leading-5">
      {code.split("\n").map((line, index) => (
        <div key={index} className="whitespace-pre">
          {highlighted?.[index] ? <CodeTokens line={highlighted[index]} /> : line || " "}
        </div>
      ))}
    </pre>
  );
}

/**
 * 에이전트 답변. HTML은 글자로 보여 주고, 외부 링크는 새 탭으로 열며, 외부 이미지는 불러오지 않는다.
 * 수식은 `$…$`(인라인)와 `$$…$$`(블록)를 그리고, 숫자로 시작하는 것은 금액으로 보아 글자로 남긴다.
 * KaTeX 기본 출력을 그대로 써서 보이는 수식과 함께 MathML을 남긴다. 화면 낭독기가 읽을 내용이 사라지지 않게 하기 위해서다.
 * 문법이 틀린 수식은 예외로 답변 전체를 깨뜨리지 않고, 그 자리를 원문으로 남긴다
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-3 break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath, remarkMoneyAsText, remarkHtmlAsText]}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
        remarkRehypeOptions={{ footnoteLabel: "각주", footnoteBackLabel: "본문으로 돌아가기" }}
        components={COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
