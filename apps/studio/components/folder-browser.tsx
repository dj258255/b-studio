"use client";

import { type KeyboardEvent, useEffect, useState } from "react";
import { filterFolders, folderListQuery, hintLabel, moveSelectionIndex, resolveListKey } from "@/lib/folder-browser";
import type { FolderListing } from "@/lib/server/folder-browser";
import { FolderProposalView } from "./folder-proposal-view";
import { OpenFolder } from "./open-folder";
import { useFolderProposal } from "./use-folder-proposal";

/**
 * 더블클릭으로 폴더를 고르는 탐색 모달 본문(ADR-082). 경로를 입력하는 대신 홈 폴더부터 시작해 하위 폴더를
 * 오가며 고른다. 고른 폴더는 바로 `useFolderProposal`로 제안을 받아 그 자리에서 보여준다 — 따로
 * "살펴보기" 단계가 없다. 데스크톱 앱은 OS 기본 대화상자(`desktop-folder-picker.tsx`)를 대신 쓴다.
 */
export function FolderBrowser() {
  const [listing, setListing] = useState<FolderListing>();
  const [listError, setListError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [manual, setManual] = useState(false);
  const proposal = useFolderProposal();

  // 이 함수 자체는 async가 아니다 — fetch 결과가 오기 전(.then 안)에서만 setState한다.
  // 마운트 직후 useEffect에서 곧바로 부르므로, 동기로 setState하면 "효과 안 setState" 경고가 난다(work-overview.tsx와 같은 이유)
  function load(target: string | undefined, hidden: boolean): Promise<void> {
    return fetch(`/api/folders${folderListQuery(target, hidden)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as FolderListing & { error?: string };
        if (!response.ok) {
          setListError(body.error ?? "폴더를 불러오지 못했습니다");
          return;
        }
        setListing(body);
        setSelected(body.path);
        setFilter("");
        setListError(undefined);
        proposal.reset();
      })
      .catch(() => setListError("폴더를 불러오지 못했습니다"));
  }

  useEffect(() => {
    void load(undefined, false);
    // 처음 한 번만 받는다(홈 폴더부터 시작)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loading = !listing && !listError;
  const filtered = listing ? filterFolders(listing.children, filter) : [];

  function moveSelection(delta: number) {
    const index = filtered.findIndex((child) => child.path === selected);
    const next = moveSelectionIndex(index, delta, filtered.length);
    if (next >= 0) setSelected(filtered[next]!.path);
  }

  function onListKeyDown(event: KeyboardEvent<HTMLUListElement>) {
    const action = resolveListKey(event.key);
    if (!action) return;
    event.preventDefault();
    if (action.type === "up") {
      if (listing?.parent) void load(listing.parent, showHidden);
      return;
    }
    if (action.type === "move") {
      moveSelection(action.delta);
      return;
    }
    const target = filtered.find((child) => child.path === selected);
    if (target) void load(target.path, showHidden);
  }

  if (manual) {
    return (
      <div>
        <button type="button" onClick={() => setManual(false)} className="mx-4 mt-3 text-xs text-muted underline hover:text-ink">
          폴더 목록에서 고르기
        </button>
        <div className="p-4">
          <OpenFolder />
        </div>
      </div>
    );
  }

  return (
    <div>
      <nav aria-label="지금 보는 경로" className="flex flex-wrap items-center gap-0.5 px-4 pt-3 text-sm">
        {listing?.breadcrumbs.map((crumb, index) => (
          <span key={crumb.path} className="flex items-center gap-0.5">
            {index > 0 && (
              <span aria-hidden className="text-muted">
                /
              </span>
            )}
            <button type="button" onClick={() => void load(crumb.path, showHidden)} className="rounded-control px-1 hover:bg-panel hover:underline">
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      {listing && listing.shortcuts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pt-2" aria-label="바로가기">
          {listing.shortcuts.map((shortcut) => (
            <button
              key={shortcut.path}
              type="button"
              onClick={() => void load(shortcut.path, showHidden)}
              className="glass-soft rounded-control px-2 py-1 text-xs hover:bg-panel"
            >
              {shortcut.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 px-4 pt-3">
        <label htmlFor="folder-filter" className="sr-only">
          폴더 이름으로 거르기
        </label>
        <input
          id="folder-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const target = filtered.find((child) => child.path === selected) ?? filtered[0];
            if (target) void load(target.path, showHidden);
          }}
          placeholder="폴더 이름으로 거르기"
          className="min-w-0 flex-1 rounded-control border border-line bg-panel px-3 py-1.5 text-sm"
        />
        <label className="flex shrink-0 items-center gap-1 text-xs text-muted">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(event) => {
              setShowHidden(event.target.checked);
              void load(listing?.path, event.target.checked);
            }}
          />
          숨김 폴더
        </label>
      </div>

      {listError && (
        <p role="alert" className="mt-2 px-4 text-sm text-fail">
          {listError}
        </p>
      )}

      <ul role="listbox" aria-label="폴더 목록" tabIndex={0} onKeyDown={onListKeyDown} className="mt-2 max-h-64 space-y-0.5 overflow-y-auto px-2 pb-1">
        {loading ? (
          <li className="px-2 py-1.5 text-sm text-muted">불러오는 중</li>
        ) : filtered.length === 0 ? (
          <li className="px-2 py-1.5 text-sm text-muted">{listing?.children.length === 0 ? "하위 폴더가 없습니다" : "찾는 이름이 없습니다"}</li>
        ) : (
          filtered.map((child) => (
            <li key={child.path}>
              <button
                type="button"
                role="option"
                aria-selected={selected === child.path}
                onClick={() => setSelected(child.path)}
                onDoubleClick={() => void load(child.path, showHidden)}
                className={`flex w-full items-center justify-between gap-2 rounded-control px-2 py-1.5 text-left text-sm hover:bg-panel ${selected === child.path ? "bg-panel font-medium" : ""}`}
              >
                <span className="min-w-0 truncate">{child.name}</span>
                {child.hints.length > 0 && (
                  <span className="flex shrink-0 flex-wrap justify-end gap-1">
                    {child.hints.map((hint) => (
                      <span key={hint} className="glass-soft rounded-control px-1.5 py-0.5 text-[11px] text-muted">
                        {hintLabel(hint)}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            </li>
          ))
        )}
      </ul>
      {listing?.truncated && (
        <p className="px-4 pb-1 text-xs text-wait">
          폴더가 많아 {listing.children.length}개만 보여줍니다(전체 {listing.totalCount}개)
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
        <button type="button" onClick={() => setManual(true)} className="text-xs text-muted underline hover:text-ink">
          경로 직접 입력
        </button>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          <p className="min-w-0 truncate font-mono text-xs text-muted" title={selected ?? ""}>
            {selected ?? listing?.path}
          </p>
          <button
            type="button"
            disabled={!selected || proposal.busy}
            onClick={() => selected && void proposal.propose(selected)}
            className="glass-soft shrink-0 rounded-control px-4 py-2 text-sm font-medium hover:bg-panel disabled:opacity-50"
          >
            {proposal.busy && !proposal.proposal ? "살펴보는 중" : "이 폴더 열기"}
          </button>
        </div>
      </div>

      {proposal.error && (
        <p role="alert" className="px-4 pb-3 text-sm text-fail">
          {proposal.error}
        </p>
      )}
      {proposal.proposal && (
        <div className="border-t border-line px-4 py-3">
          <FolderProposalView proposal={proposal.proposal} busy={proposal.busy} onApply={() => void proposal.apply(proposal.proposal!.detection.folder)} />
        </div>
      )}
    </div>
  );
}
