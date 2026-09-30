import type { FolderHint } from "@/lib/server/folder-browser";

/**
 * 폴더 선택 모달(ADR-082, `components/folder-browser.tsx`)의 순수 로직. 화면 그리기와 분리해 두면 테스트가
 * DOM·이벤트 시뮬레이션 없이도 "더블클릭으로 들어간다", "Enter로 들어간다", "Backspace로 위로 간다" 같은
 * 동작을 그대로 확인할 수 있다 — 화면 쪽은 이 함수들이 돌려준 동작(action)을 실행만 한다.
 */

/** 타이핑한 글자가 이름에 들어간 폴더만 남긴다(대소문자 구분 없이) */
export function filterFolders<T extends { name: string }>(children: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...children];
  return children.filter((child) => child.name.toLowerCase().includes(needle));
}

const HINT_LABEL: Record<FolderHint, string> = {
  nextjs: "Next.js",
  vite: "Vite",
  "spring-boot": "Spring",
  fastapi: "FastAPI",
  compose: "compose",
  git: "git",
  "studio-yaml": "studio.yaml",
  registered: "이미 등록됨",
};

export function hintLabel(hint: FolderHint): string {
  return HINT_LABEL[hint];
}

export type FolderListAction = { type: "enter" } | { type: "up" } | { type: "move"; delta: number };

/**
 * 폴더 목록에서 누른 키를 동작으로 바꾼다. Enter는 고른 폴더로 들어가고(더블클릭과 같은 동작),
 * Backspace는 한 단계 위로, 위/아래 화살표는 고른 줄을 옮긴다. 그 밖의 키는 아무 동작도 없다(undefined)
 */
export function resolveListKey(key: string): FolderListAction | undefined {
  if (key === "Enter") return { type: "enter" };
  if (key === "Backspace") return { type: "up" };
  if (key === "ArrowDown") return { type: "move", delta: 1 };
  if (key === "ArrowUp") return { type: "move", delta: -1 };
  return undefined;
}

/** 목록·필터 쿼리 문자열. 서버(`GET /api/folders`)가 받는 모양과 맞춘다 */
export function folderListQuery(target: string | undefined, showHidden: boolean): string {
  const query = new URLSearchParams();
  if (target) query.set("path", target);
  if (showHidden) query.set("showHidden", "1");
  const text = query.toString();
  return text ? `?${text}` : "";
}

/** 화살표로 옮긴 다음 고를 항목의 인덱스. 목록이 비었으면 -1 */
export function moveSelectionIndex(currentIndex: number, delta: number, length: number): number {
  if (length === 0) return -1;
  return Math.min(length - 1, Math.max(0, currentIndex + delta));
}
