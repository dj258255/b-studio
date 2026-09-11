"use client";

import { useEffect, useState } from "react";
import { highlightLines, type HighlightedLine } from "@/lib/highlight";

/** 강조한 한 줄. 토큰 색은 globals.css의 .code-token이 운영체제 테마에 맞춰 고른다 */
export function CodeTokens({ line }: { line: HighlightedLine }) {
  if (line.length === 0) return " ";
  return line.map((token, index) => (
    <span key={index} className={token.className ? `code-token ${token.className}` : undefined}>
      {token.content}
    </span>
  ));
}

/**
 * 강조한 줄. 조각을 끝낼 때마다 늘어나고, 아직 강조하지 않은 줄과 강조하지 않는 파일은 undefined다.
 * 이전 파일의 결과를 새 파일에 붙이지 않도록 입력과 함께 두고, 파일이 바뀌면 남은 조각을 멈춘다
 */
export function useHighlightedCode(code: string, lang: string | undefined): HighlightedLine[] | undefined {
  const [result, setResult] = useState<{ code: string; lang?: string; lines: HighlightedLine[] }>();
  useEffect(() => {
    const controller = new AbortController();
    highlightLines(code, lang, {
      signal: controller.signal,
      onProgress: (lines) => !controller.signal.aborted && setResult({ code, lang, lines }),
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) console.warn("[b-studio] 문법 강조에 실패해 평문으로 보여 줍니다", error);
    });
    return () => controller.abort();
  }, [code, lang]);
  return result?.code === code && result.lang === lang ? result.lines : undefined;
}
