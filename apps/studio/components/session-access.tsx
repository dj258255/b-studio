"use client";

import { createContext, useContext } from "react";

/** 이 화면을 보는 사람이 세션에서 할 수 있는 일. 서버가 모든 요청에서 다시 확인하므로 화면은 버튼을 끄고 안내만 한다 */
export interface SessionAccess {
  /** 인증을 켰을 때 로그인한 사람 */
  viewer?: string;
  owner?: string;
  canManage: boolean;
  canLogout: boolean;
}

const SessionAccessContext = createContext<SessionAccess>({ canManage: true, canLogout: false });

export const SessionAccessProvider = SessionAccessContext.Provider;

export function useSessionAccess(): SessionAccess {
  return useContext(SessionAccessContext);
}
