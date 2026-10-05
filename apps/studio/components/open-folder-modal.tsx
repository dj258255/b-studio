"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useHasDesktopBridge } from "@/lib/desktop-bridge";
import { DesktopFolderPicker } from "./desktop-folder-picker";
import { FolderBrowser } from "./folder-browser";

/**
 * 프로젝트 메뉴(ADR-070)의 "폴더 열기…"를 모달로 띄운다(ADR-085). 경로를 손으로 입력하는 대신 고른다 —
 * 데스크톱 앱(`window.bStudioDesktop.pickFolder`가 있으면)은 OS 기본 폴더 선택 창을, 그 밖(브라우저)은
 * 더블클릭으로 오가는 탐색 모달을 쓴다. 확인하면 파일을 만들고 그 프로젝트의 개발 화면으로 이동한다.
 * body에 포털로 그린다 — 머리의 유리 효과(backdrop-filter)가 안쪽 fixed 요소의 기준을 머리로 바꿔 갇힌다(work-drawer와 같은 이유)
 */
export function OpenFolderModal({ onClose, initialPath }: { onClose: () => void; /** 데스크톱 선택 창에서 이미 고른 폴더. 있으면 선택 단계 없이 제안부터 보인다 */ initialPath?: string }) {
  // 데스크톱 판단은 마운트 뒤(클라이언트에서)만 된다 — 서버 렌더는 항상 브라우저 쪽(FolderBrowser)으로 그려 SSR과 어긋나지 않게 한다
  const desktop = useHasDesktopBridge();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="open-folder">
      <button type="button" aria-label="닫기" onClick={onClose} className="absolute inset-0 bg-ink/15" />
      {/*
        세로 가운데 정렬(top-1/2 -translate-y-1/2) 대신 위에서 고정된 자리에 둔다. 폴더 목록 길이가 바뀔 때마다
        모달 전체 높이가 바뀌면 가운데 정렬은 그 자리도 따라 움직여 탐색 중 화면이 튄다 — 고정 자리는 안 움직인다
      */}
      <div className="glass absolute left-1/2 top-[10vh] max-h-[80vh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 overflow-y-auto rounded-panel shadow-xl">
        <h2 id="open-folder" className="sr-only">
          폴더 열기
        </h2>
        <div className="flex justify-end px-3 pt-3">
          <button type="button" onClick={onClose} className="glass-soft rounded-control px-3 py-1 text-sm font-medium hover:bg-panel">
            닫기
          </button>
        </div>
        {desktop || initialPath ? <DesktopFolderPicker initialPath={initialPath} /> : <FolderBrowser />}
      </div>
    </div>,
    document.body,
  );
}
