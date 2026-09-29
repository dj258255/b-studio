"use client";

import { createContext, useContext } from "react";

export interface ChatDraft {
  /** 대화 입력창에 이 글을 채운다(보내지는 않는다. 사람이 보고 고친 뒤 직접 보낸다) */
  fill(text: string): void;
  /** 대화 입력창(ChatPanel)이 마운트되면 자신의 채우기 함수를 등록한다. 저장소 탭 같은 형제 패널이 그 함수를 통해 글을 넘긴다 */
  register(setter: ((text: string) => void) | undefined): void;
}

const noop = () => {};
const ChatDraftContext = createContext<ChatDraft>({ fill: noop, register: noop });

/** 저장소 탭("이 이슈로 작업")과 대화 입력창이 이어지도록 나눈다(요소 선택과 같은 자리, Workbench에서 만든다) */
export const ChatDraftProvider = ChatDraftContext.Provider;

export function useChatDraft(): ChatDraft {
  return useContext(ChatDraftContext);
}
