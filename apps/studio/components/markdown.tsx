"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
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

type MarkdownNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: MarkdownNode[] };

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

function textOf(node: MarkdownNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

const heading: Components["h1"] = ({ children }) => <p className="font-semibold leading-7">{children}</p>;

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
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
      {children}
    </a>
  ),
  // 에이전트가 적은 외부 이미지를 불러오면 사용자 몰래 밖으로 요청이 나가므로 대체 글만 보여 준다
  img: ({ alt }) => <span className="text-muted">[이미지{alt ? `: ${alt}` : ""}]</span>,
  hr: () => <hr className="border-line" />,
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-line bg-ground px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-line px-2 py-1 align-top">{children}</td>,
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

/** 에이전트 답변. HTML은 글자로 보여 주고, 링크는 새 탭으로 열며, 외부 이미지는 불러오지 않는다 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-3 break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkHtmlAsText]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
