"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { OpenFolder } from "./open-folder";

/**
 * 프로젝트 메뉴(ADR-070)의 "폴더 열기…"를 모달로 띄운다. 안의 흐름은 새로 시작 화면(`/start`)이 쓰던 OpenFolder 그대로다 —
 * 경로를 넣고 살펴본 뒤 확인하면 파일을 만들고 그 프로젝트의 개발 화면으로 이동한다(그때 이 화면과 함께 사라진다).
 * body에 포털로 그린다 — 머리의 유리 효과(backdrop-filter)가 안쪽 fixed 요소의 기준을 머리로 바꿔 갇힌다(work-drawer와 같은 이유)
 */
export function OpenFolderModal({ onClose }: { onClose: () => void }) {
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
      <div className="glass absolute left-1/2 top-1/2 max-h-[85vh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-panel shadow-xl">
        <div className="flex justify-end px-3 pt-3">
          <button type="button" onClick={onClose} className="glass-soft rounded-control px-3 py-1 text-sm font-medium hover:bg-panel">
            닫기
          </button>
        </div>
        <div className="px-1 pb-1">
          <OpenFolder />
        </div>
      </div>
    </div>,
    document.body,
  );
}
