"use client";

import { createContext, useContext } from "react";
import { artifactUrl } from "@/lib/artifact-url";

/** 원격 브라우저에서 고른 요소 하나 */
export interface ElementSelection {
  selector: string;
  html: string;
  css: Record<string, string>;
  screenshotArtifact: string;
}

export interface ElementSelections {
  selections: ElementSelection[];
  add(selection: ElementSelection): void;
  remove(index: number): void;
  clear(): void;
}

const ElementSelectionContext = createContext<ElementSelections>({ selections: [], add: () => {}, remove: () => {}, clear: () => {} });

/** 미리보기 패널(요소 선택)과 대화 입력창이 같은 목록을 보도록 나눈다 */
export const ElementSelectionProvider = ElementSelectionContext.Provider;

export function useElementSelections(): ElementSelections {
  return useContext(ElementSelectionContext);
}

/**
 * 고른 요소를 요청 앞에 붙일 `[선택한 요소]` 블록으로 만든다.
 * 스크린샷은 모델에 이미지로 보내지 않고 참조 경로만 적는다. 이미지 입력을 받는 모델과 그렇지 않은 모델이 섞여 있어
 * 한쪽에 맞춘 이미지 요청 형식이 다른 쪽에서 오류가 되거나 조용히 무시되기 때문이다(모델마다 다름).
 */
export function formatElementSelections(sessionId: string, selections: readonly ElementSelection[]): string {
  if (selections.length === 0) return "";
  const blocks = selections.map((selection, index) => {
    const css = Object.entries(selection.css)
      .map(([key, value]) => `- ${key}: ${value}`)
      .join("\n");
    return [`## 선택한 요소 ${index + 1}`, `선택자: ${selection.selector}`, "HTML:", selection.html, "주요 CSS:", css, `참조 스크린샷: ${artifactUrl(sessionId, selection.screenshotArtifact)}`].join(
      "\n",
    );
  });
  return ["[선택한 요소]", ...blocks].join("\n\n");
}
