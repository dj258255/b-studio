"use client";

import { createContext, useContext } from "react";

export interface CodeOpenTarget {
  path: string;
  /** 1-based 줄 번호. 없으면 파일만 연다 */
  line?: number;
}

export interface CodeOpen {
  /** 형제 패널(미리보기 탭)이 읽어 코드 탭으로 전환하고, 코드 탭이 읽어 그 파일·줄로 연다 */
  target?: CodeOpenTarget;
  /** "테스트" 탭의 file:line 링크가 부른다(코드 탭으로 전환하는 것까지 이 한 번으로 한다) */
  open(target: CodeOpenTarget): void;
  /** 코드 탭이 target을 반영한 뒤 부른다(다시 마운트되거나 다시 렌더될 때 같은 target으로 또 열리지 않게 한다) */
  clear(): void;
}

const noop = () => {};
const CodeOpenContext = createContext<CodeOpen>({ open: noop, clear: noop });

/** "테스트" 탭("파일:줄"보기)과 "코드" 탭을 잇는다(대화창 채우기와 같은 자리, Workbench에서 만든다) */
export const CodeOpenProvider = CodeOpenContext.Provider;

export function useCodeOpen(): CodeOpen {
  return useContext(CodeOpenContext);
}
