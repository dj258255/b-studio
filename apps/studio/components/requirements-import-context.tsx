"use client";

import { createContext, useContext } from "react";

export interface RequirementsImportTarget {
  /** "요구사항" 탭 ImportFlow의 붙여넣기 칸을 채우고 바로 한 번 추출한다(진단 diff를 보여 준다) */
  specText: string;
}

export interface RequirementsImport {
  target?: RequirementsImportTarget;
  /** 대화의 "요구사항에 반영"이 부른다. "요구사항" 탭으로 전환하는 것까지 이 한 번으로 한다 */
  open(target: RequirementsImportTarget): void;
  /** "요구사항" 탭이 target을 반영한 뒤 부른다(다시 마운트되거나 다시 렌더될 때 같은 target으로 또 열리지 않게 한다) */
  clear(): void;
}

const noop = () => {};
const RequirementsImportContext = createContext<RequirementsImport>({ open: noop, clear: noop });

/** 대화의 "요구사항에 반영"과 "요구사항" 탭을 잇는다(코드 탭 열기·대화창 채우기와 같은 자리, Workbench에서 만든다) */
export const RequirementsImportProvider = RequirementsImportContext.Provider;

export function useRequirementsImport(): RequirementsImport {
  return useContext(RequirementsImportContext);
}
