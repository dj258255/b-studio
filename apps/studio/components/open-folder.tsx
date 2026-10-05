"use client";

import { useState } from "react";
import { FolderProposalView } from "./folder-proposal-view";
import { useFolderProposal } from "./use-folder-proposal";

/**
 * 경로를 손으로 입력해 아무 폴더나 프로젝트로 연다(ADR-067). 폴더 선택 모달(ADR-085, `open-folder-modal.tsx`→`folder-browser.tsx`)의
 * "경로 직접 입력" 토글이 쓰는 대비용 화면이다 — 기본은 더블클릭으로 고르는 탐색 모달이고, 이 화면은
 * 탐색으로 갈 수 없는 경로(예: 마운트한 다른 볼륨)를 위해 남겨 둔다.
 */
export function OpenFolder() {
  const [folder, setFolder] = useState("");
  const { proposal, busy, error, propose, apply, selectedInfra, toggleInfra } = useFolderProposal();

  return (
    <section className="glass rounded-panel p-5" aria-labelledby="open-folder-manual">
      <h2 id="open-folder-manual" className="text-lg font-semibold">
        경로로 폴더 열기
      </h2>
      <p className="mt-1 text-sm leading-6 text-muted">
        이 PC의 프로젝트 폴더를 엽니다. studio.yaml이 없으면 폴더를 보고 Next.js·Vite·Spring Boot·FastAPI를 찾아 실행 설정을 만들어 보여 줍니다.
      </p>
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (folder.trim()) void propose(folder.trim());
        }}
      >
        <label htmlFor="folder-path" className="sr-only">
          폴더 경로
        </label>
        <input
          id="folder-path"
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          placeholder="~/Desktop/my-app"
          // 폴더 목록 모달에서 "경로 직접 입력"으로 바꾸면 이 화면이 새로 그려진다 — 바로 타이핑할 수 있게 포커스를 준다
          autoFocus
          className="min-w-0 flex-1 rounded-control border border-line bg-panel px-3 py-2 font-mono text-sm"
        />
        <button type="submit" disabled={busy || !folder.trim()} className="glass-soft rounded-control px-4 py-2 text-sm font-medium hover:bg-panel disabled:opacity-50">
          {busy && !proposal ? "살펴보는 중" : "살펴보기"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-3 text-sm text-fail">
          {error}
        </p>
      )}

      {proposal && (
        <div className="mt-4">
          <FolderProposalView proposal={proposal} busy={busy} onApply={() => void apply(proposal.detection.folder)} selectedInfra={selectedInfra} onToggleInfra={toggleInfra} />
        </div>
      )}
    </section>
  );
}
