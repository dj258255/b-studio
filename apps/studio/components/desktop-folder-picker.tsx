"use client";

import { useEffect, useRef, useState } from "react";
import { desktopBridge } from "@/lib/desktop-bridge";
import { FolderProposalView } from "./folder-proposal-view";
import { useFolderProposal } from "./use-folder-proposal";

/**
 * 데스크톱 앱(apps/desktop)에서 "폴더 선택…"을 누르면 OS 기본 폴더 선택 창을 띄운다(ADR-085).
 * `window.bStudioDesktop.pickFolder()`가 있을 때만 쓴다(`open-folder-modal.tsx`가 있고 없음을 미리 본다) —
 * 고른 경로는 바로 제안을 받아 보여주고, 따로 "살펴보기" 단계가 없다.
 */
export function DesktopFolderPicker({ initialPath }: { initialPath?: string } = {}) {
  const [pending, setPending] = useState(false);
  const proposal = useFolderProposal();
  const proposed = useRef(false);

  // 메뉴에서 이미 폴더를 골라 왔으면(데스크톱) 선택 단계 없이 바로 제안을 받는다
  useEffect(() => {
    if (!initialPath || proposed.current) return;
    proposed.current = true;
    void proposal.propose(initialPath);
    // proposal은 매 렌더 새 객체라 의존성에서 뺀다(처음 한 번만 부른다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPath]);

  async function pick(): Promise<void> {
    const bridge = desktopBridge();
    if (!bridge) return;
    setPending(true);
    const path = await bridge.pickFolder().catch(() => undefined);
    setPending(false);
    if (path) void proposal.propose(path);
  }

  return (
    <div className="p-5">
      <h2 className="text-lg font-semibold">폴더 열기</h2>
      {initialPath ? (
        <p className="mt-1 break-all font-mono text-xs text-muted">{initialPath}</p>
      ) : (
        <p className="mt-1 text-sm leading-6 text-muted">
          이 PC의 프로젝트 폴더를 엽니다. studio.yaml이 없으면 폴더를 보고 Next.js·Vite·Spring Boot·FastAPI를 찾아 실행 설정을 만들어 보여 줍니다.
        </p>
      )}
      <button
        type="button"
        onClick={() => void pick()}
        disabled={pending}
        className="glass-soft mt-3 rounded-control px-4 py-2 text-sm font-medium hover:bg-panel disabled:opacity-50"
      >
        {pending ? "선택 창 여는 중" : proposal.proposal ? "다른 폴더 선택…" : "폴더 선택…"}
      </button>

      {proposal.error && (
        <p role="alert" className="mt-3 text-sm text-fail">
          {proposal.error}
        </p>
      )}
      {proposal.proposal && (
        <div className="mt-4">
          <FolderProposalView
            proposal={proposal.proposal}
            busy={proposal.busy}
            onApply={() => void proposal.apply(proposal.proposal!.detection.folder)}
            selectedInfra={proposal.selectedInfra}
            onToggleInfra={proposal.toggleInfra}
          />
        </div>
      )}
    </div>
  );
}
